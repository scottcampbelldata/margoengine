import {Geometry} from '@margoengine/core';
import {triangulatePolygon} from '../../shared/polygon.js';
export const maxBytes=64*1024*1024,maxVertices=1_000_000,maxIndices=3_000_000;
function flat(positions:number[],progress?:(value:number)=>void):Geometry {
  if(!positions.length||positions.length/3>maxIndices||positions.length%9||!positions.every(v=>Number.isFinite(Math.fround(v))))throw new RangeError('CAD requires bounded finite triangles');
  const packed:number[]=[],normals:number[]=[],indices:number[]=[],seen=new Map<string,number>();
  for(let i=0;i<positions.length;i+=9){const ux=positions[i+3]-positions[i],uy=positions[i+4]-positions[i+1],uz=positions[i+5]-positions[i+2],vx=positions[i+6]-positions[i],vy=positions[i+7]-positions[i+1],vz=positions[i+8]-positions[i+2],n=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx],length=Math.hypot(...n);if(!length)throw new RangeError('Degenerate CAD triangle');const normal=n.map(v=>v/length);
    for(let j=0;j<3;j++){const p=positions.slice(i+j*3,i+j*3+3),key=[...p,...normal].map(v=>Math.round(v*100_000)).join(',');let id=seen.get(key);
      if(id===undefined){id=packed.length/3;if(id>=maxVertices)throw new RangeError('CAD unique vertex limit');seen.set(key,id);packed.push(...p);normals.push(...normal);}indices.push(id);}
    if(i%90_000===0)progress?.(0.5+0.5*i/positions.length);
    if(new Set(indices.slice(-3)).size!==3)throw new RangeError('Triangle collapses at CAD welding tolerance');
  }
  // Core uses uint32 indices consistently across both GPU backends.
  return new Geometry(packed,normals,indices);
}
function stl(input:string|Uint8Array,progress?:(value:number)=>void):Array<{name:string;geometry:Geometry}> {
  const positions:number[]=[];
  if(input instanceof Uint8Array&&input.length>=84){const view=new DataView(input.buffer,input.byteOffset,input.byteLength),count=view.getUint32(80,true);
    if(84+count*50===input.length){if(count*3>maxIndices||!count)throw new RangeError('STL triangle limit');for(let face=0;face<count;face++){for(let i=0;i<9;i++)positions.push(view.getFloat32(84+face*50+12+i*4,true));if(face%10_000===0)progress?.(0.5*face/count);}return [{name:'STL body',geometry:flat(positions,progress)}];}}
  const text=typeof input==='string'?input:new TextDecoder('utf8',{fatal:true}).decode(input);
  if(!/^\s*solid\b/.test(text)||! /\bendsolid\b/.test(text))throw new TypeError('Invalid STL');
  const number='[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?',vertex=new RegExp(`vertex\\s+(${number})\\s+(${number})\\s+(${number})`,'g');
  const facets=text.match(/facet\s+normal[\s\S]*?endfacet/g)??[];
  if(facets.length*3>maxIndices||!facets.length)throw new RangeError('STL triangle limit');
  let face=0;for(const facet of facets){if(face++%10_000===0)progress?.(0.5*face/facets.length);const matches=[...facet.matchAll(vertex)];if(matches.length!==3||! /outer\s+loop/.test(facet)||! /endloop/.test(facet))throw new TypeError('Invalid STL facet');for(const match of matches)positions.push(...match.slice(1).map(Number));}
  return [{name:text.match(/solid\s+([^\r\n]*)/)?.[1]||'STL body',geometry:flat(positions,progress)}];
}
function obj(text:string,progress?:(value:number)=>void):Array<{name:string;geometry:Geometry}> {
  const vertices:number[][]=[],parts:Array<{name:string;positions:number[]}>=[{name:'OBJ body',positions:[]}],workCounter={used:0,limit:10_000_000};let current=parts[0],total=0;
  const lines=text.split(/\r?\n/);let lineNumber=0;for(const raw of lines){if(lineNumber++%10_000===0)progress?.(0.5*lineNumber/lines.length);const line=raw.replace(/#.*/,'').trim();if(!line)continue;const [tag,...fields]=line.split(/\s+/);
    if(tag==='v'){const p=fields.map(Number);if(p.length!==3||!p.every(v=>Number.isFinite(Math.fround(v)))||vertices.length>=maxVertices)throw new RangeError('Invalid OBJ vertex');vertices.push(p);}
    else if(tag==='o'||tag==='g'){if(parts.length>=100_000)throw new RangeError('OBJ part limit');current={name:fields.join(' ')||'OBJ body',positions:[]};parts.push(current);}
    else if(tag==='f'){
      if(fields.length<3||fields.length>4096)throw new RangeError('OBJ face vertex limit');
      const face=fields.map(field=>{if(!/^-?\d+(?:\/(?:-?\d*)?(?:\/-?\d+)?)?$/.test(field))throw new TypeError('Invalid OBJ face');const index=Number(field.split('/')[0]),point=vertices[index>0?index-1:vertices.length+index];if(!index||!point)throw new RangeError('OBJ index exceeds vertices');return point;});
      const a=face[0],b=face[1],c=face[2],normal=[(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]),(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]),(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])],length=Math.hypot(...normal);
      if(!length)throw new RangeError('Degenerate OBJ face');const axis=normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs))),u=(axis+1)%3,v=(axis+2)%3;
      if(face.some(p=>Math.abs(normal.reduce((sum,n,i)=>sum+n*(p[i]-a[i]),0))/length>1e-5))throw new RangeError('Nonplanar OBJ face');
      const result=triangulatePolygon(face.map(p=>[p[u],p[v]]),[],{maxVertices,workCounter});
      for(let i=0;i<result.indices.length;i+=3){const triangle=result.indices.slice(i,i+3);if(normal[axis]<0)triangle.reverse();for(const index of triangle){const p=[0,0,0];p[u]=result.positions[index*2];p[v]=result.positions[index*2+1];p[axis]=a[axis]-(normal[u]*(p[u]-a[u])+normal[v]*(p[v]-a[v]))/normal[axis];current.positions.push(...p);if(++total>maxIndices)throw new RangeError('OBJ triangle limit');}}
    }else if(!['vn','vt','s','usemtl','mtllib'].includes(tag))throw new Error(`Unsupported OBJ record ${tag}`);
  }
  return parts.filter(part=>part.positions.length).map(part=>({name:part.name,geometry:flat(part.positions)}));
}

export function parseCADGeometry(input:string|ArrayBuffer|ArrayBufferView,format:'stl'|'obj',progress?:(value:number)=>void):Array<{name:string;geometry:Geometry}> {
 if(!['stl','obj'].includes(format))throw new TypeError('CAD supports STL and OBJ');const data=typeof input==='string'?input:input instanceof ArrayBuffer?new Uint8Array(input):new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
 if((typeof data==='string'?new TextEncoder().encode(data).length:data.length)>maxBytes)throw new RangeError('CAD exceeds 64 MiB');
 const definitions=format==='stl'?stl(data,progress):obj(typeof data==='string'?data:new TextDecoder('utf8',{fatal:true}).decode(data),progress);if(!definitions.length)throw new Error('CAD contains no geometry');return definitions;
}

export function fingerprint(geometry:Geometry):Float32Array {
  if(geometry.indices.length>maxIndices)throw new RangeError('Deduplication triangle limit');const data=new Float32Array(geometry.indices.length*6),order:number[]=[];
  for(let face=0;face<geometry.indices.length;face+=3){const ids=Array.from(geometry.indices.subarray(face,face+3));let start=0;
    for(let i=1;i<3;i++){for(let j=0;j<6;j++){const difference=geometry.vertices[ids[i]*6+j]-geometry.vertices[ids[start]*6+j];if(difference<0){start=i;break;}if(difference>0)break;}}
    for(let i=0;i<3;i++)for(let j=0;j<6;j++)data[face*6+i*6+j]=geometry.vertices[ids[(start+i)%3]*6+j]||0;order.push(face/3);}
  order.sort((a,b)=>{for(let i=0;i<18;i++){const difference=data[a*18+i]-data[b*18+i];if(difference)return difference;}return 0;});const sorted=new Float32Array(data.length);for(let i=0;i<order.length;i++)sorted.set(data.subarray(order[i]*18,order[i]*18+18),i*18);return sorted;
}
let crcTable:Uint32Array|undefined;
export function hash(data:Float32Array):number {crcTable??=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let bit=0;bit<8;bit++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0;});let crc=0xffffffff;for(const byte of new Uint8Array(data.buffer))crc=(crc>>>8)^crcTable[(crc^byte)&255];return (crc^0xffffffff)>>>0;}
