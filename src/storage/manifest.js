import { digest } from '../adapters/contract.js';
import { pack, unpack } from './codec.js';

// Content-addressed radix tree. Four hexadecimal levels give 65536 leaf buckets.
// Updating one document copies a bounded tree path, not the whole worktree map.
export class Manifest {
  constructor(db) {
    this.db = db; this.cache = new Map(); this.queries = new Map(); this.layers = [];
    db.exec('CREATE TABLE IF NOT EXISTS shard_nodes(hash TEXT PRIMARY KEY,body TEXT NOT NULL)');
  }
  prepare(sql) { if (!this.queries.has(sql)) this.queries.set(sql, this.db.prepare(sql)); return this.queries.get(sql); }
  node(hash) {
    if (!hash) return null;
    for (const layer of [...this.layers].reverse()) if (layer.nodes.has(hash)) return layer.nodes.get(hash);
    if (this.cache.has(hash)) return this.cache.get(hash);
    const row = this.prepare('SELECT body FROM shard_nodes WHERE hash=?').get(hash);
    if (!row) throw new Error('Missing manifest node');
    const node = unpack(row.body);
    if (digest(node) !== hash) throw new Error('Corrupt manifest node');
    this.remember(hash, node); return node;
  }
  remember(hash, node) {
    this.cache.set(hash, node);
    if (this.cache.size > 2048) this.cache.delete(this.cache.keys().next().value);
  }
  put(node) {
    const hash = digest(node);
    const copy = JSON.parse(JSON.stringify(node));
    if (this.layers.length) this.layers.at(-1).nodes.set(hash, copy);
    else { this.prepare('INSERT OR IGNORE INTO shard_nodes VALUES(?,?)').run(hash, pack(copy)); this.remember(hash, copy); }
    return hash;
  }
  begin() { this.layers.push({ nodes: new Map(), roots: new Set() }); }
  retain(root) { if (root && this.layers.length) this.layers.at(-1).roots.add(root); }
  rollback() { this.layers.pop(); this.cache.clear(); }
  flush() {
    const layer = this.layers.at(-1);
    if (this.layers.length > 1) return;
    const visited = new Set(); const stack = [...layer.roots];
    while (stack.length) {
      const hash = stack.pop(); if (!hash || visited.has(hash)) continue;
      visited.add(hash); const node = layer.nodes.get(hash);
      // An existing immutable node cannot reference a newly staged child.
      if (!node) continue;
      this.prepare('INSERT OR IGNORE INTO shard_nodes VALUES(?,?)').run(hash, pack(node));
      if (node.children) stack.push(...node.children);
    }
  }
  commit() {
    const layer = this.layers.pop(); const parent = this.layers.at(-1);
    if (parent) { for (const [hash,node] of layer.nodes) parent.nodes.set(hash,node); for (const root of layer.roots) parent.roots.add(root); }
  }
  discardIntermediate(root) {
    const layer = this.layers.at(-1); if (!layer || layer.nodes.size < 10000) return;
    const live = new Set(); const stack = [root, ...layer.roots];
    while (stack.length) {
      const hash = stack.pop(); if (!hash || live.has(hash)) continue;
      const node = layer.nodes.get(hash); if (!node) continue;
      live.add(hash); if (node.children) stack.push(...node.children);
    }
    for (const hash of layer.nodes.keys()) if (!live.has(hash)) layer.nodes.delete(hash);
  }
  get(root, key) {
    const route = digest(key); let node = this.node(root);
    for (let depth = 0; node && depth < 4; depth++) node = this.node(node.children[parseInt(route[depth], 16)]);
    return node?.entries.find(([name]) => name === key)?.[1];
  }
  set(root, key, value) {
    const route = digest(key);
    const update = (hash, depth) => {
      const node = this.node(hash);
      if (depth === 4) {
        const entries = (node?.entries ?? []).filter(([name]) => name !== key);
        if (value !== null) entries.push([key, value]);
        entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        return entries.length ? this.put({ entries }) : null;
      }
      const children = [...(node?.children ?? Array(16).fill(null))];
      const at = parseInt(route[depth], 16); children[at] = update(children[at], depth + 1);
      return children.some(Boolean) ? this.put({ children }) : null;
    };
    if (JSON.stringify(this.get(root, key)) === JSON.stringify(value ?? undefined)) return root;
    return update(root, 0);
  }
  *entries(root) {
    const node = this.node(root); if (!node) return;
    if (node.entries) { yield* node.entries; return; }
    for (const child of node.children) if (child) yield* this.entries(child);
  }
  hashes(root, found = new Set()) {
    if (!root || found.has(root)) return found;
    found.add(root); const node = this.node(root);
    if (node.children) for (const child of node.children) this.hashes(child, found);
    return found;
  }
}
