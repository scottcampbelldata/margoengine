import test from 'node:test';import assert from 'node:assert/strict';
import {Spline} from '@margoengine/splines';import {structures} from '../dist/structures.js';
const straight=(y=0)=>new Spline([[0,y,0],[0,y,40]]);
const bounds=g=>{const p=g.vertices,min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<p.length;i+=6)for(let k=0;k<3;k++){min[k]=Math.min(min[k],p[i+k]);max[k]=Math.max(max[k],p[i+k]);}return {min,max};};
const volume=g=>{const p=g.vertices,I=g.indices;let v=0;for(let i=0;i<I.length;i+=3){const [a,b,c]=Array.from(I.subarray(i,i+3),j=>Array.from(p.subarray(j*6,j*6+3)));v+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;}return v;};
test('automatic bridges make closed slabs of exact analytic volume and terrain-founded supports',()=>{
 const r=structures(straight(6));assert.deepEqual(r.spans,[{kind:'bridge',start:0,end:40}]);assert.equal(r.openings.length,0);assert.ok(r.supportPositions.length>=6);
 const b=bounds(r.decks.geometry);assert.deepEqual(b.min,[-3,5.5,0]);assert.deepEqual(b.max,[3,6,40]);assert.ok(Math.abs(volume(r.decks.geometry)-120)<1e-8);assert.ok(volume(r.supports.geometry)>0);
 for(const p of r.supportPositions)assert.equal(p[1],5.5);
 const valley=structures(straight(),{ground:(_x,z)=>Math.abs(z-20)-10});assert.deepEqual(valley.spans.map(s=>s.kind),['tunnel','bridge','tunnel']);
 for(const [i,[a,b]] of [[0,3.6],[13,27],[36.4,40]].entries()){assert.ok(Math.abs(valley.spans[i].start-a)<1e-12);assert.ok(Math.abs(valley.spans[i].end-b)<1e-12);}
});
test('tunnel walls, roof and annular portals leave a clear road opening for arch and box',()=>{
 for(const tunnelShape of ['arch','box']){
 const r=structures(straight(),{spans:[{kind:'tunnel',start:5,end:35}],tunnelShape});assert.equal(r.openings.length,2);assert.equal(r.decks.geometry.indices.length,0);assert.equal(r.supports.geometry.indices.length,0);
 assert.ok(r.tunnels.geometry.indices.length>100);assert.ok(r.portals.geometry.indices.length>0);
 const b=bounds(r.tunnels.geometry);assert.ok(Math.abs(b.min[0]+3.4)<1e-6);assert.ok(Math.abs(b.max[1]-5.4)<1e-6);assert.deepEqual(r.openings.map(p=>p.distance),[5,35]);
 assert.deepEqual(r.openings[0].outward,[0,0,-1]);assert.deepEqual(r.openings[1].outward,[0,0,1]);
 for(const o of r.openings){assert.ok(Math.abs(o.boundary[0][0]+3)<1e-10);assert.ok(Math.abs(o.boundary.at(-1)[0]-3)<1e-10);assert.ok(o.boundary.some(p=>Math.abs(p[1]-5)<1e-10));}
 // Independent box-shell volume: outer rectangle less inner rectangle, extruded 30 m.
 if(tunnelShape==='box')assert.ok(Math.abs(volume(r.tunnels.geometry)+volume(r.portals.geometry)-((6.8*5.4-6*5)*30))<1e-4);
 }
 const automatic=structures(straight(),{ground:(_x,z)=>Math.max(0,12-Math.abs(z-20))});assert.equal(automatic.spans.length,1);assert.ok(Math.abs(automatic.spans[0].start-14.4)<1e-12);assert.ok(Math.abs(automatic.spans[0].end-25.6)<1e-12);
});
test('crossings keep vertical clearance and no pier enters the other carriageway',()=>{
 const crossing={curve:new Spline([[-20,0,20],[20,0,20]]),width:8};
 const r=structures(straight(8),{crossings:[crossing],supportSpacing:8});assert.equal(r.spans[0].kind,'bridge');assert.ok(r.supportPositions.length>0);
 for(const p of r.supportPositions)assert.ok(Math.abs(p[2]-20)>4+1+0.8/Math.SQRT2);
 assert.throws(()=>structures(straight(4),{crossings:[crossing]}),/clearance/);
});
test('sloping deck/piers/ground and curved open portals use the correct world-space frames',()=>{
 const curve=new Spline([[0,6,0],[0,10,40]]),r=structures(curve,{ground:(_x,z)=>z*0.02,step:0.5});
 const v=r.supports.geometry.vertices;for(let i=0;i<v.length;i+=6){const y=v[i+1],z=v[i+2];assert.ok(Math.abs(y-z*0.02)<1e-6||Math.abs(y-(5.5+z*0.1))<1e-6,'pier corners meet both grade planes');}
 const c=new Spline([[0,0,0],[8,2,20],[0,4,40]]),t=structures(c,{spans:[{kind:'tunnel',start:5,end:c.length-5}]});
 for(const o of t.openings){assert.equal(o.outward[1],0);assert.ok(Math.abs(Math.hypot(...o.outward)-1)<1e-12);const a=o.boundary[0],b=o.boundary[1];assert.ok(Math.abs(o.outward[0]*(b[0]-a[0])+o.outward[1]*(b[1]-a[1])+o.outward[2]*(b[2]-a[2]))<1e-10);}
});
test('empty at-grade, span merging, ownership, cancellation and invalid designs',()=>{
 const r=structures(straight());assert.deepEqual(r.spans,[]);for(const name of ['decks','supports','tunnels','portals'])assert.equal(r[name].geometry.indices.length,0);
 const options={spans:[{kind:'bridge',start:0,end:20},{kind:'bridge',start:20,end:40}]};const a=structures(straight(6),options);assert.deepEqual(a.spans,[{kind:'bridge',start:0,end:40}]);assert.deepEqual(options.spans[0],{kind:'bridge',start:0,end:20});
 const reason=new Error('cancel');assert.throws(()=>structures(straight(),{signal:AbortSignal.abort(reason)}),e=>e===reason);
 for(const opts of [{step:0},{ground:()=>NaN},{width:-1},{archSegments:3},{spans:[{kind:'bridge',start:4,end:3}]},{spans:[{kind:'bridge',start:0,end:30},{kind:'tunnel',start:20,end:40}]},{spans:[{kind:'bridge',start:0,end:40}],ground:()=>10}])assert.throws(()=>structures(straight(6),opts));
 assert.throws(()=>structures(new Spline([[0,0,0],[0,10,0]])));
 assert.throws(()=>structures(new Spline([[0,6,0],[0,6,2],[1,6,2],[1,6,0]]),{step:0.1}),/fold/);
});
