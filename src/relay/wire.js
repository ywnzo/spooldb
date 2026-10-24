export const MAX_BODY = 16_000_000;
export const PROTOCOL = 'spool-relay/1';
export class RelayError extends Error {
  constructor(code,message,status=400) { super(message);this.code=code;this.status=status; }
}
export const fail = (ok,code,message,status=400) => { if(!ok) throw new RelayError(code,message,status); };
export function heads(value) {
  fail(Array.isArray(value) && value.length<=128 && value.every(h=>typeof h==='string' && /^[a-f0-9]{64}$/.test(h)),'INVALID_FRONTIER','Expected at most 128 causal hashes');
  return value;
}
export async function readJson(stream,maxBytes=MAX_BODY) {
  let bytes=0;const chunks=[];
  for await (const chunk of stream.iterator({destroyOnReturn:false})) { bytes+=chunk.length;fail(bytes<=maxBytes,'BODY_TOO_LARGE','Request exceeds byte limit',413);chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))); }
  catch { throw new RelayError('INVALID_JSON','Invalid UTF-8 JSON'); }
}
