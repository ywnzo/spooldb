import type { ShardedEngine } from '../index.js';
export interface Credential { id: string; tokenHash: string; rooms: Record<string,'read'|'write'> }
export function hashToken(token: string): string;
export function createCredential(id: string, rooms: Credential['rooms']): { token: string; credential: Credential };
export class RelayError extends Error { code: string; status: number; constructor(code: string,message: string,status?: number) }
export class RelayServer {
  constructor(filename: string,options?: { credentials?: Credential[]; maxPageBytes?: number; maxConnections?: number; maxActiveRequests?: number });
  engine: ShardedEngine;
  setCredentials(credentials: Credential[]): void;
  listen(options?: { host?: string; port?: number }): Promise<string>;
  backup(filename: string): { path: string; heads: Array<{ branch: string; room: string; heads: string[] }> };
  close(): Promise<void>;
}
export interface SyncResult {
  requests: number; retries: number; uploadedBytes: number; downloadedBytes: number; pushPages: number; pullPages: number; resets: number;
  room: string; heads: string[]; durability: 'relay-sqlite'; mode: 'both'|'pull'|'push';
}
export class SyncClient {
  constructor(engine: ShardedEngine,options: { url: string; token: string; room: string; branch?: string; timeoutMs?: number; retries?: number; maxPages?: number; allowInsecureHttp?: boolean });
  cursor(): { push: string[]; pull: string[] };
  reset(): void;
  publishBranch(name: string,options?: { expectedRevision?: number; requestId?: string; signal?: AbortSignal }): Promise<{branch: {name: string; heads: string[]; revision: number; updatedBy: string; updatedAt: string}; sync: SyncResult}>;
  sync(options?: { mode?: 'both'|'pull'|'push'; signal?: AbortSignal }): Promise<SyncResult>;
  watch(options?: { intervalMs?: number; mode?: 'both'|'pull'|'push'; signal?: AbortSignal; onSync?: (result: SyncResult)=>void; onError?: (error: Error)=>void }): Promise<void>;
}
