import test from 'node:test';
import assert from 'node:assert/strict';
import { AreaShapes } from '../dist/area-shapes.js';
import { AreaLights } from '../dist/area.js';
import { Clustered } from '../dist/index.js';
import { LocalShadows } from '../dist/shadows.js';
import { Camera } from '../../core/dist/index.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('disk and sphere shadows coexist with rectangles, cache and honour unshadowed receivers', () => {
  const h = optionalGPU();
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  Object.assign(h.engine.gpu.limits, { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 });
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => ({ ...begin(d), setViewport() {} });
  const camera = new Camera({ position: [0, 5, 5], target: [0, 0, 0] });
  camera.update(1, true);
  h.context.camera = h.engine.camera = camera;
  const lights = Clustered.attach(h.engine, { grid: [1, 1, 1] }),
    local = LocalShadows.attach(h.engine, { lights, resolution: 64 }),
    shapes = AreaShapes.attach(h.engine, { lights }),
    rect = AreaLights.attach(h.engine, { lights });
  rect.setLights([{ position: [0, 3, 0], direction: [0, -1, 0], width: 1, height: 1, castShadow: true }]);
  shapes.setLights([
    { shape: 'disc', position: [1, 3, 0], direction: [0, -2, 0], radius: 0.3, castShadow: true },
    { shape: 'sphere', position: [-1, 3, 0], radius: 0.4, castShadow: true, shadow: { resolution: 32 } },
  ]);
  h.context.shader = wgsl;
  h.engine.frameGraph.execute(h.context);
  assert.equal(local['layers'], 16, 'five rectangle, five disk and six sphere faces');
  assert.match(lights.pbr(1).declarations, /clusterShapeShadow\(j,position,n,a,r,u,light.a.w<0.5\)/);
  assert.doesNotMatch(lights['unshadowed'].pbr(1).declarations, /clusterAreaShadow/);
  assert.deepEqual(shapes.shadowLights().map((s) => [s.index, s.twoSided, s.width]), [[64, false, 0], [65, true, 32]]);
  const maps = local['dirtyLayers'];
  assert.equal(maps.slice(0, 16).reduce((a, b) => a + b), 0);
  h.context.shader = wgsl;
  h.engine.frameGraph.execute(h.context);
  assert.equal(maps.slice(0, 16).reduce((a, b) => a + b), 0);
  for (const effect of [shapes, rect, local, lights]) effect.dispose();
});

test('invalid shadow entries never replace existing shaped lights or shadow frames', () => {
  const shapes = new AreaShapes({ lights: new Clustered() }),
    good = { shape: 'sphere', position: [0, 3, 0], radius: 0.5, castShadow: true };
  shapes.setLights([good]);
  assert.doesNotMatch(shapes.declarations(0), /shapeTube|shapeArc|ShapeArc/);
  const frames = shapes.shadowLights(), before = Array.from(shapes.data);
  for (const bad of [
    { ...good, radius: 0 }, { ...good, castShadow: 1 }, { ...good, shadow: { near: 2, far: 1 } },
    { shape: 'tube', start: [0, 0, 0], end: [0, 1, 0], radius: 1, castShadow: true },
  ]) {
    assert.throws(() => shapes.setLights([bad]));
    assert.deepEqual(Array.from(shapes.data), before);
    assert.equal(shapes.shadowLights(), frames);
  }
  assert.throws(() => shapes.setLights(Array(5).fill(good)), /At most 4/);
  shapes.setLights([]);
  assert.equal(shapes.shadowLights().length, 0);
});
