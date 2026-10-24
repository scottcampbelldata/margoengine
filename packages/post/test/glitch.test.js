import test from 'node:test';
import assert from 'node:assert/strict';
import { Glitch, PostStack } from '../dist/index.js';
import { harness, modules } from './support.js';

/** Runs `frames` frames of a Glitch alone and returns the uniform it wrote each frame (80 bytes as words). */
async function run(options, frames, between) {
  const h = harness(),
    glitch = Glitch.attach(h.engine, options),
    out = [];
  for (let i = 0; i < frames; i++) {
    between?.(glitch, i);
    const log = h.gpu.record(() => h.frame()),
      e = log.find((entry) => entry[0] === 'writeBuffer' && entry[3].length === 160);
    out.push(new Uint32Array(Uint8Array.from(Buffer.from(e[3], 'hex')).buffer));
    assert.equal(glitch.active, out.at(-1)[7] === 1);
  }
  glitch.dispose();
  await null;
  assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
  return out;
}
const active = (frames) => frames.map((u) => u[7]);

test('Glitch replays a seed exactly: a wait of 120-240 frames, then a burst of 4-16 glitched frames', async () => {
  const a = await run({ seed: 42 }, 600),
    b = await run({ seed: 42 }, 600),
    c = await run({ seed: 43 }, 600);
  assert.deepEqual(a, b, 'same seed, same frames');
  assert.notDeepEqual(active(a), active(c), 'another seed, other bursts');
  for (const frames of [a, c]) {
    const flags = active(frames),
      first = flags.indexOf(1);
    assert.ok(first >= 120 && first <= 240, 'first burst after 120-240 frames: ' + first);
    const length = flags.indexOf(0, first) - first;
    assert.ok(length >= 4 && length <= 16, 'burst length ' + length);
    const next = flags.indexOf(1, first + length) - (first + length);
    assert.ok(next >= 120 && next <= 240, 'next wait ' + next);
    // The burst opens at full strength (block chance 0.15-0.5 of cells), then weaker frames (strength 0.15-0.6).
    const chance = (u) => new Float32Array(u.buffer)[4];
    assert.ok(chance(frames[first]) >= 0.15 && chance(frames[first]) <= 0.5);
    for (const u of frames.slice(first + 1, first + length)) assert.ok(chance(u) >= 0.0225 && chance(u) <= 0.3);
  }
});

test('Glitch wild glitches every frame; intensity 0 and enabled false pass through', async () => {
  assert.ok(active(await run({ seed: 1, wild: true }, 30)).every((flag) => flag === 1));
  assert.ok(active(await run({ seed: 1, wild: true, intensity: 0 }, 30)).every((flag) => flag === 0));
  // Disabled frames pass through and pause the sequence: the enabled frames replay the uninterrupted run.
  const straight = await run({ seed: 9, wild: true }, 10),
    paused = await run({ seed: 9, wild: true }, 13, (glitch, i) => (glitch.enabled = i < 4 || i > 6));
  assert.deepEqual(active(paused).slice(4, 7), [0, 0, 0]);
  assert.deepEqual([...paused.slice(0, 4), ...paused.slice(7)], straight);
  // A new seed restarts the sequence.
  const reseeded = await run({ seed: 9, wild: true }, 6, (glitch, i) => (glitch.options.seed = i < 3 ? 5 : 9));
  assert.deepEqual(reseeded.slice(3), straight.slice(0, 3));
});

test('Glitch is an LDR stage: alone in its own stack on the core shader, restored and disposed cleanly', async () => {
  const h = harness(),
    glitch = Glitch.attach(h.engine, { wild: true, seed: 3 }),
    log = h.gpu.record(() => h.frame());
  assert.ok(h.engine.hasPlugin('post:stack') && h.engine.hasPlugin('glitch'));
  const passes = log.filter((e) => e[0] === 'beginRenderPass');
  assert.equal(passes.at(-1)[1].colorAttachments[0].view, h.gpu.snap(h.view.c.color), 'Glitch writes the frame');
  const code = modules(log).find((c) => c.includes('bands:array<vec4f,3>'));
  assert.match(code, /return vec4f\(r\.r,c\.g,b\.b,max\(c\.a,max\(r\.a,b\.a\)\)\);/, 'red and blue split, alpha kept');
  assert.equal(h.view.c.shader, h.view.state.shader, 'an LDR-only stack keeps the core shader');
  h.engine.restore();
  h.frame();
  glitch.dispose();
  assert.ok(!h.engine.hasPlugin('post:stack'));
  await null;
  assert.deepEqual(h.live(), []);
  assert.throws(
    () => new PostStack([new Glitch(), { name: 'hdr', setup() {}, joinStack: () => ({ kind: 'hdr' }) }]),
    RangeError,
  );
  const alone = harness();
  assert.throws(() => alone.engine.use(new Glitch()), { name: 'MargoError', code: 'state', message: /PostStack/ });
  for (const options of [{ intensity: -0.1 }, { intensity: 2 }, { seed: -1 }, { seed: 1.5 }, { seed: 2 ** 32 }])
    assert.throws(() => new Glitch(options), RangeError);
  for (const options of [{ wild: 1 }, { enabled: 'no' }]) assert.throws(() => new Glitch(options), TypeError);
});
