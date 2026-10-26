import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../dist/index.js';

const near = (a, b, eps = 1e-9, m = '') => assert.ok(Math.abs(a - b) <= eps, `${m} ${a} vs ${b}`);

test('every named easing starts at 0 and ends at 1, stays finite, and matches known midpoints', () => {
  const names = Object.keys(T).filter((k) =>
    /^ease(In|Out|InOut)(Quad|Cubic|Quart|Quint|Sine|Expo|Circ|Back|Elastic|Bounce)$/.test(k),
  );
  assert.equal(names.length, 29);
  for (const name of names) {
    const f = T[name];
    near(f(0), 0, 1e-9, name);
    near(f(1), 1, 1e-9, name);
    for (let i = 1; i < 100; i++) assert.ok(Number.isFinite(f(i / 100)), name);
  }
  near(T.easeInQuad(0.5), 0.25);
  near(T.easeOutQuad(0.5), 0.75);
  near(T.easeInOutCubic(0.25), 0.0625);
  near(T.easeInOutQuad(0.5), 0.5);
  near(T.easeInSine(0.5), 1 - Math.SQRT1_2);
  near(T.easeOutBounce(0.5), 0.765625);
  near(T.easeInBounce(0.5), 1 - 0.765625);
  assert.ok(T.easeOutBack(0.8) > 1, 'back overshoots');
  assert.ok(T.easeInBack(0.2) < 0, 'back pulls back first');
  assert.ok(T.easeOutElastic(0.4) > 1, 'elastic overshoots');
  for (const [a, b] of [
    ['easeInQuint', 'easeOutQuint'],
    ['easeInExpo', 'easeOutExpo'],
    ['easeInCirc', 'easeOutCirc'],
  ])
    near(T[a](0.3) + T[b](0.7), 1, 1e-9, a);
});

test('cubicBezier matches the CSS keywords and validates, steps makes a staircase', () => {
  const ease = T.cubicBezier(0.25, 0.1, 0.25, 1);
  near(ease(0), 0);
  near(ease(1), 1);
  assert.ok(ease(0.5) > 0.78 && ease(0.5) < 0.82, 'CSS ease at 0.5 is about 0.8');
  const lin = T.cubicBezier(0, 0, 1, 1);
  for (const t of [0.1, 0.5, 0.9]) near(lin(t), t, 1e-6);
  const inOut = T.cubicBezier(0.42, 0, 0.58, 1);
  near(inOut(0.5), 0.5, 1e-6);
  assert.throws(() => T.cubicBezier(2, 0, 0, 1), RangeError);
  const s = T.steps(4);
  assert.deepEqual([0, 0.24, 0.25, 0.99, 1].map(s), [0, 0, 0.25, 0.75, 1]);
  assert.equal(T.steps(4, true)(0.01), 0.25);
  assert.throws(() => T.steps(0), RangeError);
});

test('repeat and yoyo swing the value and end where the pass count says', () => {
  const tween = new T.Tween(),
    o = { x: 0 };
  let repeats = 0,
    done = 0;
  tween.to(o, 'x', 10, { duration: 1, repeat: 3, yoyo: true, onRepeat: () => repeats++, onComplete: () => done++ });
  const seen = [];
  for (let i = 0; i < 40; i++) {
    tween.update(0.1);
    seen.push(Math.round(o.x * 10) / 10);
  }
  assert.deepEqual(seen.slice(0, 12), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 9, 8]);
  assert.equal(o.x, 0, '4 passes of a yoyo end back at the start');
  assert.equal(repeats, 3);
  assert.equal(done, 1);
  const p = { x: 0 };
  tween.to(p, 'x', 10, { duration: 1, repeat: 1 });
  tween.update(1.5);
  near(p.x, 5);
  tween.update(0.5);
  assert.equal(p.x, 10);
  const loop = { x: 0 };
  const cancel = tween.to(loop, 'x', 1, { duration: 1, repeat: Infinity });
  tween.update(1000.25);
  near(loop.x, 0.25, 1e-6);
  cancel();
  tween.update(0.5);
  near(loop.x, 0.25, 1e-6);
  assert.throws(() => tween.to({ x: 0 }, 'x', 1, { duration: 1, repeat: 1.5 }), RangeError);
  assert.throws(() => tween.to({ x: 0 }, 'x', 1, { duration: 1, repeat: -1 }), RangeError);
});

test('array tweens colours, slerps quaternions and follows a path; custom gets eased progress', () => {
  const tween = new T.Tween(),
    colour = T.parseHexColor('#ff0000'),
    target = [...colour];
  tween.array(target, T.parseHexColor('#0000ff'), { duration: 1 });
  tween.update(0.5);
  near(target[0], 0.5);
  near(target[2], 0.5);
  tween.update(0.5);
  assert.equal(T.toHexColor(target), '#0000ff');
  assert.equal(T.parseHexColor('#f80').join(), [1, 136 / 255, 0, 1].join());
  assert.equal(T.toHexColor([1, 0, 0, 0.5]), '#ff000080');
  assert.throws(() => T.parseHexColor('red'), TypeError);
  const q = new Float32Array([0, 0, 0, 1]),
    half = Math.SQRT1_2;
  tween.array(q, [0, half, 0, half], { duration: 1, interpolate: T.slerpArray });
  tween.update(0.5);
  const angle = 2 * Math.acos(q[3]);
  near(angle, Math.PI / 4, 1e-6);
  near(Math.hypot(...q), 1, 1e-6);
  const negative = [0, 0, 0, 1];
  T.slerpArray(negative, [0, 0, 0, 1], [0, 0, 0, -1], 0.5);
  near(Math.abs(negative[3]), 1, 1e-9, 'shortest arc for the double cover');
  const pos = [0, 0, 0],
    path = T.catmullRomPath([
      [0, 0, 0],
      [1, 2, 0],
      [3, 2, 1],
      [4, 0, 1],
    ]);
  tween.path(pos, path, { duration: 1, easing: T.linear });
  tween.update(1 / 3);
  assert.deepEqual(
    pos.map((v) => Math.round(v * 1e9) / 1e9),
    [1, 2, 0],
    'passes through the control points',
  );
  tween.update(2 / 3);
  assert.deepEqual(pos, [4, 0, 1]);
  assert.throws(() => T.catmullRomPath([[0, 0]]), RangeError);
  const log = [];
  tween.custom((p) => log.push(p), { duration: 1, easing: T.easeInQuad });
  tween.update(0.5);
  tween.update(0.5);
  assert.deepEqual(log, [0.25, 1]);
  assert.throws(() => tween.array([0, 0], [1], { duration: 1 }), RangeError);
  const same = [0, 0];
  tween.array(same, [1, 1], { duration: 1 });
  tween.array(same, [5, 5], { duration: 1 });
  tween.update(1);
  assert.deepEqual(same, [5, 5], 'a new array tween replaces the old one');
});

test('Spring converges for under, critical and over damping from any frame time and keeps velocity on retarget', () => {
  for (const damping of [4, 2 * Math.sqrt(170), 60]) {
    const s = new T.Spring({ stiffness: 170, damping });
    s.target = 1;
    for (let i = 0; i < 600 && !s.settled; i++) s.update(1 / 60);
    assert.equal(s.settled, true, `damping ${damping}`);
    assert.equal(s.value, 1);
    assert.equal(s.velocity, 0);
  }
  // exact solution: the same spring stepped in one big or many small steps lands on the same point
  const a = new T.Spring({ stiffness: 100, damping: 8 }),
    b = new T.Spring({ stiffness: 100, damping: 8 });
  a.target = b.target = 1;
  a.update(0.4);
  for (let i = 0; i < 40; i++) b.update(0.01);
  near(a.value, b.value, 1e-9);
  near(a.velocity, b.velocity, 1e-9);
  const huge = new T.Spring({ stiffness: 100, damping: 8, target: 3 });
  huge.update(1e6);
  assert.equal(huge.value, 3);
  const under = new T.Spring({ stiffness: 170, damping: 5, target: 1 });
  let peak = 0;
  for (let i = 0; i < 120; i++) peak = Math.max(peak, under.update(1 / 60));
  assert.ok(peak > 1.1, 'underdamped spring overshoots');
  assert.ok(under.dampingRatio < 1);
  const carried = new T.Spring({ stiffness: 100, damping: 10, target: 1 });
  carried.update(0.1);
  const v = carried.velocity;
  carried.target = -1;
  assert.equal(carried.velocity, v, 'retargeting keeps the velocity');
  assert.throws(() => new T.Spring({ stiffness: 0 }), RangeError);
  assert.throws(() => new T.Spring({ mass: -1 }), RangeError);
  assert.throws(() => carried.update(-1), RangeError);
  carried.value = Number.NaN;
  assert.throws(() => carried.update(0.1), { code: 'state' });
});

test('Timeline sequences, labels, seeking back restores values, pause, speed, repeat, yoyo and callbacks', () => {
  const o = { a: 0, b: 10 },
    log = [];
  const t = new T.Timeline({ onComplete: () => log.push('done') })
    .to(o, 'a', 1, { duration: 1 })
    .label('mid')
    .to(o, 'b', 20, { duration: 2, at: 'mid' })
    .to(o, 'a', 3, { duration: 1, at: 'mid+0.5' })
    .call(() => log.push('end'), 3);
  assert.equal(t.duration, 3);
  t.update(10);
  assert.equal(o.a, 0, 'not playing yet');
  t.play();
  t.update(0.5);
  near(o.a, 0.5);
  t.update(1);
  near(o.a, 1 + (3 - 1) * 0.0, 1e-9);
  near(o.b, 10 + 10 * 0.25, 1e-9);
  t.update(0.5);
  near(o.a, 2, 1e-9);
  t.pause().update(5);
  near(o.a, 2, 1e-9);
  t.seek(0);
  assert.deepEqual([o.a, o.b], [0, 10], 'seeking back restores the captured start values');
  t.seek(3);
  assert.deepEqual([o.a, o.b], [3, 20]);
  t.seek(1.25);
  near(o.a, 1 + 2 * 0.0 + 0, 1);
  t.seek(0).play();
  t.update(2);
  assert.deepEqual(log, []);
  t.update(1);
  assert.deepEqual(log, ['end', 'done']);
  assert.equal(t.playing, false);
  t.play();
  assert.equal(t.time, 0, 'play after the end restarts');
  assert.equal(o.a, 0);
  assert.throws(() => t.to(o, 'a', 1, { duration: 1, at: 'nope' }), /label/);
  assert.throws(() => t.update(-1), RangeError);
  assert.throws(() => t.seek(Number.NaN), RangeError);
  assert.throws(() => new T.Timeline({ speed: 0 }), RangeError);
});

test('Timeline repeat loops from the start values, yoyo swings back, speed scales, callbacks cannot edit it', () => {
  const o = { x: 0 };
  let ended = 0;
  const loop = new T.Timeline({ repeat: 2, onComplete: () => ended++ }).to(o, 'x', 10, { duration: 1 });
  loop.play();
  const seen = [];
  for (let i = 0; i < 12; i++) {
    loop.update(0.5);
    seen.push(o.x);
  }
  assert.deepEqual(seen.slice(0, 5), [5, 10, 5, 10, 5], 'each pass restarts from 0');
  assert.equal(ended, 1);
  assert.equal(loop.playing, false);
  const swing = new T.Timeline({ repeat: 1, yoyo: true, speed: 2 }).to(o, 'x', 0, { duration: 2 });
  o.x = 8;
  swing.play();
  swing.update(0.5);
  near(o.x, 4);
  swing.update(0.5);
  near(o.x, 0);
  swing.update(0.5);
  near(o.x, 4);
  swing.update(0.5);
  near(o.x, 8);
  assert.equal(swing.playing, false);
  const zero = [];
  const c = new T.Timeline().call(() => zero.push('start'), 0).call(() => c.to(o, 'x', 1, { duration: 1 }), 0.5);
  c.to(o, 'x', 1, { duration: 1 });
  c.play();
  assert.throws(() => c.update(1), { code: 'state' });
  assert.deepEqual(zero, ['start']);
});
