import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';

const checkout=process.argv[2];
if(!checkout)throw new Error('Pass the built public Margo checkout.');
const revision=execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(revision!=='0efd9cff8230507a32deb49907ecd499d46925f5')throw new Error('Unexpected Margo revision.');
for(const [variant,source] of [['simd','physics2d.wasm'],['scalar','physics2d-scalar.wasm']]){
  const data=await readFile(join(checkout,'packages/physics2d/dist',source));
  const packed=gzipSync(data,{level:9});
  await writeFile(new URL('../kernel-'+variant+'.packed',import.meta.url),packed);
  console.log(variant,packed.length,createHash('sha256').update(data).digest('hex'));
}
