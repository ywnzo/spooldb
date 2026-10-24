import {trustMemoryHooks} from '../src/codex-connection.js';
const [root,directory,room]=process.argv.slice(2);console.log(JSON.stringify(await trustMemoryHooks({root,directory,room})));
