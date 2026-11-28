import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const checkout=process.env.MARGO_ENGINE_CHECKOUT;
if(!checkout)throw Error('Set MARGO_ENGINE_CHECKOUT to a built, verified checkout.');
const engine=from=>pathToFileURL(resolve(checkout,from));
const peer=JSON.parse(await readFile(resolve(checkout,'node_modules/web-ifc/package.json'),'utf8'));
assert.equal(peer.version,'0.0.78');
const {IfcAPI}=await import(engine('node_modules/web-ifc/web-ifc-api-node.js'));
const {openIFC,readIFCGeometry}=await import(engine('packages/ifc/dist/index.js'));
const {readIFCData,propertiesOf}=await import(engine('packages/ifc/dist/data.js'));

const lines=[];
const row=body=>{lines.push(body);return '#'+lines.length;};
const real=value=>Number(value.toFixed(6)).toString().replace(/^-?\d+$/,'$&.');
const list=values=>'('+values.join(',')+')';
const q=value=>"'"+value.replaceAll("'","''")+"'";
const alphabet='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const guid=name=>{
  let value=BigInt('0x'+createHash('sha256').update('raincourtyard/'+name).digest('hex').slice(0,32));
  let out='';
  for(let i=0;i<22;i++){out=alphabet[Number(value%64n)]+out;value/=64n;}
  return q(out);
};
const cp=coords=>row('IFCCARTESIANPOINT('+list(coords.map(real))+')');
const dir=coords=>row('IFCDIRECTION('+list(coords.map(real))+')');
const z=dir([0,0,1]), x=dir([1,0,0]);
const axis=coords=>row('IFCAXIS2PLACEMENT3D('+[cp(coords),z,x].join(',')+')');
const world=axis([0,0,0]);
const length=row('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
const area=row('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)');
const volume=row('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)');
const units=row('IFCUNITASSIGNMENT('+list([length,area,volume])+')');
const context=row("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,"+world+",$)");
const bodyCtx=row("IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,"+context+",$,.MODEL_VIEW.,$)");
const project=row("IFCPROJECT("+guid('project')+",$,'Rain Courtyard',$,$,$,$,("+context+"),"+units+")");
const globalPlacement=row('IFCLOCALPLACEMENT($,'+world+')');
const site=row("IFCSITE("+guid('site')+",$,'Courtyard lot',$,$,"+globalPlacement+",$,$,.ELEMENT.,$,$,$,$,$)");
const house=row("IFCBUILDING("+guid('house')+",$,'Rain Courtyard House',$,$,"+globalPlacement+",$,$,.ELEMENT.,$,$,$)");
const aggregate=(name,owner,children)=>row('IFCRELAGGREGATES('+[guid(name),'$','$','$',owner,list(children)].join(',')+')');
aggregate('site-aggregation',project,[site]);
aggregate('house-aggregation',site,[house]);
const levels=[
  {label:'Entry',height:0,footprint:[-4.5,-3.5,9,7]},
  {label:'Gallery',height:3.2,footprint:[-4.5,-2.8,8.1,6.3]},
  {label:'Roof studio',height:6.4,footprint:[-3.7,-1.6,6.3,4.55]},
];
for(const level of levels){
  level.ref=row('IFCBUILDINGSTOREY('+[guid(level.label),'$',q(level.label),'$','$',globalPlacement,'$','$','.ELEMENT.',real(level.height)].join(',')+')');
  level.items=[];
}
aggregate('storeys',house,levels.map(level=>level.ref));

const palette={
  timber:'Cedar',wall:'Sandstone',concrete:'Board-marked concrete',metal:'Bronze',glass:'Blue glass',roof:'Zinc',stone:'Travertine',felt:'Wool',green:'Sedum',wood:'Oak',
};
const materialNames=new Map(Object.entries(palette).map(([key,name])=>[key,row('IFCMATERIAL('+[q(name),'$',q(key)].join(',')+')')]));
const materialGroups=new Map(Object.keys(palette).map(name=>[name,[]]));
function boxSolid([startX,startY,startZ,sizeX,sizeY,sizeZ]){
  assert.ok(sizeX>0&&sizeY>0&&sizeZ>0);
  const profAxis=row('IFCAXIS2PLACEMENT2D('+cp([0,0])+',$)');
  const profile=row('IFCRECTANGLEPROFILEDEF(.AREA.,$,'+[profAxis,real(sizeX),real(sizeY)].join(',')+')');
  return row('IFCEXTRUDEDAREASOLID('+[profile,axis([startX+sizeX/2,startY+sizeY/2,startZ]),z,real(sizeZ)].join(',')+')');
}
function piece(level,type,name,style,solids,properties=null,predefined='.NOTDEFINED.'){
  const unique=level.label+'/'+name;
  const geometry=row("IFCSHAPEREPRESENTATION("+[bodyCtx,"'Body'","'SweptSolid'",list(solids.map(boxSolid))].join(',')+")");
  const shape=row('IFCPRODUCTDEFINITIONSHAPE($,$,('+geometry+'))');
  const ref=row('IFC'+type+'('+[guid(unique),'$',q(name),'$','$',globalPlacement,shape,'$',predefined].join(',')+')');
  level.items.push(ref);
  materialGroups.get(style).push(ref);
  if(properties){
    const items=Object.entries(properties).map(([key,[kind,value]])=>row('IFCQUANTITY'+kind+'('+[q(key),'$','$',real(value),'$'].join(',')+')'));
    const qto=row('IFCELEMENTQUANTITY('+[guid(unique+'/qto'),'$',q('Qto_WallBaseQuantities'),'$','$',list(items)].join(',')+')');
    row('IFCRELDEFINESBYPROPERTIES('+[guid(unique+'/qtoproperties'),'$','$','$',list([ref]),qto].join(',')+')');
    const external=row("IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$)");
    const common=row('IFCPROPERTYSET('+[guid(unique+'/pset'),'$',q('Pset_WallCommon'),'$',list([external])].join(',')+')');
    row('IFCRELDEFINESBYPROPERTIES('+[guid(unique+'/commonproperties'),'$','$','$',list([ref]),common].join(',')+')');
  }
  return ref;
}
const box=(x,y,z,w,d,h)=>[x,y,z,w,d,h];
const proxy=(level,name,style,solids)=>piece(level,'BUILDINGELEMENTPROXY',name,style,solids);
function wall(level,name,key,x,y,length,thickness,height,opening=null){
  const z=level.height;
  const along=(offset,elevation,distance,tall)=>{
    return key==='x'?box(x+offset,y,z+elevation,distance,thickness,tall):box(x,y+offset,z+elevation,thickness,distance,tall);
  };
  let shapes=[along(0,0,length,height)];
  let openingArea=0;
  if(opening){
    const [at,width,sill,top]=opening;
    openingArea=width*(top-sill);
    shapes=[along(0,0,at,height),along(at+width,0,length-at-width,height),along(at,top,width,height-top)];
    if(sill>0)shapes.push(along(at,0,width,sill));
  }
  const net=length*height-openingArea;
  return piece(level,'WALL',name,'wall',shapes,{
    Length:['LENGTH',length],Width:['LENGTH',thickness],Height:['LENGTH',height],
    NetSideArea:['AREA',net],NetVolume:['VOLUME',net*thickness],
  },'.STANDARD.');
}
function trim(level,x,y,wide,depth,doorAt,doorWidth){
  const z=level.height;
  const span=wide-.5;
  const glassStart=doorAt+doorWidth;
  if (span>glassStart+1.2) {
    proxy(level,'Courtyard glazing','glass',[box(x+glassStart,y+.095,z+.17,span-glassStart,.028,2.61)]);
    const mullions=[];
    for(let i=0;i<4;i++)mullions.push(box(x+glassStart+i*(span-glassStart)/3,y+.073,z+.14,.055,.095,2.68));
    proxy(level,'Glazing frames','metal',mullions);
  }
  const screen=[];
  for(let i=0;i<13;i++)screen.push(box(x+.24+i*.14,y-.135,z+.41,.051,.15,2.13));
  proxy(level,'Cedar sun screen','timber',screen);
  if(depth>5.5)proxy(level,'Rain terrace guard','metal',[
    box(x+wide-.06,y-.84,z+1.04,.052,2.07,.038),
    box(x+wide-.06,y-.85,z,.045,.043,1.06),
    box(x+wide-.06,y+.15,z,.045,.043,1.06),
    box(x+wide-.06,y+1.19,z,.045,.043,1.06),
  ]);
}
for(const level of levels){
  const [x0,y0,w,d]=level.footprint;
  const z=level.height;
  piece(level,'SLAB',level.label+' deck','concrete',[box(x0-.24,y0-.96,z-.23,w+.51,d+1.18,.23)],null,'.FLOOR.');
  const transom=2.68;
  wall(level,'Courtyard elevation','x',x0,y0,w,.24,3,[2.15,w-2.75,0,transom]);
  wall(level,'Garden elevation','x',x0,y0+d-.25,w,.25,3,[1.23,w-2.83,.63,2.59]);
  wall(level,'West garden wall','y',x0,y0+.24,d-.49,.245,3,[d*.20,d*.39,.68,2.52]);
  wall(level,'East gable wall','y',x0+w-.25,y0+.24,d-.49,.25,3);
  const rearGlass=box(x0+1.23,y0+d-.15,z+.63,w-2.83,.025,1.96);
  const sideGlass=box(x0+.101,y0+.24+d*.20,z+.68,.024,d*.39,1.84);
  proxy(level,'Garden glazing','glass',[rearGlass,sideGlass]);
  proxy(level,'Window heads','metal',[
    box(x0+1.20,y0+d-.161,z+2.572,w-2.77,.055,.045),
    box(x0+1.20,y0+d-.161,z+.614,w-2.77,.055,.045),
  ]);
  trim(level,x0,y0,w,d,2.15,1.32);
  proxy(level,'Reading bench','wood',[box(x0+w-1.79,y0+d-1.77,z+.39,1.30,.45,.14),box(x0+w-1.74,y0+d-1.74,z,.08,.39,.4),box(x0+w-.64,y0+d-1.74,z,.08,.39,.4)]);
  proxy(level,'Woven reading rug','felt',[box(x0+w-3.72,y0+d-2.11,z+.003,1.87,1.22,.017)]);
  proxy(level,'Stone planting trough','stone',[box(x0+.36,y0+.6,z,.83,.45,.42)]);
}
const base=levels[0], roof=levels[2];
proxy(base,'Courtyard paving','stone',[box(-6.2,-4.84,-.25,12.4,1.4,.23),box(4.72,-3.45,-.25,1.4,7.38,.23),box(-6.68,-3.45,-.25,2,7.38,.23)]);
proxy(base,'Rain garden','green',[box(4.82,-4.63,-.17,1.06,.96,.13),box(-5.86,-4.64,-.17,.97,.92,.15)]);
piece(roof,'SLAB','Studio roof','roof',[box(-3.96,-1.85,9.4,6.84,5.04,.16)],null,'.ROOF.');
proxy(roof,'Green roof','green',[box(-3.82,-1.70,9.56,6.56,4.74,.12)]);
proxy(roof,'Roof coping','metal',[box(-3.96,-1.85,9.56,6.84,.07,.14),box(-3.96,3.12,9.56,6.84,.07,.14),box(-3.96,-1.78,9.56,.07,4.90,.14),box(2.81,-1.78,9.56,.07,4.90,.14)]);
for(const floor of levels)row('IFCRELCONTAINEDINSPATIALSTRUCTURE('+[guid(floor.label+'/contain'),'$','$','$',list(floor.items),floor.ref].join(',')+')');
for(const [kind,items] of materialGroups)if(items.length)row('IFCRELASSOCIATESMATERIAL('+[guid(kind+'/material'),'$','$','$',list(items),materialNames.get(kind)].join(',')+')');

const text=[
  'ISO-10303-21;','HEADER;',
  "FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');",
  "FILE_NAME('rain-courtyard.ifc','2026-11-27T00:00:00',('Margo Demos'),('Margo'),'Margo Builder','Margo','');",
  "FILE_SCHEMA(('IFC4'));",'ENDSEC;','DATA;',
  ...lines.map((body,i)=>'#'+(i+1)+'='+body+';'),'ENDSEC;','END-ISO-10303-21;','',
].join('\n');
const api=new IfcAPI();
await api.Init();
const ifc=openIFC(api,new TextEncoder().encode(text));
const geo=readIFCGeometry(ifc,{maxTriangles:20000});
const info=readIFCData(ifc);
const pieces=new Map();
for(const group of geo.groups){
  const id=Number(group.objectId);
  if(!pieces.has(id))pieces.set(id,{position:[],normal:[],index:[],remap:new Map()});
  const part=pieces.get(id);
  for(const index of geo.indices.subarray(group.start,group.start+group.count)){
    if(!part.remap.has(index)){
      part.remap.set(index,part.remap.size);
      part.position.push(...Array.from(geo.positions.subarray(index*3,index*3+3),v=>+v.toFixed(5)));
      part.normal.push(...Array.from(geo.normals.subarray(index*3,index*3+3),v=>+v.toFixed(5)));
    }
    part.index.push(part.remap.get(index));
  }
}
const compiled=[];
for(const storey of info.spatial.children[0].children[0].children){
  const elements=[];
  for(const id of storey.elements){
    const geometry=pieces.get(id);
    if(!geometry)continue;
    const item=info.elements.get(id);
    const props=propertiesOf(info,id);
    const quantities=Object.fromEntries(Object.entries(props.Qto_WallBaseQuantities??{}).map(([key,entry])=>[key,entry.value]));
    const parsedMaterial=item.materials[0];
    const {position,normal,index}=geometry;
    elements.push({id,type:item.type,name:item.name,globalId:item.globalId,material:parsedMaterial?.name,
      elevation:storey.elevation,external:props.Pset_WallCommon?.IsExternal?.value,quantities,position,normal,index});
  }
  compiled.push({name:storey.name,elevation:storey.elevation,elements});
}
assert.deepEqual(compiled.map(floor=>floor.elevation),[0,3.2,6.4]);
assert.deepEqual(compiled.map(floor=>floor.elements.filter(e=>e.type==='IfcWall').length),[4,4,4]);
assert.ok(compiled.flatMap(f=>f.elements).every(e=>e.material&&e.index.length>0));
const example=compiled[0].elements.find(e=>e.name==='East gable wall');
assert.ok(Math.abs(example.quantities.NetVolume-4.8825)<1e-8,JSON.stringify(example.quantities));
ifc.close();
await writeFile(new URL('./assets/rain-courtyard.ifc',import.meta.url),text);
const parsed=gzipSync(JSON.stringify({schema:info.schema,floors:compiled}),{level:9});
await writeFile(new URL('./assets/house.bin',import.meta.url),parsed);
console.log(JSON.stringify({bytes:parsed.length,triangles:geo.indices.length/3,floors:compiled.map(x=>[x.name,x.elevation,x.elements.length])}));
