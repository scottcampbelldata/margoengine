// KB-FILM-BRAIN1: a CameraBrain started at film time T shows what a continuous run shows at T. It had `onPreUpdate`
// but no `advanceTime`, so `@margoengine/cutscene/seek` listed it as unseekable and a film rendered scene by scene
// restarted its blend, its cameras' stages and their focus pulls at every cut; its update also called the `change`
// and `blended` listeners, which a seek step must not. Run A takes n + 1 live updates; run B is fresh, replays n steps
// with `advanceTime` (what `seek` runs), then takes one live update. Film code moves the subject and switches cameras
// on the way, in both runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraBrain } from '../dist/brain.js';
import { FocusTracker } from '../dist/lens.js';
import { CameraNoise, handheld } from '../dist/noise.js';

const FPS = 60;
function world() {
  const subject = new Float64Array([0, 1, 0]),
    camera = { position: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 60 },
    brain = new CameraBrain({
      camera,
      aspect: 16 / 9,
      rules: [{ from: 'wide', to: 'close', duration: 2, style: 'orbit' }],
      blend: { duration: 1.5 },
    }),
    wide = brain.add({ name: 'wide', priority: 1, position: [0, 4, 12], stages: [new FocusTracker(subject)] }),
    close = brain.add({ name: 'close', priority: 0, position: [3, 1.6, 4], stages: [new FocusTracker(subject, { size: 1 })] }),
    noise = new CameraNoise(handheld),
    events = [];
  brain.stages.push(noise);
  brain.on('change', (e) => events.push(['change', e.from?.name, e.to.name]));
  brain.on('blended', (e) => events.push(['blended', e.from?.name, e.to.name]));
  // What the film does before each frame: the subject walks, and the cut list switches cameras, some mid-blend.
  const film = (step) => {
    subject[0] = Math.sin(step / 70) * 3;
    subject[2] = step * 0.004;
    const beat = step % 900;
    close.priority = beat >= 120 && beat < 500 ? 2 : 0;
    wide.enabled = !(beat >= 600 && beat < 610);
  };
  return { brain, camera, noise, events, film };
}
const plain = (w) => ({
  pose: { ...w.brain.pose, position: [...w.brain.pose.position], target: [...w.brain.pose.target], up: [...w.brain.pose.up] },
  live: w.brain.live?.name,
  blending: w.brain.blending,
  cameras: w.brain.list.map((c) => [c.name, [...c.pose.position], [...c.pose.target], c.pose.fov, c.pose.focusDistance]),
  noise: w.noise.time,
  camera: JSON.parse(JSON.stringify(w.camera)),
});

for (const n of [1, 600, 54000])
  test(`a camera brain replayed ${n} steps equals a continuous run`, () => {
    const a = world(),
      b = world();
    for (let step = 0; step <= n; step++) {
      a.film(step);
      a.brain.onPreUpdate(1 / FPS);
    }
    for (let step = 0; step < n; step++) {
      b.film(step);
      b.brain.advanceTime(1 / FPS);
    }
    assert.deepEqual(b.events, [], 'a seek step calls no listener');
    b.film(n);
    b.brain.onPreUpdate(1 / FPS);
    assert.deepEqual(plain(b), plain(a));
  });

test('a fresh brain shown at T without the replay restarts its blend and focus (the restart a film cut showed)', () => {
  const a = world(),
    c = world();
  for (let step = 0; step <= 300; step++) {
    a.film(step);
    a.brain.onPreUpdate(1 / FPS);
  }
  c.film(300);
  c.brain.onPreUpdate(1 / FPS);
  assert.notDeepEqual(plain(c), plain(a));
});

test('a live update sends its events after its step, with the pose of that frame', () => {
  const w = world(),
    seen = [];
  w.brain.on('change', () => seen.push([...w.brain.pose.position]));
  w.film(0);
  w.brain.update(1 / FPS);
  assert.deepEqual(w.events, [
    ['change', undefined, 'wide'],
    ['blended', undefined, 'wide'],
  ]);
  assert.deepEqual(seen, [[...w.brain.pose.position]]);
  assert.throws(() => w.brain.advanceTime(-1), RangeError);
});
