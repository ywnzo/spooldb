import {readFileSync} from 'node:fs';
const json=path=>JSON.parse(readFileSync(new URL('../'+path,import.meta.url),'utf8'));
const version=json('package.json').version,plugin=json('plugins/spooldb/.codex-plugin/plugin.json').version;
const review=process.env.SPOOL_RELEASE_REVIEW==='true'&&process.env.GITHUB_REF==='refs/heads/codex/rust-release-review';
if((!review&&process.env.GITHUB_REF_NAME!=='v'+version)||plugin!==version||!readFileSync(new URL('../plugins/spooldb/mcp.json',import.meta.url),'utf8').includes('/spooldb/'+version))throw Error('Release tag, package, plugin and MCP cache versions must match before publication');
console.log('Release versions match: '+version);
