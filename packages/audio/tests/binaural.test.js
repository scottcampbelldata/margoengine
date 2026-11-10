import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioListener } from '../dist/index.js';
import { BinauralAudio, ambixBasis } from '@margoengine/audio/binaural';
import { FakeAudioContext, FakeNode } from './fake-web-audio.js';

function setup(channels = 16) {
  const context = new FakeAudioContext({ state: 'suspended' }),
    panners = [],
    edges = [];
  context.createChannelSplitter = () => {
    const node = new FakeNode(context, 'splitter');
    node.connect = (gain, channel) => {
      edges.push({ gain, channel });
      node.outputs.add(gain);
      return gain;
    };
    return node;
  };
  const original = context.createPanner.bind(context);
  context.createPanner = () => {
    const panner = original();
    panners.push(panner);
    return panner;
  };
  const listener = new AudioListener({ context, smoothing: 0 });
  const buffer = context.createBuffer(channels, 48000, 48000);
  return { context, listener, buffer, panners, edges };
}
const near = (a, b, t = 1e-12) => assert.ok(Math.abs(a - b) < t, `${a} != ${b}`);

test('AmbiX basis matches analytic first/second/third order axes and addition theorem', () => {
  assert.deepEqual([...ambixBasis(1, [1, 0, 0])], [1, 0, 0, 1]);
  const north = ambixBasis(3, [0, 0, 1]);
  for (let n = 0; n <= 3; n++) for (let m = -n; m <= n; m++) near(north[n * n + n + m], m === 0 ? 1 : 0);
  const [x, y, z] = [2 / 3, 1 / 3, 2 / 3],
    b = ambixBasis(3, [x, y, z]);
  near(b[4], Math.sqrt(3) * x * y);
  near(b[5], Math.sqrt(3) * y * z);
  near(b[6], (3 * z * z - 1) / 2);
  near(b[7], Math.sqrt(3) * x * z);
  near(b[8], (Math.sqrt(3) * (x * x - y * y)) / 2);
  near(b[9], Math.sqrt(5 / 8) * y * (3 * x * x - y * y));
  near(b[12], (z * (5 * z * z - 3)) / 2);
  for (let n = 0; n <= 3; n++)
    near(
      [...b.slice(n * n, (n + 1) ** 2)].reduce((s, v) => s + v * v, 0),
      1,
    );
  assert.throws(() => ambixBasis(4, [1, 0, 0]));
  assert.throws(() => ambixBasis(3, [2, 0, 0]));
});

test('32-direction weighted decoder exactly reconstructs all modal coefficients through order 3', () => {
  for (const channels of [4, 9, 16]) {
    const s = setup(channels),
      bed = new BinauralAudio(s.listener, s.buffer);
    assert.equal(bed.order, Math.sqrt(channels) - 1);
    assert.equal(s.panners.length, 32);
    assert.equal(s.edges.length, 32 * channels);
    const basis = s.panners.map((p) =>
      ambixBasis(bed.order, [-p.positionZ.value, -p.positionX.value, p.positionY.value]),
    );
    for (let a = 0; a < channels; a++)
      for (let b = 0; b < channels; b++) {
        const sum = basis.reduce((sum, y, i) => sum + y[a] * s.edges[i * channels + b].gain.gain.value, 0);
        near(sum, a === b ? 1 : 0);
      }
    assert.ok(s.panners.every((p) => p.panningModel === 'HRTF' && p.rolloffFactor === 0));
    bed.play();
    assert.equal(bed.isPlaying, true);
    bed.pause();
    s.context.currentTime = 4;
    bed.play();
    bed.setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    const positions = s.panners.map((p) => [p.positionX.value, p.positionY.value, p.positionZ.value]);
    s.listener.setPose([10, 20, 30], [0, 0, -1]);
    s.listener.update();
    s.panners.forEach((p, i) =>
      [p.positionX, p.positionY, p.positionZ].forEach((v, j) => near(v.value, positions[i][j] + [10, 20, 30][j])),
    );
    assert.throws(() => bed.setBuffer(s.context.createBuffer(channels === 4 ? 9 : 4, 48, 48000)));
    assert.equal(bed.isPlaying, true);
    assert.equal(bed.buffer, s.buffer);
    assert.throws(() => bed.setRotation([0, 0, 0, 0]));
    s.listener.dispose();
    bed.dispose();
    assert.ok(s.panners.every((p) => p.outputs.size === 0));
    assert.equal(bed.isDisposed, true);
  }
});

test('invalid format and incomplete channel sets reject before allocating a decoder', () => {
  const s = setup();
  for (const channels of [1, 2, 3, 8, 10, 25])
    assert.throws(() => new BinauralAudio(s.listener, s.context.createBuffer(channels, 48, 48000)));
  assert.throws(() => new BinauralAudio(s.listener, s.buffer, { format: 'fuma' }));
  assert.equal(s.panners.length, 0);
  s.listener.dispose();
});
