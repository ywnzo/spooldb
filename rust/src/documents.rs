use crate::{Result, manifest};
use automerge::{AutoSerde, Automerge, Change, ChangeHash, ReadDoc};
use rusqlite::{Transaction, params};
use serde_json::Value;
use sha2::{Digest, Sha256};

const REACH: &str = "WITH RECURSIVE wanted(hash) AS (
    SELECT value FROM json_each(?1)
    UNION
    SELECT dep.value FROM wanted w JOIN shard_changes c ON c.hash=w.hash
      CROSS JOIN json_each(c.deps) dep WHERE c.room=?2 AND c.doc=?3
)";

fn checkpoint(
    db: &Transaction<'_>,
    heads: &str,
    room: &str,
    key: &str,
) -> Result<(Automerge, String)> {
    let query = format!(
        "{REACH} SELECT cp.heads,cp.body,cp.checksum FROM shard_checkpoints cp
         WHERE cp.room=?2 AND cp.doc=?3 AND NOT EXISTS (
           SELECT 1 FROM json_each(cp.heads) h
           WHERE h.value NOT IN (SELECT hash FROM wanted)
         ) ORDER BY cp.seq DESC LIMIT 1"
    );
    let mut statement = db.prepare_cached(&query)?;
    let mut rows = statement.query(params![heads, room, key])?;
    if let Some(row) = rows.next()? {
        let frontier: String = row.get(0)?;
        let body: Vec<u8> = row.get(1)?;
        let checksum: String = row.get(2)?;
        if format!("{:x}", Sha256::digest(&body)) == checksum
            && let Ok(doc) = Automerge::load(&body)
            && parse_heads(&frontier).is_ok_and(|expected| expected == sorted_heads(&doc))
        {
            return Ok((doc, frontier));
        }
    }
    Ok((Automerge::new(), "[]".to_owned()))
}

pub(crate) fn parse_heads(json: &str) -> Result<Vec<ChangeHash>> {
    let strings: Vec<String> = serde_json::from_str(json)?;
    let mut hashes = strings
        .iter()
        .map(|h| h.parse())
        .collect::<std::result::Result<Vec<_>, _>>()?;
    hashes.sort_unstable();
    Ok(hashes)
}

fn sorted_heads(doc: &Automerge) -> Vec<ChangeHash> {
    let mut heads = doc.get_heads();
    heads.sort_unstable();
    heads
}

pub fn read(db: &Transaction<'_>, room: &str, key: &str) -> Result<Value> {
    let entry = manifest::lookup(db, room, key)?;
    let heads: Vec<String> = serde_json::from_value(entry["descriptor"]["heads"].clone())
        .map_err(|_| "Missing document or invalid manifest frontier")?;
    let doc = load(db, room, key, &heads)?;
    Ok(serde_json::to_value(AutoSerde::from(&doc))?)
}

pub(crate) fn load(
    db: &Transaction<'_>,
    room: &str,
    key: &str,
    heads: &[String],
) -> Result<Automerge> {
    if heads.is_empty() {
        return Err("Empty document frontier".into());
    }

    // Match the JS engine's room and shard boundaries on every dependency hop.
    let query = format!(
        "{REACH}, covered(hash) AS (
           SELECT value FROM json_each(?4)
           UNION
           SELECT dep.value FROM covered w JOIN shard_changes c ON c.hash=w.hash
             CROSS JOIN json_each(c.deps) dep WHERE c.room=?2 AND c.doc=?3
         )
         SELECT c.hash,c.body FROM shard_changes c JOIN wanted w ON w.hash=c.hash
         WHERE c.room=?2 AND c.doc=?3 AND c.hash NOT IN (SELECT hash FROM covered) ORDER BY c.seq"
    );
    let heads_json = serde_json::to_string(heads)?;
    let (mut doc, covered) = checkpoint(db, &heads_json, room, key)?;
    let mut statement = db.prepare_cached(&query)?;
    let mut rows = statement.query(params![heads_json, room, key, covered])?;
    while let Some(row) = rows.next()? {
        let stored_hash: String = row.get(0)?;
        let change = Change::from_bytes(row.get(1)?)?;
        if change.hash().to_string() != stored_hash {
            return Err("Corrupt document change".into());
        }
        doc.apply_changes([change])?;
    }
    let expected = parse_heads(&heads_json)?;
    if sorted_heads(&doc) != expected || !doc.get_missing_deps(&expected).is_empty() {
        return Err("Incomplete or invalid shard history".into());
    }
    for (property, expected) in [("room", room), ("document", key)] {
        let (_, object) = doc
            .get(automerge::ROOT, property)?
            .ok_or("Invalid shard identity")?;
        if doc.text(object)? != expected {
            return Err("Invalid shard identity".into());
        }
    }
    if doc
        .get(automerge::ROOT, "schema")?
        .and_then(|(value, _)| value.as_i64())
        != Some(2)
    {
        return Err("Invalid shard schema".into());
    }
    Ok(doc)
}

pub fn insert_message(
    db: &Transaction<'_>,
    room: &str,
    id: &str,
    role: &str,
    text: &str,
    event: &str,
) -> Result<Vec<String>> {
    let key = format!("m:{id}");
    let (changes, heads) = crate::shard_message::encode(room, id, role, text, event)?;
    persist(db, room, &key, changes)?;
    Ok(heads)
}

pub fn persist(db: &Transaction<'_>, room: &str, key: &str, changes: Vec<Change>) -> Result<()> {
    let mut count = 0;
    let mut bytes = 0;
    for change in changes {
        let hash = change.hash().to_string();
        let deps = change
            .deps()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let body = change.raw_bytes();
        let inserted = db.execute(
            "INSERT OR IGNORE INTO shard_changes(room,doc,hash,deps,body)
             VALUES(?1,?2,?3,?4,?5)",
            params![room, key, hash, serde_json::to_string(&deps)?, body],
        )?;
        count += inserted;
        bytes += inserted * body.len();
    }
    db.execute(
        "INSERT INTO shard_doc_stats(room,doc,changes_count,bytes) VALUES(?1,?2,?3,?4)
         ON CONFLICT(room,doc) DO UPDATE SET changes_count=changes_count+excluded.changes_count,
         bytes=bytes+excluded.bytes",
        params![room, key, i64::try_from(count)?, i64::try_from(bytes)?],
    )?;
    Ok(())
}

pub(crate) fn checkpoint_if_due(
    db: &Transaction<'_>,
    room: &str,
    key: &str,
    doc: &Automerge,
) -> Result<()> {
    let due: bool = db.query_row(
        "SELECT changes_count-checkpoint_count>=128 FROM shard_doc_stats WHERE room=?1 AND doc=?2",
        params![room, key],
        |row| row.get(0),
    )?;
    if due {
        checkpoint_document(db, room, key, doc)?;
    }
    Ok(())
}

pub(crate) fn checkpoint_document(
    db: &Transaction<'_>,
    room: &str,
    key: &str,
    doc: &Automerge,
) -> Result<usize> {
    let body = doc.save();
    let checksum = format!("{:x}", Sha256::digest(&body));
    let heads: Vec<String> = sorted_heads(doc).iter().map(ToString::to_string).collect();
    db.execute("INSERT OR IGNORE INTO shard_checkpoints(room,doc,heads,body,checksum) VALUES(?1,?2,?3,?4,?5)",
        params![room,key,serde_json::to_string(&heads)?,body,checksum])?;
    db.execute(
        "UPDATE shard_doc_stats SET checkpoint_count=changes_count WHERE room=?1 AND doc=?2",
        params![room, key],
    )?;
    prune_checkpoints(db, room, key)?;
    Ok(body.len())
}

pub(crate) fn prune_checkpoints(db: &Transaction<'_>, room: &str, key: &str) -> Result<usize> {
    Ok(db.execute(
        "DELETE FROM shard_checkpoints WHERE room=?1 AND doc=?2 AND seq NOT IN (
            SELECT seq FROM shard_checkpoints WHERE room=?1 AND doc=?2 ORDER BY seq DESC LIMIT 2
        )",
        params![room, key],
    )?)
}
