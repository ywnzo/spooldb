use crate::{Result, StateRequest, fault, internal_json, memory_page, query_one, reply};
use crate::{memory_context, memory_search};
use serde::Deserialize;
use serde_json::{Value, json};
use worker::{Response, SqlStorage};

#[derive(Deserialize)]
struct Index {
    heads: String,
}

pub fn read(sql: &SqlStorage, request: &StateRequest, frontier: &str) -> Result<Response> {
    let input = &request.input;
    let room = request.room.as_str();
    let index: Option<Index> = query_one(
        sql,
        "SELECT heads FROM memory_index WHERE room=?1",
        vec![room.into()],
    )?;
    if index.is_none_or(|index| index.heads != format!("retrieval-v3:{frontier}")) {
        return fault(
            409,
            "STALE_MEMORY_INDEX",
            "Refresh the memory index before reading",
        );
    }
    if input["command"] == "search" {
        return search(sql, request, frontier);
    }
    if input["command"] == "context" {
        return context(sql, request, frontier);
    }
    if input["command"] != "get" {
        return fault(400, "INVALID_MEMORY", "Unsupported memory command");
    }
    let Some(id) = input["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.encode_utf16().count() <= 200)
    else {
        return fault(400, "INVALID_MEMORY", "Invalid memory identity");
    };
    let card: Option<memory_page::Card> = query_one(
        sql,
        "SELECT d.data,d.title,d.text,d.task_id,d.seq,s.data AS lifecycle,o.data AS origin
         FROM memory_docs d LEFT JOIN memory_state s ON s.room=d.room AND s.id=d.id
         LEFT JOIN conversation_origins o ON o.room=d.room AND o.id=d.id
         WHERE d.room=?1 AND d.id=?2",
        vec![room.into(), id.into()],
    )?;
    let Some(card) = card else {
        return fault(404, "MEMORY_NOT_FOUND", "Memory is not in this project");
    };
    let Some((offset, limit)) = memory_page::page_parameters(input) else {
        return fault(400, "INVALID_LIMIT", "Invalid text page");
    };
    let mut value = memory_page::format_page(card, offset, limit).map_err(internal_json)?;
    value["heads"] = serde_json::from_str(frontier).map_err(internal_json)?;
    value["room"] = json!(room);
    value["sourcePrefix"] = json!(format!("@machines/{}/", request.principal.id));
    memory_page::reference_freshness(&mut value);
    reply(200, value)
}

fn search(sql: &SqlStorage, request: &StateRequest, frontier: &str) -> Result<Response> {
    let input = &request.input;
    let retrieval = match memory_search::retrieval(input) {
        Ok(value) => value,
        Err(error) => return fault(400, error.0, error.1),
    };
    let plan = match memory_search::plan(&request.room, input) {
        Ok(plan) => plan,
        Err(error) => return fault(400, error.0, error.1),
    };
    let (results, next) = fetch_hits(sql, plan)?;
    let heads: serde_json::Value = serde_json::from_str(frontier).map_err(internal_json)?;
    let mut response = json!({"results":results,"nextOffset":next,"heads":heads,
        "room":request.room,"sourcePrefix":format!("@machines/{}/",request.principal.id)});
    if let Some(retrieval) = retrieval {
        response["retrieval"] = retrieval;
    }
    reply(200, response)
}

pub(super) fn fetch_hits(
    sql: &SqlStorage,
    plan: Option<memory_search::Search<'_>>,
) -> Result<(Vec<Value>, Option<usize>)> {
    let Some(plan) = plan else {
        return Ok((Vec::new(), None));
    };
    let mut results = Vec::new();
    let mut next = None;
    let values = plan
        .params
        .into_iter()
        .map(|value| {
            if let Some(string) = value.as_str() {
                worker::SqlStorageValue::from(string)
            } else {
                worker::SqlStorageValue::from(value.as_i64().expect("numeric search parameter"))
            }
        })
        .collect::<Vec<_>>();
    let cursor = sql.exec(&plan.sql, values)?;
    for row in cursor.next::<memory_page::Card>() {
        if results.len() == plan.limit {
            next = Some(plan.offset + plan.limit);
            break;
        }
        let mut value = memory_search::shape(row?, plan.query).map_err(internal_json)?;
        memory_page::reference_freshness(&mut value);
        results.push(value);
    }
    Ok((results, next))
}

fn context(sql: &SqlStorage, request: &StateRequest, frontier: &str) -> Result<Response> {
    let input = &request.input;
    let retrieval = match memory_search::retrieval(input) {
        Ok(value) => value,
        Err(error) => return fault(400, error.0, error.1),
    };
    let notes = memory_context::notes_input(input);
    let notes_plan = match memory_search::plan(&request.room, &notes) {
        Ok(plan) => plan,
        Err(error) => return fault(400, error.0, error.1),
    };
    let conversations = memory_context::conversations_input(input);
    let conversation_plan = if input["query"].as_str().is_some_and(|q| !q.is_empty()) {
        match memory_search::plan(&request.room, &conversations) {
            Ok(plan) => plan,
            Err(error) => return fault(400, error.0, error.1),
        }
    } else {
        None
    };
    let (notes, _) = fetch_hits(sql, notes_plan)?;
    let (conversations, _) = fetch_hits(sql, conversation_plan)?;
    let bound = || vec![request.room.as_str().into()];
    let cursor = sql.exec(memory_context::TASKS_SQL, bound())?;
    let mut tasks = Vec::new();
    for row in cursor.next::<memory_page::Card>() {
        let mut card = memory_search::shape(row?, "").map_err(internal_json)?;
        memory_page::reference_freshness(&mut card);
        tasks.push(card);
    }
    let tasks = memory_context::task_cards(tasks, input);
    #[derive(Deserialize)]
    struct Change {
        data: String,
    }
    let cursor = sql.exec(memory_context::CHANGES_SQL, bound())?;
    let mut changes: Vec<Value> = Vec::new();
    for row in cursor.next::<Change>() {
        changes.push(serde_json::from_str(&row?.data).map_err(internal_json)?);
    }
    let heads: Value = serde_json::from_str(frontier).map_err(internal_json)?;
    let mut result = json!({"tasks":tasks,"notes":notes,"relatedConversations":conversations,
        "recentChanges":changes,"heads":heads,"room":request.room,
        "sourcePrefix":format!("@machines/{}/",request.principal.id)});
    if let Some(retrieval) = retrieval {
        result["retrieval"] = retrieval;
    }
    memory_context::enrich(&mut result, true);
    reply(200, result)
}
