import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildAster } from '../coachwork.js';

const destination=resolve(process.argv[2]??'aster.glb');
const asset=buildAster();
await writeFile(destination,new Uint8Array(asset));
console.log(destination,asset.byteLength);
