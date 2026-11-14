import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
export const desktopPaths=(env=process.env)=>({bin:resolve(env.SPOOL_BIN_HOME??join(homedir(),'.local/bin')),data:resolve(env.XDG_DATA_HOME??join(homedir(),'.local/share')),config:resolve(env.XDG_CONFIG_HOME??join(homedir(),'.config')),state:resolve(env.XDG_STATE_HOME??join(homedir(),'.local/state'))});
export const defaultState=()=>join(desktopPaths().state,'spool');
// Older native/plugin installations keep the primary project at the state root.
// Reuse its identities, grants and databases instead of opening an empty setup service.
export const primaryDirectory=root=>existsSync(join(root,'project.json'))?root:join(root,'p');
export const inboxPath=root=>join(root,'inbox.json');
