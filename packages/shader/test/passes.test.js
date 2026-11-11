import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NodeMaterial,
  cameraPosition,
  discard,
  materialColor,
  normalLocal,
  positionLocal,
  positionWorld,
  sin,
  texture,
  uniform,
  uv,
  vec3,
  vec4,
  viewDirection,
} from '../dist/index.js';
import { LightingMaterial } from '../dist/lighting.js';
import { PassMaterial } from '../dist/pass.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Texture } from '../../materials/dist/index.js';
import { displacedDepth } from '../../shared/displacement.js';
import { instancedDepth } from '../../shared/instances.js';
import { displacementGroup } from '../../shared/caster.js';

const { pbrShader, extendedPBRShader, physicalShader } = await import('../../gltf-pro/src/shader.ts');
const { shadowDepth } = await import('../../shadows/src/shader.ts');
const { objectVelocity } = await import('../../taa/src/shader.ts');
const device = { fake: true };
const depth = (m, code = shadowDepth(true)) => {
  const record = m.caster(device);
  return { record, code: displacedDepth(code, 1, record) };
};
const wave = positionLocal.add(normalLocal.mul(sin(positionLocal.x)));

test('a positionNode that works from the position re-derives normals from its neighbours', () => {
  const m = new NodeMaterial({ positionNode: wave });
  for (const source of [pbrShader, extendedPBRShader, physicalShader()]) {
    const code = m.shader(source, 2);
    assert.ok(code.includes('o.normal=(f.normalMatrix*vec4f(margoNormal,0)).xyz;'));
    assert.ok(!code.includes('o.normal=(f.normalMatrix*vec4f(i.normal.xyz,0)).xyz;'));
  }
  assert.ok(m.vertexCode.includes('sin(margoA.x)') && m.vertexCode.includes('sin(margoB.x)'), m.vertexCode);
  assert.ok(m.vertexCode.indexOf('margoCross') < m.vertexCode.indexOf('let p=f.model'));
});

test('a positionNode that reads uv() takes the normal of each triangle in the fragment', () => {
  const m = new NodeMaterial({ positionNode: positionLocal.add(normalLocal.mul(uv().x)) });
  assert.ok(!m.vertexCode.includes('margoNormal'));
  assert.ok(m.fragmentCode.includes('dpdx(i.position)'));
  const chosen = new NodeMaterial({ positionNode: wave, positionNormals: 'faces' });
  assert.ok(chosen.fragmentCode.includes('dpdx(i.position)') && !chosen.vertexCode.includes('margoNormal'));
  const told = new NodeMaterial({ positionNode: positionLocal.add(normalLocal.mul(uv().x)), positionNormals: 'neighbours' });
  assert.ok(told.vertexCode.includes('margoNormal'));
});

test('positionNormals keep, a normalNode and a graph with no positionNode leave the normals alone', () => {
  const kept = new NodeMaterial({ positionNode: wave, positionNormals: 'keep' });
  assert.ok(kept.shader(pbrShader, 2).includes('o.normal=(f.normalMatrix*vec4f(i.normal.xyz,0)).xyz;'));
  assert.ok(!kept.fragmentCode.includes('dpdx'));
  const told = new NodeMaterial({ positionNode: positionLocal.add(uv().x), normalNode: vec3(0, 1, 0) });
  assert.ok(!told.fragmentCode.includes('dpdx'));
  assert.equal(new NodeMaterial({ colorNode: vec3(1, 0, 0) }).vertexCode.trim(), 'let p=f.model*vec4f(i.position.xyz,1);');
});

test('the G-buffer pass reads the same patched vertex and surface as the colour pass', () => {
  const m = new NodeMaterial({ positionNode: wave, colorNode: discard(uv().x.lessThan(0.5), vec3(1, 0, 0)) }),
    code = m.shader(pbrShader, 2),
    gbuffer = code.slice(code.indexOf('@fragment fn gbuffer('));
  assert.ok(gbuffer.includes('surface(i,front)'));
  assert.equal(code.split('{ discard; }').length, 2, 'once, in surface()');
  assert.ok(code.indexOf('{ discard; }') < code.indexOf('@fragment fn fragment('));
});

test('a depth pass gets the position graph, with its world inputs through the caster matrix', () => {
  const m = new NodeMaterial({ positionNode: wave.add(positionWorld.mul(0)) }),
    { record, code } = depth(m);
  assert.match(record.key, /^n\d+$/);
  assert.ok(code.includes('vec4f(margoPosition,1)') && !code.includes('f.model*vec4f(i.position.xyz,1);o.uv'));
  assert.ok(code.includes('@location(1) normal:vec4f'));
  assert.ok(code.includes('margoPosition=') && code.includes('let margoWorld=(f.model*vec4f(i.position.xyz,1)).xyz;'));
  assert.equal(m.caster(device), record, 'one record per device');
  assert.notEqual(new NodeMaterial({ positionNode: wave }).caster(device).key, record.key);
});

test('instanced casters carry the instance matrix through every use of the model', () => {
  const m = new NodeMaterial({ positionNode: wave.add(positionWorld.mul(0)) }),
    { code } = depth(m),
    instanced = instancedDepth(code);
  assert.ok(!instanced.includes('f.model*vec4f('), 'no use is left without it');
});

test('a depth pass gets the graph discards through its own varyings', () => {
  const m = new NodeMaterial({ colorNode: discard(uv().x.lessThan(0.5), vec3(1, 0, 0)) }),
    { code } = depth(m);
  assert.ok(code.includes('@builtin(front_facing) front:bool'));
  assert.match(code, /struct Out \{[^}]*@location\(8\) ndv0:vec2f\}/);
  assert.ok(code.includes('o.ndv0=i.uv.xy;') && code.includes('if (i.ndv0.x < 0.5) { discard; }'), code);
  assert.ok(code.indexOf('{ discard; }') < code.indexOf('if(textureSampleLevel'), 'ahead of the alpha test');
});

test('the depth bind group holds what the depth shader reaches, not what only the colour reads', () => {
  const made = { createBindGroupLayout: (d) => d },
    map = new Texture({ data: new Uint8Array(16), width: 2, height: 2 }),
    m = new NodeMaterial({ positionNode: positionLocal.mul(uniform(1)), emissiveNode: texture(map).rgb }),
    { entries } = m.caster(made).layout();
  assert.ok(depth(m).code.includes('ndu'));
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.deepEqual(entries[0].buffer, { type: 'uniform' });
  const cut = new NodeMaterial({ colorNode: discard(texture(map).a.lessThan(0.5), vec3(1, 0, 0)) }).caster(made),
    kinds = cut.layout().entries.map((e) => Object.keys(e).find((k) => k !== 'binding' && k !== 'visibility'));
  assert.deepEqual(kinds.sort(), ['sampler', 'texture']);
  assert.equal(cut.cuts, true);
});

test('a constant move binds nothing, so an automatic layout gets no displacement group and an explicit one an empty group', () => {
  // WebKit sweep: materials cutout-passes and inspector shaders. A constant positionNode reaches no binding, so TAA's
  // velocity pipeline (layout 'auto') used group 0 only; getBindGroupLayout(1) was out of the default layout's range
  // (WebGPU 10.1.1 makes groups up to the highest one used), WebKit made it invalid and createBindGroup failed.
  const made = {
      createBindGroupLayout: (d) => d,
      createBuffer: (d) => ({ ...d, destroy() {} }),
      queue: { writeBuffer() {} },
    },
    moved = new NodeMaterial({ positionNode: positionLocal.add(vec3(1.2, 0, 0)) }).caster(made);
  assert.ok(moved, 'the move is a caster displacement');
  assert.deepEqual(moved.entries(), []);
  const groups = [],
    device = { createBindGroup: (d) => (groups.push(d), d) };
  let asked = 0;
  const auto = () => {
    asked++;
    throw new Error('an automatic layout has no group the shader does not use');
  };
  assert.equal(displacementGroup(device, auto, moved), undefined);
  assert.equal(asked, 0);
  const own = moved.layout();
  assert.deepEqual(own.entries, []);
  assert.deepEqual(displacementGroup(device, () => own, moved, true), { layout: own, entries: [] });
  // A move that reads a uniform still gets its group from the automatic layout.
  const read = new NodeMaterial({ positionNode: positionLocal.mul(uniform(1)) }).caster(made);
  assert.equal(displacementGroup(device, () => 'auto group 1', read).layout, 'auto group 1');
  assert.equal(groups.length, 2);
});

test('a graph with nothing for a depth pass has no caster, so it stays a static plain caster', () => {
  assert.equal(new NodeMaterial({ colorNode: vec3(1, 0, 0) }).caster(device), undefined);
  assert.equal(new NodeMaterial({ emissiveNode: vec3(1, 0, 0), opacityNode: 0.5 }).caster(device), undefined);
});

test('what a depth pass cannot read drops that half of the graph, and only that half', () => {
  const material = new NodeMaterial({
      positionNode: wave,
      colorNode: discard(materialColor.a.lessThan(0.5), vec3(1, 0, 0)),
    }),
    { code } = depth(material);
  assert.ok(code.includes('sin(i.position.x)') && !code.includes('{ discard; }'));
});

test('a depth shader without the hook points is refused with the fix', () => {
  const m = new NodeMaterial({ positionNode: wave });
  assert.throws(() => m.caster(device).depth('fn other() {}', 1), /caster depth shader/);
});

test('a depth pass reads the main camera from frame members, in both stages', () => {
  const moved = depth(new NodeMaterial({ positionNode: positionLocal.add(cameraPosition.mul(0.1)) })).code;
  assert.match(moved, /cameraEye/);
  assert.match(moved, /margoPosition=/);
  const cut = depth(
    new NodeMaterial({ doubleSided: true, colorNode: discard(viewDirection.z.lessThan(0.5), vec3(1, 0, 0)) }),
  ).code;
  assert.match(cut, /normalize\([^;]*cameraEye/);
  assert.match(cut, /discard;/);
});

test('the velocity variant moves and cuts the surface, and the previous vertex moves with it', () => {
  const graph = new NodeMaterial({
      doubleSided: true,
      positionNode: positionLocal.add(vec3(0, 1, 0)),
      colorNode: discard(uv().x.lessThan(0.5), vec3(1, 0, 0)),
    }),
    record = graph.caster(device),
    code = objectVelocity(true, false, false, false, true, false, record.velocity);
  assert.match(code, /margoPosition=/);
  assert.match(code, /let shift=margoPosition-i\.position\.xyz/);
  assert.match(code, /previousVertices\[index\*5\]\.xyz\+shift/);
  assert.match(code, /@builtin\(front_facing\) front:bool/);
  assert.match(code, /discard;/);
  assert.throws(() => record.velocity('not a velocity shader', 1), /standard velocity shader/);
});

test('the colour group holds what any stage of the colour pass reads, and not a block only depth passes read', () => {
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };
  globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
  const gpu = mockGPU().device,
    held = (material) => material.bindings(gpu).filter((entry) => entry.binding >= 48).length,
    value = uniform(0.5);
  assert.equal(held(new PassMaterial({ outputs: { loop: vec4(0, value, 0, 1) } })), 1, 'a uniform only an output reads');
  assert.equal(held(new LightingMaterial({ lightingNode: vec3(value) })), 1, 'a uniform only the lighting reads');
  assert.equal(held(new NodeMaterial({ colorNode: vec3(value) })), 1, 'a uniform the colour reads');
  assert.equal(held(new NodeMaterial({ positionNode: positionLocal.add(cameraPosition.mul(0.1)) })), 0, 'the depth camera');
});

test("a move that reads the graph's uniforms runs again on last frame's in TAA's velocity", () => {
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };
  globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
  const gpu = mockGPU(),
    shift = uniform(0),
    graph = new NodeMaterial({ positionNode: positionLocal.add(vec3(shift, 0, 0)) }),
    record = graph.caster(gpu.device);
  assert.ok(record.move.some((line) => line.includes('ndu.')), 'the move alone, reading the block');
  assert.ok(record.entries().every((e) => e.binding < record.program.next), 'last frame binds after the graph');
  graph.bindings(gpu.device);
  assert.equal(record.program.buffers.get(gpu.device).bytes.length % 16, 0, 'the block TAA copies');
  const code = objectVelocity(true, false, false, false, true, false, record.velocity, {
    move: record.move,
    binding: record.program.next,
  });
  assert.match(code, new RegExp(`@group\\(1\\) @binding\\(${record.program.next}\\) var<uniform> nduBefore:NdUniforms;`));
  assert.match(code, /\{var o:Out;var margoBefore=i\.position\.xyz;\{let margoWorld=\(f\.previousModel\*/);
  assert.match(code, /nduBefore\./);
  assert.match(code, /margoBefore=margoPosition;\}let margoWorld=\(f\.model\*/, 'last frame first, then this frame');
  assert.match(code, /previousVertices\[index\*5\]\.xyz\+margoBefore-i\.position\.xyz/);
  assert.doesNotMatch(code, /\+shift,1\)/);
  // A move that reads no uniform moves the same on both frames.
  const still = new NodeMaterial({ positionNode: positionLocal.add(vec3(0, 1, 0)) }).caster(gpu.device);
  assert.ok(!still.move.some((line) => line.includes('ndu.')));
});
