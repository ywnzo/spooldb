use crate::{
    Result, bundles,
    relay_client::{Client, Fault},
    shards,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

#[derive(Default, PartialEq, Eq)]
struct Cursor {
    push: Vec<String>,
    pull: Vec<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    push_pages: usize,
    pull_pages: usize,
    resets: usize,
}

fn heads(value: &Value) -> Result<Vec<String>> {
    let hashes: Vec<String> = serde_json::from_value(value.clone())?;
    if hashes.len() > 1024
        || hashes.iter().any(|hash| {
            hash.len() != 64
                || !hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
        })
    {
        return Err("Invalid relay frontier".into());
    }
    Ok(hashes)
}

fn local_heads(db: &Connection, room: &str, branch: &str) -> Result<Option<Vec<String>>> {
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT room,heads FROM shard_refs WHERE name=?1",
            [branch],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    row.map(|(actual, raw)| {
        if actual != room {
            return Err("Local branch belongs to a different room".into());
        }
        Ok(serde_json::from_str(&raw)?)
    })
    .transpose()
}

fn cursor(db: &Connection, client: &Client, branch: &str) -> Result<Cursor> {
    let row: Option<(String, String)> = db.query_row(
        "SELECT push_heads,pull_heads FROM relay_cursors WHERE remote=?1 AND room=?2 AND branch=?3",
        params![client.origin, client.room, branch],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    match row {
        Some((push, pull)) => Ok(Cursor {
            push: serde_json::from_str(&push)?,
            pull: serde_json::from_str(&pull)?,
        }),
        None => Ok(Cursor::default()),
    }
}

fn save(
    db: &Transaction<'_>,
    client: &Client,
    branch: &str,
    previous: &Cursor,
    next: Cursor,
) -> Result<Cursor> {
    if cursor(db, client, branch)? != *previous {
        return Err("Sync cursor changed concurrently; retry sync".into());
    }
    db.execute(
        "INSERT INTO relay_cursors VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(remote,room,branch) DO UPDATE SET push_heads=excluded.push_heads,pull_heads=excluded.pull_heads",
        params![client.origin,client.room,branch,serde_json::to_string(&next.push)?,serde_json::to_string(&next.pull)?],
    )?;
    Ok(next)
}

fn next_page(budget: &mut usize) -> Result<()> {
    *budget = budget
        .checked_sub(1)
        .ok_or("Sync page budget reached; resume sync to continue")?;
    Ok(())
}

pub fn run(database: &Path, client: &Client, branch: &str, mode: &str) -> Result<Value> {
    shards::validate_id(branch, "branch")?;
    if !matches!(mode, "push" | "pull" | "both") {
        return Err("Invalid sync mode".into());
    }
    let mut db = Connection::open(database)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch(include_str!("../shared/shard_schema.sql"))?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS relay_cursors(
        remote TEXT NOT NULL,room TEXT NOT NULL,branch TEXT NOT NULL,
        push_heads TEXT NOT NULL,pull_heads TEXT NOT NULL,PRIMARY KEY(remote,room,branch));",
    )?;
    let mut stats = Stats::default();
    let mut budget = 1000;
    let mut position = cursor(&db, client, branch)?;
    while let Err(error) = sync_pages(
        &mut db,
        client,
        branch,
        mode,
        &mut position,
        &mut stats,
        &mut budget,
    ) {
        let missing = error
            .downcast_ref::<Fault>()
            .is_some_and(|fault| fault.code == "MISSING_DEPENDENCIES");
        if !missing || stats.resets != 0 {
            return Err(error);
        }
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        position = save(&tx, client, branch, &position, Cursor::default())?;
        tx.commit()?;
        stats.resets += 1;
    }
    let mut result = serde_json::to_value(stats)?;
    result["room"] = json!(client.room);
    result["mode"] = json!(mode);
    result["durability"] = json!("relay-sqlite");
    result["heads"] = json!(local_heads(&db, &client.room, branch)?.unwrap_or_default());
    Ok(result)
}

fn sync_pages(
    db: &mut Connection,
    client: &Client,
    branch: &str,
    mode: &str,
    position: &mut Cursor,
    stats: &mut Stats,
    budget: &mut usize,
) -> Result<()> {
    let state = client.request("state", None)?;
    heads(&state["heads"])?;
    let limit = state["maxPageBytes"]
        .as_u64()
        .filter(|n| (1024..=8 * 1024 * 1024).contains(n))
        .ok_or("Invalid relay page size")? as usize;
    let target = local_heads(db, &client.room, branch)?;
    if mode != "pull"
        && let Some(target) = target
    {
        loop {
            next_page(budget)?;
            let page = {
                let tx = db.transaction()?;
                bundles::export_page(
                    &tx,
                    &client.room,
                    branch,
                    &position.push,
                    Some(&target),
                    limit,
                )?
            };
            let bundle = &page["bundle"];
            if bundle.is_null() {
                break;
            }
            let ack = client.request("push", Some(&json!({"bundle":bundle})))?;
            let confirmed = heads(&bundle["heads"])?;
            let mut expected = confirmed.clone();
            let mut accepted = heads(&ack["acceptedHeads"])?;
            expected.sort_unstable();
            accepted.sort_unstable();
            if ack["durable"] != true || accepted != expected {
                return Err("Relay did not acknowledge the uploaded frontier".into());
            }
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            *position = save(
                &tx,
                client,
                branch,
                position,
                Cursor {
                    push: confirmed,
                    pull: position.pull.clone(),
                },
            )?;
            tx.commit()?;
            stats.push_pages += 1;
            if page["more"] == false {
                break;
            }
        }
    }
    if mode == "push" {
        return Ok(());
    }
    let mut target = None;
    loop {
        next_page(budget)?;
        let mut body = json!({"since":position.pull});
        if let Some(ref target) = target {
            body["heads"] = json!(target);
        }
        let page = client.request("pull", Some(&body))?;
        let frontier = heads(&page["heads"])?;
        if target.as_ref().is_some_and(|target| *target != frontier) {
            return Err("Relay changed the target frontier during sync".into());
        }
        target = Some(frontier);
        let more = page["more"].as_bool().ok_or("Invalid relay page")?;
        let bundle = &page["bundle"];
        if !bundle.is_null() {
            if bundle["room"] != client.room {
                return Err("Relay bundle room mismatch".into());
            }
            let pull = heads(&bundle["heads"])?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            bundles::import(&tx, branch, bundle)?;
            let known: Vec<_> = position.push.iter().chain(&pull).cloned().collect();
            let (push, _) = bundles::frontier(&tx, &client.room, &known)?;
            *position = save(&tx, client, branch, position, Cursor { push, pull })?;
            tx.commit()?;
            stats.pull_pages += 1;
        } else if more {
            return Err("Empty continuing page".into());
        }
        if !more {
            return Ok(());
        }
    }
}
