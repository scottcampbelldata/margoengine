// GAP-FILM-TIME: the creative PostProcessing film grain started at film time T shows the grain a continuous run shows
// at T. Run A takes n + 1 frame updates; run B is fresh, replays n steps with `advanceTime` (what `seek` from
// @margoengine/cutscene/seek runs), then takes one update. The grain clock used to move in the draw, which a seek does
// not run; the frame update moves it now, and a PostProcessing no update reaches still moves it per draw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PostProcessing } from '../dist/post.js';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
const FPS = 60,
  identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  device = { queue: { writeBuffer() {} }, createBuffer: () => ({ destroy() {} }) },
  draw = (post, delta) =>
    post['update']({
      delta,
      device,
      camera: { matrix: identity(), position: new Float32Array(3), near: 0.1, far: 100 },
    });

for (const n of [1, 600, 54000])
  test(`creative post grain replayed ${n} steps equals a continuous run`, () => {
    const a = new PostProcessing(),
      b = new PostProcessing();
    assert.equal(b.time, 0, 'a fresh PostProcessing starts at 0');
    for (let step = 0; step <= n; step++) a.onPreUpdate(1 / FPS);
    for (let step = 0; step < n; step++) b.advanceTime(1 / FPS);
    b.onPreUpdate(1 / FPS);
    assert.ok(Object.is(b.time, a.time));
    draw(a, 1 / FPS);
    draw(b, 1 / FPS);
    assert.deepEqual(Array.from(b['values']), Array.from(a['values']));
  });

test('the grain moves in the frame update, not in the draw (the draw used to move it, out of reach of a seek)', () => {
  const post = new PostProcessing();
  post.onPreUpdate(0.25);
  draw(post, 0.25);
  draw(post, 0.25);
  assert.equal(post.time, 0.25);
  assert.equal(post['values'][39], 0.25);
  const loose = new PostProcessing();
  draw(loose, 0.25);
  assert.equal(loose.time, 0.25, 'a PostProcessing no update reaches moves its grain per draw, as before');
});
