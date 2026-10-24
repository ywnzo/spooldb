import { LegacyEngine } from './legacy-engine.js';
import { ShardedEngine } from './sharded-engine.js';
export { content, validatePath } from './legacy-engine.js';
export { ShardedEngine };

// Format migration remains explicit; existing callers retain legacy storage.
export class Engine extends LegacyEngine {
  constructor(filename = ':memory:', options = {}) {
    if (options.layout === 'sharded') return new ShardedEngine(filename, options);
    if (options.layout && options.layout !== 'legacy') throw new Error('Unknown storage layout');
    super(filename, options);
  }
}
