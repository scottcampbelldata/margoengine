import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
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
const output=async (name,bytes)=>writeFile(new URL('./assets/'+name,import.meta.url),bytes);

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
const summaries=packed.map(({diameter,layers,filament})=>({diameter,layers:layers.length,filament}));
const opening=gzipSync(JSON.stringify(packed),{level:9});
await output('paths.bin',opening);
console.log(JSON.stringify({bundledBytes:opening.length,models:summaries}));
