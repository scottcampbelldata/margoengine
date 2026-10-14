import {entry, type GLTFAsset} from './asset.js';
import type {PreparedGeometry} from './index.js';
/** Geometry already packed by a parse worker, keyed by primitive definition; PBRModel then skips decoding it. */
export const packed = new WeakMap<object, PreparedGeometry>();
/** Decode one triangle primitive's accessors into gltf-pro's 80-byte vertices and uint32 indices (main thread or worker). */
export function packPrimitive(asset:GLTFAsset, p:any):PreparedGeometry {
  if ((p.mode??4)!==4) throw new Error('PBR requires triangle primitives');
  const a=p.attributes??{}, positions=asset.accessor(a.POSITION,'VEC3'), count=positions.length/3, quantized=asset.doc.extensionsUsed?.includes('KHR_mesh_quantization');
  if(count<3)throw new RangeError('Expected bounded triangle geometry');
  for(const key of ['POSITION','NORMAL','TANGENT'])if(a[key]!==undefined&&!quantized){const def=entry(asset.doc.accessors,a[key],'attribute');if(def.componentType!==5126||def.normalized)throw new TypeError('Expected Float32 '+key);}
  for(const key of ['TEXCOORD_0','TEXCOORD_1','COLOR_0'])if(a[key]!==undefined&&!(quantized&&key!=='COLOR_0')){const def=entry(asset.doc.accessors,a[key],'attribute');if(![5126,5121,5123].includes(def.componentType)||def.componentType!==5126&&!def.normalized)throw new TypeError('Invalid normalized '+key);}
  let normals=a.NORMAL===undefined?new Float32Array(positions.length):asset.accessor(a.NORMAL,'VEC3');
  const indexValues=p.indices===undefined?null:asset.accessor(p.indices,'SCALAR');
  if(indexValues)for(let i=0;i<indexValues.length;i++){const v=indexValues[i];if(!Number.isInteger(v)||v<0||v>=count)throw new RangeError('Invalid glTF triangle indices');}
  const indices=indexValues?new Uint32Array(indexValues):new Uint32Array(count);
  if(!indexValues)for(let i=0;i<count;i++)indices[i]=i;
  if (!indices.length||indices.length%3) throw new RangeError('Invalid glTF triangle indices');
  if (p.indices!==undefined && (![5121,5123,5125].includes(entry(asset.doc.accessors,p.indices,'indices').componentType)||asset.doc.accessors[p.indices].normalized)) throw new TypeError('Invalid index component type');
  if (a.NORMAL===undefined) for (let i=0;i<indices.length;i+=3) {
    const x=indices[i]*3,y=indices[i+1]*3,z=indices[i+2]*3;
    const ux=positions[y]-positions[x],uy=positions[y+1]-positions[x+1],uz=positions[y+2]-positions[x+2],vx=positions[z]-positions[x],vy=positions[z+1]-positions[x+1],vz=positions[z+2]-positions[x+2];
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    normals[x]+=nx;normals[x+1]+=ny;normals[x+2]+=nz;normals[y]+=nx;normals[y+1]+=ny;normals[y+2]+=nz;normals[z]+=nx;normals[z+1]+=ny;normals[z+2]+=nz;
  }
  const uv0=a.TEXCOORD_0===undefined?null:asset.accessor(a.TEXCOORD_0,'VEC2'),uv1=a.TEXCOORD_1===undefined?null:asset.accessor(a.TEXCOORD_1,'VEC2');
  const tangent=a.TANGENT===undefined?null:asset.accessor(a.TANGENT,'VEC4'), colors=a.COLOR_0===undefined?null:asset.accessor(a.COLOR_0);
  const colorWidth=colors?colors.length/count:0;
  if (normals.length!==count*3||uv0&&uv0.length!==count*2||uv1&&uv1.length!==count*2||tangent&&tangent.length!==count*4||colors&&![3,4].includes(colorWidth)) throw new RangeError('Mismatched glTF attributes');
  const vertices=new Float32Array(count*20);
  // Packed vertex: position+1, normal+0, tangent, uv0 uv1, color.
  for(let i=0,o=0;i<count;i++,o+=20) {
    const p=i*3,nx=normals[p],ny=normals[p+1],nz=normals[p+2],length=Math.hypot(nx,ny,nz);
    vertices[o]=positions[p];vertices[o+1]=positions[p+1];vertices[o+2]=positions[p+2];vertices[o+3]=1;
    if(!length) throw new RangeError('Zero glTF normal');
    vertices[o+4]=nx/length;vertices[o+5]=ny/length;vertices[o+6]=nz/length;
    if(tangent){const t=i*4;vertices[o+8]=tangent[t];vertices[o+9]=tangent[t+1];vertices[o+10]=tangent[t+2];vertices[o+11]=tangent[t+3];}
    if(uv0){vertices[o+12]=uv0[i*2];vertices[o+13]=uv0[i*2+1];}if(uv1){vertices[o+14]=uv1[i*2];vertices[o+15]=uv1[i*2+1];}
    if(colors){const c=i*colorWidth;vertices[o+16]=colors[c];vertices[o+17]=colors[c+1];vertices[o+18]=colors[c+2];vertices[o+19]=colorWidth===3?1:colors[c+3];}
    else{vertices[o+16]=1;vertices[o+17]=1;vertices[o+18]=1;vertices[o+19]=1;}
  }
  return {vertices,indices};
}
