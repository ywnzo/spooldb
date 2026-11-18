use automerge::{Change, ReadDoc};
use sha2::{Digest, Sha256};

pub fn encode(
    room: &str,
    id: &str,
    role: &str,
    text: &str,
    event: &str,
) -> Result<(Vec<Change>, Vec<String>), Box<dyn std::error::Error>> {
    let key = format!("m:{id}");
    use automerge::{
        ActorId, AutoCommit, ObjType, ROOT,
        transaction::{CommitOptions, Transactable},
    };

    let seed = Sha256::digest(serde_json::to_vec(
        &serde_json::json!({"room": room, "key": key}),
    )?);
    let mut doc = AutoCommit::new().with_actor(ActorId::from(&seed[..16]));
    doc.put(ROOT, "schema", 2_i64)?;
    for (property, value) in [("room", room), ("document", key.as_str())] {
        let field = doc.put_object(ROOT, property, ObjType::Text)?;
        doc.splice_text(&field, 0, 0, value)?;
    }
    for name in ["files", "messages", "comments", "adapterEvents", "events"] {
        doc.put_object(ROOT, name, ObjType::Map)?;
    }
    doc.commit_with(
        CommitOptions::default()
            .with_time(0)
            .with_message("shard-genesis"),
    );
    doc.set_actor(ActorId::random());
    let (_, messages) = doc.get(ROOT, "messages")?.ok_or("Missing messages map")?;
    let message = doc.put_object(&messages, id, ObjType::Map)?;
    for (property, value) in [("role", role), ("text", text), ("eventId", event)] {
        let field = doc.put_object(&message, property, ObjType::Text)?;
        doc.splice_text(&field, 0, 0, value)?;
    }
    doc.commit_with(CommitOptions::default().with_message(event));

    let heads = doc.get_heads().iter().map(ToString::to_string).collect();
    Ok((doc.get_changes(&[]), heads))
}
