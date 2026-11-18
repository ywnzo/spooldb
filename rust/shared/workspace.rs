use crate::{
    memory_mutation::Backend,
    memory_write::{Fault, bad},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Deserialize)]
pub struct Member {
    pub id: String,
    label: String,
    role: String,
    can_create: i64,
}

impl Member {
    pub fn is_owner(&self) -> bool {
        self.role == "owner"
    }

    fn admin(&self) -> bool {
        matches!(self.role.as_str(), "owner" | "admin")
    }
}

#[derive(Deserialize, Serialize)]
struct Project {
    room: String,
    name: String,
}

pub const CATEGORIES: [&str; 5] = [
    "handoffs",
    "decisions",
    "findings",
    "tasks",
    "conversations",
];

type Result<T> = std::result::Result<T, Fault>;
fn internal<E>(_: E) -> Fault {
    Fault(500, "INTERNAL", "Relay unavailable".to_owned())
}

fn row<T: serde::de::DeserializeOwned>(
    db: &impl Backend,
    sql: &str,
    params: &[&str],
) -> Result<Option<T>> {
    db.query(sql, params)?
        .first()
        .map(|row| serde_json::from_str(row).map_err(internal))
        .transpose()
}

fn denied(message: &str) -> Fault {
    Fault(403, "WORKSPACE_FORBIDDEN", message.to_owned())
}
fn conflict(code: &'static str, message: &str) -> Fault {
    Fault(409, code, message.to_owned())
}

fn hash(data: &str) -> String {
    format!("{:x}", Sha256::digest(data.as_bytes()))
}

pub fn authorize(db: &impl Backend, token: &str) -> Result<Member> {
    row(
        db,
        "SELECT json_object('id',id,'label',label,'role',role,'can_create',can_create)
         FROM workspace_members WHERE token_hash=?1 AND revoked=0",
        &[&hash(token)],
    )?
    .ok_or_else(|| {
        Fault(
            401,
            "WORKSPACE_AUTH",
            "Workspace authentication required".to_owned(),
        )
    })
}

fn role(db: &impl Backend, member: &Member, room: &str) -> Result<Option<String>> {
    Ok(match member.role.as_str() {
        "owner" | "admin" => Some("admin".to_owned()),
        "reader" => Some("read".to_owned()),
        "writer" => Some("write".to_owned()),
        _ => db
            .query(
                "SELECT role FROM workspace_grants WHERE member=?1 AND room=?2",
                &[&member.id, room],
            )?
            .into_iter()
            .next(),
    })
}

fn parent(db: &impl Backend, room: &str) -> Result<Option<String>> {
    Ok(db
        .query(
            "SELECT parent_room FROM workspace_project_parents WHERE child_room=?1",
            &[room],
        )?
        .into_iter()
        .next())
}

fn view(db: &impl Backend, member: &Member, project: &Project) -> Result<Value> {
    let mut object = json!(project);
    if let Some(parent) = parent(db, &project.room)?
        && role(db, member, &parent)?.is_some()
    {
        object["parentRoom"] = json!(parent);
    }
    Ok(object)
}

fn project(db: &impl Backend, room: &str) -> Result<Option<Project>> {
    row(
        db,
        "SELECT json_object('room',room,'name',name) FROM team_projects WHERE room=?1",
        &[room],
    )
}

fn projects(db: &impl Backend) -> Result<Vec<Project>> {
    db.query(
        "SELECT json_object('room',room,'name',name) FROM team_projects ORDER BY rowid",
        &[],
    )?
    .iter()
    .map(|data| serde_json::from_str(data).map_err(internal))
    .collect()
}

fn info(db: &impl Backend) -> Result<Value> {
    #[derive(Deserialize)]
    struct Workspace {
        id: String,
        name: String,
    }
    let Some(row) = row::<Workspace>(
        db,
        "SELECT json_object('id',id,'name',name) FROM workspace_settings LIMIT 1",
        &[],
    )?
    else {
        return Ok(Value::Null);
    };
    let global = policy(db, "")?;
    Ok(
        json!({"id":row.id,"name":row.name,"sharing":global["workspaceSharing"],
        "sharingRevision":global["workspaceSharingRevision"]}),
    )
}

fn token_for(db: &impl Backend, key_name: &str, payload: &str) -> Result<String> {
    let key = db
        .query(
            "SELECT value FROM deployment_meta WHERE key=?1",
            &[key_name],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| internal("workspace key missing"))?;
    let bytes = STANDARD.decode(key).map_err(internal)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&bytes).map_err(internal)?;
    mac.update(payload.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

pub fn deletion_room<'a>(db: &impl Backend, member: &Member, input: &'a Value) -> Result<&'a str> {
    let room = input["room"]
        .as_str()
        .filter(|room| !room.is_empty())
        .ok_or_else(|| denied("Project admin access required to delete shared conversations"))?;
    if project(db, room)?.is_none() || role(db, member, room)?.as_deref() != Some("admin") {
        return Err(denied(
            "Project admin access required to delete shared conversations",
        ));
    }
    Ok(room)
}

pub fn action(db: &impl Backend, member: &Member, input: &Value, origin: &str) -> Result<Value> {
    let command = input["command"].as_str().unwrap_or_default();
    match command {
        "list" => list(db, member),
        "sharing" => sharing(db, member, input, None),
        "project-sharing" => sharing(
            db,
            member,
            input,
            Some(input["room"].as_str().unwrap_or_default()),
        ),
        "repository-match" | "repository-enroll" => repository(db, member, input),
        "link-parent" => link_parent(db, member, input),
        "create" => {
            let retry = retry_key(input)?;
            let created = create(db, member, input, retry, None, None)?;
            Ok(json!({"project":created}))
        }
        "invite-member" => {
            if !member.admin() {
                return Err(denied("Workspace admin access required"));
            }
            let role = input["role"].as_str().unwrap_or("member");
            if role == "owner" || role == "admin" && !member.is_owner() {
                return Err(denied("Only an owner can invite admins"));
            }
            issue(
                db,
                origin,
                None,
                input["label"].as_str().unwrap_or("Teammate"),
                role,
                input["canCreate"] != false,
            )
        }
        "accept-project" => {
            let link = input["link"]
                .as_str()
                .ok_or_else(|| bad("WORKSPACE_INVITE", "Invalid invite link"))?;
            let code = invite_code(link, origin)?;
            let invite = inspect(db, &code, false)?;
            let claim = hash(&format!("workspace:{}", member.id));
            if invite
                .claim_hash
                .as_ref()
                .is_some_and(|previous| previous != &claim)
            {
                return Err(conflict("INVITE_USED", "Project invite already used"));
            }
            let room = invite
                .room
                .as_deref()
                .ok_or_else(|| internal("invite room missing"))?;
            db.execute(
                "UPDATE team_invites SET claim_hash=?1,member_id=?2 WHERE hash=?3",
                &[&claim, &format!("workspace-{}", member.id), &invite.hash],
            )?;
            db.execute(
                "INSERT OR IGNORE INTO workspace_grants VALUES(?1,?2,?3)",
                &[&member.id, room, &invite.role],
            )?;
            Ok(json!({"accepted":true,"room":room}))
        }
        "revoke-member" => revoke(db, member, input),
        "retrieval" | "relay-admin" => {
            if !member.is_owner() {
                return Err(Fault(
                    403,
                    "WORKSPACE_ROLE",
                    "Workspace owner access is required".to_owned(),
                ));
            }
            Ok(if command == "retrieval" {
                json!({"supported":false,"message":"Local model configuration requires a self-hosted relay with v0.4.27 or newer."})
            } else {
                json!({"supported":false,"message":"Host maintenance is unavailable on this relay backend."})
            })
        }
        _ => {
            let room = input["room"].as_str().unwrap_or_default();
            let project = project(db, room)?.ok_or_else(|| denied("Project access required"))?;
            let role = role(db, member, room)?.ok_or_else(|| denied("Project access required"))?;
            match command {
                "join" => {
                    let token = token_for(
                        db,
                        "workspace-key",
                        &format!("project:{}:{room}", member.id),
                    )?;
                    let id = format!("workspace-{}", member.id);
                    db.execute(
                        "INSERT INTO team_members VALUES(?1,?2,?3,?4,?5,0) ON CONFLICT(id,room)
                       DO UPDATE SET role=excluded.role,token_hash=excluded.token_hash,revoked=0",
                        &[
                            &id,
                            room,
                            &member.label,
                            if role == "read" { "read" } else { "write" },
                            &hash(&token),
                        ],
                    )?;
                    Ok(
                        json!({"connection":{"version":1,"url":origin,"room":room,"project":project.name,
                        "device":member.label,"token":token}}),
                    )
                }
                "invite-project" => {
                    if role != "admin" {
                        return Err(denied("Project admin access required"));
                    }
                    issue(
                        db,
                        origin,
                        Some(room),
                        input["label"].as_str().unwrap_or("Teammate"),
                        input["role"].as_str().unwrap_or("write"),
                        false,
                    )
                }
                "project-members" | "revoke-project-member" => {
                    if role != "admin" {
                        return Err(denied("Project admin access required"));
                    }
                    if command == "project-members" {
                        let entries=db.query("SELECT json_object('id',id,'label',label,'role',role,'revoked',revoked)
                            FROM team_members WHERE room=?1",&[room])?;
                        return Ok(json!({"members": parse_rows(entries)?}));
                    }
                    let id = input["memberId"]
                        .as_str()
                        .filter(|s| !s.starts_with("workspace-"))
                        .ok_or_else(|| denied("Use workspace revoke for workspace memberships"))?;
                    if db
                        .query(
                            "SELECT id FROM team_members WHERE room=?1 AND id=?2 AND revoked=0",
                            &[room, id],
                        )?
                        .is_empty()
                    {
                        return Err(Fault(
                            404,
                            "MEMBER_MISSING",
                            "Active connection not found".to_owned(),
                        ));
                    }
                    db.execute(
                        "UPDATE team_members SET revoked=1 WHERE room=?1 AND id=?2",
                        &[room, id],
                    )?;
                    Ok(json!({"revoked":true}))
                }
                _ => Err(bad("WORKSPACE_ACTION", "Unknown workspace action")),
            }
        }
    }
}

fn parse_rows(entries: Vec<String>) -> Result<Vec<Value>> {
    entries
        .iter()
        .map(|row| serde_json::from_str(row).map_err(internal))
        .collect()
}

fn list(db: &impl Backend, member: &Member) -> Result<Value> {
    let mut visible = Vec::new();
    for project in projects(db)? {
        if let Some(role) = role(db, member, &project.room)? {
            let mut info = view(db, member, &project)?;
            info["role"] = json!(role);
            visible.push(info);
        }
    }
    let members = if member.admin() {
        parse_rows(db.query("SELECT json_object('id',id,'label',label,'role',role,'canCreate',can_create,'revoked',revoked) FROM workspace_members",&[])?)?
    } else {
        Vec::new()
    };
    Ok(
        json!({"workspace":info(db)?,"projects":visible,"members":members,
        "capabilities":["repository-enrollment-v2","subprojects-v1","subproject-link-v1"],
        "member":{"id":member.id,"label":member.label,"role":member.role,"canCreate":member.admin()||member.can_create!=0}}),
    )
}

fn sharing(db: &impl Backend, member: &Member, input: &Value, room: Option<&str>) -> Result<Value> {
    let grant = if let Some(room) = room {
        if project(db, room)?.is_none() {
            return Err(denied("Project access required"));
        }
        role(db, member, room)?.ok_or_else(|| denied("Project access required"))? == "admin"
    } else {
        member.admin()
    };
    let get = || policy(db, room.unwrap_or_default());
    let mut current = get()?;
    if let Some(settings) = input.get("sharing") {
        if !grant {
            return Err(denied(if room.is_some() {
                "Project admin access required"
            } else {
                "Workspace admin access required"
            }));
        }
        let items = settings
            .as_object()
            .filter(|items| {
                !items.is_empty()
                    && items.iter().all(|(k, v)| {
                        CATEGORIES.contains(&k.as_str())
                            && (v.is_boolean() || room.is_some() && v.is_null())
                    })
            })
            .ok_or_else(|| {
                bad(
                    "SHARING_INPUT",
                    "Choose valid sharing categories and values",
                )
            })?;
        let (field, revision) = if room.is_some() {
            ("overrides", "sharingRevision")
        } else {
            ("workspaceSharing", "workspaceSharingRevision")
        };
        if input["expectedRevision"] != current[revision] {
            return Err(conflict(
                "SHARING_CONFLICT",
                "Sharing settings changed; refresh and try again",
            ));
        }
        let revision = current[revision].as_i64().unwrap_or_default() + 1;
        let mut data = current[field].clone();
        for (key, value) in items {
            data[key] = value.clone();
        }
        if let Some(room) = room {
            db.execute(
                "INSERT INTO project_sharing VALUES(?1,?2,?3) ON CONFLICT(room)
                DO UPDATE SET revision=excluded.revision,data=excluded.data",
                &[room, &revision.to_string(), &data.to_string()],
            )?;
        } else {
            db.execute(
                "INSERT INTO workspace_sharing VALUES(1,?1,?2) ON CONFLICT(id)
                DO UPDATE SET revision=excluded.revision,data=excluded.data",
                &[&revision.to_string(), &data.to_string()],
            )?;
        }
        current = get()?;
    }
    Ok(if room.is_some() {
        current
    } else {
        json!({"sharing":current["workspaceSharing"],"sharingRevision":current["workspaceSharingRevision"]})
    })
}

fn retry_key(input: &Value) -> Result<&str> {
    input["requestId"]
        .as_str()
        .filter(|key| !key.is_empty() && key.encode_utf16().count() <= 120)
        .ok_or_else(|| bad("REQUEST_ID", "Project creation needs a retry key"))
}

fn create(
    db: &impl Backend,
    member: &Member,
    input: &Value,
    retry: &str,
    key: Option<&str>,
    parent_room: Option<&str>,
) -> Result<Project> {
    if !member.admin() && member.can_create == 0 {
        return Err(denied("You cannot create workspace projects"));
    }
    let name = input["name"]
        .as_str()
        .filter(|name| !name.trim().is_empty() && name.encode_utf16().count() <= 160)
        .map(str::trim)
        .ok_or_else(|| bad("PROJECT_NAME", "Enter a project name"))?;
    let prior = row::<Project>(
        db,
        "SELECT json_object('room',room,'name',name) FROM team_projects WHERE creator=?1 AND request_id=?2",
        &[&member.id, retry],
    )?;
    if let Some(prior) = prior {
        let repository_ok = if let Some(key) = key {
            !db.query(
                "SELECT room FROM workspace_repository_links WHERE repository_key=?1 AND room=?2",
                &[key, &prior.room],
            )?
            .is_empty()
                && parent(db, &prior.room)?.as_deref() == parent_room
        } else {
            true
        };
        if prior.name != name || !repository_ok {
            return Err(conflict(
                "REQUEST_CONFLICT",
                "Project creation retry changed name, repository identity or parent",
            ));
        }
        return Ok(prior);
    }
    if let Some(key) = key {
        let linked = db.query(
            "SELECT room FROM workspace_repository_links WHERE repository_key=?1",
            &[key],
        )?;
        if !linked.is_empty() {
            let available = repository_projects(db, member, &linked)?;
            if available.is_empty() {
                return Err(denied(
                    "This repository already has a shared project. Request an invitation to join it",
                ));
            }
            let names = available
                .iter()
                .map(|value| value["name"].to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(conflict(
                "REPOSITORY_EXISTS",
                &format!(
                    "This repository already belongs to {names}. Ask to join the existing shared project; no duplicate was created."
                ),
            ));
        }
    }
    let (room, _) = db.observation()?;
    db.execute(
        "INSERT INTO team_projects VALUES(?1,?2,?3,?4)",
        &[&room, name, &member.id, retry],
    )?;
    if let Some(key) = key {
        db.execute(
            "INSERT INTO workspace_repository_links VALUES(?1,?2)",
            &[key, &room],
        )?;
    }
    if let Some(parent_room) = parent_room {
        db.execute(
            "INSERT INTO workspace_project_parents VALUES(?1,?2)",
            &[&room, parent_room],
        )?;
    }
    db.execute(
        "INSERT OR IGNORE INTO workspace_grants VALUES(?1,?2,'admin')",
        &[&member.id, &room],
    )?;
    Ok(Project {
        room,
        name: name.to_owned(),
    })
}

fn repository_projects(db: &impl Backend, member: &Member, rooms: &[String]) -> Result<Vec<Value>> {
    let mut visible = Vec::new();
    for room in rooms {
        if role(db, member, room)?.is_some()
            && let Some(project) = project(db, room)?
        {
            visible.push(view(db, member, &project)?);
        }
    }
    Ok(visible)
}

fn repository(db: &impl Backend, member: &Member, input: &Value) -> Result<Value> {
    let key = input["repositoryKey"]
        .as_str()
        .filter(|key| {
            key.len() == 64
                && key
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
        .ok_or_else(|| bad("REPOSITORY_KEY", "Invalid repository identity"))?;
    let mode = input.get("mode");
    if mode.is_some_and(|mode| !matches!(mode.as_str(), Some("create" | "join")))
        || input.get("parentRoom").is_some() && mode != Some(&json!("create"))
    {
        return Err(bad("REPOSITORY_MODE", "Choose create or join"));
    }
    let linked = db.query(
        "SELECT room FROM workspace_repository_links WHERE repository_key=?1",
        &[key],
    )?;
    if input["command"] == "repository-match" {
        let visible = repository_projects(db, member, &linked)?;
        if !linked.is_empty() && visible.is_empty() {
            return Err(denied("Repository project access required"));
        }
        return Ok(
            json!({"project":if visible.len()==1 {visible[0].clone()} else {Value::Null},
            "projects":visible,"matched":visible.len()==1,"ambiguous":visible.len()>1}),
        );
    }
    if mode == Some(&json!("create")) {
        let parent_room = input
            .get("parentRoom")
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| denied("Access to the parent project is required"))
            })
            .transpose()?;
        if let Some(parent) = parent_room
            && (project(db, parent)?.is_none() || role(db, member, parent)?.is_none())
        {
            return Err(denied("Access to the parent project is required"));
        }
        if input["room"].as_str().is_some_and(|room| !room.is_empty()) {
            return Err(bad(
                "REPOSITORY_MODE",
                "Creating a project cannot select an existing project",
            ));
        }
        let created = create(db, member, input, retry_key(input)?, Some(key), parent_room)?;
        return Ok(
            json!({"project":view(db,member,&created)?,"matched":false,"enrollmentMode":"create"}),
        );
    }
    if let Some(room) = input["room"].as_str().filter(|room| !room.is_empty()) {
        let existing = linked.iter().any(|item| item == room);
        let project = project(db, room)?.ok_or_else(|| denied("Project access required"))?;
        let role = role(db, member, room)?.ok_or_else(|| denied("Project access required"))?;
        if !existing {
            if !linked.is_empty() {
                return Err(conflict(
                    "REPOSITORY_EXISTS",
                    "This repository already has a shared project. Join that project instead of linking another one.",
                ));
            }
            if role != "admin" {
                return Err(denied(
                    "Project admin access required to link its repository",
                ));
            }
            db.execute(
                "INSERT INTO workspace_repository_links VALUES(?1,?2)",
                &[key, room],
            )?;
        }
        return Ok(json!({"project":view(db,member,&project)?,"matched":existing}));
    }
    if mode == Some(&json!("join")) || !linked.is_empty() {
        if mode != Some(&json!("join")) && repository_projects(db, member, &linked)?.is_empty() {
            return Err(denied("Repository project access required"));
        }
        return Err(conflict(
            "REPOSITORY_CHOICE_REQUIRED",
            "Choose the shared project to join",
        ));
    }
    let created = create(
        db,
        member,
        input,
        &format!("repository-{key}"),
        Some(key),
        None,
    )?;
    Ok(json!({"project":created,"matched":false}))
}

fn link_parent(db: &impl Backend, member: &Member, input: &Value) -> Result<Value> {
    let room = input["room"].as_str().unwrap_or_default();
    let target = input["parentRoom"].as_str().unwrap_or_default();
    let project = project(db, room)?
        .filter(|_| room != target)
        .ok_or_else(|| bad("PROJECT_LINK", "Choose two different existing projects"))?;
    if self::project(db, target)?.is_none() {
        return Err(bad(
            "PROJECT_LINK",
            "Choose two different existing projects",
        ));
    }
    if role(db, member, room)?.as_deref() != Some("admin")
        || role(db, member, target)?.as_deref() != Some("admin")
    {
        return Err(denied("Admin access to both projects is required"));
    }
    if parent(db, room)?.is_some_and(|parent| parent != target) {
        return Err(conflict(
            "PROJECT_LINK_CONFLICT",
            "This project already has a different parent",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut current = Some(target.to_owned());
    while let Some(candidate) = current {
        if candidate == room || !seen.insert(candidate.clone()) {
            return Err(conflict(
                "PROJECT_LINK_CYCLE",
                "Project links cannot form a cycle",
            ));
        }
        current = parent(db, &candidate)?;
    }
    db.execute(
        "INSERT OR IGNORE INTO workspace_project_parents VALUES(?1,?2)",
        &[room, target],
    )?;
    Ok(json!({"linked":true,"project":view(db,member,&project)?}))
}

fn revoke(db: &impl Backend, member: &Member, input: &Value) -> Result<Value> {
    let id = input["memberId"]
        .as_str()
        .filter(|id| *id != member.id && member.admin())
        .ok_or_else(|| denied("Cannot revoke yourself"))?;
    let target = db.query("SELECT role FROM workspace_members WHERE id=?1", &[id])?;
    if target
        .first()
        .is_none_or(|role| role == "owner" || role == "admin" && !member.is_owner())
    {
        return Err(denied("Cannot revoke that member"));
    }
    db.execute("UPDATE workspace_members SET revoked=1 WHERE id=?1", &[id])?;
    db.execute(
        "UPDATE team_members SET revoked=1 WHERE id=?1",
        &[&format!("workspace-{id}")],
    )?;
    Ok(json!({"revoked":true}))
}

fn random_secret() -> Result<[u8; 32]> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(internal)?;
    Ok(bytes)
}

pub fn setup(db: &impl Backend, input: &Value, origin: &str) -> Result<Value> {
    let name = input["name"]
        .as_str()
        .filter(|name| !name.trim().is_empty() && name.encode_utf16().count() <= 160)
        .ok_or_else(|| bad("WORKSPACE_NAME", "Enter a workspace name"))?;
    for statement in include_str!("workspace_schema.sql")
        .split(';')
        .map(str::trim)
        .filter(|sql| !sql.is_empty())
    {
        db.execute(statement, &[])?;
    }
    for key in ["workspace-key", "invite-key"] {
        if db
            .query("SELECT value FROM deployment_meta WHERE key=?1", &[key])?
            .is_empty()
        {
            db.execute(
                "INSERT INTO deployment_meta VALUES(?1,?2)",
                &[key, &STANDARD.encode(random_secret()?)],
            )?;
        }
    }
    db.execute("INSERT OR IGNORE INTO workspace_repository_links SELECT repository_key,room FROM workspace_repositories",&[])?;
    let existing = info(db)?;
    if !existing.is_null() {
        let mut result = json!({"workspace":existing,"alreadyConfigured":true});
        if db
            .query(
                "SELECT id FROM workspace_members WHERE role='owner' AND revoked=0",
                &[],
            )?
            .is_empty()
        {
            merge(
                &mut result,
                issue(db, origin, None, "Initial owner recovery", "owner", true)?,
            );
        }
        return Ok(result);
    }
    let (id, _) = db.observation()?;
    db.execute(
        "INSERT INTO workspace_settings VALUES(?1,?2)",
        &[&id, name.trim()],
    )?;
    let mut result = json!({"workspace":info(db)?});
    merge(
        &mut result,
        issue(db, origin, None, "Initial owner", "owner", true)?,
    );
    Ok(result)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn local_create(db: &impl Backend, input: &Value) -> Result<Value> {
    let member = Member {
        id: "relay-operator".into(),
        label: "Relay operator".into(),
        role: "owner".into(),
        can_create: 1,
    };
    let (generated, _) = db.observation()?;
    let retry = input["requestId"].as_str().unwrap_or(&generated);
    let project = create(db, &member, input, retry, None, None)?;
    Ok(json!({"project":project}))
}

#[cfg(not(target_arch = "wasm32"))]
pub fn owner_recovery(db: &impl Backend, origin: &str) -> Result<Value> {
    issue(db, origin, None, "Owner recovery", "owner", true)
}

fn merge(target: &mut Value, source: Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        target.extend(source.clone());
    }
}

pub fn valid_token(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}

pub fn bootstrap_authorized(token: &str, expected: &str) -> bool {
    if expected.len() != 64 {
        return false;
    }
    let actual = hash(token);
    actual
        .bytes()
        .zip(expected.bytes())
        .fold(0, |diff, (a, b)| diff | (a ^ b))
        == 0
}

pub(crate) fn issue(
    db: &impl Backend,
    origin: &str,
    room: Option<&str>,
    label: &str,
    role: &str,
    can_create: bool,
) -> Result<Value> {
    let valid_role = if room.is_some() {
        matches!(role, "read" | "write")
    } else {
        matches!(role, "owner" | "admin" | "member" | "reader" | "writer")
    };
    if !valid_role || label.trim().is_empty() || label.encode_utf16().count() > 120 {
        return Err(bad("WORKSPACE_INVITE", "Invalid invitation options"));
    }
    let code = URL_SAFE_NO_PAD.encode(random_secret()?);
    let expires = now(db)? + 1_440 * 60_000;
    if let Some(room) = room {
        db.execute(
            "INSERT INTO team_invites VALUES(?1,?2,?3,?4,?5,NULL,NULL,0)",
            &[&hash(&code), room, label, role, &expires.to_string()],
        )?;
    } else {
        db.execute(
            "INSERT INTO workspace_invites VALUES(?1,?2,?3,?4,?5,NULL,NULL,0)",
            &[
                &hash(&code),
                label,
                role,
                if can_create { "1" } else { "0" },
                &expires.to_string(),
            ],
        )?;
    }
    let payload = URL_SAFE_NO_PAD.encode(json!({"version":1,"url":origin,"code":code}).to_string());
    let path = if room.is_some() { "join" } else { "workspace" };
    let prefix = if room.is_some() { "" } else { "workspace." };
    Ok(
        json!({"link":format!("spool://{path}/v1/{payload}"),"browserLink":format!("{origin}/join#{prefix}{payload}"),
        "expiresAt":iso(db,expires)?}),
    )
}

fn now(db: &impl Backend) -> Result<u64> {
    db.query(
        "SELECT CAST((julianday('now')-2440587.5)*86400000+0.5 AS INTEGER)||''",
        &[],
    )?
    .first()
    .and_then(|data| data.parse().ok())
    .ok_or_else(|| internal("clock unavailable"))
}

fn iso(db: &impl Backend, millis: u64) -> Result<String> {
    db.query(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ',CAST(?1 AS REAL)/1000,'unixepoch')",
        &[&millis.to_string()],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| internal("clock unavailable"))
}

fn invite_code(link: &str, origin: &str) -> Result<String> {
    let invalid = || bad("WORKSPACE_INVITE", "Invalid project invite link");
    let encoded = link
        .strip_prefix("spool://join/v1/")
        .or_else(|| link.strip_prefix("threadweave://join/v1/"))
        .or_else(|| link.split_once("/join#").map(|(_, fragment)| fragment))
        .ok_or_else(invalid)?;
    if encoded.len() > 40_000 {
        return Err(invalid());
    }
    let value: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    if value["version"] != 1 {
        return Err(invalid());
    }
    if value["url"] != origin {
        return Err(Fault(
            403,
            "WORKSPACE_INVITE",
            "Invite belongs to another relay".to_owned(),
        ));
    }
    value["code"]
        .as_str()
        .filter(|code| valid_token(code))
        .map(str::to_owned)
        .ok_or_else(invalid)
}

#[derive(Deserialize)]
struct Invite {
    hash: String,
    room: Option<String>,
    role: String,
    can_create: i64,
    expires: u64,
    claim_hash: Option<String>,
    member: Option<String>,
    revoked: i64,
}

fn inspect(db: &impl Backend, code: &str, workspace: bool) -> Result<Invite> {
    let sql = if workspace {
        "SELECT json_object('hash',hash,'room',NULL,'role',role,'can_create',can_create,'expires',expires,
           'claim_hash',claim_hash,'member',member,'revoked',revoked) FROM workspace_invites WHERE hash=?1"
    } else {
        "SELECT json_object('hash',hash,'room',room,'role',role,'can_create',0,'expires',expires,
           'claim_hash',claim_hash,'member',member_id,'revoked',revoked) FROM team_invites WHERE hash=?1"
    };
    let now = now(db)?;
    row::<Invite>(db, sql, &[&hash(code)])?
        .filter(|invite| invite.revoked == 0 && invite.expires > now)
        .ok_or_else(|| {
            Fault(
                410,
                "INVITE_EXPIRED",
                "Invite expired or was revoked".to_owned(),
            )
        })
}

pub fn invite(
    db: &impl Backend,
    code: &str,
    workspace: bool,
    preview: bool,
    input: &Value,
    origin: &str,
) -> Result<Value> {
    let invite = inspect(db, code, workspace)?;
    if preview {
        if invite.claim_hash.is_some() {
            return Err(conflict("INVITE_USED", "This invite has already been used"));
        }
        return if workspace {
            Ok(
                json!({"workspace":info(db)?,"role":invite.role,"canCreate":invite.can_create!=0,"expiresAt":iso(db,invite.expires)?}),
            )
        } else {
            let room = invite
                .room
                .as_deref()
                .ok_or_else(|| internal("invite room missing"))?;
            let project = project(db, room)?
                .ok_or_else(|| Fault(404, "PROJECT_MISSING", "Project unavailable".to_owned()))?;
            Ok(
                json!({"project":project.name,"room":room,"role":invite.role,"expiresAt":iso(db,invite.expires)?}),
            )
        };
    }
    let invalid = || {
        bad(
            if workspace {
                "WORKSPACE_INPUT"
            } else {
                "INVITE_INPUT"
            },
            "Name this computer before joining",
        )
    };
    let device = input["device"]
        .as_str()
        .filter(|device| !device.trim().is_empty() && device.encode_utf16().count() <= 120)
        .map(str::trim)
        .ok_or_else(invalid)?;
    let claim = hash(
        input["claim"]
            .as_str()
            .filter(|claim| valid_token(claim))
            .ok_or_else(invalid)?,
    );
    if invite
        .claim_hash
        .as_ref()
        .is_some_and(|prior| prior != &claim)
    {
        return Err(conflict("INVITE_USED", "Invite used by another computer"));
    }
    let token = token_for(
        db,
        if workspace {
            "workspace-key"
        } else {
            "invite-key"
        },
        &format!("{}:{claim}", invite.hash),
    )?;
    if workspace {
        let id = match invite.member {
            Some(id) => id,
            None => db.observation()?.0,
        };
        if !db
            .query(
                "SELECT id FROM workspace_members WHERE id=?1 AND revoked=1",
                &[&id],
            )?
            .is_empty()
        {
            return Err(Fault(
                403,
                "WORKSPACE_REVOKED",
                "Workspace access was revoked".to_owned(),
            ));
        }
        db.execute(
            "INSERT OR IGNORE INTO workspace_members VALUES(?1,?2,?3,?4,?5,0)",
            &[
                &id,
                device,
                &invite.role,
                &invite.can_create.to_string(),
                &hash(&token),
            ],
        )?;
        db.execute(
            "UPDATE workspace_invites SET claim_hash=?1,member=?2 WHERE hash=?3",
            &[&claim, &id, &invite.hash],
        )?;
        if invite.role == "owner" {
            db.execute("UPDATE workspace_invites SET revoked=1 WHERE role='owner' AND hash<>?1 AND claim_hash IS NULL",&[&invite.hash])?;
        }
        Ok(
            json!({"memberId":id,"workspace":info(db)?,"connection":{"version":1,"url":origin,"token":token}}),
        )
    } else {
        let room = invite
            .room
            .as_deref()
            .ok_or_else(|| internal("invite room missing"))?;
        let project = project(db, room)?
            .ok_or_else(|| Fault(404, "PROJECT_MISSING", "Project unavailable".to_owned()))?;
        let id = format!(
            "machine-{}",
            &hash(&format!("{}{claim}", invite.hash))[..32]
        );
        if !db
            .query(
                "SELECT id FROM team_members WHERE id=?1 AND revoked=1",
                &[&id],
            )?
            .is_empty()
        {
            return Err(Fault(
                403,
                "MEMBER_REVOKED",
                "This connection was revoked".to_owned(),
            ));
        }
        db.execute(
            "INSERT OR IGNORE INTO team_members VALUES(?1,?2,?3,?4,?5,0)",
            &[&id, room, device, &invite.role, &hash(&token)],
        )?;
        db.execute(
            "UPDATE team_invites SET claim_hash=?1,member_id=?2 WHERE hash=?3",
            &[&claim, &id, &invite.hash],
        )?;
        Ok(
            json!({"memberId":id,"connection":{"version":1,"url":origin,"room":room,"project":project.name,
            "device":device,"token":token}}),
        )
    }
}

pub fn project_member(db: &impl Backend, room: &str, token_hash: &str) -> Result<(String, String)> {
    let unauthorized = || {
        Fault(
            401,
            "UNAUTHORIZED",
            "Project authentication required".to_owned(),
        )
    };
    let found = row::<(String, String, i64)>(
        db,
        "SELECT json_array(id,role,revoked) FROM team_members
        WHERE room=?1 AND token_hash=?2 AND revoked=0",
        &[room, token_hash],
    )?;
    let Some((id, mut grant, revoked)) = found else {
        return Err(unauthorized());
    };
    if revoked != 0 {
        return Err(unauthorized());
    }
    if let Some(member_id) = id.strip_prefix("workspace-") {
        let member = row::<Member>(
            db,
            "SELECT json_object('id',id,'label',label,'role',role,'can_create',can_create)
            FROM workspace_members WHERE id=?1 AND revoked=0",
            &[member_id],
        )?;
        let Some(member) = member else {
            return Err(Fault(
                401,
                "UNAUTHORIZED",
                "Workspace access revoked".to_owned(),
            ));
        };
        let Some(role) = role(db, &member, room)? else {
            return Err(Fault(403, "FORBIDDEN", "Project access revoked".to_owned()));
        };
        grant = if role == "read" {
            "read".to_owned()
        } else {
            "write".to_owned()
        };
    }
    Ok((id, grant))
}
pub fn policy(db: &impl Backend, room: &str) -> Result<Value> {
    let workspace = row::<(i64, Value)>(
        db,
        "SELECT json_array(revision,json(data)) FROM workspace_sharing WHERE id=1",
        &[],
    )?;
    let project = row::<(i64, Value)>(
        db,
        "SELECT json_array(revision,json(data)) FROM project_sharing WHERE room=?1",
        &[room],
    )?;
    let global = workspace.as_ref().map_or(&Value::Null, |(_, item)| item);
    let local = project.as_ref().map_or(&Value::Null, |(_, item)| item);
    let mut sharing = json!({});
    let mut overrides = json!({});
    let mut workspace_sharing = json!({});
    for category in CATEGORIES {
        overrides[category] = local[category].clone();
        workspace_sharing[category] = json!(global[category] != false);
        sharing[category] = json!(global[category] != false && local[category] != false);
    }
    Ok(
        json!({"sharing":sharing,"overrides":overrides,"workspaceSharing":workspace_sharing,
        "sharingRevision":project.map_or(0,|(revision,_)|revision),
        "workspaceSharingRevision":workspace.map_or(0,|(revision,_)|revision)}),
    )
}
