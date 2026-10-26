import {fail} from '../relay/wire.js';
const day=now=>new Date(now()).toISOString().slice(0,10);

export class RetrievalUsage {
 constructor(engine,{now=Date.now}={}) {
  this.now=now;this.engine=engine;this.db=engine.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS retrieval_usage(
   day TEXT NOT NULL,room TEXT NOT NULL,metric TEXT NOT NULL,value INTEGER NOT NULL,
   PRIMARY KEY(day,room,metric));
   CREATE TABLE IF NOT EXISTS retrieval_usage_limits(
   id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);`);
 }
 record(room,metric,value=1) {
  const today=day(this.now);
  if(this.pruned!==today) {
   this.db.prepare('DELETE FROM retrieval_usage WHERE day<?')
    .run(new Date(this.now()-90*86400000).toISOString().slice(0,10));
   this.pruned=today;
  }
  this.db.prepare(`INSERT INTO retrieval_usage VALUES(?,?,?,?)
   ON CONFLICT(day,room,metric) DO UPDATE SET value=value+excluded.value`)
   .run(today,room??'',metric,value);
 }
 // Diagnostic writes are best effort; budget reservations below fail closed.
 note(room,metric,value=1) {
  try {this.record(room,metric,value);return true;}
  catch {this.recordingError='Usage telemetry could not be persisted.';return false;}
 }
 limits() {
  const row=this.db.prepare('SELECT * FROM retrieval_usage_limits WHERE id=1').get();
  return {revision:row?.revision??0,...(row?JSON.parse(row.data):
   {dailyCharacters:0,dailyRequests:0,projectDailyCharacters:0})};
 }
 configure(input) {
  const value=input.limits;
  fail(value&&Object.keys(value).sort().join(',')==='dailyCharacters,dailyRequests,projectDailyCharacters'
   &&Object.values(value).every(v=>Number.isSafeInteger(v)&&v>=0&&v<=1000000000),
   'USAGE_LIMITS','Limits must be whole numbers from 0 to 1,000,000,000; zero means unlimited');
  this.engine.transaction(()=>{
   const current=this.limits();
   fail(input.expectedRevision===current.revision,'USAGE_CONFLICT','Usage limits changed; refresh before saving',409);
   this.db.prepare(`INSERT INTO retrieval_usage_limits VALUES(1,?,?)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data`)
    .run(current.revision+1,JSON.stringify(value));
  });
  return this.status();
 }
 status() {
  const rows=this.db.prepare('SELECT room,metric,value FROM retrieval_usage WHERE day=?').all(day(this.now));
  const totals=Object.create(null),projects=Object.create(null);
  for(const row of rows) {
   totals[row.metric]=(totals[row.metric]??0)+row.value;
   if(row.room)(projects[row.room]??={})[row.metric]=row.value;
  }
  return {day:day(this.now),retentionDays:90,recordingError:this.recordingError??null,
   limits:this.limits(),totals,projects,
   units:'UTF-16 text characters sent in embedding attempts; not provider tokens or currency',reset:'00:00 UTC'};
 }
 reserve(room,texts,external) {
  const characters=texts.reduce((sum,text)=>sum+text.length,0);
  let reserved=false;
  this.engine.transaction(()=>{
   if(external) {
    const {limits,totals,projects}=this.status(),project=projects[room]??{};
    const dailyCharactersExceeded=limits.dailyCharacters&&(totals.external_characters??0)+characters>limits.dailyCharacters;
    const dailyRequestsExceeded=limits.dailyRequests&&(totals.external_requests??0)>=limits.dailyRequests;
    const projectCharactersExceeded=room&&limits.projectDailyCharacters
     &&(project.external_characters??0)+characters>limits.projectDailyCharacters;
    if(dailyCharactersExceeded||dailyRequestsExceeded||projectCharactersExceeded) {
     this.record(room,'budget_denied');return;
    }
   }
   this.record(room,'embedding_requests');this.record(room,'embedding_characters',characters);
   if(external) {this.record(room,'external_requests');this.record(room,'external_characters',characters);}
   reserved=true;
  });
  if(!reserved) {
   const error=Error('Embedding usage limit reached; cached and keyword retrieval remain available.');
   error.code='EMBEDDING_LIMIT';throw error;
  }
 }
}
