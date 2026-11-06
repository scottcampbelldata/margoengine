import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputePass, NodeMaterial, If, Let, float, storage, uint, vec3 } from '../dist/index.js';
import { halfFloats, packHalf2, subgroups, unpackHalf2 } from '../dist/subgroups.js';

const device = (...features) => ({ queue: {}, features: new Set(features) });
const fast = device('subgroups', 'shader-f16'),
  plain = device();

const pass = (build, options = { workgroupSize: 64 }) => new ComputePass(128, build, options).code;

test('a device with subgroups gets the hardware calls, an enable first and no early return', () => {
  const sg = subgroups(fast),
    data = storage(128, 'f32'),
    out = storage(128, 'f32');
  assert.equal(sg.supported, true);
  const code = pass((i) => out.store(i, sg.add(data.element(i)).add(float(sg.size))));
  assert.ok(code.startsWith('enable subgroups;\n'), code);
  assert.match(code, /= subgroupAdd\(/);
  assert.match(code, /@builtin\(subgroup_size\) sgs:u32/);
  assert.doesNotMatch(code, /return;/, 'lanes past the count still run, as a subgroup call needs them all');
});

test('the engine form reads the device from engine.gpu', () => {
  assert.equal(subgroups({ gpu: fast, features: ['subgroups'] }).supported, true);
  assert.equal(subgroups({ gpu: plain, features: ['subgroups'] }).supported, false, 'what was granted, not what was asked');
  assert.equal(subgroups({ gpu: null }).supported, false);
  assert.equal(halfFloats({ gpu: fast }).supported, true);
});

test('every operation maps to its WGSL builtin', () => {
  const sg = subgroups(fast),
    u = storage(128, 'u32'),
    f = storage(128, 'f32'),
    table = [
      ['subgroupMul', (x) => sg.mul(x)],
      ['subgroupMin', (x) => sg.min(x)],
      ['subgroupMax', (x) => sg.max(x)],
      ['subgroupInclusiveAdd', (x) => sg.inclusiveAdd(x)],
      ['subgroupExclusiveAdd', (x) => sg.exclusiveAdd(x)],
      ['subgroupInclusiveMul', (x) => sg.inclusiveMul(x)],
      ['subgroupExclusiveMul', (x) => sg.exclusiveMul(x)],
      ['subgroupBroadcastFirst', (x) => sg.broadcastFirst(x)],
      ['subgroupBroadcast', (x) => sg.broadcast(x, 3), ', 3u)'],
      ['subgroupShuffle', (x) => sg.shuffle(x, 2), ', 2u)'],
      ['subgroupShuffleUp', (x) => sg.shuffleUp(x, 1)],
      ['subgroupShuffleDown', (x) => sg.shuffleDown(x, 1)],
      ['subgroupShuffleXor', (x) => sg.shuffleXor(x, uint(1))],
    ];
  for (const [name, op, tail] of table) {
    const code = pass((i) => f.store(i, op(f.element(i))));
    assert.ok(code.includes(`= ${name}(`), name);
    if (tail) assert.ok(code.includes(tail), `${name} ${tail}`);
  }
  for (const [name, op] of [
    ['subgroupAnd', sg.and],
    ['subgroupOr', sg.or],
    ['subgroupXor', sg.xor],
  ])
    assert.ok(pass((i) => u.store(i, op(u.element(i)))).includes(`= ${name}(`), name);
  const lanes = pass((i) => {
    const big = f.element(i).greaterThan(0);
    return u.store(i, sg.all(big).toUint().add(sg.any(big).toUint()).add(sg.ballot(big).x).add(sg.elect().toUint()).add(sg.id));
  });
  for (const name of ['subgroupAll(', 'subgroupAny(', 'subgroupBallot(', 'subgroupElect()', 'subgroup_invocation_id'])
    assert.ok(lanes.includes(name), name);
});

test('a device without subgroups runs the same graph as one-lane subgroups, with no feature in the WGSL', () => {
  const sg = subgroups(plain),
    f = storage(128, 'f32'),
    u = storage(128, 'u32');
  assert.equal(sg.supported, false);
  const code = pass((i) => {
    const x = f.element(i),
      big = x.greaterThan(0);
    return [
      f.store(i, sg.add(x).add(sg.exclusiveAdd(x)).add(sg.exclusiveMul(x)).add(sg.shuffleUp(x, 1)).add(sg.broadcast(x, 0))),
      u.store(i, sg.size.add(sg.id).add(sg.ballot(big).x).add(sg.elect().toUint()).add(sg.all(big).toUint())),
    ];
  });
  assert.doesNotMatch(code, /subgroup|enable/);
  assert.match(code, /select\(0u, 1u, /);
  // The one-lane form keeps every operation's identity.
  assert.equal(sg.exclusiveMul(float(5)).emit(), '1.0');
  assert.equal(sg.exclusiveAdd(vec3(1, 2, 3)).emit(), 'vec3f(0.0)');
  assert.equal(sg.size.emit(), '1u');
  assert.equal(sg.id.emit(), '0u');
});

test('subgroup operations refuse what the hardware cannot do, and name the fix', () => {
  const sg = subgroups(fast),
    f = storage(128, 'f32');
  assert.throws(
    () => new ComputePass(100, (i) => f.store(i, sg.add(f.element(i))), { workgroupSize: 64 }),
    /runs whole workgroups, so its count must be a multiple of workgroupSize/,
  );
  assert.throws(
    () => new NodeMaterial({ emissiveNode: vec3(sg.add(float(1))) }),
    /subgroupAdd is only available in ComputePass nodes/,
  );
  assert.throws(
    () => new NodeMaterial({ emissiveNode: vec3(float(sg.size)) }),
    /subgroups.size is only available in ComputePass nodes/,
  );
});

test('a result kept with Let can feed a branch, which WGSL needs of a subgroup call', () => {
  const sg = subgroups(fast),
    data = storage(128, 'u32'),
    total = storage(1, 'u32', { atomic: true });
  const code = pass((i) => {
    const sum = Let(sg.add(data.element(i)));
    If(sg.elect(), () => total.atomicAdd(0, sum));
  });
  assert.ok(code.indexOf('subgroupAdd(') < code.indexOf('if ('), 'the call stays outside the branch');
});

test('half floats declare f16, write f16 literals and come back to f32', () => {
  const h = halfFloats(fast),
    out = storage(128, 'vec4f'),
    a = storage(128, 'vec4f');
  assert.equal(h.supported, true);
  const code = pass((i) => {
    const x = h.half(a.element(i).xyz),
      y = x.mul(0.5).add(h.half(float(1)));
    assert.equal(y.type, 'vec3h');
    assert.equal(y.x.type, 'f16');
    assert.equal(y.length().type, 'f16');
    assert.equal(h.full(y).type, 'vec3f');
    return out.store(i, vec3ToVec4(h.full(y)));
  }, undefined);
  assert.ok(code.startsWith('enable f16;\n'), code);
  assert.match(code, /vec3h\(/);
  assert.match(code, /0\.5h/);
  assert.match(code, /f16\(1\.0\)/);
  assert.match(code, /vec3f\(/);
});
const vec3ToVec4 = (v) => v.xyzz;

test('without shader-f16 the same graph stays f32 and the WGSL names no half type', () => {
  const h = halfFloats(plain),
    out = storage(128, 'f32'),
    a = storage(128, 'f32');
  assert.equal(h.supported, false);
  const code = pass((i) => out.store(i, h.full(h.half(a.element(i)).mul(0.5))), undefined);
  assert.doesNotMatch(code, /f16|\dh\b/);
});

test('a half float cannot leave a compute pass', () => {
  const h = halfFloats(fast);
  assert.throws(
    () => new NodeMaterial({ emissiveNode: h.full(h.half(vec3(1, 2, 3))) }),
    /half is only available in ComputePass nodes/,
  );
});

test('packed halves need no feature', () => {
  const out = storage(128, 'u32'),
    back = storage(128, 'vec2f');
  const code = pass((i) => [out.store(i, packHalf2(back.element(i))), back.store(i, unpackHalf2(out.element(i)))], undefined);
  assert.match(code, /pack2x16float\(/);
  assert.match(code, /unpack2x16float\(/);
  assert.doesNotMatch(code, /enable/);
});

test('an enable comes before the resources it is declared after', () => {
  const sg = subgroups(fast),
    h = halfFloats(fast),
    f = storage(128, 'f32');
  const code = pass((i) => f.store(i, h.full(sg.add(h.half(f.element(i))))));
  const lines = code.split('\n');
  assert.deepEqual(lines.slice(0, 2).sort(), ['enable f16;', 'enable subgroups;']);
  assert.equal(code.match(/enable /g).length, 2, 'each once');
});
