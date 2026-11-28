import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { defaultDiameter,makeFlange,inspectSolid,compareSolids } from './flange.mjs';

const checkout=process.env.MARGO_ENGINE_CHECKOUT;
if (!checkout) throw new Error('Set MARGO_ENGINE_CHECKOUT to the verified public checkout.');
const revision=execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if (revision!=='0efd9cff8230507a32deb49907ecd499d46925f5') throw new Error('Unexpected Margo Engine pin: '+revision);
const {model,parseSTEP}=await import(pathToFileURL(join(checkout,'packages/brep/dist/index.js')));
const solid=makeFlange(model,defaultDiameter);
const reference=inspectSolid(model,solid);
const step=model.bodiesToSTEP([solid]);
const {bodies,problems}=model.bodiesFromSTEP(parseSTEP(step));
if (problems.length || !compareSolids(reference,inspectSolid(model,bodies[0])).equivalent) {
  throw new Error('The default flange did not round trip.');
}
const {positions,normals,indices}=reference.mesh;
const header=Buffer.alloc(24);
header.write('AST1');
header.writeUInt32LE(positions.length,4);
header.writeUInt32LE(indices.length,8);
header.writeUInt32LE(reference.properties.faces,12);
header.writeDoubleLE(reference.properties.volume,16);
const bytes=array=>Buffer.from(array.buffer,array.byteOffset,array.byteLength);
const packet=Buffer.concat([header,bytes(Float32Array.from(positions)),bytes(Float32Array.from(normals)),bytes(Uint32Array.from(indices))]);
const compressed=gzipSync(packet,{level:9});
await writeFile(new URL('./aster-flange.mesh',import.meta.url),compressed);
console.log('Default flange',positions.length/3,'vertices,',indices.length/3,'triangles,',compressed.length,'compressed bytes.');