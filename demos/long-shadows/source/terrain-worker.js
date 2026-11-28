import {preparePass} from './valley.js';
const payload=preparePass();
const data=payload.terrain,field=payload.field;
const transfer=[data.positions.buffer,data.normals.buffer,data.indices.buffer,field.heights.buffer];
for(const mesh of payload.props) transfer.push(mesh.positions.buffer,mesh.normals.buffer,mesh.indices.buffer);
postMessage(payload,transfer);
