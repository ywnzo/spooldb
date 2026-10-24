import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { AdapterIngress } from './ingress.js';
import { Bridge } from '../bridge.js';
import { ensure } from './contract.js';

export function commandFor(harness, root, write = false) {
  if (harness === 'codex') return { executable: 'codex', args: ['exec', '--json', '--color', 'never', '--sandbox',
    write ? 'workspace-write' : 'read-only', '--ephemeral', '--skip-git-repo-check', '-C', root, '-'] };
  if (harness === 'claude') return { executable: 'claude', args: ['-p', '--output-format', 'stream-json', '--verbose',
    ...(write ? [] : ['--tools', 'Read,Glob,Grep', '--disallowedTools', 'mcp__*'])] };
  throw new Error('Unsupported harness');
}

/** Starts a user-selected native CLI. It never executes text received in events. */
export async function runHarness(engine, { harness, root, branch = 'main', prompt, write = false,
  timeoutMs = 120000, streamId, command, onRecord = () => {}, signal } = {}) {
  ensure(typeof prompt === 'string' && prompt.length > 0 && prompt.length <= 1_000_000, 'Prompt must contain 1–1000000 characters');
  ensure(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 3600000, 'Invalid harness timeout');
  ensure(!signal?.aborted, 'Run cancelled before launch');
  root = realpathSync(root);
  const launch = command ?? commandFor(harness, root, write);
  ensure(typeof launch.executable === 'string' && Array.isArray(launch.args) && launch.args.every(a => typeof a === 'string'), 'Invalid native command');
  const bridge = new Bridge(engine); const ingress = new AdapterIngress(engine);
  const source = bridge.sources().find(s => s.root === root);
  if (!source) bridge.attach(branch, root);
  else ensure(source.branch === branch, 'Source checkout is attached to another branch');
  const stream = ingress.open({ branch, harness, streamId, prompt });
  let failure; let stderrBytes = 0; let child; let timer; let killTimer; let events = 0; let exit; let hasClosed = false;
  const groupSignal = sig => {
    if (!child?.pid || hasClosed) return;
    try { if (process.platform === 'win32') child.kill(sig); else process.kill(-child.pid, sig); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const terminate = () => {
    if (!child || hasClosed) return;
    groupSignal('SIGTERM');
    killTimer ??= setTimeout(() => groupSignal('SIGKILL'), 2000);
  };
  const cancel = () => { failure ??= 'cancelled'; terminate(); };
  try {
    child = spawn(launch.executable, launch.args, { cwd: root, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => {
      child.once('error', () => { failure ??= 'native-process-start-failed'; });
      child.once('close', (code, sig) => { hasClosed = true; resolve({ exitCode: code, signal: sig }); });
    });
    // Drain stderr without persisting it; native diagnostics may contain credentials.
    child.stderr.on('data', bytes => { stderrBytes += bytes.length; });
    child.stdin.on('error', () => { failure ??= 'native-input-failed'; terminate(); });
    child.stdin.end(prompt);
    timer = setTimeout(() => { failure ??= 'timeout'; terminate(); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    let pending = ''; const decoder = new TextDecoder('utf-8', { fatal: true }); let sequence = 0;
    const recordLine = line => {
      if (!line.trim()) return;
      const response = ingress.ingest(stream.streamId, sequence++, JSON.parse(line)); events += response.events.length;
      onRecord({ event: 'adapter.recorded', streamId: stream.streamId, events: response.events });
      const boundary = response.events.findLast(e => ['tool.completed', 'turn.completed', 'turn.failed'].includes(e.kind));
      if (boundary) {
        const current = ingress.get(stream.streamId);
        const capture = bridge.capture(root, { sessionId: boundary.sessionId, ...(boundary.turnId ? { turnId: boundary.turnId } : {}),
          ...(boundary.payload.toolCallId ? { toolCallId: boundary.payload.toolCallId } : {}),
          ...(current.promptId ? { messageId: current.promptId } : {}), observedAfter: boundary.eventId });
        if (capture.operations) onRecord({ event: 'filesystem.observed', streamId: stream.streamId, result: capture });
      }
    };
    try {
      for await (const chunk of child.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        ensure(pending.length <= 2_000_000, 'Native stream buffer exceeds 2 MB');
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); recordLine(line); }
      }
      pending += decoder.decode(); if (pending.trim()) recordLine(pending);
    } catch {
      failure ??= 'native-stream-or-capture-failed'; terminate();
    }
    exit = await closed;
    // Record any saved writes even when a harness dies before reporting a boundary.
    try {
      const current = ingress.get(stream.streamId);
      const capture = bridge.capture(root, { ...(current.sessionId ? { sessionId: current.sessionId } : {}),
        ...(current.promptId ? { messageId: current.promptId } : {}) });
      if (capture.operations) onRecord({ event: 'filesystem.observed', streamId: stream.streamId, result: capture });
    } catch { failure ??= 'final-filesystem-capture-failed'; }
    const final = ingress.close(stream.streamId, { ...exit, ...(failure ? { reason: failure } : {}) });
    return { streamId: stream.streamId, status: final.status, ...exit, events, stderrBytes,
      ...(failure ? { reason: failure } : {}) };
  } finally {
    clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', cancel);
    if (child && !hasClosed) terminate();
  }
}
