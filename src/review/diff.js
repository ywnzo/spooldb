// Bounded line comparison: trim common edges, then LCS for modest middles.
// Large middles use an explicit replacement hunk rather than quadratic work.
export function lineDiff(before,after,{context=3,limit=2000}={}) {
  const a=before===''?[]:before.split('\n'),b=after===''?[]:after.split('\n');
  if(a.length>20000||b.length>20000||before.length+after.length>400000) return {rows:[],added:null,removed:null,truncated:true,approximate:true,reason:'This file is too large for an inline comparison. Use the file preview or a local snapshot.'};
  let prefix=0;while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
  let suffix=0;while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
  const x=a.slice(prefix,a.length-suffix),y=b.slice(prefix,b.length-suffix);const ops=a.slice(0,prefix).map(text=>['context',text]);let approximate=false;
  if(x.length*y.length<=1_000_000) {
    const width=y.length+1;const grid=new Uint32Array((x.length+1)*width);
    for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)grid[i*width+j]=x[i]===y[j]?1+grid[(i+1)*width+j+1]:Math.max(grid[(i+1)*width+j],grid[i*width+j+1]);
    let i=0,j=0;while(i<x.length||j<y.length) {
      if(i<x.length&&j<y.length&&x[i]===y[j]) {ops.push(['context',x[i++]]);j++;}
      else if(i<x.length&&(j===y.length||grid[(i+1)*width+j]>=grid[i*width+j+1]))ops.push(['delete',x[i++]]);
      else ops.push(['add',y[j++]]);
    }
  } else {approximate=true;ops.push(...x.map(text=>['delete',text]),...y.map(text=>['add',text]));}
  ops.push(...a.slice(a.length-suffix).map(text=>['context',text]));
  let old=0,next=0;const all=ops.map(([type,text])=>({type,text,oldLine:type==='add'?null:++old,newLine:type==='delete'?null:++next}));
  const changed=all.flatMap((r,i)=>r.type!=='context'?[i]:[]);const visible=new Set();
  if(!changed.length) for(let i=0;i<Math.min(120,all.length);i++)visible.add(i);
  for(const at of changed)for(let i=Math.max(0,at-context);i<=Math.min(all.length-1,at+context);i++)visible.add(i);
  const rows=[];let last=-1,included=0;
  for(const at of [...visible].sort((a,b)=>a-b)) {
    if(rows.length+(at>last+1?2:1)>limit)break;
    if(at>last+1) rows.push({type:'gap',text:`${at-last-1} unchanged lines`});rows.push(all[at]);last=at;included++;
  }
  return {rows,added:all.filter(r=>r.type==='add').length,removed:all.filter(r=>r.type==='delete').length,truncated:included<visible.size||!changed.length&&all.length>120,approximate};
}
