// Implements the small synchronous SQL interface shared by the local engine and DOs.
// Durable Object storage owns durability and transaction boundaries; never issue BEGIN.
export class DurableSqlite {
 constructor(storage){this.storage=storage;this.sql=storage.sql;}
 exec(query){const statements=query.split(';').map(s=>s.trim()).filter(Boolean);for(const statement of statements)if(!/^PRAGMA\b/i.test(statement))this.sql.exec(statement);}
 prepare(query){
  const execute=args=>this.sql.exec(query,...args.map(value=>value===undefined?null:value));
  const rows=cursor=>cursor.toArray().map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof ArrayBuffer?new Uint8Array(v):v])));
  return {all:(...args)=>rows(execute(args)),get:(...args)=>rows(execute(args))[0],run:(...args)=>{execute(args);return this.sql.exec('SELECT changes() AS changes,last_insert_rowid() AS lastInsertRowid').one();}};
 }
 transaction(fn){return this.storage.transactionSync(fn);}
 close(){} // Storage belongs to the Durable Object lifecycle.
}
