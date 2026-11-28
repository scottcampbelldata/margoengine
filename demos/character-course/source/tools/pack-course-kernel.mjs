import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inflateRawSync} from 'node:zlib';

const checkout=process.argv[2];
if(!checkout)throw new Error('Pass a built public Margo checkout.');
const revision=execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(revision!=='0efd9cff8230507a32deb49907ecd499d46925f5')throw new Error('Unexpected Margo checkout.');
const {findPython}=await import(pathToFileURL(resolve(checkout,'scripts/support/find-python.mjs')).href),python=findPython();
if(!python)throw new Error('Python 3 is needed to pack the kernel.');
const distribution=resolve(checkout,'packages/physics/dist');
const names=await readdir(distribution);
for(const [variant,pattern] of [['simd',/^wasm-(?!scalar|threads)[^/]+\.js$/],['scalar',/^wasm-scalar-[^/]+\.js$/]]){
  const choices=names.filter(name=>pattern.test(name));
  if(choices.length!==1)throw new Error('Expected one verified '+variant+' module.');
  const {wasmBase64}=await import(pathToFileURL(resolve(distribution,choices[0])));
  const bytes=inflateRawSync(Buffer.from(wasmBase64,'base64'));
  const packed=spawnSync(python,['-c','import lzma,sys; sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read(),format=lzma.FORMAT_XZ,check=lzma.CHECK_CRC32,preset=9|lzma.PRESET_EXTREME))'],{input:bytes});
  if(packed.error||packed.status!==0)throw packed.error??new Error(String(packed.stderr));
  await writeFile(new URL('../course-'+variant+'.packed',import.meta.url),packed.stdout);
  console.log(variant,packed.stdout.length,bytes.length,createHash('sha256').update(bytes).digest('hex'));
}
