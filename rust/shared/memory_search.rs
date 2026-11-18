use crate::memory_page::Card;
use serde_json::{Value, json};

const STOP: &str = "a an and are as at be been but by can could do does for from had has have how i if in is it its me my no not of on or our please should so some that the their them there these they this to us was we were what when where which why will with would you your se je na do pro že jak proč co to ve v z s";

pub struct Search<'a> {
    pub query: &'a str,
    pub sql: String,
    pub params: Vec<Value>,
    pub limit: usize,
    pub offset: usize,
}

pub struct SearchError(pub &'static str, pub &'static str);

pub fn tokens(query: &str) -> Vec<&str> {
    let mut found = Vec::new();
    for token in query.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-') {
        let lower = token.to_lowercase();
        if token.is_empty()
            || found.contains(&token)
            || STOP.split_ascii_whitespace().any(|stop| stop == lower)
        {
            continue;
        }
        found.push(token);
        if found.len() == 16 {
            break;
        }
    }
    found
}

pub fn plan<'a>(room: &str, input: &'a Value) -> Result<Option<Search<'a>>, SearchError> {
    let page = |key, default, max| {
        if input[key].is_null() {
            Some(default)
        } else {
            input[key].as_u64().filter(|n| *n <= max)
        }
    };
    let limit = page("limit", 10, 30)
        .filter(|n| *n > 0)
        .ok_or(SearchError("INVALID_LIMIT", "Invalid search page"))?;
    let offset =
        page("offset", 0, 10_000).ok_or(SearchError("INVALID_LIMIT", "Invalid search page"))?;
    let query = if input["query"].is_null() {
        ""
    } else {
        input["query"]
            .as_str()
            .filter(|q| q.encode_utf16().count() <= 1000)
            .ok_or(SearchError(
                "INVALID_QUERY",
                "Search must be at most 1000 characters",
            ))?
    };
    let task = match &input["taskId"] {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        Value::String(s)
            if s.len() <= 160
                && s.as_bytes().split_first().is_some_and(|(first, rest)| {
                    first.is_ascii_alphanumeric()
                        && rest
                            .iter()
                            .all(|c| c.is_ascii_alphanumeric() || b"._/-".contains(c))
                }) =>
        {
            Some(s)
        }
        _ => return Err(SearchError("INVALID_TASK", "Use a short task identifier")),
    };
    let kinds = if input["kinds"].is_null() {
        &[]
    } else {
        input["kinds"]
            .as_array()
            .map(Vec::as_slice)
            .filter(|kinds| {
                kinds.len() <= 6
                    && kinds.iter().all(|k| {
                        matches!(
                            k.as_str(),
                            Some(
                                "task"
                                    | "finding"
                                    | "decision"
                                    | "blocker"
                                    | "handoff"
                                    | "conversation"
                            )
                        )
                    })
            })
            .ok_or(SearchError("INVALID_KIND", "Invalid memory kind"))?
    };
    let tokens = tokens(query);
    if !query.trim().is_empty() && tokens.is_empty() {
        return Ok(None);
    }
    let mut sql = String::from(
        "SELECT d.data,d.title,d.text,d.task_id,d.seq,s.data AS lifecycle,o.data AS origin
         FROM memory_docs d LEFT JOIN memory_state s ON s.room=d.room AND s.id=d.id
         LEFT JOIN conversation_origins o ON o.room=d.room AND o.id=d.id",
    );
    if !tokens.is_empty() {
        sql.push_str(" JOIN memory_fts ON memory_fts.room=d.room AND memory_fts.id=d.id");
    }
    sql.push_str(
        " WHERE d.room=? AND COALESCE(json_extract(d.data,'$.lifecycleControl'),0)<>1
          AND NOT EXISTS (SELECT 1 FROM memory_docs bg WHERE bg.room=d.room AND bg.kind='task'
              AND bg.task_id=d.task_id
              AND instr(bg.text,'Current request (source text, not verified findings):'||char(10)||
                'This is an app-generated request for a suggested next user message. The user did not write this message.')=1)",
    );
    let mut params = vec![json!(room)];
    if input["includeArchived"] != true {
        sql.push_str(
            " AND COALESCE(s.status,'active') NOT IN ('archived','resolved','superseded')
             AND (d.kind<>'task' OR (
                instr(d.text,'Current request (source text, not verified findings):'||char(10))<>1
                AND COALESCE(json_extract(d.data,'$.status'),'')<>'done'
                AND NOT EXISTS(SELECT 1 FROM memory_docs newer
                    WHERE newer.room=d.room AND newer.kind='task' AND newer.task_id=d.task_id
                    AND CAST(json_extract(newer.data,'$.revision') AS INTEGER)>CAST(json_extract(d.data,'$.revision') AS INTEGER)
                )))",
        );
        if task.is_none() {
            sql.push_str(" AND (d.kind<>'task' OR d.title<>'Codex project work' OR d.text<>'Session task created automatically. Agent-authored progress, findings and continuation details are pending.')");
        }
    }
    if let Some(task) = task {
        sql.push_str(" AND d.task_id=?");
        params.push(json!(task));
    }
    if !kinds.is_empty() {
        sql.push_str(" AND d.kind IN (");
        sql.push_str(&vec!["?"; kinds.len()].join(","));
        sql.push(')');
        params.extend_from_slice(kinds);
    }
    if !tokens.is_empty() {
        sql.push_str(" AND memory_fts MATCH ?");
        params.push(json!(
            tokens
                .iter()
                .map(|t| format!("\"{t}\""))
                .collect::<Vec<_>>()
                .join(" OR ")
        ));
    }
    sql.push_str(if tokens.is_empty() {
        " ORDER BY "
    } else {
        " ORDER BY bm25(memory_fts,0,0,3,1),"
    });
    sql.push_str("d.seq DESC LIMIT ? OFFSET ?");
    params.extend([json!(limit + 1), json!(offset)]);
    Ok(Some(Search {
        query,
        sql,
        params,
        limit: limit as usize,
        offset: offset as usize,
    }))
}

pub fn shape(card: Card, query: &str) -> serde_json::Result<Value> {
    let mut utf16 = card.text.encode_utf16().collect::<Vec<_>>();
    let truncated = utf16.len() > 1400;
    let offset = if truncated {
        let lower = card.text.to_lowercase();
        let at = tokens(query)
            .iter()
            .find_map(|token| lower.find(&token.to_lowercase()))
            .map_or(150, |at| lower[..at].encode_utf16().count());
        (at.saturating_sub(150)).min(utf16.len() - 1400)
    } else {
        0
    };
    utf16.truncate(offset + 1400);
    let mut value = crate::memory_page::format_card(card)?;
    value["truncated"] = json!(truncated);
    value["text"] = json!(String::from_utf16_lossy(&utf16[offset..]));
    Ok(value)
}

pub fn retrieval(input: &Value) -> Result<Option<Value>, SearchError> {
    if input["query"].as_str().is_none_or(|q| q.trim().is_empty()) {
        return Ok(None);
    }
    if let Some(mode) = input.get("mode")
        && !matches!(mode.as_str(), Some("hybrid" | "keyword"))
    {
        return Err(SearchError(
            "INVALID_QUERY",
            "Choose hybrid or keyword retrieval",
        ));
    }
    Ok(Some(
        if input["mode"] == "keyword" || input["includeArchived"] == true {
            json!({"mode":"keyword","semanticStatus":"not_requested"})
        } else {
            json!({"mode":"keyword","semanticStatus":"disabled","index":"sqlite-exact-cosine"})
        },
    ))
}
