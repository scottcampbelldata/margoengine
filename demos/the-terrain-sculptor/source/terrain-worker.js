import {generateField} from './ground-data.js';
import {prepareMaterials} from './surface.js';
import {prepareArt} from './art.js';

const field=generateField(),maps=prepareMaterials(),art=prepareArt();
const textureBuffers=Object.values(maps).flat().map(level=>level.buffer);
self.postMessage({...field,maps,art},[field.heights.buffer,field.weights.buffer,
  art.vertices.buffer,art.indices.buffer,...textureBuffers]);
