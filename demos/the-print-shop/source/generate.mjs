import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const checkout=process.env.MARGO_ENGINE_CHECKOUT;
if(!checkout)throw Error('Set MARGO_ENGINE_CHECKOUT to the built public engine checkout.');
const use=path=>import(pathToFileURL(resolve(checkout,path)));
const [
  { model },
  { export3MF },
  { exportGCode },
  { parseGCode },
  { parse3MF },
] = await Promise.all([
  use('packages/brep/dist/index.js'),
  use('packages/exporters/dist/threemf.js'),
  use('packages/exporters/dist/gcode.js'),
  use('packages/loaders/dist/gcode.js'),
  use('packages/loaders/dist/index.js'),
]);
const {extrude,frameOf,cylinder,boolean,meshBodies,checkBody,massProperties}=model;
const coords=[[-.030,0,-.018],[-.023,0,-.025],[.018,0,-.025],[.030,0,-.015],[.030,0,.010],
  [.022,0,.025],[-.006,0,.025],[-.017,0,.016],[-.030,0,.016]];
const stock=extrude('kite-stock',{
  name:'kite-outline',start:coords[0],normal:[0,1,0],
  segments:[...coords.slice(1),coords[0]].map(to=>({kind:'line',to})),
},[0,.0084,0]);
const bore=(name,body,x,z,radius)=>boolean(name,'subtract',body,
  cylinder(name+'-cutter',radius,.013,frameOf([x,-.002,z],[0,1,0],[1,0,0])));
const original=[[-.015,0,.003],[.016,0,-.004]];
const output=async (name,bytes)=>{await mkdir(new URL('./assets/',import.meta.url),{recursive:true});await writeFile(new URL('./assets/'+name,import.meta.url),bytes);};

const packed=[];
for(const diameter of [8,11,14]){
  const exact=original.reduce((shape,[x,,z],index)=>bore('bore-'+index,shape,x,z,diameter*.0005),stock);
  assert.equal(checkBody(exact).length,0);
  const {meshes:[mesh]}=meshBodies([exact],{deflection:.000035,angle:.14});
  assert.equal(mesh.failures.length,0);
  const source={nodes:[{name:'Kite jig '+diameter+' mm',geometry:{positions:mesh.positions,normals:mesh.normals,indices:mesh.indices}}]};
  const buildFile=await export3MF(source,{unit:'millimeter',title:'Kite jig / '+diameter+' mm'});
  const built=await parse3MF(buildFile);
  assert.equal(built.indices.length,mesh.indices.length);
  const program=exportGCode(source,{upAxis:'y',scale:1000,center:[60,60],layerHeight:.28,firstLayerHeight:.28,
    infill:.19,lineWidth:.45,bedTemperature:0,nozzleTemperature:0,fan:0,startCode:'; Kite jig display toolpath',endCode:'; End of model paths'});
  const readback=parseGCode(program.text);
  assert.equal(readback.layers.length,program.layers);
  assert.equal(program.layers,30);
  assert.ok(Math.abs(readback.filament-program.filament)<.05);
  const layers=readback.layers.map(({z,extrusion,travel})=>{
    const convert=points=>Array.from(points).flatMap((n,i)=>i%3===2?[]:[Math.round((n-60)*1000)]);
    return {z:+z.toFixed(4),paths:convert(extrusion),travel:convert(travel)};
  });
  assert.ok(layers.every(layer=>layer.paths.length>0&&layer.paths.length%4===0));
  const mass=massProperties(exact);
  const expected=massProperties(stock).volume-2*Math.PI*(diameter*.0005)**2*.0084;
  assert.ok(Math.abs(mass.volume-expected)<1e-10);
  packed.push({diameter,volume:mass.volume,filament:program.filament,length:program.length,
    bounds:{min:program.min,max:program.max},layers,
    position:Array.from(mesh.positions,p=>+p.toFixed(7)),
    normal:Array.from(mesh.normals,n=>+n.toFixed(6)),index:Array.from(mesh.indices)});
  await output('kite-'+diameter+'.3mf',buildFile);
  await output('kite-'+diameter+'.gcode',program.text);
}
// The three solids as one glTF binary (meshopt, 16-bit normals), one node each; the page reads the toolpaths from the
// G-code files themselves with @margoengine/loaders/gcode.
const [{exportGLB},{compressMeshopt}]=await Promise.all([use('packages/exporters/dist/gltf.js'),use('packages/exporters/dist/meshopt.js')]);
const nodes=packed.map(({diameter,position,normal,index})=>({name:'kite-'+diameter,geometry:{positions:position,normals:normal,indices:index}}));
const {glb}=await compressMeshopt(exportGLB({nodes},{generator:'Margo Engine the-print-shop'}),{normalBits:16});
await mkdir(new URL('./assets/',import.meta.url),{recursive:true});
await output('kites.glb',glb);
const facts=packed.map(({diameter,volume,filament,length,layers})=>({diameter,volume,filament,length,layers:layers.length}));
await writeFile(new URL('./facts.json',import.meta.url),JSON.stringify(facts,null,1)+String.fromCharCode(10));
console.log(JSON.stringify({glbBytes:glb.byteLength,models:facts}));

// The print head: a hotend modelled on the standard 0.4 mm kit, tip at the origin, Y up, in metres. Brass nozzle (a
// revolved profile with its bore), a silicone sock over the heater block, the stainless heat break and ten aluminium
// cooling fins; the page gives each node its metal.
const {revolve,box,cylinder:post}=model;
const up=[0,1,0];
const nozzleProfile=[[.0002,0],[.0006,0],[.0027,.0032],[.0035,.0036],[.0035,.0083],[.0030,.0083],[.0030,.0125],[.0015,.0125],[.0015,.0050],[.0002,.0010]]
  .map(([x,y])=>[x,y,0]);
const heads=[
  revolve('nozzle',{name:'nozzle-profile',start:nozzleProfile[0],normal:[0,0,1],
    segments:[...nozzleProfile.slice(1),nozzleProfile[0]].map(to=>({kind:'line',to}))},{origin:[0,0,0],direction:up}),
  box('sock',[.022,.0143,.019],frameOf([-.011,.0072,-.0095],[0,0,1],[1,0,0])),
  post('heat-break',.003,.0305,frameOf([0,.0215,0],up,[1,0,0])),
  post('heatsink-core',.0045,.019,frameOf([0,.0285,0],up,[1,0,0])),
  ...Array.from({length:10},(_,i)=>post('fin-'+i,.0112,.001,frameOf([0,.0285+i*.002,0],up,[1,0,0]))),
];
for(const body of heads)assert.equal(checkBody(body).length,0,body.name);
const {meshes:headMeshes}=meshBodies(heads,{deflection:.000012,angle:.14});
assert.ok(headMeshes.every(mesh=>mesh.failures.length===0));
const headNodes=heads.map((body,i)=>({name:body.name,
  geometry:{positions:Array.from(headMeshes[i].positions,p=>+p.toFixed(7)),normals:Array.from(headMeshes[i].normals,n=>+n.toFixed(6)),indices:Array.from(headMeshes[i].indices)}}));
const {glb:headGlb}=await compressMeshopt(exportGLB({nodes:headNodes},{generator:'Margo Engine the-print-shop hotend'}),{normalBits:16});
await output('printhead.glb',headGlb);
console.log(JSON.stringify({printheadBytes:headGlb.byteLength}));
