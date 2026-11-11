import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer, createSnapshot } from '../dist/index.js';
import { AdaptiveDelay } from '../dist/delay.js';

const rng = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

/** Runs a stand-in link: `transit(sent, index)` gives a snapshot's delay in seconds, or null when it is lost. */
function link({ interval = 0.05, seconds = 60, transit, offset = 0 }) {
  const packets = [];
  for (let i = 0; i * interval < seconds; i++) {
    const sent = i * interval,
      delay = transit(sent, i);
    if (delay !== null) packets.push({ sent, received: sent + delay + offset });
  }
  return packets.sort((a, b) => a.received - b.received);
}

/**
 * Plays `packets` at 60 frames a second against `renderAt`, measuring what a player sees: the share of frames drawn
 * past the newest snapshot held, and the mean delay behind real sender time. `from` skips the warm-up.
 */
function play(packets, renderAt, { observe = () => {}, from = 5, offset = 0 } = {}) {
  let next = 0,
    newest = -Infinity,
    frames = 0,
    starved = 0,
    behind = 0;
  const end = packets[packets.length - 1].received;
  for (let frame = 0, now = packets[0].received; now < end; now = packets[0].received + ++frame / 60) {
    while (next < packets.length && packets[next].received <= now) {
      observe(packets[next]);
      newest = Math.max(newest, packets[next++].sent);
    }
    const time = renderAt(now);
    if (now - offset < from) continue;
    frames++;
    behind += now - offset - time;
    if (time > newest) starved++;
  }
  return { starved: starved / frames, behind: behind / frames };
}

test('a clean link settles on exactly one send interval, whatever the clocks say', () => {
  for (const offset of [0, 1000, -86400]) {
    const delay = new AdaptiveDelay();
    for (const { sent, received } of link({ transit: () => 0.04, offset })) delay.observe(sent, received);
    assert.ok(Math.abs(delay.target - 0.05) < 1e-9, `target ${delay.target}`);
    assert.ok(Math.abs(delay.offset - (0.04 + offset)) < 1e-9, `offset ${delay.offset}`);
  }
});

test('the delay covers the measured jitter: the 99th percentile of uniform noise', () => {
  const random = rng(1),
    interval = 0.05,
    jitter = 0.08,
    delay = new AdaptiveDelay();
  for (const { sent, received } of link({ interval, transit: () => 0.03 + jitter * random() }))
    delay.observe(sent, received);
  // The gap needed is the interval plus this snapshot's jitter above the floor, so at most interval + jitter, and the
  // 99th percentile of 256 uniform draws falls in the top tenth with near certainty.
  assert.ok(delay.target > interval + 0.9 * jitter && delay.target <= interval + jitter, `target ${delay.target}`);
});

test('lost snapshots count: a gap of two intervals is a need of two intervals', () => {
  const random = rng(2),
    interval = 0.05,
    delay = new AdaptiveDelay();
  for (const { sent, received } of link({ interval, transit: () => (random() < 0.1 ? null : 0.03) }))
    delay.observe(sent, received);
  // At 10% loss one gap in a hundred runs over two lost snapshots, so the 99th percentile sits near three intervals.
  assert.ok(delay.target >= 2 * interval - 1e-9 && delay.target <= 4 * interval + 1e-9, `target ${delay.target}`);
});

test('on a link that turns bad then calms, it beats any fixed delay on both counts', () => {
  const random = rng(3),
    interval = 0.05,
    // Quiet for 20 s, 150 ms of jitter for 20 s, quiet for 40 s.
    transit = (sent) => 0.03 + (sent >= 20 && sent < 40 ? 0.15 * random() : 0.002 * random()),
    packets = link({ interval, seconds: 80, transit }),
    delay = new AdaptiveDelay(),
    adaptive = play(packets, (now) => delay.renderTime(now), {
      observe: (packet) => delay.observe(packet.sent, packet.received),
    }),
    fixedAt = (seconds) => play(packets, (now) => now - 0.03 - seconds),
    sameDelay = fixedAt(adaptive.behind - 0.03),
    sameStarved = fixedAt(0.2);
  assert.ok(adaptive.starved < 0.02, `starved ${adaptive.starved}`);
  // A fixed delay with the same mean goes hungry far more often, and one that never goes hungry sits further behind.
  assert.ok(sameDelay.starved > 3 * adaptive.starved, `${sameDelay.starved} against ${adaptive.starved}`);
  assert.ok(sameStarved.behind > 1.5 * adaptive.behind, `${sameStarved.behind} against ${adaptive.behind}`);
});

test('it follows a delay spike and does not learn from it', () => {
  const interval = 0.02,
    // Moon et al.'s shape: a sudden rise, then packets landing in a burst as the queue drains.
    transit = (sent) => {
      const since = sent - 10;
      return 0.03 + (since >= 0 && since < 0.4 ? 0.4 - since : 0);
    },
    delay = new AdaptiveDelay();
  let seen = false,
    peak = 0;
  for (const { sent, received } of link({ interval, seconds: 20, transit })) {
    delay.observe(sent, received);
    seen ||= delay.spiking;
    peak = Math.max(peak, delay.target);
  }
  assert.equal(seen, true);
  assert.equal(delay.spiking, false);
  assert.ok(peak >= 0.4, `peak ${peak}`);
  assert.ok(Math.abs(delay.target - interval) < 1e-9, `target ${delay.target}`);
});

test('a lasting change of route is learned, not treated as a spike for ever', () => {
  const interval = 0.05,
    delay = new AdaptiveDelay({ window: 64 });
  for (const { sent, received } of link({ interval, seconds: 30, transit: (sent) => (sent < 10 ? 0.03 : 0.33) }))
    delay.observe(sent, received);
  assert.equal(delay.spiking, false);
  assert.ok(Math.abs(delay.offset - 0.33) < 1e-9, `offset ${delay.offset}`);
  assert.ok(Math.abs(delay.target - interval) < 1e-9, `target ${delay.target}`);
});

test('a faster route and a drifting clock keep the view in place', () => {
  const interval = 0.05,
    delay = new AdaptiveDelay({ window: 64 });
  // 1,000 parts per million of drift against a route that gets 100 ms shorter at 10 s.
  for (const { sent, received } of link({
    interval,
    seconds: 40,
    transit: (sent) => (sent < 10 ? 0.13 : 0.03) + sent * 0.001,
  }))
    delay.observe(sent, received);
  // The floor is the oldest transit the window holds, so drift lifts the need by the drift across the window.
  assert.ok(Math.abs(delay.target - interval) <= 0.001 * 64 * interval + 1e-9, `target ${delay.target}`);
});

test('out-of-order and repeated snapshots do not count as arrivals', () => {
  const delay = new AdaptiveDelay();
  assert.equal(delay.observe(1, 1.03), true);
  assert.equal(delay.observe(1.1, 1.13), true);
  assert.equal(delay.observe(1.05, 1.14), false);
  assert.equal(delay.observe(1.1, 1.15), false);
  assert.ok(Math.abs(delay.offset - 0.03) < 1e-12);
  assert.equal(delay.observe(0.9, 1.0), false);
  assert.ok(Math.abs(delay.offset - 0.03) < 1e-12);
  assert.equal(delay.observe(0.5, 0.51), false);
  assert.ok(Math.abs(delay.offset - 0.01) < 1e-12, 'an old snapshot still teaches the floor');
});

test('the view never runs backward and leaves real time only by its limits', () => {
  const random = rng(4),
    delay = new AdaptiveDelay(),
    packets = link({
      interval: 0.05,
      seconds: 40,
      transit: (sent) => 0.03 + (sent % 10 < 5 ? 0.3 : 0.01) * random(),
    });
  let next = 0,
    last = Number.NaN;
  for (let now = packets[0].received; now < 40; now += 1 / 60) {
    while (next < packets.length && packets[next].received <= now) {
      delay.observe(packets[next].sent, packets[next].received);
      next++;
    }
    const time = delay.renderTime(now);
    if (!Number.isNaN(last)) {
      const rate = (time - last) * 60;
      assert.ok(rate >= 0.75 - 1e-6 && rate <= 1.05 + 1e-6, `rate ${rate} at ${now}`);
    }
    last = time;
  }
  // A clock that steps back holds the view; it does not move it.
  assert.equal(delay.renderTime(10), last);
});

test('a view left behind by more than max jumps forward', () => {
  const delay = new AdaptiveDelay({ max: 0.5 });
  delay.observe(0, 0);
  delay.observe(0.05, 0.05);
  const first = delay.renderTime(1);
  // The floor falls by 5.1 s, ten times max, so slewing there at 5% would take a minute and more.
  delay.observe(0.1, -5);
  const time = delay.renderTime(1.001);
  assert.ok(time > first + 0.5);
  assert.ok(Math.abs(time - (1.001 - delay.offset - delay.target)) < 1e-12);
  assert.ok(Math.abs(delay.delay - delay.target) < 1e-12);
});

test('before any snapshot there is no time, and reset forgets', () => {
  const delay = new AdaptiveDelay({ initial: 0.2 });
  assert.equal(Number.isNaN(delay.renderTime(1)), true);
  assert.equal(Number.isNaN(delay.offset), true);
  assert.equal(delay.delay, 0.2);
  delay.observe(5, 5.03);
  assert.ok(Math.abs(delay.renderTime(5.03) - 4.8) < 1e-12);
  assert.ok(Math.abs(delay.delay - 0.2) < 1e-12);
  delay.reset();
  assert.equal(Number.isNaN(delay.renderTime(1)), true);
  assert.equal(delay.observe(1, 1), true, 'older times count again after a reset');
});

test('min, max, margin and a short cold start bound the delay', () => {
  const clean = link({ transit: () => 0.01, seconds: 5 }),
    run = (options) => {
      const delay = new AdaptiveDelay(options);
      for (const { sent, received } of clean) delay.observe(sent, received);
      return delay.target;
    };
  assert.equal(run({ min: 0.08 }), 0.08);
  assert.equal(run({ max: 0.02 }), 0.02);
  assert.ok(Math.abs(run({ margin: 0.01 }) - 0.06) < 1e-9);
  const cold = new AdaptiveDelay({ initial: 0.15 });
  for (const { sent, received } of clean.slice(0, 4)) cold.observe(sent, received);
  assert.equal(cold.target, 0.15);
});

// Pins the documented warm-up constant (docs/clean-room.md, net/delay: `WARM`, 8 arrivals; KB6124a). Ramjee et al.
// 1994 and Moon, Kurose and Towsley 1998 give no warm-up count; 8 is Margo's own number, so a change must be deliberate.
test('the initial delay is the floor for exactly 8 arrivals, then the measured delay takes over', () => {
  const clean = link({ transit: () => 0.01, seconds: 2 }),
    delay = new AdaptiveDelay({ initial: 0.15 });
  // The first snapshot only sets the clocks; arrivals 2 to 9 each give one measured gap.
  for (const { sent, received } of clean.slice(0, 8)) delay.observe(sent, received);
  assert.equal(delay.target, 0.15, 'seven measured gaps: still below the 8-arrival warm-up');
  delay.observe(clean[8].sent, clean[8].received);
  assert.ok(
    Math.abs(delay.target - 0.05) < 1e-9,
    `eighth measured gap: the clean link's one send interval, got ${delay.target}`,
  );
});

test('options are checked', () => {
  for (const options of [
    { quantile: 0.2 },
    { quantile: 1.5 },
    { window: 8 },
    { window: 16.5 },
    { min: 2 },
    { max: -1 },
    { slowdown: 1 },
    { speedup: 2 },
    { spikeHead: 1 },
    { spikeTail: 0.5 },
    { initial: Number.NaN },
    { margin: -1 },
  ])
    assert.throws(() => new AdaptiveDelay(options), RangeError, JSON.stringify(options));
  const delay = new AdaptiveDelay();
  assert.throws(() => delay.observe(Number.NaN, 1), RangeError);
  assert.throws(() => delay.renderTime(Number.POSITIVE_INFINITY), RangeError);
});

test('driving a SnapshotBuffer: a moving object plays back exactly while the view is fed', () => {
  const random = rng(5),
    buffer = new SnapshotBuffer(64),
    delay = new AdaptiveDelay(),
    pose = createSnapshot(),
    speed = 3,
    packets = link({ transit: () => 0.03 + 0.04 * random(), seconds: 30 });
  let worst = 0,
    next = 0;
  for (let now = packets[0].received; now < 30; now += 1 / 60) {
    while (next < packets.length && packets[next].received <= now) {
      const { sent, received } = packets[next++];
      buffer.push(sent, [sent * speed, 0, 0], undefined, [speed, 0, 0]);
      delay.observe(sent, received);
    }
    const time = delay.renderTime(now);
    buffer.sample(time, pose);
    if (now > 5) worst = Math.max(worst, Math.abs(pose.position[0] - time * speed));
  }
  // Hermite interpolation and capped dead reckoning are both exact on constant velocity.
  assert.ok(worst < 1e-9, `worst ${worst}`);
});
