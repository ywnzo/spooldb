import {existsSync} from 'node:fs';
import {join} from 'node:path';
// Existing Node bundles remain installable. New bundles prefer Bun.
export function bundledRuntime(app){if(existsSync(join(app,'runtime/bun')))return join(app,'runtime/bun');if(existsSync(join(app,'runtime/node')))return join(app,'runtime/node');return process.execPath;}
