import { createHash } from 'node:crypto';
import conforms from './event-validator.js';

export const PROTOCOL = 'spool-adapter/1';
export const KINDS = ['session.started', 'turn.started', 'message', 'tool.started', 'tool.completed', 'turn.completed', 'turn.failed', 'notice', 'run.closed'];
export function ensure(ok, message) { if (!ok) throw new Error(message); }
export function string(value, label, max = 200) {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= max, `Invalid ${label}`); return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function validateEvent(event) {
  ensure(conforms(event), 'Adapter event violates spool-adapter/1 schema');
  ensure(Number.isSafeInteger(event.sequence) && event.sequence >= 0 && Number.isSafeInteger(event.part) && event.part >= 0, 'Invalid event sequence');
  ensure(JSON.stringify(event).length <= 1_000_000, 'Adapter event exceeds 1 MB');
  return event;
}

// Only explicitly selected public event fields survive normalization. No thinking,
// credential fields, transcript paths, or arbitrary unknown payloads are retained.
export function normalize(harness, raw, state) {
  ensure(raw && typeof raw === 'object' && !Array.isArray(raw), 'Expected native event object');
  string(raw.type, 'native event type');
  const next = structuredClone(state); const output = [];
  const emit = (kind, payload = {}) => output.push({ kind, payload });
  const notice = reason => emit('notice', { reason });
  const session = nativeId => {
    string(nativeId, 'native session ID');
    ensure(!next.sessionId || next.sessionId === nativeId, 'Native session changed within stream');
    next.sessionId = nativeId;
  };
  const beginTurn = () => {
    ensure(next.sessionId, 'Session must start before a turn');
    next.turnCounter = (next.turnCounter ?? 0) + 1;
    next.assistantSeen = false;
    next.turnId = `${next.streamId}-turn-${next.turnCounter}`;
    next.status = 'running'; emit('turn.started');
  };
  if (harness === 'codex') {
    if (raw.type === 'thread.started') { session(raw.thread_id); next.status = 'running'; emit('session.started'); }
    else if (raw.type === 'turn.started') beginTurn();
    else if (raw.type === 'turn.completed' || raw.type === 'turn.failed' || raw.type === 'error') {
      next.status = raw.type === 'turn.completed' ? 'completed' : 'failed';
      emit(next.status === 'completed' ? 'turn.completed' : 'turn.failed', { ...(raw.error?.message || raw.message ? { text: raw.error?.message ?? raw.message } : {}) });
    } else if (['item.started', 'item.updated', 'item.completed'].includes(raw.type)) {
      const item = raw.item; ensure(item && typeof item === 'object', 'Missing Codex item');
      if (item.type === 'reasoning') notice('reasoning-omitted');
      else if (item.type === 'agent_message') {
        if (raw.type === 'item.completed') emit('message', { role: 'assistant', text: item.text ?? '', nativeId: string(item.id, 'item ID') });
        else notice('partial-message-omitted');
      } else if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item.type)) {
        if (raw.type === 'item.updated') notice('intermediate-tool-update-omitted');
        else {
          const payload = { toolCallId: string(item.id, 'tool call ID'), name: item.type, status: item.status ?? 'unknown' };
          if (item.command !== undefined) payload.input = item.command;
          if (item.aggregated_output !== undefined) payload.output = item.aggregated_output;
          if (item.tool !== undefined) payload.tool = item.tool;
          if (item.server !== undefined) payload.server = item.server;
          if (item.type === 'file_change') payload.paths = (item.changes ?? []).map(c => string(c.path, 'native file path', 4096));
          emit(raw.type === 'item.started' ? 'tool.started' : 'tool.completed', payload);
        }
      } else notice('unsupported-item');
    } else notice('unsupported-event');
  } else if (harness === 'claude') {
    if (raw.session_id) session(raw.session_id);
    if (raw.type === 'system' && raw.subtype === 'init') { next.status = 'running'; emit('session.started'); beginTurn(); }
    else if (raw.parent_tool_use_id) notice('subagent-event-omitted');
    else if (raw.type === 'assistant' || raw.type === 'user') {
      ensure(Array.isArray(raw.message?.content), 'Missing Claude message content');
      for (const [index, block] of raw.message.content.entries()) {
        if (block.type === 'text') emit('message', { role: raw.type === 'user' ? 'user' : 'assistant', text: block.text,
          nativeId: `${raw.message.id ?? raw.uuid ?? 'message'}-${index}` });
        else if (block.type === 'tool_use') emit('tool.started', { toolCallId: block.id, name: block.name, input: JSON.stringify(block.input ?? {}) });
        else if (block.type === 'tool_result') {
          const outputText = typeof block.content === 'string' ? block.content : (block.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          emit('tool.completed', { toolCallId: block.tool_use_id, name: 'tool_result', status: block.is_error ? 'failed' : 'completed', output: outputText });
        } else notice(block.type === 'thinking' || block.type === 'redacted_thinking' ? 'reasoning-omitted' : 'unsupported-content');
      }
    } else if (raw.type === 'result') {
      next.status = raw.is_error || raw.subtype !== 'success' ? 'failed' : 'completed';
      // result text repeats assistant content in normal streams. Use it only as a fallback.
      if (!next.assistantSeen && typeof raw.result === 'string') emit('message', { role: 'assistant', text: raw.result, nativeId: raw.uuid ?? 'result' });
      emit(next.status === 'completed' ? 'turn.completed' : 'turn.failed', { status: raw.subtype ?? 'unknown' });
    } else notice(raw.type === 'stream_event' ? 'partial-event-omitted' : 'unsupported-event');
  } else throw new Error('Unsupported harness');
  if (!output.length) notice('empty-event');
  ensure(next.sessionId || output.every(e => e.kind === 'notice' || e.kind === 'turn.failed'), 'Native session has not started');
  for (const event of output) if (event.kind === 'message' && event.payload.role === 'assistant') next.assistantSeen = true;
  return { state: next, events: output };
}
