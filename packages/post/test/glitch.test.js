import test from 'node:test';
import assert from 'node:assert/strict';
import { Glitch, PostStack } from '../dist/index.js';
import { harness, modules } from './support.js';

/** Runs `frames` frames of a Glitch alone and returns the uniform it wrote each frame (112 bytes as words). */
async function run(options, frames, between) {
  const h = harness(),
    glitch = Glitch.attach(h.engine, options),
    out = [];
  for (let i = 0; i < frames; i++) {
    between?.(glitch, i);
    const log = h.gpu.record(() => h.frame()),
      e = log.find((entry) => entry[0] === 'writeBuffer' && entry[3].length === 224);
    out.push(new Uint32Array(Uint8Array.from(Buffer.from(e[3], 'hex')).buffer));
    assert.equal(glitch.active, out.at(-1)[1] === 1);
  }
  glitch.dispose();
  await null;
  assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
  return out;
}
const active = (frames) => frames.map((u) => u[1]);
const floats = (u) => new Float32Array(u.buffer);
/** Lengths of the alternating runs of quiet (0) and glitched (1) frames. */
function runs(flags) {
  const out = [];
  for (let i = 0; i < flags.length; ) {
    let j = i;
    while (j < flags.length && flags[j] === flags[i]) j++;
    out.push([flags[i], j - i]);
    i = j;
  }
  return out;
}

test('Glitch replays a seed exactly', async () => {
  const a = await run({ seed: 42 }, 600),
    b = await run({ seed: 42 }, 600),
    c = await run({ seed: 43 }, 600);
  assert.deepEqual(a, b, 'same seed, same frames');
  assert.notDeepEqual(active(a), active(c), 'another seed, other bursts');
  // Quiet waits of 90-300 frames, bursts of 3-10 glitched frames, the first burst frame the strongest.
  let first = 0,
    later = 0,
    firsts = 0,
    laters = 0;
  for (const seed of [42, 43, 1, 2, 3, 4]) {
    const frames = seed === 42 ? a : seed === 43 ? c : await run({ seed }, 1200),
      parts = runs(active(frames));
    assert.equal(parts[0][0], 0, 'starts quiet');
    // The last run may be cut off by the end of the recording.
    for (const [flag, length] of parts.slice(0, -1))
      if (flag) assert.ok(length >= 3 && length <= 10, 'burst of ' + length);
      else assert.ok(length >= 90 && length <= 300, 'wait of ' + length);
    let at = 0;
    for (const [flag, length] of parts) {
      if (flag)
        for (let k = 0; k < length; k++) {
          // Share of displaced cells: (0.08-0.45) x strength.
          const chance = floats(frames[at + k])[8];
          assert.ok(chance > 0 && chance <= 0.45 + 1e-6);
          if (k === 0) (first += chance), firsts++;
          else (later += chance), laters++;
        }
      at += length;
    }
  }
  assert.ok(firsts >= 6 && first / firsts > (later / laters) * 1.3, 'the first burst frame is the strongest');
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
  const code = modules(log).find((c) => c.includes('tears:array<vec4f,4>'));
  assert.match(
    code,
    /return vec4f\(left\.r,centre\.g,right\.b,max\(max\(left\.a,centre\.a\),right\.a\)\);/,
    'red and blue split, alpha kept',
  );
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
