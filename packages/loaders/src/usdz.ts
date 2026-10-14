import {LoaderError,type LoadedGeometry,type LoadedGroup,type ParseLimits} from './types.js';
import {limits,throwIfAborted,toBytes,type BinaryInput} from './util.js';
import {readZipDirectory,readZipEntry,type ZipOptions} from './zip.js';
import {computeVertexNormals} from './normals.js';
import {multiplyMatrices} from '@margoengine/math/mat4';

const F='USD';
export interface USDOptions extends ParseLimits,Pick<ZipOptions,'maxEntries'|'maxEntryBytes'|'signal'> {
  units?:'meters'|'file';maxDepth?:number;
}
export type USDValue=number|string|boolean|USDValue[]|{path:string}|{asset:string};
type Value=USDValue;
/** One `def` prim of a USDA layer. `attrs` keys are property names as written (`outputs:surface.connect`); `properties` holds each property's `( ... )` metadata. */
export interface USDPrim {type:string;name:string;path:string;attrs:Map<string,Value>;metadata:Map<string,Value>;properties:Map<string,Map<string,Value>>;children:USDPrim[]}
type Prim=USDPrim;
export interface USDALayer {metadata:Map<string,Value>;roots:USDPrim[];prims:Map<string,USDPrim>}
export interface USDAReadOptions {maxDepth?:number;signal?:AbortSignal;
  /** Return `@path@` asset values as `{asset}` instead of rejecting them. */
  assets?:boolean;
  /** Drop `over` and `class` prims (with their subtrees) instead of rejecting them. */
  skipOver?:boolean}
function fail(code:'syntax'|'unsupported'|'range'|'limit',message:string):never {throw new LoaderError(F,code,message);}
const identity=():Float64Array=>new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
function numbers(value:Value|undefined,size?:number):number[] {
  if(!Array.isArray(value)||value.some(v=>typeof v!=='number'||!Number.isFinite(v))||size!==undefined&&value.length!==size)fail('syntax','expected a numeric tuple or array');
  return value as number[];
}
function transform(prim:Prim,parent:Float64Array,base:Float64Array):Float64Array {
  const order=prim.attrs.get('xformOpOrder');
  if(order===undefined) {
    if([...prim.attrs.keys()].some(key=>key.startsWith('xformOp:')))fail('unsupported','transforms require xformOpOrder');
    return parent;
  }
  if(!Array.isArray(order)||order.some(v=>typeof v!=='string'))fail('syntax','invalid xformOpOrder');
  let local=identity(),inherited=parent;
  for(const name of order as string[]) {
    if(name==='!resetXformStack!'){inherited=base;continue;}
    let matrix=identity();const value=prim.attrs.get(name);
    if(name==='xformOp:transform') {
      if(!Array.isArray(value)||value.length!==4)fail('syntax','expected a 4x4 transform');
      matrix=new Float64Array((value as Value[]).flatMap(row=>numbers(row,4)));
      if(matrix[3]!==0||matrix[7]!==0||matrix[11]!==0||matrix[15]!==1)fail('unsupported','only affine transforms are supported');
    }else if(name==='xformOp:translate')matrix.set(numbers(value,3),12);
    else if(name==='xformOp:scale') {const v=numbers(value,3);matrix[0]=v[0];matrix[5]=v[1];matrix[10]=v[2];}
    else if(name==='xformOp:rotateXYZ') {
      const angles=numbers(value,3).map(v=>v*Math.PI/180);
      for(let axis=0;axis<3;axis++) {
        const rotation=identity(),a=(axis+1)%3,b=(axis+2)%3,c=Math.cos(angles[axis]),s=Math.sin(angles[axis]);
        rotation[a*4+a]=c;rotation[b*4+b]=c;rotation[a*4+b]=s;rotation[b*4+a]=-s;matrix=multiplyMatrices(rotation,matrix,new Float64Array(16));
      }
    }else fail('unsupported',`unsupported transform ${name}`);
    local=multiplyMatrices(local,matrix,new Float64Array(16));
  }
  return multiplyMatrices(inherited,local,new Float64Array(16));
}

/** Tokenizes a static USDA layer into its `def` prim tree. Composition, variants and time samples are rejected explicitly. */
export function readUSDA(text:string,options:USDAReadOptions={}):USDALayer {
  const maxDepth=options.maxDepth??32;
  if(!Number.isSafeInteger(maxDepth)||maxDepth<1||maxDepth>64)fail('range','maxDepth must be 1..64');
  if(!text.startsWith('#usda 1.0'))fail('syntax','expected #usda 1.0');
  const token=/\s+|#[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|<[^>]*>|@[\s\S]*?@|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_!][\w:!.]*|[{}()[\]=,;]/y;
  let offset=0,cached:{text:string;newLine:boolean}|undefined,numbers=0;
  function peek():{text:string;newLine:boolean} {
    if(cached)return cached;let newLine=false;
    while(offset<text.length) {
      token.lastIndex=offset;const match=token.exec(text);
      if(!match)fail('syntax',`invalid token at offset ${offset}`);offset=token.lastIndex;
      const word=match![0];if(/^\s|^#/.test(word)){newLine||=word.includes('\n');continue;}
      return cached={text:word,newLine};
    }
    return cached={text:'',newLine};
  }
  const take=()=>{const value=peek().text;cached=undefined;return value;};
  const expect=(word:string)=>{if(take()!==word)fail('syntax',`expected ${word}`);};
  const number=(word:string)=>{const n=word?Number(word):NaN;if(!Number.isFinite(n))fail('range','non-finite number');if(++numbers>16_000_000)fail('limit','numeric values exceed 16 million');return n;};
  function value(depth=0):Value {
    if(depth>maxDepth)fail('limit','nested value exceeds maxDepth');
    const word=take();
    if(word==='['||word==='(') {
      const end=word==='['?']':')',close=text.indexOf(end,offset);
      // Fast path for flat numeric arrays and arrays of numeric tuples, the bulk of mesh data.
      if(word==='['&&!cached&&close>=0&&/^[\s\d.eE+\-(),]*$/.test(text.slice(offset,close))&&!/\([^)]*\(/.test(text.slice(offset,close))) {
        const body=text.slice(offset,close),tuples=body.includes('(')?[...body.matchAll(/\(([^)]*)\)/g)].map(m=>m[1].split(',').map(v=>number(v.trim()))):body.trim()?body.split(',').map(v=>number(v.trim())):[];
        offset=close+1;return tuples;
      }
      const out:Value[]=[];
      while(peek().text!==end){if(!peek().text)fail('syntax','unterminated array');out.push(value(depth+1));if(peek().text===',')take();else if(peek().text!==end)fail('syntax','expected comma');}
      take();return out;
    }
    if(word==='{') {let open=1;while(open){const t=take();if(!t)fail('syntax','unterminated dictionary');open+=t==='{'?1:t==='}'?-1:0;}return '';}
    if(word.startsWith('"""'))return word.slice(3,-3);
    if(word.startsWith('"')) {try{return JSON.parse(word);}catch{fail('syntax','invalid string escape');}}
    if(word.startsWith('<'))return {path:word.slice(1,-1)};
    if(word.startsWith('@')){if(!options.assets)fail('unsupported','external assets and textures are unsupported');return {asset:word.replace(/^@+|@+$/g,'')};}
    if(word==='true'||word==='false')return word==='true';
    if(/^[+-]?(\d|\.\d)/.test(word))return number(word);
    if(word==='None')return '';
    fail('unsupported',`unsupported value ${word}`);
  }
  function metadata():Map<string,Value> {
    const out=new Map<string,Value>();expect('(');
    while(peek().text!==')') {
      let key=take();if(!key)fail('syntax','unterminated metadata');
      if(['prepend','append','add','delete','reorder'].includes(key))key=take();
      if(key.startsWith('"')){out.set('doc',JSON.parse(key));continue;}
      if(['references','payload','subLayers','variants','variantSets','inherits','specializes','instanceable'].includes(key))fail('unsupported',`USD composition ${key} is unsupported`);
      expect('=');out.set(key,value());if(peek().text===','||peek().text===';')take();
    }take();return out;
  }
  const prims=new Map<string,Prim>();
  function prim(parent:string,depth:number):Prim|undefined {
    if(depth>maxDepth)fail('limit','prim hierarchy exceeds maxDepth');
    const specifier=take();
    if(specifier!=='def'&&!(options.skipOver&&(specifier==='over'||specifier==='class')))fail('unsupported','only defined static prims are supported');
    let type=take();const name=type.startsWith('"')?JSON.parse(type):value();if(type.startsWith('"'))type='Xform';
    if(typeof name!=='string')fail('syntax','prim name must be a string');
    const path=`${parent}/${name}`,attrs=new Map<string,Value>(),properties=new Map<string,Map<string,Value>>(),meta=peek().text==='('?metadata():new Map<string,Value>(),children:Prim[]=[];
    if(prims.has(path))fail('syntax','duplicate prim path');
    const result:Prim={type,name:name as string,path,attrs,metadata:meta,properties,children};if(specifier==='def')prims.set(path,result);expect('{');
    while(peek().text!=='}') {
      throwIfAborted(options.signal,F);const first=peek().text;
      if(first==='def'||options.skipOver&&(first==='over'||first==='class')){const p=prim(path,depth+1);if(p)children.push(p);continue;}
      if(!first)fail('syntax','unterminated prim');
      if(first==='over'||first==='class'||first==='variantSet')fail('unsupported',`USD composition ${first} is unsupported`);
      const header:string[]=[];
      while(peek().text!=='=') {
        if(header.length>=2&&(peek().newLine||peek().text==='}'||peek().text==='('))break;
        if(!peek().text||header.length>8)fail('syntax','invalid property declaration');header.push(take());
      }
      const key=header[header.length-1];
      if(!key)fail('syntax','missing property name');
      if(key.includes('timeSamples'))fail('unsupported','animated USD attributes are unsupported');
      if(peek().text==='='){take();if(attrs.has(key))fail('syntax','duplicate property');attrs.set(key,value());}
      if(peek().text==='(')properties.set(key,metadata());if(peek().text===';')take();
    }take();return specifier==='def'?result:undefined;
  }
  const metadataMap=peek().text==='('?metadata():new Map<string,Value>(),roots:Prim[]=[];
  while(peek().text){const p=prim('',1);if(p)roots.push(p);}
  return {metadata:metadataMap,roots,prims};
}

/** Static USDA polygon meshes. Composition, animation and binary Crate layers are rejected explicitly. */
export function parseUSDA(input:string|BinaryInput,options:USDOptions={}):LoadedGeometry {
  throwIfAborted(options.signal,F);
  const limit=limits(options,F),maxBytes=options.maxEntryBytes??64*1024*1024;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0)fail('range','invalid maxEntryBytes');
  const bytes=typeof input==='string'?new TextEncoder().encode(input):toBytes(input,F);
  if(bytes.length>maxBytes)fail('limit','USDA exceeds maxEntryBytes');
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('syntax','invalid UTF-8');}
  if(options.units!==undefined&&options.units!=='meters'&&options.units!=='file')fail('range','units must be meters or file');
  const {metadata:meta,roots,prims}=readUSDA(text,{maxDepth:options.maxDepth,signal:options.signal});
  let polygonWork=0;
  const unit=meta.get('metersPerUnit')??0.01,axis=meta.get('upAxis')??'Y';
  if(typeof unit!=='number'||unit<=0||!Number.isFinite(unit))fail('range','invalid metersPerUnit');
  if(axis!=='Y'&&axis!=='Z')fail('unsupported','only Y and Z up stages are supported');
  const scale=options.units==='file'?1:unit as number,base=identity();base[0]=scale;base[5]=scale;base[10]=scale;
  if(axis==='Z'){base[5]=0;base[10]=0;base[6]=-scale;base[9]=scale;}
  const positions:number[]=[],indices:number[]=[],groups:LoadedGroup[]=[];
  function visit(node:Prim,parent:Float64Array,hidden=false):void {
    hidden||=node.attrs.get('visibility')==='invisible'||node.metadata.get('active')===false;
    if(hidden)return;
    const world=transform(node,parent,base);
    if(node.type==='Mesh') {
      if((node.attrs.get('subdivisionScheme')??'catmullClark')!=='none')fail('unsupported','subdivision surfaces are unsupported');
      const holes=node.attrs.get('holeIndices');if(holes!==undefined&&(!Array.isArray(holes)||holes.length))fail('unsupported','mesh hole faces are unsupported');
      if(!Array.isArray(node.attrs.get('points')))fail('syntax','mesh has no points');
      const points=(node.attrs.get('points') as Value[]).map(p=>numbers(p,3)),counts=numbers(node.attrs.get('faceVertexCounts')),faces=numbers(node.attrs.get('faceVertexIndices'));
      if(positions.length/3+points.length>limit.maxVertices)fail('limit','vertex limit exceeded');
      const det=world[0]*(world[5]*world[10]-world[6]*world[9])-world[4]*(world[1]*world[10]-world[2]*world[9])+world[8]*(world[1]*world[6]-world[2]*world[5]);
      if(!det||!Number.isFinite(det))fail('range','singular transform');
      const start=indices.length,vertexBase=positions.length/3;
      for(const [x,y,z] of points)for(let r=0;r<3;r++){const v=Math.fround(world[r]*x+world[4+r]*y+world[8+r]*z+world[12+r]);if(!Number.isFinite(v))fail('range','vertex outside Float32 range');positions.push(v);}
      const orientation=node.attrs.get('orientation')??'rightHanded';if(orientation!=='rightHanded'&&orientation!=='leftHanded')fail('range','invalid orientation');
      const reverse=(orientation==='leftHanded')!==(det<0);let cursor=0;
      for(const count of counts) {
        if(!Number.isSafeInteger(count)||count<3||cursor+count>faces.length)fail('syntax','invalid faceVertexCounts');
        if(indices.length/3+count-2>limit.maxTriangles)fail('limit','triangle limit exceeded');
        const face=faces.slice(cursor,cursor+count);cursor+=count;
        if(face.some(v=>!Number.isSafeInteger(v)||v<0||v>=points.length))fail('range','face index outside points');
        if(count>3) {
          // shortcut: convex planar polygons only, use a polygon tessellator before importing concave faces.
          polygonWork+=count*count;if(polygonWork>10_000_000)fail('limit','polygon validation work limit exceeded');
          const a=points[face[0]],b=points[face[1]],c=points[face[2]],u=b.map((v,i)=>v-a[i]),v=c.map((v,i)=>v-a[i]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n);
          if(!length)fail('unsupported','degenerate polygon');
          for(let k=0;k<count;k++) {
            const p=points[face[k]],q=points[face[(k+1)%count]],r=points[face[(k+2)%count]],edge=q.map((v,i)=>v-p[i]),next=r.map((v,i)=>v-q[i]);
            if(Math.abs(n.reduce((s,v,i)=>s+v*(p[i]-a[i]),0))>length*1e-5||n[0]*(edge[1]*next[2]-edge[2]*next[1])+n[1]*(edge[2]*next[0]-edge[0]*next[2])+n[2]*(edge[0]*next[1]-edge[1]*next[0])<0)fail('unsupported','concave or non-planar polygon');
            for(const index of face) {
              const w=points[index].map((v,i)=>v-p[i]);
              if(n[0]*(edge[1]*w[2]-edge[2]*w[1])+n[1]*(edge[2]*w[0]-edge[0]*w[2])+n[2]*(edge[0]*w[1]-edge[1]*w[0])<-length*1e-10)fail('unsupported','self-intersecting or concave polygon');
            }
          }
        }
        for(let k=1;k<count-1;k++)indices.push(vertexBase+face[0],vertexBase+face[reverse?k+1:k],vertexBase+face[reverse?k:k+1]);
      }
      if(cursor!==faces.length)fail('syntax','faceVertexCounts does not match indices');
      let color:LoadedGroup['color'];
      const binding=node.attrs.get('material:binding');
      if(binding&&typeof binding==='object'&&!Array.isArray(binding)&&'path' in binding) {
        const material=prims.get(binding.path),surface=material?.attrs.get('outputs:surface.connect');
        if(!surface||typeof surface!=='object'||Array.isArray(surface)||!('path' in surface))fail('unsupported','unsupported material binding');
        const shader=prims.get((surface as {path:string}).path.split('.outputs:')[0]);
        if(!shader||shader.attrs.get('info:id')!=='UsdPreviewSurface'||shader.attrs.has('inputs:diffuseColor.connect'))fail('unsupported','only constant UsdPreviewSurface colors are supported');
        const rgb=numbers(shader.attrs.get('inputs:diffuseColor')??[0.18,0.18,0.18],3),opacity=shader.attrs.get('inputs:opacity')??1;
        if(typeof opacity!=='number')fail('range','invalid opacity');color=[...rgb.map(v=>v<=0.0031308?v*12.92:1.055*v**(1/2.4)-0.055),opacity] as LoadedGroup['color'];
      }else {
        const display=node.attrs.get('primvars:displayColor');
        if(display!==undefined) {
          if(!Array.isArray(display)||display.length!==1)fail('unsupported','only uniform displayColor is supported');
          color=[...numbers(display[0],3).map(v=>v<=0.0031308?v*12.92:1.055*v**(1/2.4)-0.055),1] as LoadedGroup['color'];
        }
      }
      if(color?.some(v=>!Number.isFinite(v)||v<0||v>1))fail('range','invalid display color');
      groups.push({start,count:indices.length-start,name:typeof node.attrs.get('displayName')==='string'?node.attrs.get('displayName') as string:node.name,objectId:node.path,...color?{color}:{}});
    }else if(!['Xform','Scope','Material','Shader'].includes(node.type))fail('unsupported',`unsupported USD prim type ${node.type}`);
    for(const child of node.children)visit(child,world,hidden);
  }
  for(const root of roots)visit(root,base);
  if(!indices.length)fail('unsupported','stage contains no polygon meshes');
  const vertices=new Float32Array(positions),triangles=new Uint32Array(indices);
  return {kind:'mesh',positions:vertices,indices:triangles,normals:computeVertexNormals(vertices,triangles),groups};
}

/** Reads a USDZ root USDA layer; binary USDC and composed stages are unsupported. */
export async function parseUSDZ(input:BinaryInput,options:USDOptions={}):Promise<LoadedGeometry> {
  throwIfAborted(options.signal,F);
  for(const value of [options.maxEntries??10_000,options.maxEntryBytes??64*1024*1024])if(!Number.isSafeInteger(value)||value<0)fail('range','invalid ZIP limit');
  const bytes=toBytes(input,F),entries=readZipDirectory(bytes,options);
  const root=entries.reduce<typeof entries[number]|undefined>((first,entry)=>!first||entry.headerOffset<first.headerOffset?entry:first,undefined);
  if(!root||! /\.(usd|usda|usdc)$/i.test(root.name))fail('unsupported','USDZ first entry must be its root USD layer');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(const entry of entries) {
    if(entry.method!==0)fail('unsupported','USDZ entries must be stored without compression');
    if(entry.headerOffset+30>bytes.length)fail('syntax','truncated ZIP local header');
    const offset=entry.headerOffset+30+view.getUint16(entry.headerOffset+26,true)+view.getUint16(entry.headerOffset+28,true);
    if(offset%64)fail('syntax','USDZ entries must be aligned to 64 bytes');
  }
  const data=await readZipEntry(bytes,root,options);throwIfAborted(options.signal,F);
  if(new TextDecoder().decode(data.subarray(0,8))==='PXR-USDC')fail('unsupported','binary USDC is unsupported; convert the root layer to USDA with usdcat');
  return parseUSDA(data,options);
}
