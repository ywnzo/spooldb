export type Harness = 'codex' | 'claude';
export type EventKind = 'session.started' | 'turn.started' | 'message' | 'tool.started' | 'tool.completed' | 'turn.completed' | 'turn.failed' | 'notice' | 'run.closed';
export interface AdapterEvent {
  protocol: 'spool-adapter/1';
  /** Open namespace; bundled native launchers currently support Harness. */
  harness: string;
  eventId: string;
  streamId: string;
  /** Position in this native stream, never distributed causal time. */
  sequence: number;
  /** Index of a normalized event when one native record contains several blocks. */
  part: number;
  sessionId: string;
  sessionIdSource: 'native' | 'adapter';
  /** Adapter-local turn ID. Not asserted to be a native harness turn UUID. */
  turnId?: string;
  kind: EventKind;
  sourceType: string;
  evidence: 'native-event' | 'adapter-process';
  payload: {
    role?: 'user' | 'assistant'; text?: string; nativeId?: string;
    toolCallId?: string; name?: string; status?: string;
    input?: string; output?: string; paths?: string[]; tool?: string; server?: string;
    reason?: string; exitCode?: number | null; signal?: string | null;
  };
}
/** Minimal structural interface; the supplied instance owns its SQLite connection. */
export interface EngineHost {
  db: unknown;
  filename: string | null;
  ref(branch: string): { heads: string[]; room: string };
  transaction<T>(callback: () => T): T;
}
export interface StreamState {
  streamId: string; branch: string; harness: Harness; nextSequence: number;
  sessionId?: string; promptId: string | null; turnId?: string;
  status: 'opened' | 'running' | 'completed' | 'failed' | 'incomplete'; closed?: boolean;
}
export interface RecordResult { branch: string; room: string; heads: string[]; eventId: string; events: AdapterEvent[] }
export class AdapterIngress {
  constructor(engine: EngineHost);
  open(options: { branch: string; harness: Harness; streamId?: string; prompt?: string }): StreamState;
  get(streamId: string): StreamState;
  list(): StreamState[];
  ingest(streamId: string, sequence: number, nativeEvent: unknown): RecordResult;
  close(streamId: string, result?: { exitCode?: number | null; signal?: string | null; reason?: string }): StreamState;
}
export interface RunResult {
  streamId: string; status: StreamState['status']; exitCode: number | null; signal: string | null;
  events: number; stderrBytes: number; reason?: string;
}
export function runHarness(engine: EngineHost, options: {
  harness: Harness; root: string; branch?: string; prompt: string; write?: boolean;
  timeoutMs?: number; streamId?: string; signal?: AbortSignal;
  /** Trusted caller override, primarily for protocol tests. Never sourced from native events. */
  command?: { executable: string; args: string[] };
  onRecord?: (record: { event: string; streamId: string; events?: AdapterEvent[]; result?: unknown }) => void;
}): Promise<RunResult>;
export function commandFor(harness: Harness, root: string, write?: boolean): { executable: string; args: string[] };
export function validateEvent(event: unknown): AdapterEvent;
export const PROTOCOL: 'spool-adapter/1';
