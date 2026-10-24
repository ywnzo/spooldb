import {existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {desktopPaths,defaultState} from '../desktop/paths.js';
export const pluginSettingsPath=()=>join(desktopPaths().config,'spool','plugin.json');
export function pluginState(){
 if(process.env.SPOOL_STATE)return resolve(process.env.SPOOL_STATE);
 const settings=pluginSettingsPath();if(existsSync(settings))return resolve(JSON.parse(readFileSync(settings)).state);
 const receipt=join(desktopPaths().data,'spool/installation.json');if(existsSync(receipt))return resolve(JSON.parse(readFileSync(receipt)).state);
 return defaultState();
}
