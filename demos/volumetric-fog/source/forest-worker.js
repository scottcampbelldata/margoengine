import {prepareForest} from './forest.js';

const forest=prepareForest();
const buffers=forest.flatMap(({positions,normals,indices})=>[positions.buffer,normals.buffer,indices.buffer]);
postMessage(forest,buffers);
