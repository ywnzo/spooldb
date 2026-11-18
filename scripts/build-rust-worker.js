import {fileURLToPath} from 'node:url';
import {prepareRustWorker} from '../src/deploy/rust-worker.js';

await prepareRustWorker(fileURLToPath(new URL('../',import.meta.url)),{force:true});
