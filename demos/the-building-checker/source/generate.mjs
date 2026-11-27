import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {makeArchive,delivery} from './model.mjs';
import {encodeArchive,decodeArchive} from './asset.mjs';

const revision='0efd9cff8230507a32deb49907ecd499d46925f5';
const checkout=process.env.MARGO_ENGINE_CHECKOUT;
assert.ok(checkout,'Set MARGO_ENGINE_CHECKOUT to the verified public checkout.');
assert.equal(execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),revision);
const load = (path) => import(pathToFileURL(resolve(checkout,path)));
const {IfcAPI,LogLevel}=await load('node_modules/web-ifc/web-ifc-api-node.js');
const {openIFC,readIFCGeometry}=await load('packages/ifc/dist/index.js');
const {readIFCData}=await load('packages/ifc/dist/data.js');
const {writeIDS,parseIDS,checkIDS,bcfTopicsFromIDS}=await load('packages/ifc/dist/ids.js');
const {bcfFromView,viewFromBCF,writeBCF,readBCF}=await load('packages/ifc/dist/bcf.js');

const api = new IfcAPI();
await api.Init();
api.SetLogLevel(LogLevel.LOG_LEVEL_ERROR);
const encoder=new TextEncoder();
const ids=writeIDS(delivery);
const parsed=parseIDS(ids);
const archive=makeArchive();
const model=openIFC(api,encoder.encode(archive.file));
const data=readIFCData(model);
const geom=readIFCGeometry(model);
const report=checkIDS(model,parsed,{data});
model.close();

assert.equal(data.schema,'IFC4');
assert.equal(data.spatial.children[0].children[0].children.length,2);
assert.equal(report.specifications.length,2);
assert.deepEqual(report.specifications.map(s=>[s.applicable.length,s.passed.length,s.failures.length]),[[4,3,1],[4,3,1]]);
const idsForDoor=archive.doorRecords.map(d=>d.id);
assert.deepEqual(report.specifications.map(s=>s.applicable),[idsForDoor,idsForDoor]);
assert.deepEqual(report.specifications.map(s=>s.failures[0].id),[idsForDoor[0],idsForDoor[2]]);
const corrected=makeArchive({G01:{rating:'EI60'},M01:{selfClosing:true}});
const fixed=openIFC(api,encoder.encode(corrected.file));
assert.equal(checkIDS(fixed,parsed).pass,true);
fixed.close();
const missing=makeArchive({G01:{rating:null}});
const incomplete=openIFC(api,encoder.encode(missing.file));
assert.match(checkIDS(incomplete,parsed).specifications[0].failures[0].reason,/has no property FireRating/i);
incomplete.close();

const hidden=[...archive.display].filter(([,visual])=>visual.hidden).map(([id])=>id);
for(const entry of data.elements.values()) if(entry.type==='IfcOpeningElement')hidden.push(entry.id);
const overview=bcfFromView({
  guid:'4b9775de-c2c2-4ea7-aa20-cada24c45b00',
  camera:{type:'orthogonal',position:[11.5,14.7,19.3],target:[0,2.66,0],height:13.85,aspect:1.32},
  hidden,
},data);
const topics=bcfTopicsFromIDS(report,{author:'review@archive.example',date:'2026-11-27T00:00:00.000Z'});
for(const [i,topic] of topics.entries()) {
  const id=report.specifications[i].failures[0].id, element=data.elements.get(id);
  const door=archive.doorRecords.find(d=>d.id===id);
  const target=[door.x,door.y+1.25,door.z];
  const position=door.level?[door.x+2.38,door.y+3.46,door.z+7.7]:[door.x+2.68,door.y+2.8,door.z+8.2];
  topic.guid='4b9775de-c2c2-4ea7-aa20-cada24c45b0'+(i+1);
  topic.viewpoints=[bcfFromView({
    guid:'4b9775de-c2c2-4ea7-aa20-cada24c45b1'+(i+1),
    camera:{type:'perspective',position,target,fov:39,aspect:1.32},
    hidden,selected:[id],colors:new Map([[id,[.95,.29,.12]]]),
  },data)];
  for(const [commentId,comment] of topic.comments.entries()) {
    comment.guid='4b9775de-c2c2-4ea7-aa20-cada24c45c'+String(i*10+commentId).padStart(2,'0');
    comment.viewpoint=topic.viewpoints[0].guid;
  }
  topic.files=[{filename:'archive.ifc',isExternal:true,ifcProject:data.spatial.globalId}];
  assert.equal(topic.viewpoints[0].selection[0].ifcGuid,element.globalId);
}
const bcf=writeBCF({topics});
const roundTrip=await readBCF(bcf);
assert.equal(roundTrip.version,'3.0');
for(const [i,topic] of roundTrip.topics.entries()){
  const view=viewFromBCF(topic.viewpoints[0],data);
  const expected=report.specifications[i].failures[0].id;
  assert.deepEqual(view.selected,[expected]);
  assert.equal(view.unresolved.length,0);
  assert.ok(view.camera&&view.hidden.includes(hidden[0]));
  assert.ok(view.colors.has(expected));
}

const out = new Map();
const box=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
for(const group of geom.groups) {
  const id=Number(group.objectId);
  const meta=archive.display.get(id);
  if(!meta)continue;
  const keepUnique=meta.hidden||idsForDoor.includes(id);
  const key=keepUnique?id:meta.finish;
  if(!out.has(key))out.set(key,{id:keepUnique?id:0,finish:meta.finish,positions:[],normals:[],indices:[],use:new Map()});
  const mesh=out.get(key);
  for(let ref=group.start;ref<group.start+group.count;ref++){
    const vertex=geom.indices[ref];
    let to=mesh.use.get(vertex);
    if(to===undefined){
      to=mesh.positions.length/3;
      mesh.use.set(vertex,to);
      for(let k=0;k<3;k++){
        const coord=geom.positions[vertex*3+k];
        mesh.positions.push(Math.round(coord*10000));
        mesh.normals.push(Math.round(geom.normals[vertex*3+k]*127));
        box[k]=Math.min(box[k],coord);
        box[k+3]=Math.max(box[k+3],coord);
      }
    }
    mesh.indices.push(to);
  }
}
const meshes=[...out.values()].map(({use,...mesh})=>mesh);
assert.equal(meshes.filter(m=>idsForDoor.includes(m.id)).length,4);
for(const anchor of archive.doorRecords){
  const pos=meshes.find(m=>m.id===anchor.id).positions;
  const min=Math.min(...pos.filter((_,i)=>i%3===1))/10000;
  assert.ok(Math.abs(min-anchor.y)<.002,[anchor.id,min,anchor.y].join(' '));
}
const elements=[...data.elements.values()].map(({id,type,name,globalId,tag,aggregate,nest})=>({id,type,name,globalId,tag,aggregate,nest}));
const encoded=encodeArchive({schema:data.schema,elements,report,overview,doorRecords:archive.doorRecords,
  finishes:[...new Set(meshes.map(m=>m.finish))]},meshes);
const decoded=decodeArchive(encoded);
assert.equal(decoded.meshes.length,meshes.length);
for(const [i,mesh] of decoded.meshes.entries()){
  assert.equal(mesh.indices.length,meshes[i].indices.length);
  assert.ok(mesh.indices.every((value,j)=>value===meshes[i].indices[j]));
  assert.ok(mesh.positions.every((value,j)=>Math.abs(value-meshes[i].positions[j]/10000)<.000001));
}
const pack=gzipSync(encoded,{level:9});
const writes=[
  ['archive.ifc',archive.file],['requirements.ids',ids],['issues.bcf',bcf],['archive.mesh',pack],
];
await Promise.all(writes.map(([filename,content])=>writeFile(new URL(filename,import.meta.url),content)));
console.log(JSON.stringify({
  schema:data.schema, modelBounds:box,
  guids:idsForDoor.map(id=>data.elements.get(id).globalId),
  renderedProducts:geom.products.length,triangles:geom.indices.length/3,meshes:meshes.length,
  failures:report.specifications.map(s=>s.failures), correctedPass:true,missingPropertyFail:true,
  bcfTopics:roundTrip.topics.length,
  bytes:Object.fromEntries(writes.map(([k,v])=>[k,Buffer.byteLength(v)])),
  hashes:Object.fromEntries(writes.map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')])),
}));
