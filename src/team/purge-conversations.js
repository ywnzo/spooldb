import {existsSync,readFileSync,mkdirSync,copyFileSync,renameSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ShardedEngine} from '../sharded-engine.js';
import {MemoryStore} from '../memory/store.js';
// Offline replacement is required: deleting a search row alone leaves the
// immutable source documents and historical frontiers retrievable.
export function purgeConversations(directory,room,{confirm=false}={}){
 if(!confirm)throw Error('Explicit confirmation is required to remove shared conversations');
 const dir=resolve(directory),filename=join(dir,'shared.sqlite');if(existsSync(join(dir,'admin.sock')))throw Error('Stop the relay before removing shared conversations');
 const host=JSON.parse(readFileSync(join(dir,'host.json')));const matches=host.projects.filter(project=>project.room===room||project.name===room);if(matches.length!==1)throw Error('Choose one shared project by its exact name');room=matches[0].room;
 const old=new ShardedEngine(filename),branch='relay-'+room,records=[],origins=[];let removed=0,next;
 try{const memory=new MemoryStore(old),version=memory.index(room);if([...old.manifest.entries(version.root)].some(([key])=>!key.startsWith('m:')))throw Error('This cleanup only supports memory-only shared projects');
  for(const row of old.db.prepare('SELECT id,kind,data FROM memory_docs WHERE room=? ORDER BY seq,rowid').all(room)){if(row.kind==='conversation'){removed++;continue;}const doc=old.doc(version,'m:'+row.id);try{records.push({id:row.id,value:JSON.parse(JSON.stringify(doc.messages[row.id])),source:JSON.parse(row.data).source});}finally{old.documents.release(doc);}const origin=old.db.prepare('SELECT * FROM conversation_origins WHERE room=? AND id=?').get(room,row.id);if(origin)origins.push(origin);}
  old.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');old.close();if(!removed)return {removed:0,retained:records.length,room};
  next=filename+'.purge-'+randomUUID();copyFileSync(filename,next);chmodSync(next,0o600);const fresh=new ShardedEngine(next);
  try{new MemoryStore(fresh,{referencesOnly:true});fresh.transaction(()=>{const refs=fresh.refs().filter(ref=>ref.room===room);for(const ref of refs)fresh.db.prepare('DELETE FROM shard_receipts WHERE branch=?').run(ref.branch);
   for(const table of ['shard_refs','shard_batches','shard_versions','shard_batch_files','shard_changes','shard_doc_stats','shard_checkpoints','memory_docs','memory_index','memory_provenance','memory_write_receipts','conversation_origins','team_ingest','relay_audit','relay_review_branches','relay_review_publications'])if(fresh.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))fresh.db.prepare('DELETE FROM '+table+' WHERE room=?').run(room);
   fresh.db.prepare('DELETE FROM memory_fts WHERE room=?').run(room);fresh.create(branch,{room});for(const record of records)fresh.submit(branch,{actor:record.source?.actor??'retained-memory',harness:record.source?.harness??'conversation-cleanup',evidence:'retained-memory',requestId:'retain-'+record.id,expectedHeads:fresh.ref(branch).heads,operations:[{type:'message.add',messageId:record.id,role:record.value.role,text:record.value.text}]});for(const row of origins)fresh.db.prepare('INSERT INTO conversation_origins VALUES(?,?,?)').run(row.room,row.id,row.data);
  });const memory=new MemoryStore(fresh,{referencesOnly:true});memory.index(room);if(fresh.db.prepare("SELECT count(*) AS n FROM memory_docs WHERE room=? AND kind='conversation'").get(room).n!==0)throw Error('Conversation cleanup validation failed');fresh.db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");fresh.db.exec('VACUUM');fresh.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{fresh.close();}
  const backups=join(dir,'private-backups');mkdirSync(backups,{recursive:true,mode:0o700});const backup=join(backups,'before-conversation-cleanup-'+randomUUID()+'.sqlite');renameSync(filename,backup);try{renameSync(next,filename);next=null;}catch(error){renameSync(backup,filename);throw error;}return {room,removed,retained:records.length,backup,notice:'The private rollback backup still contains the removed conversations; it is not served by the relay.'};
 }catch(error){try{old.close();}catch{}if(next)for(const suffix of ['','-wal','-shm'])rmSync(next+suffix,{force:true});throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){process.umask(0o077);console.log(JSON.stringify(purgeConversations(process.argv[2],process.argv[3],{confirm:process.argv.includes('--confirm')})));}
