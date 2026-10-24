// Wrangler aliases node:sqlite here; Worker engines must inject DurableSqlite.
export class DatabaseSync {constructor(){throw new Error('Cloudflare requires Durable Object SQL storage');}}
