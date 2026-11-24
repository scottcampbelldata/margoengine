import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {teapotGeometry} from '../dist/teapot.js';
import {assertValid,assertUVRange,assertNormalsAgreeWithWinding} from './support/mesh-checks.js';

const raw=readFileSync(new URL('./fixtures/teapotCGA.bpt',import.meta.url),'utf8').trim().split(/\s+/).map(Number),patchCount=raw.shift(),patches=[];
for(let i=0;i<patchCount;i++){assert.deepEqual(raw.splice(0,2),[3,3]);patches.push(Array.from({length:16},()=>raw.splice(0,3)));}
function casteljau(points,t){let p=points.map(v=>v.slice());while(p.length>1)p=p.slice(1).map((b,i)=>b.map((v,k)=>p[i][k]*(1-t)+v*t));return p[0];}
const sample=(patch,u,v)=>casteljau(Array.from({length:4},(_,i)=>casteljau(patch.slice(i*4,i*4+4),v)),u);
const near=(a,b,tolerance=1e-6)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<=tolerance,`${v} != ${b[i]}`));

test('standard model has all 32 patches, exact cusp-free counts, finite unit normals and patch UVs',()=>{
  for(const n of [2,3,10,18]){
    const mesh=teapotGeometry(1,n);assertValid(mesh);assertUVRange(mesh);
    assert.equal(mesh.positions.length/3,32*(n+1)**2);assert.equal(mesh.indices.length/3,64*n*n-8*n);assert.equal(mesh.groups.length,32);
  }
  assertNormalsAgreeWithWinding(teapotGeometry());
  assertNormalsAgreeWithWinding(teapotGeometry(1,18));
});
test('every control-net patch agrees with independent two-dimensional de Casteljau evaluation',()=>{
  const n=7,mesh=teapotGeometry(1,n,{fitLid:false}),scale=1/1.575;
  for(let f=0;f<32;f++)for(let i=0;i<=n;i++)for(let j=0;j<=n;j++) {
    const p=sample(patches[f],i/n,j/n),at=(f*(n+1)**2+i*(n+1)+j)*3;
    near([...mesh.positions.slice(at,at+3)],[p[0]*scale,(p[2]-1.575)*scale,-p[1]*scale]);
  }
});
test('analytic normals agree with independent centered differences away from cusps and one-sided pole limits',()=>{
  const n=10,mesh=teapotGeometry(1,n,{fitLid:false,blinn:false}),h=1e-5;
  for(let f=0;f<32;f++)for(let i=1;i<n;i+=2)for(let j=1;j<n;j+=2){
    const u=i/n,v=j/n,a=sample(patches[f],u-h,v),b=sample(patches[f],u+h,v),c=sample(patches[f],u,v-h),d=sample(patches[f],u,v+h),du=b.map((x,k)=>x-a[k]),dv=d.map((x,k)=>x-c[k]),normal=[dv[1]*du[2]-dv[2]*du[1],dv[2]*du[0]-dv[0]*du[2],dv[0]*du[1]-dv[1]*du[0]],transformed=[normal[0],normal[2]*.75,-normal[1]],length=Math.hypot(...transformed),at=(f*(n+1)**2+i*(n+1)+j)*3;
    near([...mesh.normals.slice(at,at+3)],transformed.map(x=>x/length),2e-6);
  }
  for(const f of [20,21,22,23,28,29,30,31])near([...mesh.normals.slice(f*121*3,f*121*3+3)],[0,f<28?1:-1,0],1e-4);
});
test('body, lid and bottom switch independently; proportions and lid fit retain their stated scale',()=>{
  const n=5,counts=[];
  for(const [key,expected]of [['body',40*n*n],['lid',16*n*n-4*n],['bottom',8*n*n-4*n]]){
    const mesh=teapotGeometry(1,n,{body:false,lid:false,bottom:false,[key]:true});assertValid(mesh);assert.equal(mesh.indices.length/3,expected);counts.push(expected);
  }
  assert.equal(counts.reduce((a,b)=>a+b),teapotGeometry(1,n).indices.length/3);
  assert.equal(teapotGeometry(1,n,{body:false,lid:false,bottom:false}).positions.length,0);
  const a=teapotGeometry(2,n,{fitLid:false}),b=teapotGeometry(2,n,{fitLid:true}),c=teapotGeometry(2,n,{fitLid:false,blinn:false});
  for(let i=0;i<a.positions.length;i+=3){const part=Math.floor(i/3/(n+1)**2);near([b.positions[i],b.positions[i+2]],[a.positions[i]*(part>=20&&part<28?14/13:1),a.positions[i+2]*(part>=20&&part<28?14/13:1)]);near([c.positions[i+1]],[a.positions[i+1]*4/3]);}
  assert.throws(()=>teapotGeometry(0),RangeError);assert.throws(()=>teapotGeometry(1,1),RangeError);assert.throws(()=>teapotGeometry(1,176),RangeError);
  assert.throws(()=>teapotGeometry(1e300),RangeError);assert.throws(()=>teapotGeometry(1e-300),RangeError);
});
