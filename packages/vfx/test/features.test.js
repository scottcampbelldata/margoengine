import test from 'node:test';
import assert from 'node:assert/strict';
import { obstacles } from '@margoengine/vfx/obstacles';
import { wrap } from '@margoengine/vfx/wrap';
import { sort } from '@margoengine/vfx/sort';

const settle = 'particles[at]=p.positionLife;';
const force =
  'p.velocitySize=vec4f(p.velocitySize.xyz+(f.gravityDelta.xyz+curlNoise(p.positionLife.xyz))*dt,p.velocitySize.w);';
const simulation = `@group(0) @binding(1) var<storage> particles;\n@compute fn main(){\n${force}\n${settle}\n}`;

test('obstacles.write packs spheres and boxes into the uniform and counts them', () => {
  const extra = new Float32Array(524);
  obstacles.write(
    [
      { kind: 'sphere', center: [1, 2, 3], radius: 0.5 },
      { kind: 'box', center: [4, 5, 6], halfSize: [1, 2, 3] },
    ],
    extra,
  );
  assert.equal(new Uint32Array(extra.buffer)[8], 2);
  assert.deepEqual([...extra.slice(12, 20)], [1, 2, 3, 0, 0.5, 0.5, 0.5, 0]);
  assert.deepEqual([...extra.slice(20, 28)], [4, 5, 6, 1, 1, 2, 3, 0]);
  obstacles.write([], extra);
  assert.equal(new Uint32Array(extra.buffer)[8], 0, 'an empty list clears the count');
});

test('obstacles.write rejects bad lists with errors that name the fix', () => {
  const extra = new Float32Array(524);
  const sphere = { kind: 'sphere', center: [0, 0, 0], radius: 1 };
  assert.throws(
    () => obstacles.write(Array(65).fill(sphere), extra),
    (e) => e instanceof RangeError && /at most 64/.test(e.message),
  );
  assert.throws(
    () => obstacles.write([{ kind: 'cone', center: [0, 0, 0], radius: 1 }], extra),
    (e) => e instanceof RangeError && /'sphere' or 'box'/.test(e.message),
  );
  assert.throws(() => obstacles.write([{ ...sphere, radius: 0 }], extra), /above 0/);
  assert.throws(() => obstacles.write([{ kind: 'box', center: [0, 0, 0], halfSize: [1, -1, 1] }], extra), /above 0/);
  assert.throws(() => obstacles.write([{ ...sphere, center: [0, Number.NaN, 0] }], extra));
});

test('obstacles.patch adds the uniform, the distance function and both collision loops once', () => {
  const out = obstacles.patch(simulation);
  assert.match(out, /struct Extra/);
  assert.equal(out.split('fn obstacle(').length, 2);
  assert.ok(!out.includes(force), 'the plain force line is replaced by the obstacle-aware one');
  assert.equal(out.split('for(var i=0u;i<extra.count.x;i++)').length, 3, 'one loop for the flow, one for contact');
  assert.ok(out.includes(settle), 'the settle marker stays for later features');
});

test('wrap.patch re-enters particles through the opposite face of the emission box', () => {
  const out = wrap.patch(simulation);
  assert.match(out, /floor\(q\/span\)/);
  assert.match(out, /f\.velocitySpread\.xyz/);
  assert.ok(out.indexOf('floor(q/span)') < out.lastIndexOf(settle), 'wraps before the position is stored');
  assert.equal(out.split(settle).length, 2);
  assert.equal(wrap.patch('no marker here'), 'no marker here');
});

test('sort.create builds a bitonic network padded to the list size and clears stale slots first', () => {
  const had = 'GPUBufferUsage' in globalThis;
  globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
  const calls = [];
  const writes = [];
  const device = {
    createShaderModule: ({ code }) => ({ code }),
    createComputePipeline: ({ compute }) => ({ entry: compute.entryPoint, getBindGroupLayout: () => ({}) }),
    createBuffer: (d) => ({ size: d.size }),
    createBindGroup: () => ({}),
    queue: { writeBuffer: (_b, _o, data) => writes.push([...data]) },
  };
  const owned = [];
  const sorter = sort.create(device, {}, { size: 4096 }, {}, {}, 8, owned);
  if (!had) delete globalThis.GPUBufferUsage;
  assert.equal(owned.length, 6, 'k = 2, 4, 8 gives 1 + 2 + 3 compare-exchange stages');
  assert.deepEqual(writes, [
    [1, 2, 8, 0],
    [2, 4, 8, 0],
    [1, 4, 8, 0],
    [4, 8, 8, 0],
    [2, 8, 8, 0],
    [1, 8, 8, 0],
  ]);
  const pass = {
    setPipeline: (p) => calls.push(p.entry),
    setBindGroup: () => {},
    dispatchWorkgroups: (n) => calls.push(n),
  };
  sorter.run(pass);
  assert.deepEqual(calls.slice(0, 3), ['clear', 4, 'main']);
  assert.equal(
    calls.filter((c) => c === 4).length,
    7,
    'one clear dispatch plus six sort stages, ceil(4096 / 1024) each',
  );
});
