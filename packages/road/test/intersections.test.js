import test from 'node:test';
import assert from 'node:assert/strict';
import { intersections } from '../dist/intersections.js';
const cross=[{points:[[-10,0],[10,0]],width:4},{points:[[0,-10],[0,10]],width:4}];
const surfaceArea=g=>{let area=0;const p=g.vertices;for(let i=0;i<g.indices.length;i+=3){const [a,b,c]=Array.from(g.indices.subarray(i,i+3),j=>j*6);const y=(p[b+2]-p[a+2])*(p[c]-p[a])-(p[b]-p[a])*(p[c+2]-p[a+2]);assert.ok(y>0);area+=y/2;}return area;};
test('circular curb returns have analytic radius and area; union counts crossing once',async()=>{
  const result=await intersections(cross,{cap:'butt',turnRadius:2,arcTolerance:0.001});
  const expected=144+4*(4-Math.PI);
  assert.ok(Math.abs(result.area-expected)<0.02,`${result.area} vs ${expected}`);
  assert.ok(Math.abs(surfaceArea(result.geometry)-result.area)<1e-4);
  for(const p of result.footprint[0].contour) if(p[0]>2&&p[0]<4&&p[1]>2&&p[1]<4)assert.ok(Math.abs(Math.hypot(p[0]-4,p[1]-4)-2)<5e-7);
  assert.ok(result.curb.area>0&&result.sidewalk.area>0);
  assert.ok(result.curb.geometry.indices.length>0);
});
test('round caps and join styles match analytic corridor semantics',async()=>{
  const line=[{points:[[-5,0],[5,0]],width:4}];
  const r=await intersections(line,{turnRadius:0,curbWidth:0,sidewalkWidth:0,arcTolerance:0.001});
  assert.ok(Math.abs(r.area-(40+4*Math.PI))<0.02);
  assert.equal(r.curb,null);assert.equal(r.sidewalk,null);
  const bend=[{points:[[0,0],[10,0],[10,10]],width:4}];
  const opts={cap:'butt',turnRadius:0,curbWidth:0,sidewalkWidth:0};
  const m=await intersections(bend,{...opts,join:'miter'}),b=await intersections(bend,{...opts,join:'bevel'}),c=await intersections(bend,{...opts,join:'round'});
  assert.equal(m.area,80);assert.equal(b.area,78);assert.ok(c.area>b.area&&c.area<m.area);
});
test('all layers follow a shared slope, with outward normals and hard curb risers',async()=>{
  const result=await intersections(cross,{elevation:(x,z)=>1+x*0.1+z*0.2});
  for(const [layer,raise] of [[result,0],[result.sidewalk,0.15]]){
    const v=layer.geometry.vertices;
    for(let i=0;i<v.length;i+=6){assert.ok(Math.abs(v[i+1]-(1+v[i]*0.1+v[i+2]*0.2+raise))<5e-7);assert.ok(v[i+4]>0);}
  }
  assert.ok(Array.from(result.curb.geometry.vertices).some((v,i)=>i%6===4&&Math.abs(v)<1e-6));
});
test('T crossings, holes, ownership, abort, malformed and impossible designs',async()=>{
  const t=await intersections([cross[0],{points:[[0,0],[0,10]],width:4}],{cap:'butt'});assert.ok(t.area>112);
  const courtyard=await intersections([{points:[[-10,-10],[10,-10],[10,10],[-10,10],[-10,-10]],width:2}],{turnRadius:1});
  assert.equal(courtyard.footprint[0].holes.length,1);
  const input=structuredClone(cross),pending=intersections(input);input[0].points[0][0]=999;
  assert.deepEqual((await pending).geometry.vertices,(await intersections(cross)).geometry.vertices);
  const reason=new Error('cancel');await assert.rejects(intersections(cross,{signal:AbortSignal.abort(reason)}),e=>e===reason);
  for(const options of [{turnRadius:100},{elevation:()=>NaN},{join:'invalid'},{uvMeters:0}])await assert.rejects(intersections(cross,options));
  await assert.rejects(intersections([{points:[[0,0],[0,0]]}]));
});
