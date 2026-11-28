import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync,gzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const checkout=process.env.MARGO_ENGINE_CHECKOUT;
if(!checkout)throw Error('Set MARGO_ENGINE_CHECKOUT to the verified public Margo Engine checkout.');
const {parseBrightStarCatalog}=await import(pathToFileURL(resolve(checkout,'packages/sky/dist/astro.js')));
const url='https://vizier.cfa.harvard.edu/ftp/cats/V/50/catalog.gz';
const content=process.argv[2]?await readFile(process.argv[2]):new Uint8Array(await (await fetch(url)).arrayBuffer());
const sha=createHash('sha256').update(content).digest('hex');
if(sha!=='3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed')
  throw Error('The CDS V/50 source snapshot does not match.');
const cutoff=5.45, data=parseBrightStarCatalog(new TextDecoder('latin1').decode(gunzipSync(content)),{maxMagnitude:cutoff});
const stride=18;
const packet=Buffer.alloc(2+data.count*stride);
packet.writeUInt16LE(data.count,0);
for(let i=0;i<data.count;i++){
  const at=2+i*stride;
  packet.writeUInt16LE(data.numbers[i],at);
  packet.writeInt16LE(Math.round(data.magnitudes[i]*100),at+2);
  packet.writeInt16LE(Number.isFinite(data.colors[i])?Math.round(data.colors[i]*100):-32768,at+4);
  for(let c=0;c<3;c++){
    packet.writeInt16LE(Math.round(data.positions[i*3+c]*32767),at+6+c*2);
    packet.writeInt16LE(Math.round(data.motions[i*3+c]*1e8),at+12+c*2);
  }
}
const packed=gzipSync(packet,{level:9});
await writeFile(new URL('../assets/yale-v50.bin',import.meta.url),packed);
console.log(JSON.stringify({stars:data.count,cutoff,bytes:packed.byteLength,source:sha}));
