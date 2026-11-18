use crate::storage::{CloudMemory, Sql};
use crate::{Result, StateRequest, json, memory_page, memory_search, query_one, reply, vectors};
use serde::Deserialize;
use serde_json::Value;
use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
};
use worker::{Ai, Error, Response, SqlStorage};

#[derive(Default)]
pub struct QueryCache(RefCell<VecDeque<(String, Vec<f32>)>>);

impl QueryCache {
    fn get(&self, key: &str) -> Option<Vec<f32>> {
        self.0
            .borrow()
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, v)| v.clone())
    }
    fn remember(&self, key: String, value: Vec<f32>) {
        let mut cache = self.0.borrow_mut();
        if cache.len() >= 64 {
            cache.pop_front();
        }
        cache.push_back((key, value));
    }
}

#[derive(Deserialize)]
struct Inference {
    data: Vec<Vec<f64>>,
}

fn err<E: std::fmt::Display>(error: E) -> Error {
    Error::RustError(error.to_string())
}
fn schema(sql: &SqlStorage) -> Result<()> {
    for statement in vectors::SCHEMA
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        sql.exec(statement, None)?;
    }
    Ok(())
}

fn note(sql: &SqlStorage, room: &str, metric: &str, count: i64) -> Result<()> {
    sql.exec(
        "INSERT INTO retrieval_usage VALUES(date('now'),?1,?2,?3)
        ON CONFLICT(day,room,metric) DO UPDATE SET value=value+excluded.value",
        vec![room.into(), metric.into(), count.into()],
    )?;
    Ok(())
}

async fn embed(ai: &Ai, model: &str, texts: &[String]) -> Result<Vec<Vec<f32>>> {
    let out: Inference = ai.run(model, json!({"text":texts})).await?;
    if out.data.len() != texts.len() {
        return Err(err("Embedding count mismatch"));
    }
    out.data
        .iter()
        .map(|values| vectors::normalized(values).ok_or_else(|| err("Invalid embedding")))
        .collect()
}

#[derive(Deserialize)]
struct Count {
    n: i64,
}

fn reserve(sql: &SqlStorage, room: &str, texts: &[String]) -> Result<bool> {
    let characters = texts
        .iter()
        .map(|s| s.encode_utf16().count() as i64)
        .sum::<i64>();
    #[derive(Deserialize)]
    struct Limits {
        data: String,
    }
    let limits = query_one::<Limits>(
        sql,
        "SELECT data FROM retrieval_usage_limits WHERE id=1",
        vec![],
    )?
    .map(|row| serde_json::from_str::<Value>(&row.data))
    .transpose()
    .map_err(err)?
    .unwrap_or(Value::Null);
    for (key, metric, increment, project) in [
        ("dailyCharacters", "external_characters", characters, false),
        ("dailyRequests", "external_requests", 1, false),
        (
            "projectDailyCharacters",
            "external_characters",
            characters,
            true,
        ),
    ] {
        let maximum = limits[key].as_i64().unwrap_or(0);
        if maximum <= 0 {
            continue;
        }
        let used = query_one::<Count>(
            sql,
            "SELECT COALESCE(sum(value),0) AS n FROM retrieval_usage
            WHERE day=date('now') AND metric=?1 AND (?2 IS NULL OR room=?2)",
            vec![metric.into(), project.then_some(room).into()],
        )?
        .map_or(0, |row| row.n);
        if used.saturating_add(increment) > maximum {
            note(sql, room, "budget_denied", 1)?;
            return Ok(false);
        }
    }
    for (metric, increment) in [
        ("embedding_requests", 1),
        ("external_requests", 1),
        ("embedding_characters", characters),
        ("external_characters", characters),
    ] {
        note(sql, room, metric, increment)?;
    }
    Ok(true)
}

#[derive(Deserialize)]
struct Source {
    id: String,
    kind: String,
    title: String,
    text: String,
    data: String,
    fingerprint: String,
    next_chunk: Option<i64>,
}

async fn index_one(
    ai: &Ai,
    model: &str,
    model_id: &str,
    sql: &SqlStorage,
    room: &str,
) -> Result<()> {
    let sql_query=format!("SELECT d.id,d.kind,d.title,d.text,d.data,d.fingerprint,p.next_chunk FROM memory_docs d
        LEFT JOIN memory_vector_progress p ON p.room=d.room AND p.id=d.id AND p.model=?2 AND p.fingerprint=d.fingerprint
        WHERE d.room=?1 AND {} AND (p.next_chunk IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM memory_vectors v WHERE v.room=d.room AND v.id=d.id AND v.model=?2 AND v.fingerprint=d.fingerprint
        )) ORDER BY CASE WHEN d.kind='conversation' THEN 1 ELSE 0 END,d.seq DESC LIMIT 1",vectors::VISIBLE);
    let Some(row) = query_one::<Source>(sql, &sql_query, vec![room.into(), model_id.into()])?
    else {
        return Ok(());
    };
    let data: Value = serde_json::from_str(&row.data).map_err(err)?;
    let parts = vectors::chunks(&row.kind, &row.title, &row.text, &data);
    let start = row.next_chunk.unwrap_or_default().max(0) as usize;
    let batch = parts
        .get(start..(start + 8).min(parts.len()))
        .unwrap_or_default();
    if batch.is_empty() {
        return Ok(());
    }
    let texts = batch
        .iter()
        .map(|(_, text)| text.clone())
        .collect::<Vec<_>>();
    if !reserve(sql, room, &texts)? {
        return Ok(());
    }
    let out = embed(ai, model, &texts).await.inspect_err(|_| {
        let _ = note(sql, room, "embedding_failures", 1);
    })?;
    let live = format!(
        "SELECT d.fingerprint AS fingerprint FROM memory_docs d WHERE d.room=?1 AND d.id=?2 AND {}",
        vectors::VISIBLE
    );
    #[derive(Deserialize)]
    struct Fingerprint {
        fingerprint: String,
    }
    if !query_one::<Fingerprint>(sql, &live, vec![room.into(), row.id.as_str().into()])?
        .is_some_and(|current| current.fingerprint == row.fingerprint)
    {
        return Ok(());
    }
    for ((offset, _), vector) in batch.iter().zip(out) {
        sql.exec(
            "INSERT OR REPLACE INTO memory_vectors VALUES(?1,?2,?3,?4,?5,?6)",
            vec![
                room.into(),
                row.id.as_str().into(),
                model_id.into(),
                row.fingerprint.as_str().into(),
                (*offset as i64).into(),
                Sql::Blob(vectors::encode(&vector)),
            ],
        )?;
    }
    let next = start + batch.len();
    if next < parts.len() {
        sql.exec("INSERT INTO memory_vector_progress VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(room,id,model) DO UPDATE SET fingerprint=excluded.fingerprint,next_chunk=excluded.next_chunk",
            vec![room.into(),row.id.as_str().into(),model_id.into(),row.fingerprint.into(),(next as i64).into()])?;
    } else {
        sql.exec(
            "DELETE FROM memory_vector_progress WHERE room=?1 AND id=?2 AND model=?3",
            vec![room.into(), row.id.into(), model_id.into()],
        )?;
    }
    Ok(())
}

fn candidates(
    sql: &SqlStorage,
    room: &str,
    model: &str,
    query: &[f32],
    input: &Value,
    context: bool,
) -> Result<Vec<Value>> {
    let mut condition = format!(
        "d.room=? AND v.model=? AND v.fingerprint=d.fingerprint AND {}",
        vectors::VISIBLE
    );
    let mut bind = vec![room.into(), model.into()];
    if let Some(task) = input["taskId"].as_str().filter(|s| !s.is_empty()) {
        condition.push_str(" AND d.task_id=?");
        bind.push(task.into());
    }
    let chosen = input["kinds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    let kinds = if context {
        vec!["finding", "decision", "blocker", "handoff"]
    } else {
        chosen
    };
    if !kinds.is_empty() {
        condition.push_str(&format!(
            " AND d.kind IN ({})",
            vec!["?"; kinds.len()].join(",")
        ));
        bind.extend(kinds.into_iter().map(Sql::from));
    }
    let statement = format!(
        "SELECT d.id,d.seq,v.chunk,v.vector FROM memory_vectors v
        JOIN memory_docs d ON d.room=v.room AND d.id=v.id WHERE {condition}
        AND (v.id,v.chunk)>(?,?) ORDER BY v.id,v.chunk LIMIT 512"
    );
    let mut best = BTreeMap::<String, (f64, i64, usize)>::new();
    let (mut last, mut chunk) = (String::new(), -1_i64);
    let mut scanned = 0;
    loop {
        let mut bindings = bind.clone();
        bindings.extend([last.as_str().into(), chunk.into()]);
        let cursor = sql.exec(&statement, bindings)?;
        let mut added = 0;
        for row in cursor.raw() {
            let row = row?;
            let [
                Sql::String(id),
                Sql::Integer(seq),
                Sql::Integer(offset),
                Sql::Blob(bytes),
            ] = row.as_slice()
            else {
                return Err(err("Invalid vector row"));
            };
            last = id.clone();
            chunk = *offset;
            added += 1;
            if let Some(score) = vectors::score(bytes, query).filter(|score| *score >= 0.25) {
                let score = (score * 1000.0).round() / 1000.0;
                let existing = best
                    .entry(id.clone())
                    .or_insert((score, *seq, *offset as usize));
                if score > existing.0 {
                    *existing = (score, *seq, *offset as usize);
                }
            }
        }
        scanned += added;
        if added < 512 {
            break;
        }
    }
    let _ = note(sql, room, "vector_scan_vectors", scanned);
    let mut ranking = best.into_iter().collect::<Vec<_>>();
    ranking.sort_by(|(_, a), (_, b)| b.0.total_cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let mut results = Vec::new();
    let lookup=format!("SELECT d.data,d.title,d.text,d.task_id,d.seq,s.data AS lifecycle,o.data AS origin
        FROM memory_docs d LEFT JOIN memory_state s ON s.room=d.room AND s.id=d.id
        LEFT JOIN conversation_origins o ON o.room=d.room AND o.id=d.id WHERE d.room=?1 AND d.id=?2 AND {}",vectors::VISIBLE);
    for (id, (score, _, offset)) in ranking.into_iter().take(100) {
        if let Some(row) =
            query_one::<memory_page::Card>(sql, &lookup, vec![room.into(), id.into()])?
        {
            let (text, truncated) = vectors::excerpt(&row.text, offset);
            let mut value = memory_search::shape(row, "").map_err(err)?;
            memory_page::reference_freshness(&mut value);
            value["text"] = json!(text);
            value["truncated"] = json!(truncated);
            value["match"] = json!({"semantic":score,"offset":offset});
            results.push(value);
        }
    }
    Ok(results)
}

fn remaining(sql: &SqlStorage, room: &str, model: &str) -> Result<i64> {
    Ok(query_one::<Count>(sql,&format!("SELECT count(*) AS n FROM memory_docs d WHERE d.room=?1 AND {}
        AND (NOT EXISTS(SELECT 1 FROM memory_vectors v WHERE v.room=d.room AND v.id=d.id AND v.model=?2 AND v.fingerprint=d.fingerprint)
          OR EXISTS(SELECT 1 FROM memory_vector_progress p WHERE p.room=d.room AND p.id=d.id AND p.model=?2 AND p.fingerprint=d.fingerprint))",vectors::VISIBLE),
        vec![room.into(),model.into()])?.map_or(0,|row|row.n))
}

pub async fn augment(
    project: &crate::SpoolProject,
    sql: &SqlStorage,
    input: &StateRequest,
    frontier: &str,
    mut base: Response,
) -> Result<Response> {
    let command = input.input["command"].as_str().unwrap_or_default();
    let Some(query) = input.input["query"]
        .as_str()
        .filter(|q| !q.trim().is_empty())
    else {
        return Ok(base);
    };
    if base.status_code() != 200
        || !matches!(command, "search" | "context")
        || input.input["mode"] == "keyword"
        || input.input["includeArchived"] == true
    {
        return Ok(base);
    }
    let Ok(ai) = project.env.ai("AI") else {
        return Ok(base);
    };
    let model = project
        .env
        .var("EMBEDDING_MODEL")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "@cf/baai/bge-small-en-v1.5".to_owned());
    let model_id = format!("workers-ai:{model}:mean");
    schema(sql)?;
    let mut data: Value = base.json().await?;
    let room = &input.room;
    let key = format!("{model_id}\0{query}");
    let vector = if let Some(vector) = project.cache.get(&key) {
        let _ = note(sql, room, "query_cache_hits", 1);
        Some(vector)
    } else {
        let _ = note(sql, room, "query_cache_misses", 1);
        let texts = [query.to_owned()];
        if !reserve(sql, room, &texts)? {
            data["retrieval"]["semanticStatus"] = json!("budget_exceeded");
            return reply(200, data);
        }
        match embed(&ai, &model, &texts).await {
            Ok(mut vectors) => {
                let vector = vectors.pop();
                if let Some(vector) = &vector {
                    project.cache.remember(key, vector.clone());
                }
                vector
            }
            Err(_) => {
                let _ = note(sql, room, "embedding_failures", 1);
                data["retrieval"]["semanticStatus"] = json!("unavailable");
                return reply(200, data);
            }
        }
    };
    let Some(vector) = vector else {
        return reply(200, data);
    };
    if !project.indexing.get() && remaining(sql, room, &model_id)? > 0 {
        let sql = sql.clone();
        let room = room.clone();
        let model = model.clone();
        let id = model_id.clone();
        let pending = project.indexing.clone();
        pending.set(true);
        project.state.wait_until(async move {
            let _ = index_one(&ai, &model, &id, &sql, &room).await;
            pending.set(false);
        });
    }
    let memory = CloudMemory(sql.clone());
    let current = memory.frontier(room).map_err(|error| err(error.2))?;
    if current.heads != frontier {
        // A deletion or write may have changed the frontier while inference awaited.
        return crate::memory::read(sql, input, &current.heads);
    }
    let context = command == "context";
    let semantic = candidates(sql, room, &model_id, &vector, &input.input, context)?;
    let field = if context { "notes" } else { "results" };
    let mut params = input.input.clone();
    params["limit"] = json!(30);
    params["offset"] = json!(0);
    if context {
        params["kinds"] = json!(["finding", "decision", "blocker", "handoff"]);
    }
    let plan = memory_search::plan(room, &params).map_err(|error| err(error.1))?;
    let (lexical, _) = crate::memory::fetch_hits(sql, plan)?;
    let fused = vectors::fuse(lexical, semantic, query);
    let left = remaining(sql, room, &model_id)?;
    let offset = if context {
        0
    } else {
        input.input["offset"].as_u64().unwrap_or(0) as usize
    };
    let limit = if context {
        8
    } else {
        input.input["limit"].as_u64().unwrap_or(10) as usize
    };
    data[field] = json!(fused.iter().skip(offset).take(limit).collect::<Vec<_>>());
    if context {
        data["relatedConversations"] = json!([]);
    } else {
        data["nextOffset"] = json!((fused.len() > offset + limit).then_some(offset + limit));
    }
    data["retrieval"] = json!({"mode":"hybrid","semanticStatus":if left>0{"indexing"}else{"ready"},
      "remaining":left,"model":model_id,"candidateLimit":130,"index":"sqlite-exact-cosine"});
    reply(200, data)
}
