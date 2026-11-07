#!/usr/bin/env bun
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {repositoryAt} from './repository.js';
import {isGuidanceEvent, runHook} from './codex-hooks.js';

export async function runDiscoveryHook({directory, event, input}) {
  if (!isGuidanceEvent(event)) return {};
  const repo = repositoryAt(input.cwd);

  // Respect a prior skip using local state, without contacting the companion.
  try {
    const {entries} = JSON.parse(readFileSync(join(directory, 'discovery.json'), 'utf8'));
    if (entries.some(entry => entry.status === 'ignored' && entry.root === repo.root && entry.repositoryKey === repo.repositoryKey)) return {};
  } catch {}
  try {
    if (readFileSync(join(repo.root, '.codex/config.toml'), 'utf8').includes('# BEGIN SPOOL MANAGED')) return {};
  } catch {}

  return runHook({directory, root: repo.root, event, input});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let text = '';
  try {
    for await (const chunk of process.stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 1000000) throw new Error('Hook input too large');
    }
    const [directory, event] = process.argv.slice(2);
    console.log(JSON.stringify(await runDiscoveryHook({directory, event, input: JSON.parse(text)})));
  } catch {
    console.log('{}');
  }
}
