// One provider invocation at a time. Queries may pass queued indexing batches;
// after four queries, one indexing batch gets a turn to avoid starvation.
export class InferenceQueue{
 constructor(){this.queries=[];this.background=[];this.running=false;this.closed=false;this.burst=0;}
 run(work,query=false){if(this.closed)return Promise.reject(Error('Embedding queue is closed'));return new Promise((resolve,reject)=>{(query?this.queries:this.background).push({work,resolve,reject});this.pump();});}
 async pump(){if(this.running||this.closed)return;const queue=this.queries.length&&(this.burst<4||!this.background.length)?this.queries:this.background,job=queue.shift();if(!job)return;this.burst=queue===this.queries?this.burst+1:0;this.running=true;try{job.resolve(await job.work());}catch(error){job.reject(error);}finally{this.running=false;this.pump();}}
 close(){this.closed=true;for(const job of [...this.queries,...this.background])job.reject(Error('Embedding queue is closed'));this.queries=[];this.background=[];}
}
