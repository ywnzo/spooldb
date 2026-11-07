// Hook-only entry point. Its local import graph is pinned by the stable dispatcher.
import {pluginState} from './state.js';
import {runDiscoveryHook} from '../discovery-hook.js';

process.umask(0o077);
try {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 1000000) throw new Error('Hook input too large');
  }
  console.log(JSON.stringify(await runDiscoveryHook({
    directory: pluginState(), event: process.argv[2], input: JSON.parse(text),
  })));
} catch {
  console.log('{}');
}
