import test from 'node:test';
import assert from 'node:assert/strict';
import {geodesicGeometry,goldbergGeometry,hemisphereGeometry,tiledPlaneGeometry,tiledBoxGeometry} from '../dist/extras.js';
import {assertValid,assertNormalsAgreeWithWinding,assertUVRange,watertight,surfaceArea,signedVolume} from './support/mesh-checks.js';

test('geodesic classes I, II and III satisfy Euler counts and exactly twelve fivefold poles',()=>{
  for(const [m,n]of [[1,0],[2,0],[1,1],[2,1],[1,2],[3,2],[3,3],[5,0]]) {
    const mesh=geodesicGeometry({m,n,radius:2}),T=m*m+m*n+n*n;
    assertValid(mesh);assertNormalsAgreeWithWinding(mesh);watertight(mesh);assertUVRange(mesh);
    assert.equal(mesh.indices.length/3,20*T);
    const degree=new Map();
    for(let i=0;i<mesh.positions.length;i+=3){const p=[...mesh.positions.slice(i,i+3)];assert.ok(Math.abs(Math.hypot(...p)-2)<2e-7);const k=p.join(',');degree.set(k,(degree.get(k)??0)+1);}
    assert.equal(degree.size,10*T+2);assert.equal([...degree.values()].filter(n=>n===5).length,12);
    assert.ok([...degree.values()].every(n=>n===5||n===6),`${m},${n}: ${[...degree.values()]}`);
  }
});
test('Goldberg duals have pentagons then hexagons, paired adjacency and outward face-addressable UVs',()=>{
  for(const [m,n]of [[1,0],[1,1],[2,1],[3,2],[3,3]]) {
    const mesh=goldbergGeometry({m,n}),T=m*m+m*n+n*n;
    assertValid(mesh);assertNormalsAgreeWithWinding(mesh);watertight(mesh);assertUVRange(mesh);
    assert.equal(mesh.faces.length,10*T+2);
    assert.deepEqual(mesh.faces.slice(0,12).map(f=>f.length),new Array(12).fill(5));
    assert.ok(mesh.faces.slice(12).every(f=>f.length===6));
    mesh.faces.forEach((face,f)=>{assert.equal(mesh.adjacentFaces[f].length,face.length);for(const other of mesh.adjacentFaces[f])assert.ok(mesh.adjacentFaces[other].includes(f));});
    assert.ok(signedVolume(mesh)>0);
  }
});
test('hemisphere is closed by default with a hard flat cap and converges to analytic area and volume',()=>{
  const mesh=hemisphereGeometry(2,96,48);assertValid(mesh);assertNormalsAgreeWithWinding(mesh);watertight(mesh);
  assert.ok(Math.abs(surfaceArea(mesh)/(3*Math.PI*4)-1)<.002);
  assert.ok(Math.abs(signedVolume(mesh)/(2/3*Math.PI*8)-1)<.002);
  assert.equal(mesh.groups.length,2);assert.equal(hemisphereGeometry(1,8,4,false).groups,undefined);
});
test('all 63 tile pattern/alignment combinations cover exact bounds, preserve UV scale and face forward',()=>{
  for(const pattern of ['none','flip-tile','rotate-tile','flip-row','rotate-row','flip-rotate-tile','flip-rotate-row'])for(const alignHorizontal of ['left','center','right'])for(const alignVertical of ['bottom','center','top']) {
    const mesh=tiledPlaneGeometry({width:2.5,height:1.7,tileWidth:1,tileHeight:.6,pattern,alignHorizontal,alignVertical});
    assertValid(mesh);assertNormalsAgreeWithWinding(mesh);assertUVRange(mesh);assert.ok(Math.abs(surfaceArea(mesh)-4.25)<1e-6);
    for(let i=0;i<mesh.positions.length;i+=12){
      const width=mesh.positions[i+3]-mesh.positions[i],du=Math.abs(mesh.uvs[i/3*2+2]-mesh.uvs[i/3*2]);assert.ok(Math.abs(width-du)<1e-6);
    }
  }
  const centered=tiledPlaneGeometry({width:2.5,height:1}),xs=[...new Set([...centered.positions].filter((_,i)=>i%3===0))].sort((a,b)=>a-b);
  assert.deepEqual(xs,[-1.25,-1,0,1,1.25]);
  const small=tiledPlaneGeometry({width:.5,height:.5});assert.equal(small.indices.length,6);assert.equal(small.uvs[0],.25);
});
test('separate sides have independent UV rectangles and tiles retain box material groups and outward winding',()=>{
  const double=tiledPlaneGeometry({width:2,height:2,side:'double',frontUVs:[0,0,.5,1],backUVs:[.5,0,1,1]});assertValid(double);assertNormalsAgreeWithWinding(double);
  assert.equal(double.positions.length/3,32);assert.equal(surfaceArea(double),8);
  const box=tiledBoxGeometry({width:2.5,height:1.5,depth:.7,tileSize:.4,faceOptions:[{pattern:'flip-tile'}]});
  assertValid(box);assertNormalsAgreeWithWinding(box);watertight(box);assertUVRange(box);assert.equal(box.groups.length,6);
  assert.ok(Math.abs(signedVolume(box)-2.5*1.5*.7)<1e-6);
  assert.throws(()=>geodesicGeometry({m:0,n:0}),RangeError);assert.throws(()=>goldbergGeometry({n:-1}),RangeError);assert.throws(()=>tiledPlaneGeometry({tileSize:0}),RangeError);
});
