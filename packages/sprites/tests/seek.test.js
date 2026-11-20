// GAP-FILM-TIME: a sprite layer's effect clock and a sprite animation started at film time T show what a continuous run
// shows at T. Run A takes n + 1 frame updates; run B is fresh, replays n steps with `advanceTime` (what `seek` from
// @margoengine/cutscene/seek runs; a SpriteAnimation goes in as an `extra` clock), then takes one update. A replayed
// frame fires no event; the one live update fires what the continuous run fired on that update.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpriteLayer } from '../dist/index.js';
import { frameGrid, SpriteAnimation } from '../dist/animation.js';

const FPS = 60,
  atlas = () => ({ width: 4, height: 4, data: new Uint8Array(64).fill(255) });
function animation(log) {
  const a = new SpriteAnimation({
    clips: { walk: { frames: frameGrid(8, 8, 4), fps: 12, events: [{ frame: 2, name: 'step' }] } },
    onEvent: (name) => log.push(name),
  });
  a.play('walk');
  return a;
}

for (const n of [1, 600, 54000])
  test(`a sprite layer and animation replayed ${n} steps equal a continuous run`, () => {
    const la = new SpriteLayer({ atlas: atlas() }),
      lb = new SpriteLayer({ atlas: atlas() }),
      heardA = [],
      heardB = [],
      aa = animation(heardA),
      ab = animation(heardB);
    assert.equal(lb.time, 0, 'a fresh SpriteLayer starts at 0');
    assert.equal(ab.time, 0, 'a played SpriteAnimation starts at 0');
    // Film code speeds the walk up on the way, in both runs.
    const film = (x, step) => (x.speed = step >= 300 ? 1.5 : 1);
    for (let step = 0; step < n; step++) {
      film(aa, step);
      la.onPreUpdate(1 / FPS);
      aa.update(1 / FPS);
    }
    const before = heardA.length;
    film(aa, n);
    la.onPreUpdate(1 / FPS);
    aa.update(1 / FPS);
    heardB.length = 0;
    for (let step = 0; step < n; step++) {
      film(ab, step);
      lb.advanceTime(1 / FPS);
      ab.advanceTime(1 / FPS);
    }
    assert.deepEqual(heardB, [], 'a replayed frame fires no event');
    film(ab, n);
    lb.onPreUpdate(1 / FPS);
    ab.update(1 / FPS);
    assert.ok(Object.is(lb.time, la.time));
    assert.ok(Object.is(ab.time, aa.time));
    assert.deepEqual([ab.frame, ab.rect, ab.finished], [aa.frame, aa.rect, aa.finished]);
    assert.deepEqual(heardB, heardA.slice(before), 'the live update fires what the continuous run fired on it');
    assert.throws(() => ab.advanceTime(-1), RangeError);
  });
