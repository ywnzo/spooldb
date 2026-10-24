import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
export const markers=[['# BEGIN SPOOL DISCOVERY','# END SPOOL DISCOVERY'],['# BEGIN SPOOL MANAGED','# END SPOOL MANAGED'],['# BEGIN THREADWEAVE MANAGED','# END THREADWEAVE MANAGED']];
export function legacyFiles(root,{codexHome=process.env.CODEX_HOME??join(homedir(),'.codex')}={}){return [...new Set([join(codexHome,'config.toml'),join(root,'.codex/config.toml')])].filter(path=>existsSync(path)&&markers.some(([begin])=>readFileSync(path,'utf8').includes(begin)));}
