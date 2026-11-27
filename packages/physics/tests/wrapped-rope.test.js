// A rope wrapped over fixed cylinders with capstan friction (`WrappedRope`, SOFT-02 item 3): against the capstan law
// T_high = T_low e^(mu phi) (Euler 1762, Eytelwein 1808) and the Atwood machine over a capstan, whose closed form is
// a = g (m2 - k m1) / (m2 + k m1), k = e^(mu phi), for a massless rope; held while m2 / m1 lies within [1/k, k].
import assert from 'node:assert/strict';
import test from 'node:test';
import { WrappedRope } from '../dist/rod.js';

const g = 9.81,
  R = 0.2;

/** A rope over a cylinder of radius R at the origin, a mass hung each side 1 m down, over the top (clockwise from the left). */
function atwood(m1, m2, mu) {
  return new WrappedRope({
    nodes: [
      { position: [-R, -1, 0], mass: m1 },
      { position: [R, -1, 0], mass: m2 },
    ],
    wraps: [{ center: [0, 0, 0], axis: [0, 0, 1], radius: R, friction: mu, turn: -1 }],
  });
}

test('over a frictionless pulley and a capstan, the masses move at the closed form and the tensions keep its ratio', () => {
  // The constraints are linear in the speeds and each step solves them, so the speed after 0.25 s is the closed form's to
  // the passes' convergence: measured exact to 1e-12 m/s^2, held to 1e-9.
  for (const mu of [0, 0.3]) {
    const k = Math.exp(mu * Math.PI);
    for (const ratio of [0.8, 1.2, 2]) {
      const m1 = 1,
        m2 = ratio * k * m1,
        rope = atwood(m1, m2, mu);
      for (let i = 0; i < 15; i++) rope.step(1 / 60);
      const a = -rope.velocity(1)[1] / 0.25,
        exact =
          m2 > k * m1 ? (g * (m2 - k * m1)) / (m2 + k * m1) : m1 > k * m2 ? (-g * (m1 - k * m2)) / (m1 + k * m2) : 0;
      assert.ok(Math.abs(a - exact) < 1e-9, `mu ${mu}, m2/m1 ${m2}: ${a} m/s^2, the closed form ${exact}`);
      const [tA, tB] = rope.tension(0);
      if (mu > 0 && ratio > 1) {
        assert.equal(rope.holding(0), false);
        assert.ok(
          Math.abs(tB / tA - k) < 1e-9,
          `sliding, the tensions are ${tA} and ${tB}, a ratio of ${tB / tA}, not ${k}`,
        );
      }
      if (mu > 0 && ratio < 1) {
        assert.equal(rope.holding(0), true);
        assert.ok(tB / tA < k, `held, the tensions' ratio ${tB / tA} is within ${k}`);
      }
    }
  }
});

test('a cleat holds a load over a capstan with the load over the capstan ratio, and a winch lifts it', () => {
  // A rope from a fixed cleat over the cylinder to a 5 kg load: the wrap holds whatever the load, and the cleat carries at
  // least the load over e^(mu phi). Driven up 0.1 m, the cleat's end lifts the load 0.1 m (the rope does not stretch).
  const mu = 0.25,
    rope = new WrappedRope({
      nodes: [
        { position: [-R, -1, 0], fixed: true },
        { position: [R, -1, 0], mass: 5 },
      ],
      wraps: [{ center: [0, 0, 0], axis: [0, 0, 1], radius: R, friction: mu, turn: -1 }],
    });
  for (let i = 0; i < 60; i++) rope.step(1 / 60);
  const [cleat, load] = rope.tension(0);
  assert.ok(Math.abs(load - 5 * g) < 1e-6, `the load side carries ${load} N`);
  assert.ok(Math.abs(cleat - (5 * g) / Math.exp(mu * Math.PI)) < 1e-6, `the cleat carries ${cleat} N`);
  assert.ok(Math.abs(rope.position(1)[1] + 1) < 1e-6, 'the load hangs still');
  for (let i = 1; i <= 60; i++) {
    rope.setNodePosition(0, [-R, -1 - (0.1 * i) / 60, 0]);
    rope.step(1 / 60);
  }
  for (let i = 0; i < 60; i++) rope.step(1 / 60);
  assert.ok(Math.abs(rope.position(1)[1] + 0.9) < 1e-3, `the winch lifted the load to ${rope.position(1)[1]} m`);
});

test('over two pulleys in turn, the rope holds until the tensions differ by the product of the two capstan ratios', () => {
  // Over two cylinders a quarter turn each, a light node between them sagging 2 cm on the span (a weight on a straight
  // taut rope would need a tension without end): the wraps hold while
  // T_B / T_A < e^(mu (phi1 + phi2)) = e^(mu pi). Held at 0.9 of it; slides at 1.1 of it.
  const mu = 0.3,
    k = Math.exp(mu * Math.PI);
  for (const [ratio, slides] of [
    [0.9, false],
    [1.1, true],
  ]) {
    const rope = new WrappedRope({
      nodes: [
        { position: [-1 - R, -1, 0], mass: 1 },
        { position: [0, R - 0.02, 0], mass: 0.01 },
        { position: [1 + R, -1, 0], mass: ratio * k },
      ],
      wraps: [
        { center: [-1, 0, 0], axis: [0, 0, 1], radius: R, friction: mu, turn: -1 },
        { center: [1, 0, 0], axis: [0, 0, 1], radius: R, friction: mu, turn: -1 },
      ],
      passes: 64,
    });
    // The middle span's tension is not fixed by the statics of an inextensible rope, so the rope first slips a little at
    // one pulley until it carries what the other needs (2.5 cm here); after half a second the held rope stands still.
    for (let i = 0; i < 30; i++) rope.step(1 / 60);
    const settled = rope.position(2)[1];
    for (let i = 0; i < 30; i++) rope.step(1 / 60);
    const dropped = settled - rope.position(2)[1];
    if (slides) assert.ok(dropped > 0.05, `at ${ratio} of the ratio the heavy side dropped only ${dropped} m in 0.5 s`);
    else assert.ok(Math.abs(dropped) < 1e-3, `at ${ratio} of the ratio the heavy side moved ${dropped} m in 0.5 s`);
  }
});

test('a wrapped rope refuses what it cannot be made of, naming the fix', () => {
  const refused = (message) => ({ name: 'MargoError', code: 'unsupported', message: new RegExp(`${message}.+#rods`) });
  assert.throws(() => new WrappedRope({ nodes: [{ position: [0, 0, 0], mass: 1 }] }), refused('two or more nodes'));
  assert.throws(
    () => new WrappedRope({ nodes: [{ position: [0, 0, 0] }, { position: [1, 0, 0], mass: 1 }] }),
    refused('mass above 0'),
  );
  assert.throws(
    () =>
      new WrappedRope({
        nodes: [
          { position: [0, 0, 0], mass: 1 },
          { position: [1, 0, 0], mass: 1 },
        ],
        wraps: [null, null],
      }),
    refused('one entry per span'),
  );
  const rope = atwood(1, 1, 0);
  assert.throws(() => rope.step(0), refused('finite time'));
  assert.throws(() => rope.setNodePosition(0, [0, 0, 0]), refused('fixed node'));
});
