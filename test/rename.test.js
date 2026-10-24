import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseInvite,inviteLink} from '../src/team/invites.js';
import {parseWorkspaceLink,workspaceLink} from '../src/team/workspace.js';
import {installCodex} from '../src/codex-install.js';
test('SpoolDB emits spool invitations and accepts pre-rename invitations',()=>{
 const value={version:1,url:'https://example.com',code:'a'.repeat(43)};
 assert.ok(inviteLink(value).startsWith('spool://'));
 assert.deepEqual(parseInvite(inviteLink(value).replace('spool:','threadweave:')),value);
 assert.deepEqual(parseWorkspaceLink(workspaceLink(value).replace('spool:','threadweave:')),value);
});
test('reconnecting replaces the legacy managed Codex block without duplicate hooks',t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-rename-')),root=join(base,'repo'),directory=join(base,'state');mkdirSync(root);mkdirSync(directory);mkdirSync(join(root,'.codex'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const path=join(root,'.codex/config.toml');writeFileSync(path,'model_verbosity = "medium"\n# BEGIN THREADWEAVE MANAGED\n[mcp_servers.threadweave]\ncommand = "old-node"\n# END THREADWEAVE MANAGED\n');
 installCodex({root,directory,room:'test-room'});const config=readFileSync(path,'utf8');assert.ok(config.includes('[mcp_servers.spool]'));assert.ok(!config.includes('threadweave'));assert.ok(config.includes('model_verbosity = "medium"'));assert.equal(installCodex({root,directory,room:'test-room'}).changed,false);
});
