// Terrain's lighting group holds what the effects declared, whatever bindings they chose. It used to take binding 2 for a
// depth array and everything unknown for a buffer, so VirtualShadows, with a flat pool and a page table, could not attach.
import assert from 'node:assert/strict';
import test from 'node:test';
import { lightingLayout } from '../src/lighting-layout.ts';

globalThis.GPUShaderStage ??= { FRAGMENT: 2 };
const bound = (...bindings) => bindings.map((binding) => ({ binding, resource: {} }));
const entry = (code, binding) => lightingLayout(code, bound(binding))[0];

test('a flat depth pool and an integer page table keep their own kinds', () => {
  const code = `@group(1) @binding(2) var shadowMap:texture_depth_2d;
@group(1) @binding(31) var shadowPages:texture_2d_array<u32>;`;
  assert.deepEqual(entry(code, 2).texture, { sampleType: 'depth', viewDimension: '2d' });
  assert.deepEqual(entry(code, 31).texture, { sampleType: 'uint', viewDimension: '2d-array' });
});

test('buffers and samplers come from the declaration, not the number', () => {
  const code = `@group(1) @binding(1) var<uniform> frame:Frame;
@group(1) @binding(2) var<storage,read> cells:array<vec2f>;
@group(1) @binding(3) var compare:sampler_comparison;
@group(1) @binding(14) var linear:sampler;`;
  assert.deepEqual(entry(code, 1).buffer, { type: 'uniform' });
  assert.deepEqual(entry(code, 2).buffer, { type: 'read-only-storage' });
  assert.deepEqual(entry(code, 3).sampler, { type: 'comparison' });
  assert.deepEqual(entry(code, 14).sampler, { type: 'filtering' });
});

test('only a texture read through a sampler must be filterable', () => {
  const code = `@group(1) @binding(40) var mask:texture_2d<f32>;
@group(1) @binding(41) var moments:texture_2d_array<f32>;
fn a(s:sampler,uv:vec2f)->vec4f {return textureSampleLevel(mask,s,uv,0.0)+textureLoad(moments,vec2i(0),0,0);}`;
  assert.equal(entry(code, 40).texture.sampleType, 'float');
  assert.equal(entry(code, 41).texture.sampleType, 'unfilterable-float');
});

test('other groups do not count: a binding group 1 never declared gets no entry, for createBindGroup to refuse', () => {
  const code = '@group(0) @binding(5) var<uniform> own:vec4f;';
  assert.deepEqual(lightingLayout(code, bound(5)), []);
});
