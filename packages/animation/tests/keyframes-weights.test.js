// Morph-weight tracks in code-authored clips: sampling, glTF baking, and playback on Skeletons and glTF-pro models.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGLB } from '../../exporters/dist/index.js';
import {
  Animation,
  Skeleton,
  applyKeyframeClip,
  bakeKeyframeClip,
  createKeyframeClip,
  sampleKeyframes,
} from '../dist/index.js';
import { engine, fromGLB, near, position } from './support/models.js';

const smile = createKeyframeClip({
  name: 'Smile',
  tracks: [
    {
      target: 'face',
      path: 'weights',
      keys: [
        { time: 0, value: [0, 1], interpolation: 'easeIn' },
        { time: 1, value: [1, 0.5], interpolation: 'discrete' },
        { time: 2, value: [0.25, 0] },
        { time: 3, value: [0.75, 0.25] },
      ],
    },
    {
      target: 'face',
      path: 'translation',
      keys: [
        { time: 0, value: [0, 0, 0] },
        { time: 3, value: [3, 0, 0] },
      ],
    },
  ],
});

/** A two-target morph quad named 'face' under a node named 'head'. */
function faceScene(animations = []) {
  const face = {
    name: 'face',
    geometry: {
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2, 0, 2, 3],
      morphs: [
        { name: 'smile', positions: [0, 0.1, 0, 0, 0.1, 0, 0, 0, 0, 0, 0, 0] },
        { name: 'blink', positions: [0, 0, 0, 0, 0, 0, 0, -0.1, 0, 0, -0.1, 0] },
      ],
    },
  };
  return { face, glb: (bake) => exportGLB({ nodes: [{ name: 'head', children: [face] }], animations: bake(face) }) };
}

test('weights tracks sample per component with each key easing to the next, unnormalised', () => {
  const track = smile.tracks[0];
  assert.equal(track.path, 'weights');
  assert.equal(smile.duration, 3);
  near(sampleKeyframes(track, -1), [0, 1], 0, 'before the first key');
  near(sampleKeyframes(track, 0.5), [0.125, 1 - 0.5 * 0.125], 1e-12, 'ease in: 0.5^3');
  near(sampleKeyframes(track, 1.5), [1, 0.5], 0, 'discrete holds');
  near(sampleKeyframes(track, 2), [0.25, 0], 0, 'and jumps at the next key');
  near(sampleKeyframes(track, 2.5), [0.5, 0.125], 1e-12, 'linear');
  near(sampleKeyframes(track, 9), [0.75, 0.25], 0, 'after the last key');
  const out = new Float64Array(2);
  assert.equal(sampleKeyframes(track, 2.5, out), out);
  // Four targets are four weights, not a quaternion: no normalisation, and the weighted blend works per component.
  const four = createKeyframeClip({
    tracks: [
      {
        target: 'm',
        path: 'weights',
        blend: 'weighted',
        keys: [
          { time: 0, value: [1, 1, 1, 1] },
          { time: 1, value: [0, 2, 0, 4] },
        ],
      },
    ],
  }).tracks[0];
  near(sampleKeyframes(four, 0), [1, 1, 1, 1], 0, 'kept as keyed');
  near(sampleKeyframes(four, 0.5), [0.5, 1.5, 0.5, 2.5], 1e-12, 'weighted');
});

test('weights tracks validate their width, values and path', () => {
  const clip = (keys) => () => createKeyframeClip({ tracks: [{ target: 'm', path: 'weights', keys }] });
  assert.throws(clip([{ time: 0, value: [] }]), /one number per morph target/);
  assert.throws(clip([{ time: 0, value: 3 }]), /one number per morph target/);
  assert.throws(
    clip([
      { time: 0, value: [0, 1] },
      { time: 1, value: [0, 1, 2] },
    ]),
    /needs 2 numbers/,
  );
  assert.throws(clip([{ time: 0, value: [0, Number.NaN] }]), RangeError);
  assert.throws(
    () => createKeyframeClip({ tracks: [{ target: 'm', path: 'colour', keys: [{ time: 0, value: [0] }] }] }),
    /use translation, rotation, scale or weights/,
  );
});

test('a Skeleton skips weights tracks; other targets must be a Skeleton or an Animation', () => {
  const skeleton = new Skeleton([{ name: 'face', parent: -1 }]);
  applyKeyframeClip(smile, skeleton, 1.5);
  near(skeleton.getPose(0).translation, [1.5, 0, 0], 1e-12, 'translation applied');
  assert.throws(() => applyKeyframeClip(smile, {}, 0), /needs a Skeleton or an Animation/);
});

test('code-authored weights drive a glTF-pro model through setMorph, and bake to glTF weights channels', async () => {
  const { glb } = faceScene(),
    model = fromGLB(
      await engine(),
      glb(() => []),
    ),
    animation = new Animation(model),
    faceNode = model.nodes.findIndex((node) => node.name === 'face'),
    weights = () => Array.from(model.primitives.find((p) => p.nodeIndex === faceNode).weights);
  animation.playing = false;
  for (const t of [0, 0.5, 1.5, 2.5, 3]) {
    applyKeyframeClip(smile, animation, t);
    near(weights(), Array.from(sampleKeyframes(smile.tracks[0], t)), 1e-7, `weights at ${t}`);
    near(position(model.nodes[faceNode]), [t, 0, 0], 1e-6, `translation at ${t}`);
  }
  const wide = createKeyframeClip({
    tracks: [{ target: 'face', path: 'weights', keys: [{ time: 0, value: [1, 2, 3] }] }],
  });
  assert.throws(() => applyKeyframeClip(wide, animation, 0), /has 3 values but the node has 2 morph targets/);

  // Baked: one LINEAR or STEP 'weights' channel, two values per key, read back by gltf-pro and played by Animation.
  const baked = bakeKeyframeClip(smile, 30, (target) => (target === 'face' ? 'face' : undefined)),
    channel = baked.channels.find((c) => c.path === 'weights');
  assert.equal(channel.interpolation, 'LINEAR');
  assert.equal(channel.values.length, channel.times.length * 2);
  const played = fromGLB(
      await engine(),
      faceScene().glb((face) => [bakeKeyframeClip(smile, 30, (target) => (target === 'face' ? face : undefined))]),
    ),
    player = new Animation(played, { loop: false }).play('Smile'),
    node = played.nodes.findIndex((n) => n.name === 'face');
  for (const t of [0, 0.2, 0.5, 1, 1.5, 2, 2.5, 3]) {
    player.seek(t);
    near(
      Array.from(played.primitives.find((p) => p.nodeIndex === node).weights),
      Array.from(sampleKeyframes(smile.tracks[0], t)),
      1e-6,
      `round trip at ${t}`,
    );
  }
});
