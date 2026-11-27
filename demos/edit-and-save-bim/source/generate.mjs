import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {buildPavilion} from './model.mjs';
import {extractDoors, prepareIFC} from './door-values.mjs';

const checkout=process.env.MARGO_ENGINE_CHECKOUT;
assert.ok(checkout);
assert.equal(execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  '0efd9cff8230507a32deb49907ecd499d46925f5');
const packageModule=path=>import(pathToFileURL(resolve(checkout,path)));
const {IfcAPI,LogLevel}=await packageModule('node_modules/web-ifc/web-ifc-api-node.js');
const {openIFC,readIFCGeometry}=await packageModule('packages/ifc/dist/index.js');
const {readIFCData}=await packageModule('packages/ifc/dist/data.js');
const {editIFC,saveIFC,ifcGuidFromUUID}=await packageModule('packages/ifc/dist/write.js');
const api=new IfcAPI();
await api.Init();
api.SetLogLevel(LogLevel.LOG_LEVEL_ERROR);
const design=buildPavilion(i=>ifcGuidFromUUID('cdb656a4-5db9-4ffd-ab00-'+i.toString(16).padStart(12,'0')));
const source=new TextEncoder().encode(design.file);
const model=openIFC(api,source);
const data=readIFCData(model);
const geometry=readIFCGeometry(model);
const doors=extractDoors(data);
model.close();
assert.equal(data.schema,'IFC4');
assert.equal(doors.length,2);
assert.deepEqual(doors.map(d=>[d.rating,d.selfClosing]),[[30,true],[38,false]]);
assert.ok(doors.every(door=>data.elements.get(door.id).fills));
const edited=prepareIFC(api,source,[{guid:doors[0].guid,rating:46,selfClosing:false}],{openIFC,readIFCData,editIFC,saveIFC});
assert.deepEqual(edited.checked[0],{...doors[0],rating:46,selfClosing:false});
assert.deepEqual(edited.checked[1],doors[1]);
const saved=openIFC(api,edited.bytes);
const newGeometry=readIFCGeometry(saved);
saved.close();
assert.deepEqual(newGeometry.indices,geometry.indices);
assert.deepEqual(newGeometry.positions,geometry.positions);
assert.deepEqual(newGeometry.groups,geometry.groups);

const groupsByColor = new Map();
const doorIds=new Set(doors.map(d=>d.id));
const rgbColor=(color) => '#'+color.slice(0,3).map(value=>Math.round(value*255).toString(16).padStart(2,'0')).join('');
for(const group of geometry.groups){
  const {objectId,color}=group;
  const door=doorIds.has(+objectId)?+objectId:0;
  const paint=rgbColor(color);
  const key=door+'-'+paint;
  if(!groupsByColor.has(key))groupsByColor.set(key,{door,color:paint,positions:[],normals:[],indices:[],seen:new Map()});
  const mesh=groupsByColor.get(key);
  for(let j=group.start;j<group.start+group.count;j++){
    const from=geometry.indices[j];
    let to=mesh.seen.get(from);
    if(to===undefined){
      to=mesh.positions.length/3;
      mesh.seen.set(from,to);
      for(let k=0;k<3;k++){
        mesh.positions.push(Math.round(geometry.positions[3*from+k]*10000));
        mesh.normals.push(Math.round(geometry.normals[3*from+k]*127));
      }
    }
    mesh.indices.push(to);
  }
}
const meshes=[...groupsByColor.values()].map(({seen,...mesh})=>mesh);
const originalDoors=doors.map((door,index)=>({...door,...design.doors[index]}));
assert.ok(meshes.filter(mesh=>mesh.door).length>=8);
assert.ok(new Set(meshes.map(m=>m.color)).size>=9,JSON.stringify(meshes.map(m=>m.color)));
const asset=gzipSync(JSON.stringify({doors:originalDoors,meshes}),{level:9});
const path=(name)=>new URL(name,import.meta.url);
await Promise.all([writeFile(path('tern-pavilion.ifc'),source),writeFile(path('tern-pavilion.mesh'),asset)]);
console.log(JSON.stringify({doors:originalDoors, triangles:geometry.indices.length/3,
  materials:[...new Set(meshes.map(mesh=>mesh.color))], products:geometry.products.length,drawGroups:meshes.length,
  bytes:{ifc:source.length,mesh:asset.length,export:edited.bytes.length},
  inputHash:createHash('sha256').update(source).digest('hex'),
  exportGeometryExactlyEqual:true,untouchedDoorExactlyEqual:true}));
