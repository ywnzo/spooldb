import { Engine, ShardedEngine } from 'spooldb';
import { RelayServer,SyncClient,createCredential } from 'spooldb/relay';
import { AdapterIngress, runHarness, validateEvent, type AdapterEvent } from 'spooldb/adapters';
const engine = new Engine(':memory:');
const ingress = new AdapterIngress(engine);
const stream = ingress.open({ branch: 'main', harness: 'codex' });
const result = ingress.ingest(stream.streamId, 0, { type: 'thread.started', thread_id: 'example' });
const event: AdapterEvent = validateEvent(result.events[0]);
const sequence: number = event.sequence;
void sequence;
void runHarness(engine, { harness: 'claude', root: '/tmp/example', prompt: 'Review code' });
// @ts-expect-error unknown harnesses require a protocol extension
ingress.open({ branch: 'main', harness: 'invented-harness' });
// @ts-expect-error a native event sequence is a number, not a string
ingress.ingest(stream.streamId, '0', {});
// @ts-expect-error unknown event evidence must not silently become a native claim
const badEvidence: AdapterEvent['evidence'] = 'proven-author';
void badEvidence;
const sharded = new ShardedEngine(':memory:', { checkpointEvery: 128, checkpointKeep: 2, cacheEntries: 32 });
sharded.create();
const page = sharded.listFiles('main', { limit: 10 });
const metrics: number = sharded.storageStats().replayedChanges;
void page; void metrics;
const compacted: number = sharded.compact({ vacuum: true }).removedNodes;
void compacted;
// @ts-expect-error vacuum is a boolean, not a string
sharded.compact({ vacuum: 'true' });
// @ts-expect-error metadata pages require a known record kind
sharded.readRecords('main', { kind: 'unknown-records' });
const auth = createCredential('alice',{room:'write'});
const relay = new RelayServer(':memory:',{credentials:[auth.credential]});
const sync = new SyncClient(sharded,{url:'http://localhost:8787',room:'room',token:auth.token});
void relay;void sync.sync({mode:'pull'});void sharded.exportPage('main',[],{limit:8});
void sync.publishBranch('feature/example',{expectedRevision:1});void sync.sync({mode:'push'});
// @ts-expect-error room grants use explicit read/write roles
createCredential('alice',{room:'admin'});
