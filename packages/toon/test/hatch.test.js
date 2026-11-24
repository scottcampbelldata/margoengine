import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hatching, HATCH_BINDING } from '../dist/hatch.js';
import { ToonShading } from '../../creative/dist/toon.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// Core's mesh shader, the first backtick-quoted text of packages/core/src/shaders.ts.
const core = readFileSync(new URL('../../core/src/shaders.ts', import.meta.url), 'utf8').split('`')[1];
const harness = () => {
  const h = optionalGPU();
  // A frame with core's shader: the graph's patch passes rewrite it in order, as the renderer runs them.
  h.frame = () => {
    Object.assign(h.context, { shader: core, bindings: [] });
    h.engine.frameGraph.execute(h.context);
    h.drawn = { shader: h.context.shader, bindings: [...h.context.bindings] };
  };
  return h;
};

test('hatching replaces the diffuse with the paper colour and inks over it, bound at its slot', () => {
  const h = harness(),
    hatch = Hatching.attach(h.engine, { style: 'halftone', spacing: 10, angle: 30, ink: [0.1, 0, 0] });
  let seen;
  h.context.draw = () => {
    seen = { shader: h.context.shader, bindings: [...h.context.bindings] };
  };
  h.frame();
  assert.ok(seen, 'the main pass drew');
  assert.match(seen.shader, /let ink=hatchInk\(i\.clip\.xy,light\);let direct=i\.color;/);
  assert.match(seen.shader, /let linear=mix\(.+,hatch\.ink\.rgb,ink\);/);
  assert.match(seen.shader, new RegExp(`@binding\\(${HATCH_BINDING}\\) var<uniform> hatch:Hatch`));
  const entry = seen.bindings.find((b) => b.binding === HATCH_BINDING),
    values = new Float32Array(entry.resource.buffer.data);
  assert.deepEqual([...values.subarray(0, 4)], [1, 10, 1.5, 3]);
  assert.ok(Math.abs(values[4] - Math.PI / 6) < 1e-6);
  assert.ok(Math.abs(values[8] - 0.1) < 1e-6);
  hatch.style = 'hatch';
  hatch.layers = 2;
  h.frame();
  assert.deepEqual([...new Float32Array(entry.resource.buffer.data).subarray(0, 4)], [0, 10, 1.5, 2]);
  for (const bad of [{ spacing: 1 }, { width: 20 }, { layers: 5 }, { style: 'dots' }, { ink: [2, 0, 0] }])
    assert.throws(() => hatch.set(bad), RangeError, JSON.stringify(bad));
  hatch.dispose();
  assert.ok(h.resources.filter((r) => r.destroy).every((r) => r.destroyed));
});

test('after ToonShading the hatching replaces its bands, keeping its rim', () => {
  const h = harness();
  ToonShading.attach(h.engine);
  Hatching.attach(h.engine);
  h.frame();
  const { shader } = h.drawn;
  assert.doesNotMatch(shader, /let direct=i\.color\*band;/);
  assert.match(shader, /let direct=i\.color;/);
  assert.match(shader, /vec3f\(rim\)/);
});
