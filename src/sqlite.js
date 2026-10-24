// Use each runtime's native driver. Bun's Node compatibility layer caches reopened
// database paths differently, which is unsafe for atomic restore/rename workflows.
export const DatabaseSync=process.versions.bun?(await import('./bun-sqlite.js')).BunSqlite:(await import('node:sqlite')).DatabaseSync;
