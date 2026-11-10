import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { OccludedScatter } from '../dist/occlusion.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

test('occlusion compacts separate colour rings and retains camera rings for shadows and restoration', () => {
  const h = optionalGPU();
  h.context.shader = wgsl;
  const s = new OccludedScatter([box(), box(), box()], { count: 8 });
  h.engine.use(s);
  h.frame();
  assert.notEqual(s.colourCommands(), s.commands);
  for (let i = 0; i < 3; i++) assert.notEqual(s.colourInstances()[i], s.instances[i]);
  assert.equal(s.colourCommands().size, 60);
  const before = s.colourCommands();
  s.enabled = false;
  h.frame();
  assert.equal(s.colourCommands(), before);
  s.onDeviceRestored(h.engine);
  h.frame();
  assert.ok(before.destroyed);
  s.dispose();
  s.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});
