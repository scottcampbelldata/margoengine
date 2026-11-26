// GAP-FILM-LATE: scene captures nest, the one that begins first ending last. Native glass began at -64, outside the
// HDR captures that begin later (SSAO and bloom -60, DOF -55, Tonemap -50) and end from 30, and presented its own
// colour at 29, before they wrote this frame into it: every frame showed the one before, and a fresh engine's first
// frame was black. Under an HDR capture the glass now stays on the linear blend (no capture of its own), the scene
// draws into the HDR target and the frame's last pass writes the frame's own colour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireNativeGlass, nativeGlass } from '../src/native-glass.js';
import { harness } from '../../post/test/support.js';
import { acquireDepth } from '../../shared/gpu.js';
import { VolumeDepthCapture } from '../../sciviz/src/volume-depth.ts';
import { Tonemap } from '../../tonemap/dist/index.js';
import { Bloom, PostStack } from '../../post/dist/index.js';

const lastPass = (log) => log.filter((e) => e[0] === 'beginRenderPass').at(-1)[1];

for (const [name, make] of [
  ['Tonemap', () => new Tonemap()],
  ['Bloom', () => new Bloom()],
  ['PostStack', () => new PostStack([new Bloom()])],
])
  for (const samples of [1, 4])
    test(`native glass nests inside ${name} at ${samples}x: the frame's last pass writes this frame`, () => {
      const h = harness({ samples }),
        release = acquireNativeGlass(h.engine, () => true);
      h.engine.use(make());
      let active;
      const begin = h.engine.frameGraph.add({
        name: 'test:inside',
        order: 0.5,
        execute: (c) => (active = nativeGlass(c)),
      });
      try {
        for (let frame = 0; frame < 2; frame++) {
          const log = h.gpu.record(() => h.frame()),
            original = h.gpu.snap(h.view.c.color);
          assert.equal(
            active,
            undefined,
            'the glass reads the HDR capture with the linear blend, no capture of its own',
          );
          assert.ok(
            !log.some((e) => e[0] === 'beginRenderPass' && e[1].label === 'native-glass:present'),
            'no glass presentation pass',
          );
          const last = lastPass(log).colorAttachments[0];
          assert.ok(
            last.view === original || last.resolveTarget === original,
            `${name}'s last pass writes the frame's own colour (frame ${frame})`,
          );
          assert.equal(h.draws.at(-1).color === h.view.c.color, false, 'the scene drew into the HDR capture');
        }
      } finally {
        begin();
        release();
      }
    });

test('native glass alone still captures and presents into the frame colour', () => {
  const h = harness({ samples: 4 }),
    release = acquireNativeGlass(h.engine, () => true);
  try {
    const log = h.gpu.record(() => h.frame()),
      last = lastPass(log);
    assert.equal(last.label, 'native-glass:present');
    assert.equal(last.colorAttachments[0].view, h.gpu.snap(h.view.c.color));
  } finally {
    release();
  }
});

// KB-FILM-NEST2: a capture that begins inside the glass capture can end after it. The shared scene depth (water, html,
// clustered contact: -15 to 10000) and sciviz volume depth (-0.001 to 39) end after the glass presented at 29: the
// glass presented a colour nothing had drawn, and the scene went into the glass colour that was never shown.
const volume = (engine) => VolumeDepthCapture.attach(engine).members.add({ visible: true });
for (const [name, attach] of [
  ['the shared scene depth', (engine) => acquireDepth(engine)],
  ['sciviz volume depth', volume],
  ['both', (engine) => (acquireDepth(engine), volume(engine))],
])
  for (const samples of [1, 4])
    test(`native glass presents after ${name} ends at ${samples}x`, () => {
      const h = harness({ samples }),
        release = acquireNativeGlass(h.engine, () => true);
      attach(h.engine);
      let original;
      h.engine.frameGraph.add({ name: 'test:first', order: -1000, execute: (c) => (original = c.color) });
      try {
        for (let frame = 0; frame < 2; frame++) {
          const log = h.gpu.record(() => h.frame()),
            passes = log.filter((e) => e[0] === 'beginRenderPass').map((e) => e[1]),
            present = passes.findIndex((p) => p.label === 'native-glass:present'),
            frameColour = h.gpu.snap(original);
          assert.ok(present >= 0, 'the glass presents');
          assert.equal(passes[present].colorAttachments[0].view, frameColour, 'into the frame colour');
          assert.equal(present, passes.length - 1, `no capture writes after the glass presented (frame ${frame})`);
          assert.equal(h.view.c.color, original, 'the frame ends on its own colour');
        }
      } finally {
        release();
      }
    });
