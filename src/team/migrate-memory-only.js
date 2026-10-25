import {existsSync,mkdirSync,renameSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ShardedEngine} from '../sharded-engine.js';
import {MemoryStore} from '../memory/store.js';
// Rebuild immutable history: deleting current file entries would retain their old contents.
export function migrateMemoryOnly(directory,backupDirectory){
 const dir=resolve(directory),backup=resolve(backupDirectory);if(backup===dir||backup.startsWith(dir+'/'))throw new Error('Keep the rollback backup outside the relay directory');
 if(existsSync(join(dir,'admin.sock')))throw new Error('Stop the shared relay before migrating');
 const filename=join(dir,'shared.sqlite'),next=filename+'.memory-only-new';if(existsSync(next))throw new Error('An unfinished migration exists; inspect it before retrying');
 const config=JSON.parse(readFileSync(join(dir,'host.json'))),old=new ShardedEngine(filename);let fresh;
 const result={projects:config.projects.length,messages:0,removedFileDocuments:0,backup:null};
 try{
  fresh=new ShardedEngine(next);const memory=new MemoryStore(old);new MemoryStore(fresh,{referencesOnly:true});
  for(const project of config.projects){const branch=`relay-${project.room}`,version=memory.index(project.room);result.removedFileDocuments+=[...old.manifest.entries(version.root)].filter(([key])=>key.startsWith('f:')).length;
   fresh.transaction(()=>{const batch={schema:2,room:project.room,parents:[],root:null,metadata:null,updates:[]};fresh.publish(branch,project.room,[fresh.putBatch(batch)],null);});
   for(const row of old.db.prepare('SELECT id,data FROM memory_docs WHERE room=? ORDER BY seq,rowid').all(project.room)){
    const doc=old.doc(version,'m:'+row.id);let value;try{value=JSON.parse(JSON.stringify(doc.messages[row.id]));}finally{old.documents.release(doc);}
    let text=value.text;try{const event=JSON.parse(text);if(value.role==='system'&&event.protocol==='spool-memory/1'){event.files=(event.files??[]).map(file=>({path:file.path.replace(/^@machines\/[^/]+\//,''),legacySnapshotReference:true}));text=JSON.stringify(event);}}catch{}
    const source=JSON.parse(row.data).source??{};fresh.submit(branch,{actor:source.actor??'memory-migration',harness:'memory-only-migration',sessionId:source.sessionId??'migration',evidence:'retained-memory',requestId:'migration-'+row.id,expectedHeads:fresh.ref(branch).heads,operations:[{type:'message.add',messageId:row.id,role:value.role,text}]});result.messages++;
   }
  }
  // Keep grants, invites, revocations and retry receipts. None contains source bodies.
  for(const table of ['team_members','team_invites','team_host_meta','team_ingest','memory_write_receipts','team_projects','workspace_settings','workspace_members','workspace_grants','workspace_invites']){
   const schema=old.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;if(!schema)continue;
   if(!fresh.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))fresh.db.exec(schema);
   for(const row of old.db.prepare('SELECT * FROM '+table).all()){if(table==='memory_write_receipts'){const value=JSON.parse(row.result);value.heads=fresh.ref('relay-'+row.room).heads;row.result=JSON.stringify(value);}const columns=Object.keys(row);fresh.db.prepare('INSERT INTO '+table+'('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(key=>row[key]));}
  }
  const check=new MemoryStore(fresh,{referencesOnly:true});for(const project of config.projects){check.index(project.room);if([...fresh.manifest.entries(fresh.version('relay-'+project.room).root)].some(([key])=>key.startsWith('f:')))throw new Error('Migration retained file documents');}
  fresh.close();fresh=null;old.close();mkdirSync(backup,{recursive:true,mode:0o700});const destination=join(backup,'shared-before-memory-only-'+Date.now()+'.sqlite');renameSync(filename,destination);try{renameSync(next,filename);}catch(error){renameSync(destination,filename);throw error;}result.backup=destination;return result;
 }catch(error){if(fresh)fresh.close();try{old.close();}catch{}for(const suffix of ['','-wal','-shm'])rmSync(next+suffix,{force:true});throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){process.umask(0o077);if(!process.argv[2]||!process.argv[3])throw new Error('Usage: node src/team/migrate-memory-only.js RELAY_STATE LOCAL_BACKUP_DIRECTORY (relay must be stopped)');console.log(JSON.stringify(migrateMemoryOnly(process.argv[2],process.argv[3])));}
