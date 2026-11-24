import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {importGeoJSON,importOSM} from '../dist/geojson.js';
import {road} from '../dist/index.js';
const local={project:p=>[p[0],p[2],p[1]]};
const feature=(coordinates,properties={},id='road')=>({type:'Feature',id,properties,geometry:{type:'LineString',coordinates}});
const collection=features=>({type:'FeatureCollection',features});
test('GeoJSON splits crossings, T junctions and collinear overlaps, retaining source identity and tags',()=>{
 const n=importGeoJSON(collection([feature([[-10,0],[10,0]],{highway:'primary',lanes:3,width:9},'a'),feature([[0,-10],[0,10]],{highway:'service'},'b')]),local);
 assert.equal(n.nodes.length,5);assert.equal(n.roads.length,4);const junction=n.nodes.findIndex(p=>p.every(v=>v===0));assert.equal(n.roads.filter(r=>r.from===junction||r.to===junction).length,4);
 for(const r of n.roads.filter(r=>r.sourceId==='a')){assert.equal(r.width,9);assert.equal(r.lanes,3);assert.deepEqual(r.laneWidths,[3,3,3]);assert.equal(r.curve.length,10);}
 const t=importGeoJSON(collection([feature([[0,0],[10,0]]),feature([[5,0,0.1],[5,10,0.1]],{},'t')]),local);
 assert.equal(t.roads.length,3);const id=t.nodes.findIndex(p=>p[0]===5&&p[2]===0);assert.equal(t.roads.filter(r=>r.from===id||r.to===id).length,3,'a height-tolerant endpoint shares the split trunk node');
 const overlap=importGeoJSON(collection([feature([[0,0],[10,0]]),feature([[3,0],[7,0]])]),local);assert.equal(overlap.roads.length,4);assert.equal(overlap.nodes.length,4);
 const multi=importGeoJSON({type:'GeometryCollection',geometries:[{type:'Point',coordinates:[0,0]},{type:'MultiLineString',coordinates:[[[0,0],[1,0]],[[1,0],[2,0]]]}]},local);assert.equal(multi.roads.length,2);assert.equal(multi.nodes.length,3);
});
test('grade-separated crossing lines and OSM ways never gain false connectivity',()=>{
 for(const properties of [{layer:1},{bridge:'yes'}]){const n=importGeoJSON(collection([feature([[-10,0],[10,0]]),feature([[0,-10],[0,10]],properties)]),local);assert.equal(n.nodes.length,4);assert.equal(n.roads.length,2);}
 const high=importGeoJSON(collection([feature([[-10,0],[10,0]]),feature([[0,-10,8],[0,10,8]])]),local);assert.equal(high.roads.length,2);
 const n=importOSM({elements:[...[[1,-10,0],[2,10,0],[3,0,-10],[4,0,10]].map(([id,lon,lat])=>({type:'node',id,lon,lat})),{type:'way',id:1,nodes:[1,2],tags:{highway:'primary'}},{type:'way',id:2,nodes:[3,4],tags:{highway:'primary'}}]},local);assert.equal(n.roads.length,2);assert.equal(n.nodes.length,4);
});
test('WGS84 ECEF to east/up/south matches closed-form equator and dateline cases',()=>{
 const a=6378137,rad=Math.PI/180*0.001,n=importGeoJSON(feature([[0,0,0],[0.001,0,0]]),{origin:[0,0,0]});
 const p=n.nodes[1];assert.ok(Math.abs(p[0]-a*Math.sin(rad))<1e-8);assert.ok(Math.abs(p[1]-a*(Math.cos(rad)-1))<1e-8);assert.equal(p[2],0);
 const date=importGeoJSON(feature([[179.999,0],[-179.999,0]]));assert.ok(Math.abs(date.nodes[1][0]-a*Math.sin(2*rad))<1e-7);
 assert.deepEqual(n.origin,[0,0,0]);assert.equal(importGeoJSON(collection([])).origin,null);
});
test('widths in metres/feet, directional lane counts, lane proportions, oneway and defaults',()=>{
 for(const [tag,width] of [['12 ft',3.6576],[`12' 6"`,3.81],['7 m',7]])assert.ok(Math.abs(importGeoJSON(feature([[0,0],[1,0]],{width:tag}),local).roads[0].width-width)<1e-12);
 const r=importGeoJSON(feature([[0,0],[1,0]],{tags:{highway:'residential','lanes:forward':'2','lanes:backward':'1','width:lanes':'3|4|5',width:'24',oneway:'-1',name:'Example'}}),local).roads[0];assert.deepEqual(r.laneWidths,[6,8,10]);assert.equal(r.direction,'reverse');assert.equal(r.tags.name,'Example');
 assert.equal(importGeoJSON(feature([[0,0],[1,0]],{highway:'motorway'}),local).roads[0].direction,'forward');
 assert.equal(importGeoJSON(feature([[0,0],[1,0]],{highway:'service'}),local).roads[0].width,3);
 const fallback=importGeoJSON(feature([[0,0],[1,0]],{lanes:'bad',width:'bad'}),local);assert.equal(fallback.warnings.length,2);assert.equal(fallback.roads[0].width,7);
});
test('OSM XML preserves IDs/entities, forward references, tags and shared-node topology',()=>{
 const xml=`<?xml version="1.0"?><osm version='0.6'><way id='-1'><nd ref='1'/><nd ref='2'/><tag k='highway' v='service'/><tag k='name' v='A &amp; B &#x3E; C'/></way><node id='1' lon='0' lat='0'/><node id='2' lon='0.001' lat='0'><tag k='ele' v='5'/></node></osm>`;
 const n=importOSM(xml,local);assert.equal(n.roads[0].tags.name,'A & B > C');assert.equal(n.roads[0].sourceId,'way/-1');assert.equal(n.nodes[1][1],5);
 assert.equal(importOSM(xml.replace("v='5'","v='-5 m'"),local).nodes[1][1],-5);
 const other=importOSM(xml,local);n.roads[0].tags.name='changed';assert.equal(other.roads[0].tags.name,'A & B > C');
 for(const doc of ['<osm><node></osm>','<!DOCTYPE osm><osm/>','<osm><node id="1" lon="a" lat="0"/></osm>','<osm><way id="1"><nd ref="2"/><nd ref="3"/><tag k="highway" v="service"/></way></osm>','<osm a="x" a="y"/>','<osm><node id="1" lon="0" lat="0"><tag k="x" v="A & B"/></node></osm>'])assert.throws(()=>importOSM(doc,local));
});
test('real Times Square OSM roads retain their graph and build renderable geometry',()=>{
 const xml=readFileSync(new URL('./fixtures/osm-times-square.osm',import.meta.url),'utf8'),n=importOSM(xml);
 assert.ok(n.roads.length>10);assert.ok(n.nodes.length>10);assert.ok(n.roads.some(r=>r.tags.name));
 for(const r of n.roads){assert.ok(r.width>0&&r.lanes>=1);const mesh=road(r.curve,{width:r.width,segments:1,crossSection:[[-r.width/2,0],[r.width/2,0]]});assert.ok(mesh.geometry.vertices.every(Number.isFinite));}
});
test('malformed inputs, bounds, cancellation and zero-length diagnostics',()=>{
 assert.equal(importGeoJSON(feature([[0,0],[0,0],[1,0]]),local).warnings.length,1);
 for(const doc of [{type:'FeatureCollection',features:0},feature([[NaN,0],[1,0]]),{type:'LineString',coordinates:[[0,0]]}])assert.throws(()=>importGeoJSON(doc,local));
 assert.throws(()=>importGeoJSON(feature([[200,0],[201,0]])));assert.throws(()=>importGeoJSON(feature([[0,0],[1,0]]),{project:()=>[Infinity,0,0]}));
 let nested=feature([[0,0],[1,0]]);for(let i=0;i<40;i++)nested={type:'GeometryCollection',geometries:[nested]};assert.throws(()=>importGeoJSON(nested,local));
 const reason=new Error('cancel');for(const run of [()=>importGeoJSON(collection([]),{signal:AbortSignal.abort(reason)}),()=>importOSM('<osm/>',{signal:AbortSignal.abort(reason)})])assert.throws(run,e=>e===reason);
});

test('GeoJSON joins T endpoints whose solved parameter rounds just outside the trunk segment (review 5)',()=>{
 // Before the fix about a third of these endpoints solved to u = -1e-17 or so and stayed unjoined (4 nodes, 2 roads).
 let seed=7;const random=()=>(seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32;
 for(let k=0;k<200;k++){
  const ax=random()*100-50,az=random()*100-50,bx=random()*100-50,bz=random()*100-50,s=0.2+0.6*random();
  const m=[ax+(bx-ax)*s,az+(bz-az)*s];
  const n=importGeoJSON(collection([feature([[ax,az],[bx,bz]],{},'trunk'),feature([m,[m[0]+10,m[1]+20]],{},'branch')]),local);
  assert.equal(n.roads.length,3,`case ${k}: the branch splits the trunk`);assert.equal(n.nodes.length,4,`case ${k}`);
 }
});
