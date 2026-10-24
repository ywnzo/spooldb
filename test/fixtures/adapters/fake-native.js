// Protocol test double, never presented as a real harness session.
import { readFileSync, writeFileSync } from 'node:fs';
const [harness, mode] = process.argv.slice(2);
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if (mode === 'timeout') { setInterval(() => {}, 1000); }
else if (mode === 'malformed') console.log('not JSON');
else if (mode === 'oversized') console.log('x'.repeat(2_000_001));
else if (mode === 'failure') { console.error('native diagnostic not persisted'); process.exitCode = 9; }
else {
  if (mode === 'edit') writeFileSync('a.txt', 'native hello');
  const lines = readFileSync(new URL(`./${harness}.jsonl`, import.meta.url), 'utf8').trim().split('\n');
  if (mode === 'incomplete') lines.pop();
  for (const line of lines) process.stdout.write(line + '\n');
}
