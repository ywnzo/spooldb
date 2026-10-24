import {existsSync} from 'node:fs';
import {join} from 'node:path';
// Existing Node bundles remain installable. New bundles prefer Bun.
export function bundledRuntime(app){if(process.platform==='darwin'&&process.arch==='arm64'&&existsSync(join(app,'runtime/bun-darwin-arm64')))return join(app,'runtime/bun-darwin-arm64');if(existsSync(join(app,'runtime/bun')))return join(app,'runtime/bun');if(existsSync(join(app,'runtime/node')))return join(app,'runtime/node');return process.execPath;}
