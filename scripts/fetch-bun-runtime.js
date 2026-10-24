import {existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const BUN_VERSION='1.4.3';
const hash=data=>createHash('sha256').update(data).digest('hex');
export async function fetchBunRuntime(){
 const dir=fileURLToPath(new URL('../work/runtime/bun-v'+BUN_VERSION+'/',import.meta.url)),runtime=join(dir,'bun'),receipt=join(dir,'verified.json');
 if(existsSync(runtime)&&existsSync(receipt)&&hash(readFileSync(runtime))===JSON.parse(readFileSync(receipt)).binarySha256)return runtime;
 mkdirSync(dir,{recursive:true,mode:0o700});const asset='bun-linux-x64-baseline.zip',origin='https://github.com/oven-sh/bun/releases/download/bun-v'+BUN_VERSION+'/';
 const download=async(name,max)=>{const response=await fetch(origin+name,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error('Bun runtime download failed: '+response.status);const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>max)throw new Error('Runtime download exceeds limit');chunks.push(chunk);}return Buffer.concat(chunks);};
 const sums=(await download('SHASUMS256.txt',100000)).toString();const expected=sums.split('\n').find(line=>line.trim().endsWith(asset))?.split(/\s+/)[0];if(!/^[a-f0-9]{64}$/.test(expected??''))throw new Error('Official Bun runtime checksum missing');
 console.log('Downloading portable Bun '+BUN_VERSION+' from the official release…');const archive=await download(asset,150000000);if(hash(archive)!==expected)throw new Error('Bun release checksum mismatch');const zip=join(dir,asset);writeFileSync(zip,archive);
 // Extract only the expected binary, never arbitrary ZIP entries or paths.
 const binary=execFileSync('unzip',['-p',zip,'bun-linux-x64-baseline/bun'],{maxBuffer:200000000});writeFileSync(runtime,binary,{mode:0o755});chmodSync(runtime,0o755);if(execFileSync(runtime,['--version'],{encoding:'utf8'}).trim()!==BUN_VERSION)throw new Error('Unexpected Bun runtime version');
 writeFileSync(receipt,JSON.stringify({version:BUN_VERSION,source:origin+asset,archiveSha256:expected,binarySha256:hash(binary)},null,2)+'\n');return runtime;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(await fetchBunRuntime());
