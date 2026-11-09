import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../../splines/dist/index.js';
import { road } from '../dist/index.js';
import { junctions } from '../dist/junctions.js';

export const hairpin = () => new Spline([[-2,0,-8],[-2,0,8],[0,0,9],[2,0,8],[2,0,-8]]);
export function sampled(curve,n=128) {
  const p=new Float64Array(3),points=[];
  for(let i=0;i<=n;i++){curve.atDistance(curve.length*i/n,p);points.push([p[0],p[2]]);}
  return points;
}
function inspect(g,x=0.123,z=0.234) {
  let reversed=0, coverage=0, area=0;
  const v=g.vertices;
  for(let i=0;i<g.indices.length;i+=3) {
    const p=Array.from(g.indices.subarray(i,i+3),k=>[v[k*6],v[k*6+2]]);
    const side=(a,b,q)=>(b[0]-a[0])*(q[1]-a[1])-(b[1]-a[1])*(q[0]-a[0]);
    const a=side(...p);area-=a/2;if(a>=0)reversed++;
    const e=p.map((a,k)=>side(a,p[(k+1)%3],[x,z]));
    if(e.every(s=>s<0)||e.every(s=>s>0))coverage++;
  }
  return {reversed,coverage,area};
}
test('renderer precision triangulation repairs a local hairpin without inverted faces or double coverage',async()=>{
  const curve=hairpin();
  const folded=inspect(road(curve,{width:8,crossSection:[[-4,0],[4,0]]}).geometry);
  assert.ok(folded.reversed>0,'fixture really folds the old sweep');
  assert.ok(folded.coverage>1,'fixture overlaps the driving surface');
  const repaired=await junctions([{points:sampled(curve),width:8}]);
  const proof=inspect(repaired.geometry);
  assert.equal(proof.reversed,0);assert.equal(proof.coverage,1);
  // Every boundary is first rounded to float32, so reported polygon area and rendered triangle area agree.
  assert.ok(Math.abs(proof.area-repaired.area)<1e-8);
  assert.ok(inspect(repaired.geometry,12.123,0.234).coverage===0);
});
