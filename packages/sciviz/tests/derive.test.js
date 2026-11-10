import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveFlow, deriveFlowGPU } from '@margoengine/sciviz/derive';

export function sampled(fn, dims = [5, 4, 3], bounds = [-2, 2, -3, 3, -1, 1]) {
  const u = [], v = [], w = [];
  for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
    const p = [i, j, k].map((n, a) => bounds[2*a] + (dims[a] === 1 ? 0 : n/(dims[a]-1)*(bounds[2*a+1]-bounds[2*a])));
    const xyz = fn(...p); u.push(xyz[0]); v.push(xyz[1]); w.push(xyz[2]);
  }
  return { u, v, w, dims, bounds };
}
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a-b) <= tol, `${a} != ${b} (+/- ${tol})`);
const everywhere = (array, expected, tol) => Array.from(array).forEach((v, i) => near(v, expected[i % expected.length], tol));

test('general nonsymmetric gradients match an independent symmetric eigenvalue oracle', async () => {
  // Own deterministic integer matrices, oracle from NumPy eigvalsh of sym(J^2), never companion code.
  const cases=JSON.parse(readFileSync(new URL('./derive-eigen-oracle.json',import.meta.url)));
  for(const {j,lambda2} of cases){
    const r=await deriveFlow(sampled((x,y,z)=>[0,1,2].map(row=>j[3*row]*x+j[3*row+1]*y+j[3*row+2]*z)));
    everywhere(r.lambda2,[lambda2],2e-5);
  }
});

test('near-cancelling strain and rotation keep the lambda-2 sign at the exact centre stencil', async () => {
  const a=10000,b=a+1/1024;
  const r=await deriveFlow(sampled((x,y)=>[a*x+b*y,-b*x-a*y,0],[3,3,3],[-1,1,-1,1,-1,1]));
  const at=13, expected=b*b-a*a;
  near(r.q[at],expected,1e-5);near(r.lambda2[at],-expected,1e-5);
});

test('affine nonsymmetric Jacobian has physical signed spacings and row-major layout at every boundary', async () => {
  const j = [1, 2, -3, 4, -5, 6, -7, 8, 9];
  const g = sampled((x,y,z) => [1+x+2*y-3*z, -7+4*x-5*y+6*z, 9-7*x+8*y+9*z], [5,4,3], [2,-2,-3,3,1,-1]);
  const r = await deriveFlow(g);
  everywhere(r.gradient, j); everywhere(r.divergence, [5]); everywhere(r.curl, [2,4,2]);
  everywhere(r.vorticity, [Math.sqrt(24)]);
  // trace(J^2) = 1 + 25 + 81 + 2*(8+21+48) = 261.
  everywhere(r.q, [-130.5]);
  assert.deepEqual(r.dims, g.dims); assert.deepEqual(r.bounds, g.bounds);
});

test('quadratic derivatives are exact at interiors, faces, edges and corners', async () => {
  const r = await deriveFlow(sampled((x,y,z) => [x*x+2*y*y, y*y+3*z*z, z*z+4*x*x]));
  let at = 0;
  for (let k=0;k<3;k++) for(let j=0;j<4;j++) for(let i=0;i<5;i++,at++) {
    const x=i-2,y=2*j-3,z=k-1;
    [2*x,4*y,0,0,2*y,6*z,8*x,0,2*z].forEach((v,c)=>near(r.gradient[9*at+c],v));
  }
});

test('solid rotation, irrotational strain, pure shear and zero distinguish curl, Q and lambda-2', async () => {
  for (const [fn, curl, q, lambda2] of [
    [(x,y)=>[-3*y,3*x,0],[0,0,6],9,-9],
    [(x,y,z)=>[2*x,-2*y,z],[0,0,0],-4.5,4],
    [(x,y)=>[4*y,0,0],[0,0,-4],0,0],
    [()=>[0,0,0],[0,0,0],0,0],
    // Nonzero divergence: rotation dominance is -3/2, not the second invariant +3.
    [(x,y,z)=>[x,y,z],[0,0,0],-1.5,1],
  ]) {
    const r=await deriveFlow(sampled(fn)); everywhere(r.curl,curl);everywhere(r.q,[q]);everywhere(r.lambda2,[lambda2]);
  }
});

test('orthogonally rotated strain has repeated/clustered eigenvalues and scale covariance', async () => {
  // R diag(a,b,c) R^T, R rational orthogonal (Householder reflection).
  const rot=[[-2/3,2/3,1/3],[2/3,1/3,2/3],[1/3,2/3,-2/3]];
  for (const eigen of [[1,1,1],[-2,2,1],[1,1.0001,-3],[0,1e-4,2]]) for (const scale of [1e-12,1,1e12]) {
    const a=rot.map(row=>rot.map(col=>row.reduce((s,v,k)=>s+v*eigen[k]*col[k]*scale,0)));
    const r=await deriveFlow(sampled((...p)=>a.map(row=>row.reduce((s,v,k)=>s+v*p[k],0))));
    const expected=eigen.map(v=>v*v).sort((x,y)=>x-y)[1]*scale*scale;
    everywhere(r.lambda2,[expected],Math.max(1e-30,2e-6*scale*scale));
  }
});

test('singleton axes extend constantly; two-point axes use a secant in either direction', async () => {
  for (const dims of [[1,1,1],[2,1,1],[1,2,1],[1,1,2]]) {
    const bounds=dims.flatMap(n=>n===1?[4,4]:[7,-3]);
    const r=await deriveFlow(sampled((x,y,z)=>[2*x,3*y,4*z],dims,bounds));
    everywhere(r.gradient,[dims[0]===1?0:2,0,0,0,dims[1]===1?0:3,0,0,0,dims[2]===1?0:4]);
  }
});

test('mask propagation uses the full second-order stencil, never bridges a missing neighbour', async () => {
  const g=sampled(x=>[x,0,0],[7,1,1],[0,6,0,0,0,0]);g.mask=[1,1,1,0,1,1,1];
  const r=await deriveFlow(g);
  assert.deepEqual(Array.from(r.divergence),[1,1,NaN,NaN,NaN,1,1]);
  g.mask.fill(1);g.u[1]=NaN;
  const missing=await deriveFlow(g);
  for(const name of ['gradient','curl','divergence','vorticity','q','lambda2']) {
    const width=name==='gradient'?9:name==='curl'?3:1;
    for(const point of [0,1,2]) assert.ok(missing[name].subarray(point*width,(point+1)*width).every(Number.isNaN));
  }
});

test('owned snapshots and outputs remain independent after caller mutation', async () => {
  const g=sampled((x,y)=>[-y,x,0]), r=await deriveFlow(g);
  g.u.fill(9);g.dims[0]=99;g.bounds[0]=99;
  everywhere(r.q,[1]); assert.equal(r.dims[0],5); assert.equal(r.bounds[0],-2);
  const s=await deriveFlow(sampled(()=>[0,0,0]));r.q.fill(7);everywhere(s.q,[0]);
});

test('exact-reason cancellation before copying, during copying and CPU computation', async () => {
  const reason={stop:true};
  for(const cpu of [true,false]) {
    const c=new AbortController();c.abort(reason);
    await assert.rejects(cpu?deriveFlow(null,{signal:c.signal}):deriveFlowGPU(null,null,{signal:c.signal}),e=>e===reason);
  }
  const c=new AbortController(), pending=deriveFlow(sampled(()=>[0,0,0]),{signal:c.signal});c.abort(reason);
  await assert.rejects(pending,e=>e===reason);
  const d=new AbortController(), big=sampled(()=>[0,0,0],[50,50,4],[0,1,0,1,0,1]);
  let reads=0;big.u=new Proxy(big.u,{get(target,key){if(key==='8193'){reads++;setTimeout(()=>d.abort(reason),0);}return target[key];}});
  await assert.rejects(deriveFlow(big,{signal:d.signal}),e=>e===reason);assert.equal(reads,1);
});

test('invalid grids reject before any GPU allocation', async () => {
  for(const edit of [{dims:[0,2,2]},{dims:[2.5,2,2]},{dims:[1001,1000,1]}, {bounds:[0,0,0,1,0,1]},
    {bounds:[0,1e-40,0,1,0,1]},{u:[1]},{mask:[1]}, {u:new Array(60).fill(Infinity)},
    {u:new Array(60).fill(1e30)},{u:new Array(60).fill(undefined)},{w:null},{mask:null},
    {u:new Array(60).fill(1n)},{v:new Array(60).fill(Symbol('invalid'))}]) {
    const g={...sampled(()=>[0,0,0]),...edit};
    await assert.rejects(deriveFlow(g),e=>e instanceof RangeError && /https:\/\/margoengine.com\/errors#sciviz/.test(e.message));
    await assert.rejects(deriveFlowGPU(null,g),e=>e instanceof RangeError && /https:\/\/margoengine.com\/errors#sciviz/.test(e.message));
  }
});

test('GPU partial failures, nonconvergence and abort release all owned resources, never the context', async () => {
  const grid=sampled(()=>[0,0,0]);
  for(const mode of ['allocation','compile','dispatch','read','convergence','abort','success']) {
    const made=[], reason={mode}, controller=new AbortController();let calls=0;
    const allocate=()=>{
      if(mode==='allocation'&&++calls===5)throw reason;
      const obj={disposed:0,dispose(){this.disposed++;},async read(){
        if(mode==='read')throw reason;
        if(mode==='abort'){controller.abort(reason);controller.signal.throwIfAborted();}
        return new Uint32Array([mode==='convergence'?2:1]);
      }};made.push(obj);return obj;
    };
    const gpu={routeReady:Promise.resolve(),device:{limits:{maxBufferSize:1e8,maxStorageBufferBindingSize:1e8,
      maxStorageBuffersPerShaderStage:8,maxComputeWorkgroupsPerDimension:65535}},array:allocate,zeros:allocate,
      kernel(){if(mode==='compile')throw reason;const obj=allocate();obj.run=()=>{if(mode==='dispatch')throw reason;};return obj;},
      dispose(){assert.fail('caller compute context disposed');}};
    if(mode==='success'){
      const result=await deriveFlowGPU(gpu,grid);result[Symbol.dispose]();result.dispose();
      assert.deepEqual(made.map(x=>x.disposed),made.map(()=>1));
    }else{
      await assert.rejects(deriveFlowGPU(gpu,grid,{signal:controller.signal}),e=>mode==='convergence'?e.code==='failed':e===reason);
      assert.ok(made.every(x=>x.disposed===1),`${mode} leaked or double disposed`);
    }
  }
});
