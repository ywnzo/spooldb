import type { AdapterEvent } from './adapters/index.js';
export interface Version { branch: string; room: string; heads: string[] }
export interface Content { kind?: 'text' | 'binary' | 'symlink'; text?: string; data?: string; target?: string; mode?: 420 | 493 }
export interface FileRecord extends Content { fileId: string; path: string; text: string; deleted: boolean; createdBy: string }
export interface Message { role: 'user' | 'assistant' | 'tool' | 'system'; text: string; eventId: string }
export interface Anchor { room?: string; heads?: string[]; fileId: string; start: string; end: string }
export interface State {
  room: string; heads: string[]; files: FileRecord[]; messages: Record<string, Message>;
  comments: Record<string, Anchor & { text: string; eventId: string }>;
  adapterEvents: Record<string, AdapterEvent>; conflicts: Array<Record<string, unknown>>;
}
export type Operation =
  | ({ type: 'file.create'; fileId: string; path: string } & Content)
  | ({ type: 'file.write'; fileId: string } & Content)
  | { type: 'file.splice'; fileId: string; index: number; deleteCount: number; insert: string }
  | { type: 'file.rename'; fileId: string; path: string }
  | { type: 'file.delete' | 'file.restore'; fileId: string }
  | { type: 'message.add'; messageId: string; role: Message['role']; text: string }
  | { type: 'comment.add'; commentId: string; fileId: string; start: number; end: number; text: string }
  | { type: 'adapter.record'; event: AdapterEvent };
export interface Submission {
  actor: string; requestId: string; expectedHeads: string[]; operations: Operation[];
  harness?: string; sessionId?: string; turnId?: string; messageId?: string; toolCallId?: string;
  evidence?: string; gitCommit?: string; observedAfter?: string; sourceEventId?: string;
}
export interface LegacyBundle { protocol: 'spool/1'; schema: 1; room: string; heads: string[]; changes: string[] }
export interface ShardedBundle {
  protocol: 'spool/2'; schema: 2; room: string; heads: string[];
  batches: Array<Record<string, unknown>>; nodes: Array<{ hash: string; node: unknown }>;
  documents: Array<{ key: string; changes: string[] }>;
}
export type Bundle = LegacyBundle | ShardedBundle;
export interface StorageOptions { layout?: 'legacy' | 'sharded'; checkpointEvery?: number; checkpointKeep?: number; cacheBytes?: number; cacheEntries?: number }
export interface HistoryEntry { cursor: number; changeId: string; parents: string[]; provenance: Record<string, unknown> | null }
export class Engine {
  constructor(filename?: string, options?: StorageOptions);
  layout: 'legacy' | 'sharded';
  filename: string | null;
  /** Internal SQLite connection; use public engine/adapter operations for mutations. */
  db: unknown;
  close(): void;
  transaction<T>(fn: () => T): T;
  create(branch?: string, options?: { room?: string }): Version;
  ref(branch: string): { name: string; room: string; heads: string[] };
  refs(): Version[];
  read(branch: string, heads?: string[]): State;
  readFile(branch: string, fileId: string, heads?: string[]): { room: string; heads: string[]; file: FileRecord; conflicts: State['conflicts'] };
  submit(branch: string, input: Submission): Version & { eventId: string };
  fork(source: string, target: string, heads?: string[]): Version;
  merge(target: string, source: string): Version;
  history(branch: string, options?: { after?: number; limit?: number }): HistoryEntry[];
  trace(branch: string, fileId: string): Array<{ changeId: string; parents: string[]; provenance: Record<string, unknown>; messages: Array<Message & { messageId: string }> }>;
  anchor(branch: string, fileId: string, start: number, end: number): Anchor;
  resolve(branch: string, anchor: Anchor, heads?: string[]): { fileId: string; path: string; deleted: boolean; start: number; end: number; text: string };
  export(branch: string, since?: string[]): Bundle;
  import(branch: string, bundle: Bundle): Version;
}
export interface StorageStats {
  layout: 'sharded'; cacheHits: number; documentLoads: number; checkpointLoads: number; replayedChanges: number; corruptCheckpoints: number;
  activeDocumentHandles: number;
  cacheEntries: number; cacheWeightBytes: number; cacheWeightLimit: number; cacheEntryLimit: number;
  documents: number; changes: number; checkpoints: number; manifestNodes: number; batches: number;
}
export class ShardedEngine extends Engine {
  layout: 'sharded';
  listFiles(branch: string, options?: { after?: string; limit?: number; includeDeleted?: boolean }): {
    room: string; heads: string[]; files: Array<{ fileId: string; path: string; deleted: boolean }>; nextCursor: string | null;
  };
  readRecords(branch: string, options?: { kind?: 'messages' | 'comments' | 'adapterEvents'; after?: string; limit?: number; byteLimit?: number }): {
    room: string; heads: string[]; records: Array<{ id: string; value: unknown }>; bytes: number; nextCursor: string | null;
  };
  checkpoint(branch: string, options?: { fileId?: string }): { documents: number; bytes: number; heads: string[] };
  compact(options?: { vacuum?: boolean }): { removedNodes: number; encodedRows: number; removedCheckpoints: number; vacuum: boolean; walBusy: boolean };
  export(branch: string,since?: string[],options?: { heads?: string[] }): ShardedBundle;
  exportPage(branch: string,since?: string[],options?: { heads?: string[]; limit?: number; maxBytes?: number }): { bundle: ShardedBundle|null; heads: string[]; more: boolean; bytes: number };
  clearCache(): void;
  storageStats(options?: { resetMetrics?: boolean }): StorageStats;
}
export function validatePath(path: string): string;
export function content(value: Content): Required<Content>;
