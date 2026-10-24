import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,cpSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
test('Git-marketplace first launch verifies payload and reviewed hook definitions, then reuses the runtime',t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-plugin-bootstrap-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const plugin=join(base,'installed plugin'),payload=join(base,'payload/plugins/spooldb'),bin=join(base,'bin');mkdirSync(join(plugin,'hooks'),{recursive:true});mkdirSync(join(payload,'app/runtime'),{recursive:true});mkdirSync(join(payload,'hooks'));mkdirSync(bin);
 const hooks='{"hooks":{}}\n',profile='{"protocol":"spool-hooks/1","fingerprint":"fixture"}\n';for(const root of [plugin,payload]){writeFileSync(join(root,'hooks/hooks.json'),hooks);writeFileSync(join(root,'hooks/runtime-profile.json'),profile);}
 writeFileSync(join(payload,'app/runtime/bun'),'#!/bin/sh\nexit 0\n',{mode:0o755});const archive=join(base,'payload.tar.gz');execFileSync('tar',['-czf',archive,'-C',join(base,'payload'),'.']);const sha=createHash('sha256').update(readFileSync(archive)).digest('hex');
 writeFileSync(join(plugin,'payload.sha256'),sha+'  spooldb-codex-linux-x64.tar.gz\n');writeFileSync(join(plugin,'payload.url'),'https://github.com/ywnzo/spooldb/releases/download/v0.4.4/spooldb-codex-linux-x64.tar.gz\n');
 writeFileSync(join(bin,'curl'),'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then out=$2; shift; fi; shift; done\nprintf x >> "$SPOOL_TEST_DOWNLOADS"\ncp "$SPOOL_TEST_ARCHIVE" "$out"\n',{mode:0o755});
 const env={...process.env,PATH:bin+':'+process.env.PATH,SPOOL_TEST_ARCHIVE:archive,SPOOL_TEST_DOWNLOADS:join(base,'downloads')},run=()=>execFileSync('sh',['plugins/spooldb/scripts/bootstrap.sh',plugin],{env,stdio:'pipe'});
 writeFileSync(join(plugin,'payload.sha256'),'0'.repeat(64)+'  payload\n');assert.throws(run,/checksum mismatch/);assert.equal(existsSync(join(plugin,'app')),false);
 writeFileSync(join(plugin,'payload.sha256'),sha+'  payload\n');writeFileSync(join(plugin,'hooks/hooks.json'),'different hooks');assert.throws(run,/reviewed hook definitions/);assert.equal(existsSync(join(plugin,'app')),false);
 writeFileSync(join(plugin,'hooks/hooks.json'),hooks);writeFileSync(join(plugin,'hooks/runtime-profile.json'),'different fingerprint');assert.throws(run,/fingerprint differs/);assert.equal(existsSync(join(plugin,'app')),false);
 writeFileSync(join(plugin,'hooks/runtime-profile.json'),profile);assert.equal(run().toString(),'');assert.ok(existsSync(join(plugin,'app/runtime/bun')));const calls=readFileSync(join(base,'downloads'),'utf8');run();assert.equal(readFileSync(join(base,'downloads'),'utf8'),calls);
 assert.equal(readFileSync(join(plugin,'hooks/hooks.json'),'utf8'),hooks);assert.equal(readFileSync(join(plugin,'hooks/runtime-profile.json'),'utf8'),profile);
});
