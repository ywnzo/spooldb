import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request } from 'node:https';
import { startTeamHost } from '../../src/team/host.js';
import { parseWorkspaceLink } from '../../src/team/workspace.js';

const configuredEngine = process.env.SPOOL_TEST_CONTAINER_ENGINE;
const runtime = configuredEngine
  ? [configuredEngine]
  : ['docker', '--host', 'unix:///run/kiri/docker.sock'];
assert(!configuredEngine || ['/usr/bin/docker', '/usr/bin/podman'].includes(configuredEngine),
  'Use a Docker or Podman engine in CI, or Kiri by default');
const engineName = configuredEngine ? configuredEngine.split('/').at(-1) : 'Kiri';
const binary = resolve(process.argv[2] ?? 'work/debian-target/release/spool-native');
const root = mkdtempSync(join(resolve('work'), 'spool-kiri-compat-'));
const state = join(root, 'state');
const backup = join(root, 'backup');
mkdirSync(state, { mode: 0o700 });
mkdirSync(backup, { mode: 0o700 });
const name = 'spool-rust-compat-' + randomUUID();
const caddy = name + '-caddy';
const network = name + '-network';
const caddyfile = join(root, 'Caddyfile');
const hostname = 'spool.container.example.org';
const setupProbe = randomUUID();
writeFileSync(caddyfile, hostname + ' {\n tls internal\n @health path /healthz\n header @health X-SpoolDB-Setup ' +
  setupProbe + '\n reverse_proxy relay:8878\n}\n');
const image = 'docker.io/library/node:24-bookworm';
const engine = args => {
  const command = Bun.spawnSync([...runtime, ...args]);
  if (command.exitCode !== 0) throw Error(command.stderr.toString());
  return command.stdout.toString().trim();
};
const mountFlags = engineName === 'podman' ? ['--security-opt', 'label=disable'] : [];
const mounts = [
  '--mount', 'type=bind,source=' + binary + ',target=/spool-native,readonly',
  '--mount', 'type=bind,source=' + state + ',target=/data',
];
const http = async (origin, path, authorization, input) => {
  const response = await fetch(origin + path, {
    method: input ? 'POST' : 'GET',
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(input ? { 'content-type': 'application/json' } : {}),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200, path);
  return response.json();
};

let legacy;
let live = false;
let proxy = false;
let networkCreated = false;
try {
  legacy = await startTeamHost(state, { port: 0, embeddings: null });
  const setup = await legacy.command({ command: 'workspace-init', name: 'Container compatibility' });
  const owner = await http(legacy.origin, '/v1/workspace/enroll',
    'Invite ' + parseWorkspaceLink(setup.link).code,
    { claim: randomBytes(32).toString('base64url'), device: 'Old owner' });
  const auth = 'Workspace ' + owner.connection.token;
  const workspace = (origin, input) => http(origin, '/v1/workspace/action', auth, input);
  const { project } = await workspace(legacy.origin, { command: 'create', name: 'Persistent project', requestId: 'fixture-project' });
  const { connection } = await workspace(legacy.origin, { command: 'join', room: project.room });
  const memory = (origin, input) => http(origin, '/v1/rooms/' + project.room + '/memory',
    'Bearer ' + connection.token, input);
  const old = await memory(legacy.origin, {
    command: 'remember', kind: 'finding', title: 'Original deployment evidence', requestId: 'legacy-finding',
    text: 'Existing memory remains available across the container transition.',
  });
  await legacy.close();
  legacy = null;

  engine(['network', 'create', network]);
  networkCreated = true;
  engine(['run', '-d', '--name', name, '--network', network, '--network-alias', 'relay', '--user', process.getuid() + ':' + process.getgid(),
    '-p', '127.0.0.1::8878', ...mountFlags, ...mounts, '--entrypoint', '/spool-native', image,
    'team-host', 'start', '/data', '--host=0.0.0.0', '--port=8878', '--origin=http://127.0.0.1:8878']);
  live = true;
  const published = engine(['port', name, '8878/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
  assert(published, 'The relay port was not published');
  const origin = 'http://127.0.0.1:' + published;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      ready = (await http(origin, '/healthz')).protocol === 'spool-relay/1';
      if (ready) break;
    } catch {}
    await Bun.sleep(250);
  }
  assert(ready, 'Native relay failed to become healthy: ' + engine(['logs', name]));
  engine(['run', '-d', '--name', caddy, '--network', network, '-p', '127.0.0.1::443',
    ...mountFlags, '--mount', 'type=bind,source=' + caddyfile + ',target=/etc/caddy/Caddyfile,readonly',
    'docker.io/library/caddy:2.11.7']);
  proxy = true;
  const tlsPort = engine(['port', caddy, '443/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
  assert(tlsPort, 'The Caddy TLS port was not published');
  const caName = '/data/caddy/pki/authorities/local/root.crt';
  let ca, lastError;
  for (let attempt = 0; attempt < 25; attempt++) {
    try { ca = engine(['exec', caddy, 'cat', caName]); break; }
    catch (error) { lastError = error; await Bun.sleep(200); }
  }
  assert(ca, String(lastError));
  const tlsRequest = (path, authorization, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = request({ host: '127.0.0.1', port: Number(tlsPort), servername: hostname, ca, path,
      method: data ? 'POST' : 'GET', timeout: 3000, headers: {
        host: hostname,
        ...(authorization ? { authorization } : {}),
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Error('TLS request timed out')));
    req.end(data ?? undefined);
  });
  let tlsHealth;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      tlsHealth = await tlsRequest('/healthz');
      if (tlsHealth.status === 200) break;
    } catch (error) { lastError = error; }
    await Bun.sleep(200);
  }
  assert.equal(tlsHealth?.status, 200, String(lastError));
  assert.equal(tlsHealth.headers['x-spooldb-setup'], setupProbe);
  const tlsWorkspace = await tlsRequest('/v1/workspace/action', auth, { command: 'list' });
  assert.equal(tlsWorkspace.status, 200);
  assert.equal(JSON.parse(tlsWorkspace.text).workspace.id, owner.workspace.id);
  assert.equal((await workspace(origin, { command: 'list' })).workspace.id, owner.workspace.id);
  assert.equal((await memory(origin, { command: 'get', id: old.id })).text,
    'Existing memory remains available across the container transition.');
  const finding = await memory(origin, {
    command: 'remember', kind: 'finding', title: 'Native relay receipt', requestId: 'native-finding',
    text: 'The historical project grant can still write memory.',
  });
  engine(['stop', '--time', '15', name]);
  engine(['rm', name]);
  live = false;
  engine(['run', '--rm', '--user', process.getuid() + ':' + process.getgid(),
    ...mountFlags, ...mounts, '--mount', 'type=bind,source=' + backup + ',target=/backup',
    '--entrypoint', '/spool-native', image, 'relay-volume', 'snapshot', '/data', '/backup']);
  engine(['run', '--rm', '--user', process.getuid() + ':' + process.getgid(),
    ...mountFlags, ...mounts, '--mount', 'type=bind,source=' + backup + ',target=/backup',
    '--entrypoint', '/spool-native', image, 'relay-volume', 'restore', '/data', '/backup']);
  legacy = await startTeamHost(state, { port: 0, embeddings: null });
  assert.equal((await memory(legacy.origin, { command: 'get', id: finding.id })).text,
    'The historical project grant can still write memory.');
  console.log('Existing workspace, HTTPS, project credentials, records, and restored backup verified in ' + engineName + '.');
} finally {
  await legacy?.close();
  if (live) {
    try { engine(['rm', '-f', name]); } catch {}
  }
  if (proxy) { try { engine(['rm', '-f', caddy]); } catch {} }
  if (networkCreated) { try { engine(['network', 'rm', network]); } catch {} }
  rmSync(root, { recursive: true, force: true });
}
