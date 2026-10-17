import test from 'node:test';
import assert from 'node:assert/strict';
import { optionalGPU } from './support/optional-gpu.js';
import { wgsl } from '../packages/core/src/shaders.ts';
import { box, PbrMaterial } from '../packages/core/dist/index.js';
import { TAA } from '../packages/taa/dist/index.js';
import { lighting } from '../packages/sky/src/lighting.ts';
import { Scatter } from '../packages/scatter/dist/index.js';
import { ToonShading } from '../packages/creative/dist/toon.js';
import { Shadows } from '../packages/shadows/dist/index.js';
import { Clustered } from '../packages/clustered/dist/index.js';
import { Transitions } from '../packages/transitions/dist/index.js';

function harness() {
  const h = optionalGPU();
  h.context.shader = wgsl;
  h.engine.lighting = { direction: new Float32Array([1, 2, 3, 1]), radiance: new Float32Array([1, 1, 1, 0.2]) };
  return h;
}

test('TAA jitter and sky ambient use distinct live bindings', () => {
  const h = harness(),
    taa = new TAA(),
    owned = [];
  const sky = lighting.create(h.engine.gpu, owned);
  h.engine.use(taa);
  h.engine.frameGraph.add({ name: 'audit:sky', order: -6, execute: (c) => sky.pass(c) });
  try {
    h.engine.frameGraph.execute(h.context);
    const bindings = h.context.bindings.map((entry) => entry.binding);
    assert.equal(new Set(bindings).size, bindings.length);
    const declarations = [...h.context.shader.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((m) => +m[1]);
    assert.equal(new Set(declarations).size, declarations.length);
    assert.match(h.context.shader, /o.clip=taaCamera\*p/);
    assert.match(h.context.shader, /skyAmbient.rgb/);
  } finally {
    taa.dispose();
    for (const resource of owned) resource.destroy();
    h.cleanup();
  }
});

test('PBR Scatter retains TAA jitter in the replacement vertex shader', () => {
  const h = harness(),
    taa = new TAA(),
    scatter = new Scatter(box(), { count: 1, material: new PbrMaterial() });
  h.engine.use(taa);
  h.engine.use(scatter);
  h.engine.lighting.ambient = new Float32Array([2, 0.5, 0]);
  try {
    h.engine.frameGraph.execute(h.context);
    const pipeline = h.pipelines.find((p) => p.vertex?.module.code.includes('lodVisible'));
    assert.match(pipeline.vertex.module.code, /o.clip=taaCamera\*vec4f\(o.position,1\)/);
    const frame = h.resources.find((r) => r.size === 128 && r.usage === 72);
    assert.deepEqual([...new Float32Array(frame.data).subarray(28, 32)], [2, 0.5, 0, 0]);
    assert.ok(
      h.groups.some((g) =>
        g.entries.some((e) => e.binding === taa.cameraBinding.binding && e.resource === taa.cameraBinding.resource),
      ),
    );
  } finally {
    scatter.dispose();
    taa.dispose();
    h.cleanup();
  }
});

test('Toon shading preserves directional shadows, clustered lights and unique bindings', () => {
  const h = harness(),
    toon = new ToonShading(),
    shadows = new Shadows(),
    lights = new Clustered();
  h.engine.use(toon);
  h.engine.use(shadows);
  h.engine.use(lights);
  try {
    h.engine.frameGraph.execute(h.context);
    const bindings = h.context.bindings.map((e) => e.binding);
    assert.equal(new Set(bindings).size, bindings.length);
    assert.match(h.context.shader, /shadowLit\(direct/);
    assert.match(h.context.shader, /clusterLighting\(/);
    assert.match(h.context.shader, /let direct=i.color\*band;/);
    assert.match(h.context.shader, /vec3f\(rim\)/);
  } finally {
    lights.dispose();
    shadows.dispose();
    toon.dispose();
    h.cleanup();
  }
});

for (const [format, manual] of [
  ['bgra8unorm', 1],
  ['rgba8unorm-srgb', 0],
  ['rgba16float', 0],
])
  test(`TAA color transfer matches ${format}`, () => {
    const h = harness(),
      taa = new TAA();
    h.context.format = format;
    h.engine.use(taa);
    try {
      h.engine.frameGraph.execute(h.context);
      assert.equal(taa.resolvePipeline.compute.constants?.manualSRGB, manual);
      assert.equal(taa.presentPipeline.fragment.constants?.manualSRGB, manual);
    } finally {
      taa.dispose();
      h.cleanup();
    }
  });

test('a transition requested before its first frame or resize remains active', () => {
  const h = harness(),
    transition = new Transitions();
  h.engine.use(transition);
  try {
    transition.start('wipe', 1);
    h.engine.frameGraph.execute(h.context);
    assert.equal(transition.progress, 0.1);
    const scene = transition.scene;
    h.context.width = 64;
    transition.start('dissolve', 1);
    h.engine.frameGraph.execute(h.context);
    assert.equal(transition.progress, 0.1);
    assert.equal(transition.previous, scene, 'resizing preserves the last rendered scene as the transition source');
    assert.equal(scene.destroyed, false);
    transition.start('radial', 1);
    h.engine.frameGraph.execute(h.context);
    assert.equal(transition.previous.width, 64, 'the next snapshot matches the resized scene');
  } finally {
    transition.dispose();
    h.cleanup();
  }
});
