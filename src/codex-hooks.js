#!/usr/bin/env bun
import {mkdirSync, realpathSync, renameSync, writeFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
export const isGuidanceEvent = event => ['SessionStart', 'UserPromptSubmit'].includes(event);

export async function runHook({directory, root, event, input}) {
  if (!isGuidanceEvent(event)) return {};
  const sessionId = input.session_id;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return {};
  const project = realpathSync(root);
  const pathFromRoot = relative(project, realpathSync(input.cwd));
  if (pathFromRoot === '..' || pathFromRoot.startsWith('../') || pathFromRoot.startsWith('/')) return {};

  const ignored = event === 'UserPromptSubmit' && /^This is an app-generated request for a suggested next user message\. The user did not write this message\./.test(input.prompt ?? '');
  const now = new Date().toISOString();
  const sessionHash = hash(sessionId);
  const folder = join(directory, 'lifecycle');
  const path = join(folder, sessionHash + '-' + hash(project).slice(0, 16) + '.json');
  const state = {sessionId, root: project, ignored, guidanceSent: !ignored, startedAt: now};
  if (event === 'UserPromptSubmit' && !ignored) state.lastPromptAt = now;
  try {
    mkdirSync(folder, {recursive: true, mode: 0o700});
    const temp = path + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, JSON.stringify(state), {mode: 0o600});
    renameSync(temp, path);
  } catch {
    // Local bookkeeping is optional. The hint can still be delivered.
  }

  if (ignored) return {};
  const additionalContext = 'SpoolDB is optional. If prior project memory would help, consider project_context or memory_search with the current Git root. You can continue directly if it is irrelevant or unavailable. If you choose to save durable findings or a handoff, follow the project sharing settings. Connecting a repository requires explicit user approval. Task for this Codex session: codex-' + sessionHash.slice(0, 24) + '.';
  return {hookSpecificOutput: {hookEventName: event, additionalContext}};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, , root, event] = process.argv.slice(2);
  try {
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 1000000) throw new Error('Hook input too large');
    }
    console.log(JSON.stringify(await runHook({directory, root, event, input: JSON.parse(text)})));
  } catch {
    console.log('{}');
  }
}
