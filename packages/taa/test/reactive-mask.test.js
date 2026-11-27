// KB-WATER-TAASMEAR1: a pass whose look moves with no motion vector (Water's waves) publishes its reactive mask on the
// pass context (packages/shared/reactive-mask.js) and TAA reads it with no option, so a scene with Water and TAA wires
// nothing. On the recording mock GPU: the registry's encoder and view tags, TAA compiling the masked resolve the first
// frame a mask is published and binding it, the black stand-in on a later frame with none, and the maximum of several
// masks (a sea and a river, or the option's and a published one). The picture-level proof is
// packages/water/test/near-detail.browser.mjs (TAA.attach(engine) keeps the moving near sea's relief).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { wgsl } from '../../core/src/shaders.ts';
import {
  publishReactiveMask,
  reactiveMasks,
  reactiveMaskWanted,
  reactiveTarget,
} from '../../shared/reactive-mask.js';

function rig(options) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      meshes: new Map(),
      stats: { drawCalls: 0 },
      sceneOf() {
        return undefined;
      },
      removePlugin() {},
      store: { visible: new Uint8Array(1), hidden: new Uint8Array(1), parents: new Int32Array(1).fill(-1) },
    };
  const taa = new TAA(options);
  taa.setup(engine);
  const run = passes(taa),
    view = context(gpu, { samples: 1, shader: wgsl });
  let index = 0;
  return {
    gpu,
    taa,
    mask: (size = [320, 180]) => gpu.device.createTexture({ size, format: 'r8unorm', usage: 4 | 16 }),
    // One frame on a fresh encoder (as each real frame has), publishing `published` before TAA's passes run, as Water
    // does at order 4.
    frame(published = []) {
      view.begin(index++);
      view.c.encoder = { ...gpu.encoder };
      for (const m of published) publishReactiveMask(view.c, m);
      run(view.c);
      view.end();
    },
  };
}
const resolveGroups = (log, entries) => log.filter((c) => c[0] === 'group' && c[2].entries.length === entries);
const maskedModules = (log) => log.filter((c) => c[0] === 'module' && /reactiveMask/.test(c[2].code ?? ''));

test('the registry keeps a frame and view its own masks, several of them, once each', () => {
  const encoder = {},
    view = {},
    c = { encoder, view },
    sea = { label: 'sea' },
    river = { label: 'river' };
  assert.deepEqual(reactiveMasks(c), [], 'nothing published');
  publishReactiveMask(c, sea);
  publishReactiveMask(c, river);
  publishReactiveMask(c, sea);
  assert.deepEqual(reactiveMasks(c), [sea, river], 'both publishers, the sea once');
  c.view = {};
  assert.deepEqual(reactiveMasks(c), [], 'another view does not read them');
  c.view = view;
  c.encoder = {};
  assert.deepEqual(reactiveMasks(c), [], 'nor the next frame');
  publishReactiveMask(c, river);
  assert.deepEqual(reactiveMasks(c), [river], 'a new frame starts its own list');
});

test('TAA with no reactive option compiles the masked resolve the first frame a mask is published and binds it', () => {
  const r = rig();
  let log = r.gpu.record(() => r.frame());
  assert.equal(maskedModules(log).length, 0, 'no mask published: the same resolve as before');
  assert.equal(resolveGroups(log, 9).length, 2, 'no binding 9');
  const sea = r.mask();
  log = r.gpu.record(() => r.frame([sea]));
  assert.equal(maskedModules(log).length, 1, 'the masked resolve is compiled');
  assert.ok(
    log.some((c) => c[0] === 'computePipeline' && c[2].compute.module === maskedModules(log)[0][1]),
    'into a new resolve pipeline',
  );
  const groups = resolveGroups(log, 10);
  assert.equal(groups.length, 2, 'both history directions bind the mask at 9');
  log = r.gpu.record(() => r.frame([sea]));
  assert.equal(
    maskedModules(log).length + resolveGroups(log, 10).length,
    0,
    'the same mask keeps its pipeline and groups',
  );
  log = r.gpu.record(() => r.frame());
  assert.equal(maskedModules(log).length, 0, 'a frame with no mask keeps the masked resolve');
  const black = log.find((c) => c[0] === 'texture' && c[2].format === 'r8unorm');
  assert.deepEqual(black?.[2].size, [1, 1], "and binds the black stand-in, not last frame's mask");
  assert.equal(resolveGroups(log, 10).length, 2);
  r.taa.dispose();
});

test("several masks in one frame are combined by their maximum, the option's included", () => {
  const sea = { current: undefined };
  const r = rig({ reactive: () => sea.current });
  const river = r.mask([64, 36]);
  sea.current = r.mask();
  const log = r.gpu.record(() => r.frame([river]));
  const combined = log.find((c) => c[0] === 'texture' && c[2].label === 'TAA combined reactive mask');
  assert.ok(combined, "a combined mask the frame's size");
  assert.deepEqual(combined[2].size, [1280, 720]);
  assert.equal(combined[2].format, 'r8unorm');
  const pipe = log.find((c) => c[0] === 'renderPipeline' && c[2].fragment?.targets?.[0]?.format === 'r8unorm');
  assert.deepEqual(pipe[2].fragment.targets[0].blend.color, { dstFactor: 'one', operation: 'max', srcFactor: 'one' });
  const start = log.findIndex(
      (c) =>
        c[0] === 'beginRenderPass' &&
        c[1].colorAttachments[0].loadOp === 'clear' &&
        c[1].colorAttachments[0].clearValue,
    ),
    end = log.findIndex((c, i) => i > start && c[0] === 'pass.end');
  assert.ok(start >= 0, 'cleared to 0 first');
  assert.equal(log.slice(start, end).filter((c) => c[0] === 'pass.draw').length, 2, 'one draw per mask');
  const module = log.find((c) => c[0] === 'module' && /fn fs\(v:V\)/.test(c[2].code ?? ''));
  assert.match(module[2].code, /textureLoad\(mask,vec2i\(min\(v\.uv\*s,s-1\)\),0\)\.r/, 'read scaled to the frame');
  // One mask again (the option's alone): bound as it is, with no combine pass.
  const again = r.gpu.record(() => r.frame());
  assert.equal(
    again.filter((c) => c[0] === 'beginRenderPass' && c[1].colorAttachments[0].clearValue).length,
    0,
    'no combine pass for a single mask',
  );
  r.taa.dispose();
});

// KB-TAA-PARTICLEMASK1: Weather's and VFX's particle masks cost a pass of their own, so they draw only while something
// reads masks. TAA's read is that signal; the browser proofs are packages/sky/test/features-check.mjs (weather) and
// packages/vfx/test/reactive-check.mjs, a plain TAA.attach(engine) with nothing wired.
test('a mask is wanted from the frame after a read, for every view of that frame, until reads stop', () => {
  const c = { encoder: {}, view: {} },
    owner = {};
  assert.equal(reactiveMaskWanted(c, owner), false, 'nothing reads masks yet');
  reactiveMasks(c);
  assert.equal(reactiveMaskWanted(c, owner), false, 'this frame was decided before the read');
  c.encoder = {};
  assert.equal(reactiveMaskWanted(c, owner), true, 'the next frame draws its mask');
  reactiveMasks(c);
  c.view = {};
  assert.equal(reactiveMaskWanted(c, owner), true, 'a second view of the frame gets the same answer');
  reactiveMasks(c);
  c.encoder = {};
  assert.equal(reactiveMaskWanted(c, owner), true, 'reads go on');
  c.encoder = {};
  assert.equal(reactiveMaskWanted(c, owner), false, 'no read in the last frame: the reader is gone');
  assert.equal(reactiveMaskWanted(c, {}), true, 'each owner keeps its own count of the reads it saw');
});

test('the shared particle target is cleared by the first draw of a view, loaded after, and published', () => {
  const gpu = mockGPU(),
    c = { device: gpu.device, encoder: {}, view: {}, width: 320, height: 180, descriptor: { multisample: { count: 4 } } };
  const first = reactiveTarget(c),
    second = reactiveTarget(c);
  assert.equal(first.loadOp, 'clear');
  assert.equal(second.loadOp, 'load', 'a second effect in the same view keeps the coverage of the first');
  assert.ok(first.resolveTarget, 'a multisampled frame resolves into the mask');
  const [mask] = reactiveMasks(c);
  assert.equal(mask.format, 'r8unorm');
  assert.equal(mask.sampleCount, 1);
  c.view = {};
  assert.equal(reactiveTarget(c).loadOp, 'clear', 'a new view starts from 0');
  c.width = 640;
  reactiveTarget(c);
  assert.equal(mask.destroyed, true, 'a resize replaces the old mask');
});
