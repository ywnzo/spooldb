#!/usr/bin/env node
import { ShardedEngine } from './index.js';
import { SyncClient } from './relay/index.js';
if(process.argv.includes('--help')) {
  console.log('Usage: spool-sync DATABASE RELAY_ORIGIN ROOM [BRANCH] [--watch] [--pull] [--publish=NAME] [--revision=N]\nSet SPOOL_RELAY_TOKEN in the environment. Tokens are not command-line arguments.\nAn empty sharded database can pull an existing authorized room. --watch polls until SIGINT/SIGTERM.');process.exit(0);
}
const [, ,filename,url,room,...args]=process.argv;
if(!filename||!url||!room||args.filter(a=>!a.startsWith('--')).length>1||args.some(a=>a.startsWith('--')&&!['--watch','--pull'].includes(a)&&!/^--(?:publish|revision)=.+$/.test(a))) throw new Error('See --help for sync arguments');
const branch=args.find(a=>!a.startsWith('--'))??'main';const engine=new ShardedEngine(filename);
const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
try {
  const client=new SyncClient(engine,{url,room,branch,token:process.env.SPOOL_RELAY_TOKEN});const mode=args.includes('--pull')?'pull':'both';
  const publish=args.find(a=>a.startsWith('--publish='))?.slice(10);
  if(!publish&&args.some(a=>a.startsWith('--revision=')))throw new Error('Revision requires --publish=NAME');
  if(publish) {
    if(args.includes('--watch')||args.includes('--pull'))throw new Error('Publish is a one-shot writer operation');
    const expectedRevision=Number(args.find(a=>a.startsWith('--revision='))?.slice(11)??0);
    console.log(JSON.stringify({event:'review.published',result:await client.publishBranch(publish,{expectedRevision,signal:controller.signal})}));
  } else if(args.includes('--watch')) await client.watch({mode,signal:controller.signal,onSync:result=>console.log(JSON.stringify({event:'sync.completed',result})),onError:error=>console.error(JSON.stringify({event:'sync.error',code:error.code??'NETWORK',message:error.message}))});
  else console.log(JSON.stringify({event:'sync.completed',result:await client.sync({mode,signal:controller.signal})}));
} catch(error) {if(!controller.signal.aborted) {console.error(JSON.stringify({event:'sync.error',code:error.code??'NETWORK',message:error.message}));process.exitCode=1;}}
finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);engine.close();}
