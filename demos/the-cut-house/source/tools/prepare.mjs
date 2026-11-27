import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const engine = process.env.MARGO_ENGINE_CHECKOUT;
const engineFile = (name) => pathToFileURL(resolve(engine, 'packages/ifc/dist', name));
const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const { ifcGuidFromUUID } = await import(engineFile('write.js'));
const { openIFC } = await import(engineFile('index.js'));
const { readIFCMeshes } = await import(engineFile('scene.js'));
const { readIFCData } = await import(engineFile('data.js'));
const { sectionIFC } = await import(engineFile('section.js'));
const require = createRequire(resolve(engine, 'package.json'));
const { IfcAPI } = require('web-ifc');

const statements = [];
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
const decimal = (n) => n.toFixed(6);
const coords = (v) => '(' + v.map(decimal).join(',') + ')';
const list = (ids) => '(' + ids.join(',') + ')';
const sha = (data) => createHash('sha256').update(data).digest('hex');
function guid(key) {
  const hash = sha('cut-house/' + key);
  return quote(ifcGuidFromUUID([hash.slice(0,8),hash.slice(8,12),'4'+hash.slice(13,16),'8'+hash.slice(17,20),hash.slice(20,32)].join('-')));
}
function add(type, fields) {
  const id = '#' + (statements.length + 1);
  statements.push(id + '=' + type + '(' + fields.join(',') + ');');
  return id;
}
const pt = (values) => add('IFCCARTESIANPOINT',[coords(values)]);
const axis = (values) => add('IFCDIRECTION',[coords(values)]);
const up = axis([0,0,1]), east = axis([1,0,0]);
const zero = pt([0,0,0]);
const world = add('IFCAXIS2PLACEMENT3D',[zero,up,east]);
const local = add('IFCLOCALPLACEMENT',['$',world]);
const length = add('IFCSIUNIT',['*','.LENGTHUNIT.','$','.METRE.']);
const area = add('IFCSIUNIT',['*','.AREAUNIT.','$','.SQUARE_METRE.']);
const units = add('IFCUNITASSIGNMENT',[list([length,area])]);
const context = add('IFCGEOMETRICREPRESENTATIONCONTEXT',['$',quote('Model'),'3','0.000001',world,'$']);
const displayed = add('IFCGEOMETRICREPRESENTATIONSUBCONTEXT',[quote('Body'),quote('Model'),'*','*','*','*',context,'$','.MODEL_VIEW.','$']);

function root(type, key, name, fields) {
  return add(type,[guid(key),'$',quote(name),'$','$',...fields]);
}
const project = root('IFCPROJECT','project','The Cut House',[quote('Cut House'),'$',list([context]),units]);
const site = root('IFCSITE','site','Cliff garden',[local,'$','$','.ELEMENT.','$','$','$','$','$']);
const building = root('IFCBUILDING','building','Cut House',[local,'$',quote('Cut House'),'.ELEMENT.','$','$','$']);
const ground = root('IFCBUILDINGSTOREY','ground','Lower gallery',[local,'$',quote('Lower gallery'),'.ELEMENT.','0.000000']);
const upper = root('IFCBUILDINGSTOREY','upper','Reading gallery',[local,'$',quote('Reading gallery'),'.ELEMENT.','3.070000']);
const aggregate = (key, parent, children) => add('IFCRELAGGREGATES',[guid(key),'$','$','$',parent,list(children)]);
aggregate('project-site',project,[site]);
aggregate('site-building',site,[building]);
aggregate('building-storeys',building,[ground,upper]);

const productIds = {}, byStorey = new Map([[ground,[]],[upper,[]]]);
const shades = {
  plaster: ['Lime concrete',[.77,.70,.59],0],
  roof: ['Weathered zinc',[.27,.38,.39],0],
  deck: ['Smoked oak',[.56,.36,.22],0],
  trim: ['Patinated bronze',[.28,.43,.42],0],
  glass: ['Glazing',[.42,.65,.65],.66],
  fabric: ['Wool upholstery',[.47,.60,.51],0],
  textile: ['Ecru linen',[.76,.69,.52],0],
  dark: ['Graphite details',[.20,.25,.24],0],
  tiles: ['Limestone',[.70,.67,.56],0],
};
const styles = Object.fromEntries(Object.entries(shades).map(([key,[name,color,transparency]])=>{
  const rgb = add('IFCCOLOURRGB',[quote(name),...color.map(decimal)]);
  const shade = add('IFCSURFACESTYLESHADING',[rgb,decimal(transparency)]);
  return [key,add('IFCSURFACESTYLE',[quote(name),'.BOTH.',list([shade])])];
}));

function contour(points) {
  return add('IFCPOLYLINE',[list([...points,points[0]].map(pt))]);
}
const corners = ([x0,y0,x1,y1]) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
function extruded(style, outline, holes, [position, along, depthDirection], depth) {
  const profile = holes.length
    ? add('IFCARBITRARYPROFILEDEFWITHVOIDS',['.AREA.','$',contour(outline),list(holes.map(contour))])
    : add('IFCARBITRARYCLOSEDPROFILEDEF',['.AREA.','$',contour(outline)]);
  const placement = add('IFCAXIS2PLACEMENT3D',[pt(position),axis(depthDirection),axis(along)]);
  const solid = add('IFCEXTRUDEDAREASOLID',[profile,placement,up,decimal(depth)]);
  add('IFCSTYLEDITEM',[solid,list([styles[style]]),'$']);
  return solid;
}
function block(style, [x0,y0,z0,x1,y1,z1]) {
  return extruded(style,corners([0,0,x1-x0,y1-y0]),[],[[x0,y0,z0],[1,0,0],[0,0,1]],z1-z0);
}
function product(storey, type, tag, label, solids, kind = '.NOTDEFINED.') {
  const shape = add('IFCSHAPEREPRESENTATION',[displayed,quote('Body'),quote('SweptSolid'),list(solids)]);
  const representation = add('IFCPRODUCTDEFINITIONSHAPE',['$','$',list([shape])]);
  const id = root(type,tag,label,[local,representation,quote(tag),kind]);
  byStorey.get(storey).push(id);
  productIds[tag] = id;
  return id;
}
const member = (storey, tag, label, style, boxes) =>
  product(storey,'IFCBUILDINGELEMENTPROXY',tag,label,boxes.map((sizes)=>block(style,sizes)));
const slab = (storey, tag, label, style, sizes, role='.FLOOR.') =>
  product(storey,'IFCSLAB',tag,label,[block(style,sizes)],role);

function wall(storey, tag, label, across, start, run, base, height, thickness, openings) {
  const along = across === 'x' ? [1,0,0] : [0,1,0];
  const through = across === 'x' ? [0,-1,0] : [1,0,0];
  const placement = across === 'x' ? [start[0],start[1]+thickness,base] : [start[0],start[1],base];
  const solid = extruded('plaster',corners([0,0,run,height]),openings.map(corners),[placement,along,through],thickness);
  product(storey,'IFCWALL',tag,label,[solid],'.STANDARD.');
  for (const [i,[u0,h0,u1,h1]] of openings.entries()) {
    const toBox = (a, a1, b, b1, k0, k1) => across === 'x'
      ? [start[0]+a,start[1]+k0,base+b,start[0]+a1,start[1]+k1,base+b1]
      : [start[0]+k0,start[1]+a,base+b,start[0]+k1,start[1]+a1,base+b1];
    const edge = .047, center = thickness * .5;
    const rails = [
      toBox(u0,u1,h0,h0+edge,center-.04,center+.04),
      toBox(u0,u1,h1-edge,h1,center-.04,center+.04),
      toBox(u0,u0+edge,h0+edge,h1-edge,center-.04,center+.04),
      toBox(u1-edge,u1,h0+edge,h1-edge,center-.04,center+.04),
    ];
    if (u1-u0>2.64) {
      const a = (u1+u0)*.5;
      rails.push(toBox(a-edge*.5,a+edge*.5,h0+edge,h1-edge,center-.04,center+.04));
    }
    member(storey,tag+'-F'+i,'Bronze frame', 'trim', rails);
    if (h0>.1) member(storey,tag+'-G'+i,'Clear pane','glass',[
      toBox(u0+edge,u1-edge,h0+edge,h1-edge,center-.012,center+.012),
    ]);
  }
}

slab(ground,'S-01','Ground slab','tiles',[-5.60,-3.83,0,5.60,3.83,.19]);
slab(ground,'S-02','Front terrace','tiles',[-5.30,-4.86,.035,3.55,-3.86,.12],'.LANDING.');
slab(upper,'S-11','Mezzanine floor','deck',[.54,-3.51,2.94,5.39,3.50,3.13]);
slab(upper,'S-12','Stair landing','deck',[-.88,.35,2.94,.54,1.49,3.13],'.LANDING.');
slab(upper,'S-21','West roof','roof',[-5.67,-3.97,5.61,.40,3.96,5.84],'.ROOF.');
slab(upper,'S-22','East roof','roof',[.43,-3.98,5.96,5.67,3.98,6.17],'.ROOF.');
slab(upper,'S-23','Upper roof coping','trim',[.38,-4.015,5.93,5.72,-3.98,6.19],'.ROOF.');

wall(ground,'W-01','South gallery wall','x',[-5.39,-3.69],10.78,.19,2.78,.22,[[.63,.66,4.71,2.47],[6.10,.025,8.27,2.45]]);
wall(ground,'W-02','North gallery wall','x',[-5.39,3.47],10.78,.19,2.78,.22,[[1.02,.43,4.72,2.35],[7.16,.88,9.70,2.32]]);
wall(ground,'W-03','West atrium wall','y',[-5.39,-3.46],6.92,.19,2.78,.22,[[1.10,.52,5.75,2.42]]);
wall(ground,'W-04','East lower return','y',[5.17,-3.46],6.92,.19,2.78,.22,[[1.21,.81,3.91,2.39],[4.51,.87,6.28,2.38]]);
wall(upper,'W-11','South reading wall','x',[.62,-3.69],4.77,2.97,2.99,.22,[[.35,.82,4.18,2.41]]);
wall(upper,'W-12','North reading wall','x',[.62,3.47],4.77,2.97,2.99,.22,[[.54,.70,3.75,2.29]]);
wall(upper,'W-13','East upper return','y',[5.17,-3.46],6.92,2.97,2.99,.22,[[1.2,.67,3.31,2.44],[4.05,.73,6.40,2.47]]);
wall(upper,'W-14','West upper return','y',[-5.39,-3.46],6.92,2.97,2.64,.22,[[1.12,.54,5.78,2.17]]);
wall(upper,'W-15','North atrium clerestory','x',[-5.39,3.47],6.01,2.97,2.64,.22,[[.64,.48,4.91,2.19]]);
wall(upper,'W-16','South atrium clerestory','x',[-5.39,-3.69],6.01,2.97,2.64,.22,[[.65,.52,4.85,2.13]]);
wall(upper,'W-17','Roof step','y',[.42,-3.45],6.90,5.61,.34,.20,[]);
wall(ground,'W-05','Reading room partition','y',[.77,.48],2.98,.19,2.75,.15,[[.66,.023,1.61,2.22]]);
wall(ground,'W-06','Studio partition','x',[.78,.41],4.37,.19,2.75,.14,[[2.67,.022,3.61,2.22]]);
wall(upper,'W-18','Upper study partition','x',[.92,.84],4.24,3.13,2.81,.15,[[.97,.026,1.94,2.19]]);

const stairs = [];
for (let i = 0; i < 14; i++) {
  const z = .19 + i*.196, y = -3.09 + i*.246;
  stairs.push([-.84,y,z,-.04,y+.263,z+.194]);
}
member(ground,'ST-01','Oak stair flight','deck',stairs);
const balusters = Array.from({length: 9}, (_,i)=>[.56,-3.28+i*.428,3.135,.60,-3.246+i*.428,4.09]);
member(upper,'F-11','Mezzanine balustrade','trim',[...balusters,[.55,-3.29,4.053,.615,.16,4.105]]);
member(ground,'F-01','Gallery couch','fabric',[
  [-4.46,.66,.19,-2.07,1.61,.46],[-4.46,1.45,.46,-2.07,1.61,.95],
  [-4.48,.68,.45,-4.28,1.47,.63],[-2.24,.68,.45,-2.05,1.47,.63],
]);
member(ground,'F-02','Gallery table','deck',[
  [-4.13,-.35,.54,-2.47,.42,.63],[-4.06,-.27,.19,-3.96,-.17,.54],[-2.62,.21,.19,-2.52,.32,.54],
]);
member(ground,'F-03','Reading cabinet','deck',[
  [4.70,1.12,.19,5.12,3.22,.27],[4.71,1.12,.27,5.10,1.19,1.85],[4.71,3.14,.27,5.10,3.21,1.85],
  ...[.58,.91,1.23,1.56,1.83].map(z=>[4.71,1.19,z,5.10,3.14,z+.056]),
]);
member(ground,'F-04','Studio worktable','deck',[
  [2.27,-2.39,.92,4.45,-1.60,.99],[2.35,-2.31,.19,2.47,-2.19,.92],[4.26,-1.82,.19,4.38,-1.70,.92],
]);
member(upper,'F-12','Study desk','deck',[
  [3.19,-2.77,3.80,4.95,-1.92,3.87],[3.23,-2.73,3.13,3.34,-2.62,3.80],[4.80,-2.08,3.13,4.91,-1.97,3.80],
]);
member(upper,'F-13','Window bench','textile',[
  [1.31,2.52,3.13,3.53,3.12,3.52],[1.31,2.52,3.52,3.53,3.02,3.61],
]);
member(upper,'F-14','Desk chair','fabric',[
  [3.60,-1.76,3.60,4.19,-1.17,3.68],[3.60,-1.24,3.68,4.19,-1.17,4.19],[3.82,-1.54,3.13,3.94,-1.42,3.60],
]);
member(ground,'F-05','Gallery reading lamps','dark',[
  [-4.57,-.04,.19,-4.48,.05,1.71],[-4.70,-.19,1.64,-4.33,.20,1.79],
  [4.63,1.36,.19,4.71,1.44,1.60],[4.51,1.23,1.52,4.80,1.57,1.64],
]);

const spaces = [
  [ground,'R-101','Living gallery'],[ground,'R-102','Studio'],[ground,'R-103','Reading room'],
  [upper,'R-201','Upper study'],[upper,'R-202','Window gallery'],
];
for(const [storey,tag,name] of spaces){
  const room = root('IFCSPACE',tag,tag,[local,'$',quote(name),'.ELEMENT.','.INTERNAL.','$']);
  productIds[tag] = room;
  aggregate('room-'+tag,storey,[room]);
}
for(const [storey,children] of byStorey) {
  add('IFCRELCONTAINEDINSPATIALSTRUCTURE',[guid('contains-'+storey),'$','$','$',list(children),storey]);
}

const header = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');",
  "FILE_NAME('cut-house.ifc','2026-11-27T00:00:00',('Margo Web Demos'),('Margo Web Demos'),'Margo IFC authoring','The Cut House','');",
  "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
];
const source = [...header,...statements,'ENDSEC;','END-ISO-10303-21;',''].join('\n');
const bytes = Buffer.from(source,'utf8');
const api = new IfcAPI();
await api.Init();
const input = openIFC(api,bytes);
const geometry = readIFCMeshes(input);
const data = readIFCData(input,{properties:false});
input.close();
assert.equal(geometry.schema,'IFC4');
const idNum = (x) => Number(x.slice(1));
const elements = geometry.placements.map((p)=>p.element);
for (const [tag] of Object.entries(productIds).filter(([tag])=>/^W-\d{2}$/.test(tag))) {
  assert.ok(elements.includes(idNum(productIds[tag])), 'Missing geometry '+tag);
}
const products = [];
for (const [key, record] of data.elements) {
  if (!elements.includes(key)&&record.type!=='IfcSpace')continue;
  const tag = Object.entries(productIds).find(([,id])=>idNum(id)===key)?.[0] ?? '';
  products.push({id:key,name:record.type==='IfcSpace' ? record.attributes.LongName??record.name : record.name,
    type:record.type,globalId:record.globalId,tag});
}
assert.equal(products.filter((x)=>x.type==='IfcSpace').length,5);
const sectionSources = geometry.placements.map(p=>({element:p.element,geometry:geometry.geometries.get(p.geometry),matrix:p.matrix}));
const cut = (planes)=>sectionIFC(sectionSources,planes);
const vertical = cut([[0,0,-1,1.38]]), plan = cut([[0,-1,0,1.52]]);
assert.ok(vertical.filter((p)=>p.closed).length>=10);
assert.ok(plan.filter((p)=>p.closed).length>=8);
const payload = {
  schema:geometry.schema,origin:geometry.origin,products,sources:[...geometry.geometries].map(([key,g])=>[
    key,Array.from(g.positions),Array.from(g.normals),Array.from(g.indices),
  ]),
  placements:geometry.placements.map((p)=>({...p,matrix:Array.from(p.matrix)})),
  sourceSHA:sha(bytes),
};
const bin = gzipSync(JSON.stringify(payload),{level:9});
await writeFile(resolve(assets,'cut-house.ifc'),bytes);
await writeFile(resolve(assets,'building.bin'),bin);
console.log({products:products.length,placements:geometry.placements.length,colors:[...new Set(geometry.placements.map(p=>p.color.join(',')))],
  sourceBytes:bytes.length,packBytes:bin.length,cut:[vertical.length,plan.length],sectionAreas:[vertical.filter(p=>p.closed).length,plan.filter(p=>p.closed).length]});
