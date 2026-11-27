import {bakeRoom} from './room.js';
const batches=bakeRoom();
postMessage(batches,batches.flatMap(({positions,normals,indices})=>[positions.buffer,normals.buffer,indices.buffer]));
