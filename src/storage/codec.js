import { deflateRawSync, inflateRawSync } from 'node:zlib';

// Existing TEXT rows stay readable. New BLOB rows carry a version byte, so
// storage compression never changes canonical JSON hashes or wire bundles.
export function pack(value) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) < 256) return json;
  const body = deflateRawSync(Buffer.from(json), { level: 1 });
  return body.length + 1 < Buffer.byteLength(json) ? Buffer.concat([Buffer.from([1]), body]) : json;
}
export function unpack(body) {
  if (typeof body === 'string') return JSON.parse(body);
  if (body[0] !== 1) throw new Error('Unknown storage encoding');
  return JSON.parse(inflateRawSync(body.subarray(1), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'));
}
