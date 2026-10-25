import {startRelayControl} from './relay-control.js';
process.umask(0o077);
startRelayControl(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
