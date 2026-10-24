import {Database} from 'bun:sqlite';
export class BunSqlite {
 constructor(filename){this.database=new Database(filename,{create:true,strict:true});}
 exec(sql){this.database.exec(sql);}
 prepare(sql){const stmt=this.database.query(sql),row=value=>value?Object.assign(Object.create(null),value):undefined;return {run:(...args)=>stmt.run(...args),get:(...args)=>row(stmt.get(...args)),all:(...args)=>stmt.all(...args).map(row)};}
 close(){this.database.close();}
}
