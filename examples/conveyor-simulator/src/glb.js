// Minimal GLB reader for the conveyor assembly: static triangle meshes with POSITION + NORMAL,
// one primitive per mesh and tightly packed buffer views. @margoengine/gltf caps a file at one
// million vertices in total and drops node extras, both of which this assembly needs.
import {decodeMargo} from '@margoengine/blender';
const JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

export function readModel(buffer) {
  if(buffer.byteLength>=4&&new DataView(buffer).getUint32(0,true)===0x4f47524d){
    const {document:doc,geometry}=decodeMargo(buffer);
    return {doc,geometry};
  }
  return readGLB(buffer);
}

export function readGLB(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new TypeError('Invalid GLB header');
  let doc, bin;
  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + length > buffer.byteLength) throw new RangeError('Truncated GLB chunk');
    if (type === JSON_CHUNK) doc = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset, length)));
    else if (type === BIN_CHUNK) bin = {buffer, offset, length};
    offset += length;
  }
  if (!doc || !bin) throw new TypeError('GLB needs a JSON and a binary chunk');
  return {doc, bin};
}

const TYPES = {5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array};

export function readAccessor({doc, bin}, id, components) {
  const accessor = doc.accessors[id], view = doc.bufferViews[accessor.bufferView], Type = TYPES[accessor.componentType];
  const size = Type?.BYTES_PER_ELEMENT * components, length = accessor.count * components;
  if (!Type || accessor.sparse || view.buffer !== 0 || (view.byteStride ?? size) !== size) throw new Error('Unsupported glTF accessor');
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (start + length * Type.BYTES_PER_ELEMENT > bin.length) throw new RangeError('glTF accessor exceeds the buffer');
  const offset = bin.offset + start;
  // Views need natural alignment; copy the rare unaligned accessor instead.
  return offset % Type.BYTES_PER_ELEMENT ? new Type(bin.buffer.slice(offset, offset + length * Type.BYTES_PER_ELEMENT)) : new Type(bin.buffer, offset, length);
}

/** Positions, normals, indices and local bounds for every mesh's single primitive. */
export function readMeshes(glb) {
  return glb.doc.meshes.map((mesh,meshIndex) => {
    const [primitive] = mesh.primitives;
    if (mesh.primitives.length !== 1 || (primitive.mode ?? 4) !== 4 || primitive.indices === undefined || !glb.geometry && primitive.attributes.NORMAL === undefined) throw new Error('Expected one indexed triangle primitive with normals per mesh');
    let positions,normals,indices;
    if(glb.geometry){
      const prepared=glb.geometry[meshIndex][0],count=prepared.vertices.length/20;
      positions=new Float32Array(count*3);normals=new Float32Array(count*3);indices=prepared.indices;
      for(let i=0;i<count;i++){positions.set(prepared.vertices.subarray(i*20,i*20+3),i*3);normals.set(prepared.vertices.subarray(i*20+4,i*20+7),i*3);}
    }else{positions=readAccessor(glb,primitive.attributes.POSITION,3);normals=readAccessor(glb,primitive.attributes.NORMAL,3);indices=readAccessor(glb,primitive.indices,1);}
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {const a = i % 3, v = positions[i]; if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v;}
    return {positions, normals, indices, material: primitive.material, min, max};
  });
}
