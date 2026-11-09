import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { streamline, sampleField } from '@margoengine/sciviz/maths';
import { streamTubeGeometry, streamRibbonGeometry } from '@margoengine/sciviz/tubes';

const grid = (f) => {
  const u = [], v = [], w = [];
  for (const z of [-1, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) {
    const value = f(x, y, z); u.push(value[0]); v.push(value[1]); w.push(value[2] ?? 0);
  }
  return { u, v, w, dims: [2, 2, 2], bounds: [-1, 1, -1, 1, -1, 1] };
};

// The exact sink trajectory approaches zero monotonically and cannot cross its equilibrium.
test('streamline approaching an analytical stagnation point terminates without repeated or reversed steps', () => {
  const line = streamline({ dims: [2, 2, 1], bounds: [-1, 1, -1, 1, 0, 0],
    u: [1, -1, 1, -1], v: [1, 1, -1, -1] }, [0.13, 0, 0],
    { step: 0.1, maxSteps: 100, minSpeed: 1e-9, direction: 'forward' });
  for (let i = 3; i < line.positions.length; i += 3) {
    assert(line.positions[i] >= 0, 'a streamline cannot cross the equilibrium');
    assert(line.positions[i] < line.positions[i - 3], `zero or reversed progress at sample ${i / 3}`);
    assert.equal(line.positions[i + 1], 0);
  }
  assert(line.positions.length / 3 < 101, 'stagnation terminates before the step budget is exhausted');
  assert(line.positions.length > 6 && line.positions.at(-3) < 2e-7, 'resolves the approach, rather than stopping at the first rejected step');
});

test('3D sinks and backward sources converge without crossing, including nonzero minSpeed', () => {
  for (const sign of [-1, 1]) for (const minSpeed of [0, 1e-3]) {
    const field = grid((x, y, z) => [sign*x, sign*y, sign*z]);
    const line = streamline(field, [0.13, 0.13, 0.13],
      { step: 0.1, maxSteps: 100, minSpeed, direction: sign < 0 ? 'forward' : 'backward' });
    for (let i = 3; i < line.positions.length; i++)
      assert(line.positions[i] >= 0 && (sign < 0 ? line.positions[i] < line.positions[i-3] : line.positions[i] > line.positions[i-3]));
    assert((sign < 0 ? line.speeds.at(-1) : line.speeds[0]) < Math.max(2e-7, 1.01*minSpeed));
    assert(line.speeds.length < 101);
  }
  const field = grid((x,y,z) => [-x,-y,-z]);
  assert.equal(streamline(field,[0,0,0],{minSpeed:0}).positions.length,3);
});

test('a small closed orbit and a near-saddle passage are resolved, rather than classified as stagnation', () => {
  const circle = streamline(grid((x,y) => [-y,x]),[0.03,0,0],{step:0.1,maxSteps:150,direction:'forward'});
  assert.equal(circle.speeds.length,151);
  let angle = 0;
  for(let i=3;i<circle.positions.length;i+=3){
    const x=circle.positions[i],y=circle.positions[i+1],a=circle.positions[i-3],b=circle.positions[i-2];
    assert(Math.abs(Math.hypot(x,y)-0.03)<1e-6);
    const turn=Math.atan2(a*y-b*x,a*x+b*y); assert(turn>0 && turn<Math.PI/2);angle+=turn;
  }
  assert(angle>2*Math.PI,'continues around a true periodic orbit');
  const saddle=streamline(grid((x,y)=>[x,-y]),[0.001,0.13,0],{step:0.1,maxSteps:150,direction:'forward'});
  assert(saddle.positions.at(-3)>0.9,'passes the close encounter and exits along the unstable branch');
  for(let i=0;i<saddle.positions.length;i+=3){
    assert(saddle.positions[i]>0 && saddle.positions[i+1]>0);
    assert(Math.abs(saddle.positions[i]*saddle.positions[i+1]-0.00013)<1e-8,'saddle invariant xy');
  }
});

test('streamline bounds remain physical at rounding edges and invalid integration controls reject', () => {
  const field=grid(()=>[1,0,0]);
  assert.equal(sampleField(field,1+Number.EPSILON,0,0),null);
  assert.equal(sampleField(field,-1-Number.EPSILON,0,0),null);
  for(const options of [{step:0},{step:Infinity},{step:NaN},{maxSteps:0.5},{maxSteps:-1},{minSpeed:-1},{minSpeed:NaN},{direction:'else'}])
    assert.throws(()=>streamline(field,[0,0,0],options), /Streamline/);
  assert.equal(streamline(field,[0,0,0],{maxSteps:0}).positions.length,3);
});

test('all unchanged NOAA demo seeds and days trace without false cusps and build tubes and ribbons', () => {
  const raw=gunzipSync(readFileSync(new URL('../../../examples/assets/sciviz/wind.bin',import.meta.url))),
    data=new Float32Array(raw.buffer,raw.byteOffset,raw.byteLength/4),nx=49,ny=19,size=nx*ny,
    km=Math.PI*6371/180,cosine=Math.cos(42.5*Math.PI/180),
    bounds=[-60*km*cosine,60*km*cosine,-22.5*km,22.5*km,0,0];
  for(let day=0;day<8;day++){
    const east=data.subarray(day*2*size,(day*2+1)*size),north=data.subarray((day*2+1)*size,(day*2+2)*size),
      u=Float32Array.from(east,(v,i)=>v*cosine/Math.cos((20+Math.floor(i/nx)*2.5)*Math.PI/180)),
      field={u,v:north,dims:[nx,ny,1],bounds};
    for(let seed=0;seed<12;seed++){
      const line=streamline(field,[-3500+(seed%4)*2100,-1500+Math.floor(seed/4)*1400,0],{step:50,maxSteps:180});
      assert(line.speeds.length>=2,`day ${day}, seed ${seed}`);
      for(let i=3;i<line.positions.length;i+=3){
        const delta=Array.from(line.positions.slice(i,i+3),(v,c)=>v-line.positions[i-3+c]),
          velocity=sampleField(field,...line.positions.slice(i-3,i));
        assert(delta.reduce((sum,v,c)=>sum+v*velocity[c],0)>0,'ordered chord advances with the field');
      }
      const path={positions:line.positions,scalar:line.speeds},radius=Float64Array.from(line.speeds,v=>8+1.8*v);
      for(const mesh of [streamTubeGeometry(path,{radius,steps:64}),
        streamRibbonGeometry(path,{width:Float64Array.from(radius,v=>4*v),steps:64})]){
        assert(mesh.positions.every(Number.isFinite));assert(mesh.normals.every(Number.isFinite));
      }
    }
  }
});
