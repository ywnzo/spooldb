import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configureVPS, containerRequest } from '../../src/server-vps.js';
import { rootRun } from '../../src/server-caddy.js';
import { parseWorkspaceLink } from '../../src/team/workspace.js';

const engine = process.env.SPOOL_TEST_CONTAINER_ENGINE;
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use a disposable hosted runner');
assert(['/usr/bin/docker', '/usr/bin/podman'].includes(engine));
assert.equal(process.getuid(), 0);
const [legacyBundle, installer] = process.argv.slice(2).map(path => resolve(path));
assert.equal(JSON.parse(readFileSync(join(legacyBundle, 'package.json'))).version, '0.4.45');
const candidateVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;

const root = mkdtempSync(join(tmpdir(), 'spool-packaged-upgrade-'));
const paths = { app: join(root, 'app'), cli: '/usr/local/bin/spool', unit: join(root, 'unit') };
const configPath = join(paths.app, 'containers.json');
const controlUnit = '/etc/systemd/system/spool-relay-control.service';
const lock = paths.app + '.operation.lock';
const domain = 'spool-upgrade.example.com';
const caFile = join(root, 'caddy.pem');
const controllerFailure = join(root, 'failed-controller');
const hosts = readFileSync('/etc/hosts');
assert(!existsSync(paths.cli) && !existsSync(controlUnit));
const volumes = ['spool-relay-data', 'spool-caddy-data', 'spool-caddy-config'];
const containerNames = ['spool-relay', 'spool-caddy'];
const call = (...args) => rootRun(engine, args);
for (const [kind, names] of [['container', containerNames], ['volume', volumes], ['network', ['spool-network']]]) {
  for (const name of names) assert.throws(() => call(kind, 'inspect', name));
}
const run = (command, args, options) => {
  if (command === 'systemctl') return '';
  if (['/usr/bin/docker', '/usr/bin/podman'].includes(command)) {
    if (command !== engine) throw Error('Fixture selects ' + engine);
    if (args[0] === 'cp') {
      writeFileSync(args[1], readFileSync(args[1], 'utf8').replace('{\n', '{\n tls internal\n'));
    }
  }
  return rootRun(command, args, options);
};

function api(path, authorization, body) {
  return new Promise((done, fail) => {
    const input = body && JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port: 443, servername: domain,
      path, ca: readFileSync(caFile), timeout: 3000, method: input ? 'POST' : 'GET',
      headers: { host: domain, ...(authorization && { authorization }),
        ...(input && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(input) }) } },
    res => {
      let raw = '';
      res.on('data', part => { raw += part; });
      res.on('error', fail);
      res.on('end', () => {
        try { done({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) }); }
        catch (error) { fail(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('TLS request timed out')));
    req.on('error', fail);
    req.end(input);
  });
}

async function healthy(_domain, probe) {
  let error;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      writeFileSync(caFile, call('exec', 'spool-caddy', 'cat', '/data/caddy/pki/authorities/local/root.crt'));
      const health = await api('/healthz');
      assert.equal(health.headers['x-spooldb-setup'], probe);
      assert.equal(health.body.ok, true);
      return;
    } catch (problem) { error = problem; await Bun.sleep(500); }
  }
  throw error;
}

function upgrade(failController) {
  const result = Bun.spawnSync(['/bin/sh', installer, '--relay-update', configPath], {
    env: { ...process.env, PATH: root + ':' + process.env.PATH, SSL_CERT_FILE: caFile,
      SPOOL_TEST_FAIL_CONTROLLER: failController ? '1' : '0' },
    stdout: 'inherit', stderr: 'inherit', timeout: 240_000,
  });
  return result.exitCode;
}

try {
  appendFileSync('/etc/hosts', '\n127.0.0.1 ' + domain + '\n');
  // Only systemd is substituted. All containers, TLS requests, SQLite writes and installer code run normally.
  writeFileSync(join(root, 'systemctl'), `#!/bin/sh
if [ "$1" = restart ] && [ "$SPOOL_TEST_FAIL_CONTROLLER" = 1 ] && [ ! -e "${controllerFailure}" ]; then
 if ${engine} exec spool-relay /app/spool-native relay-health http://127.0.0.1:8878 | grep -q '"updating":true'; then
  touch "${controllerFailure}"
 fi
 exit 1
fi
`, { mode: 0o700 });
  const installed = await configureVPS({ domain, bundle: legacyBundle, paths, run,
    checkDNS: async () => {}, firewall: () => {}, checkHTTPS: healthy });
  const workspace = await api('/v1/workspace/enroll', 'Invite ' + parseWorkspaceLink(installed.ownerLink).code,
    { claim: randomBytes(32).toString('base64url'), device: 'existing client' });
  assert.equal(workspace.status, 200);
  const auth = 'Workspace ' + workspace.body.connection.token;
  const { body: { project } } = await api('/v1/workspace/action', auth,
    { command: 'create', name: 'Existing project', requestId: 'old-project' });
  const { body: { connection } } = await api('/v1/workspace/action', auth, { command: 'join', room: project.room });
  const memory = input => api('/v1/rooms/' + project.room + '/memory', 'Bearer ' + connection.token, input);
  const saved = await memory({ command: 'remember', kind: 'finding', title: 'Existing memory',
    text: 'This record predates the Rust upgrade.', requestId: 'original-finding' });
  assert.equal(saved.status, 200);
  const record = { command: 'get', id: saved.body.id };
  const previous = readFileSync(configPath, 'utf8');
  assert.notEqual(JSON.parse(previous).relayBackend, 'rust');
  const oldCLI = readFileSync(paths.cli, 'utf8');

  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));
  assert.equal(upgrade(true), 1);
  assert(existsSync(controllerFailure), 'Candidate must reach the failing controller check with maintenance still enabled');
  assert.deepEqual(JSON.parse(readFileSync(configPath)), JSON.parse(previous));
  assert.equal(readFileSync(paths.cli, 'utf8'), oldCLI);
  assert.equal((await memory(record)).body.text, 'This record predates the Rust upgrade.');
  assert(!existsSync(join(paths.app, 'relay-update-journal.json')));

  assert.equal(upgrade(false), 0);
  assert.equal(JSON.parse(readFileSync(configPath)).relayBackend, 'rust');
  assert.match(readFileSync(paths.cli, 'utf8'), /runtime\/spool-native-linux-x64/);
  assert.equal((await api('/healthz')).body.version, candidateVersion);
  assert.equal((await api('/v1/workspace/action', auth, { command: 'list' })).body.workspace.id, workspace.body.workspace.id);
  assert.equal((await memory(record)).body.text, 'This record predates the Rust upgrade.');
  assert.equal(containerRequest(configPath, { command: 'list' }).projects[0].room, project.room);
} finally {
  const containers = call('container', 'ls', '--all', '--format', '{{.Names}}').split('\n');
  for (const name of containers) {
    if (containerNames.includes(name) || name.startsWith('spool-relay-previous-')) {
      try { call('rm', '-f', name); } catch {}
    }
  }
  for (const name of volumes) { try { call('volume', 'rm', name); } catch {} }
  try { call('network', 'rm', 'spool-network'); } catch {}
  writeFileSync('/etc/hosts', hosts);
  rmSync(controlUnit, { force: true });
  rmSync(paths.cli, { force: true });
  rmSync(root, { force: true, recursive: true });
}
