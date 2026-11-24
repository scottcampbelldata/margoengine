import test from 'node:test';
import assert from 'node:assert/strict';
import { NurbsCurve, NurbsSurface, nurbsCircle, nurbsRevolve } from '../dist/nurbs.js';
import { insertNurbsKnot, elevateNurbsDegree, insertNurbsSurfaceKnot, elevateNurbsSurfaceDegree, trimmedNurbsSurfaceGeometry } from '../dist/nurbs-edit.js';
import { surfaceArea, assertValid, assertNormalsAgreeWithWinding } from './support/mesh-checks.js';

const near = (a,b,e=2e-10) => { assert.equal(a.length,b.length); a.forEach((v,i) => assert.ok(Math.abs(v-b[i]) < e, `${v} != ${b[i]}`)); };
function same(a,b) {
  assert.equal(a.start,b.start); assert.equal(a.end,b.end);
  for(let i=0;i<=113;i++) {
    const u=a.start+(a.end-a.start)*i/113;
    a.derivatives(u,2).forEach((v,k)=>near(v,b.derivatives(u,2)[k],2e-8));
  }
}
test('homogeneous insertion preserves rational circles, arbitrary domains, repeated knots and caller data',()=>{
  const a=nurbsCircle(2), before=JSON.stringify([a.points,[...a.knots],[...a.weights]]);
  same(a,insertNurbsKnot(insertNurbsKnot(a,0.13,2),0.5));
  assert.equal(JSON.stringify([a.points,[...a.knots],[...a.weights]]),before);
  const b=new NurbsCurve({degree:2,points:[[0,0],[1,3],[3,1],[4,0]],knots:[2,2,2,5,8,8,8],weights:[1,3,2,1]});
  same(b,insertNurbsKnot(b,4,2));
});
test('elevation preserves rational geometry, second derivatives and canonical knot multiplicities',()=>{
  for(const a of [nurbsCircle(2),new NurbsCurve({degree:3,points:[[0,0],[1,2],[2,-1],[3,4],[4,0],[5,1]],weights:[1,2,1,3,2,1]}),new NurbsCurve({degree:2,points:[[0,0],[1,3],[2,0],[4,1]],knots:[0,1,2,3,4,5,6]})]) {
    for(const t of [1,2,3]) {
      const b=elevateNurbsDegree(a,t); same(a,b); assert.equal(b.degree,a.degree+t);
      for(const k of new Set(a.knots)) if(k>a.start&&k<a.end) assert.equal([...b.knots].filter(x=>x===k).length,[...a.knots].filter(x=>x===k).length+t);
    }
  }
});
test('discontinuous segments and endpoint insertions keep both one-sided limits',()=>{
  const a=new NurbsCurve({degree:1,points:[[0,0],[1,1],[2,3],[4,5]],knots:[0,0,.5,.5,1,1]}),b=elevateNurbsDegree(a,2);
  same(a,b); near(a.derivatives(.5,0,true)[0],b.derivatives(.5,0,true)[0]);
  const c=new NurbsCurve({degree:2,points:[[0,0],[1,2],[2,1],[3,0]],knots:[0,1,2,3,4,5,6]});
  same(c,insertNurbsKnot(insertNurbsKnot(c,c.start,2),c.end,2));
});
test('surface refinement works independently on both rational control-net axes',()=>{
  const a=nurbsRevolve(nurbsCircle(2,-Math.PI/2,Math.PI/2));
  for(const direction of ['u','v']) for(const b of [insertNurbsSurfaceKnot(a,direction,.31,2),elevateNurbsSurfaceDegree(a,direction,2)]) {
    for(let i=0;i<=13;i++) for(let j=0;j<=11;j++) near(a.getPoint(i/13,j/11),b.getPoint(i/13,j/11));
  }
});
const plane=new NurbsSurface({degreeU:1,degreeV:1,points:[[[0,0,0],[0,1,0]],[[1,0,0],[1,1,0]]]});
test('trimmed surfaces respect concave outlines, reversed holes, islands and clipping outside the domain',()=>{
  const a=trimmedNurbsSurfaceGeometry(plane,[{contour:[[-1,-1],[.8,-1],[.8,.4],[.4,.4],[.4,1],[-1,1]],holes:[[[.1,.1],[.2,.1],[.2,.2],[.1,.2]]]},{contour:[[.9,.8],[1.1,.8],[1.1,1.1],[.9,1.1]]}],{slices:7,stacks:5});
  assertValid(a); assertNormalsAgreeWithWinding(a);
  assert.ok(Math.abs(surfaceArea(a)-(.8*.4+.4*.6-.01+.1*.2))<1e-7);
  for(let t=0;t<a.indices.length;t+=3) {
    const ids=[...a.indices.slice(t,t+3)],x=ids.reduce((s,i)=>s+a.uvs[i*2],0)/3,y=ids.reduce((s,i)=>s+a.uvs[i*2+1],0)/3;
    assert.ok((x<.8&&y<.4||x<.4||x>.9&&y>.8)&&!(x>.1&&x<.2&&y>.1&&y<.2));
  }
  assert.equal(trimmedNurbsSurfaceGeometry(plane,[]).indices.length,0);
});
test('rational trim curves map to exact curved surfaces with UV chord control',()=>{
  const circle=nurbsCircle(.25), uv=new NurbsCurve({degree:circle.degree,points:circle.points.map(p=>[p[0]+.5,p[1]+.5]),knots:circle.knots,weights:circle.weights}),
    sphere=nurbsRevolve(nurbsCircle(1,-Math.PI/2,Math.PI/2)), mesh=trimmedNurbsSurfaceGeometry(sphere,{contour:uv},{slices:8,stacks:8,trimTolerance:1e-3});
  assertValid(mesh); assertNormalsAgreeWithWinding(mesh);
  for(let i=0;i<mesh.positions.length;i+=3) assert.ok(Math.abs(Math.hypot(...mesh.positions.slice(i,i+3))-1)<1e-6);
  for(let i=0;i<mesh.uvs.length;i+=2) assert.ok(Math.hypot(mesh.uvs[i]-.5,mesh.uvs[i+1]-.5)<.250001);
});
test('invalid edits and trims fail explicitly',()=>{
  assert.throws(()=>insertNurbsKnot(nurbsCircle(),-1),RangeError);
  assert.throws(()=>insertNurbsKnot(nurbsCircle(),0),RangeError);
  assert.throws(()=>elevateNurbsDegree(nurbsCircle(),-.1),RangeError);
  assert.throws(()=>trimmedNurbsSurfaceGeometry(plane,{contour:[[0,0],[1,0]]}),RangeError);
  assert.throws(()=>trimmedNurbsSurfaceGeometry(plane,[],{slices:0}),RangeError);
  assert.throws(()=>insertNurbsSurfaceKnot(plane,'z',.5),RangeError);
});

test('trim cells preserve exact one-sided positions and normals at fully discontinuous surface knots',()=>{
  for(const axis of ['u','v']) {
    const rows=[[[0,0,0],[0,1,0]],[[.5,0,0],[.5,1,0]],[[.5,0,2],[.5,1,2]],[[1,0,2],[1,1,2]]],
      surface=new NurbsSurface({degreeU:1,degreeV:1,points:axis==='u'?rows:rows[0].map((_,j)=>rows.map(row=>row[j])),[axis==='u'?'knotsU':'knotsV']:[0,0,.5,.5,1,1]}),
      left=surface.derivatives(.5,.5,axis==='u',axis==='v'),right=surface.derivatives(.5,.5),
      mesh=trimmedNurbsSurfaceGeometry(surface,{contour:[[0,0],[1,0],[1,1],[0,1]]},{slices:3,stacks:3});
    assert.equal(left.point[2],0);assert.equal(right.point[2],2);assertValid(mesh);assertNormalsAgreeWithWinding(mesh);
    assert.ok(Math.abs(surfaceArea(mesh)-1)<1e-7);
    for(let t=0;t<mesh.indices.length;t+=3){const zs=[...mesh.indices.slice(t,t+3)].map(i=>mesh.positions[i*3+2]);assert.equal(Math.min(...zs),Math.max(...zs));}
  }
});
