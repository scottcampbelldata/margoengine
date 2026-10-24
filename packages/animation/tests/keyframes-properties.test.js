import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyKeyframeClip,
  bakeKeyframeClip,
  bakeKeyframeTrack,
  createKeyframeClip,
  sampleKeyframes,
  Skeleton,
} from '../dist/index.js';

const near = (actual, expected, epsilon = 1e-12) => {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) <= epsilon, `[${i}] ${actual[i]} != ${expected[i]}`);
};

test('scalar, vec3 and colour property tracks drive a plain object through nested paths', () => {
  const lamp = { intensity: 0, offset: [0, 0, 0], material: { roughness: 1, color: new Float32Array([1, 1, 1, 0.5]) } };
  const clip = createKeyframeClip({
    name: 'Lamp',
    tracks: [
      {
        target: lamp,
        property: 'intensity',
        keys: [
          { time: 0, value: [0] },
          { time: 2, value: [10] },
        ],
      },
      {
        target: lamp,
        property: 'offset',
        keys: [
          { time: 0, value: [0, 0, 0] },
          { time: 1, value: [2, 4, 6] },
        ],
      },
      {
        target: lamp,
        property: 'material.roughness',
        keys: [
          { time: 0, value: [1] },
          { time: 1, value: [0] },
        ],
      },
      {
        target: lamp,
        property: 'material.color',
        type: 'color',
        keys: [
          { time: 0, value: [1, 0, 0] },
          { time: 1, value: [0, 0, 1] },
        ],
      },
    ],
  });
  assert.equal(clip.tracks.length, 0);
  assert.equal(clip.properties.length, 4);
  assert.equal(clip.duration, 2);
  assert.equal(clip.properties[3].type, 'color');
  assert.equal(clip.properties[3].size, 3);
  const color = lamp.material.color;
  applyKeyframeClip(clip, 0.5);
  assert.equal(lamp.intensity, 2.5);
  assert.deepEqual(lamp.offset, [1, 2, 3]);
  assert.equal(lamp.material.roughness, 0.5);
  assert.equal(lamp.material.color, color, 'the live array is written in place');
  near(color, [0.5, 0, 0.5, 0.5], 1e-7); // linear-space blend; opacity kept
  applyKeyframeClip(clip, 5);
  assert.equal(lamp.intensity, 10);
  assert.deepEqual(lamp.offset, [2, 4, 6]);
  near(clip.properties[1].read(), [2, 4, 6]);
});

test('a quaternion property slerps along the shortest path and is normalised', () => {
  const s = Math.SQRT1_2,
    holder = { q: [0, 0, 0, 1] },
    clip = createKeyframeClip({
      tracks: [
        {
          target: holder,
          property: 'q',
          type: 'quaternion',
          keys: [
            { time: 0, value: [0, 0, 0, 2] },
            { time: 1, value: [0, 0, -s, -s] }, // the far hemisphere of +90 degrees about z
          ],
        },
      ],
    });
  near(clip.properties[0].values.subarray(0, 4), [0, 0, 0, 1]);
  applyKeyframeClip(clip, 0.5);
  const half = Math.PI / 8;
  near(holder.q, [0, 0, Math.sin(half), Math.cos(half)], 1e-12);
  assert.throws(
    () =>
      createKeyframeClip({
        tracks: [{ target: holder, property: 'q', type: 'quaternion', keys: [{ time: 0, value: [0, 0, 0, 0] }] }],
      }),
    { name: 'RangeError', message: /zero quaternion/ },
  );
});

test('vector objects, setter properties, copying getters and booleans bind once', () => {
  let writes = 0;
  const position = {
    store: [0, 0, 0],
    get x() {
      return this.store[0];
    },
    get y() {
      return this.store[1];
    },
    get z() {
      return this.store[2];
    },
    set(x, y, z) {
      writes++;
      this.store = [x, y, z];
      return this;
    },
  };
  const tint = { value: [0, 0, 0] };
  const mesh = {
    position,
    visible: false,
    get tint() {
      return tint.value.slice(); // a copy on every read
    },
    set tint(v) {
      tint.value = [...v];
    },
    rgba: { r: 0, g: 0, b: 0, a: 1 },
  };
  const clip = createKeyframeClip({
    tracks: [
      {
        target: mesh,
        property: 'position',
        keys: [
          { time: 0, value: [0, 0, 0] },
          { time: 1, value: [1, 2, 3] },
        ],
      },
      {
        target: mesh,
        property: 'tint',
        keys: [
          { time: 0, value: [0, 0, 0] },
          { time: 1, value: [1, 1, 1] },
        ],
      },
      {
        target: mesh,
        property: 'visible',
        keys: [
          { time: 0, value: [0], interpolation: 'discrete' },
          { time: 1, value: [1] },
        ],
      },
      { target: mesh, property: 'rgba', type: 'color', keys: [{ time: 0, value: [1, 0.5, 0.25, 0.5] }] },
    ],
  });
  applyKeyframeClip(clip, 0.5);
  assert.deepEqual(position.store, [0.5, 1, 1.5]);
  assert.equal(writes, 1, 'a vector object with set(x, y, z) gets one call');
  assert.deepEqual(tint.value, [0.5, 0.5, 0.5], 'a getter that copies is assigned through its setter');
  assert.equal(mesh.visible, false);
  assert.deepEqual(mesh.rgba, { r: 1, g: 0.5, b: 0.25, a: 0.5 });
  applyKeyframeClip(clip, 1);
  assert.equal(mesh.visible, true);
  near(clip.properties[0].read(), [1, 2, 3]);
});

test('accessor tracks call set with a reused array and read through get', () => {
  const seen = [];
  let fov = 60;
  let reused;
  const camera = {};
  const clip = createKeyframeClip({
    tracks: [
      {
        target: camera,
        name: 'fov',
        get: () => fov,
        set: (value) => {
          reused ??= value;
          assert.equal(value, reused);
          assert.equal(value.length, 1);
          fov = value[0];
          seen.push(fov);
        },
        keys: [
          { time: 0, value: [30] },
          { time: 1, value: [90] },
        ],
      },
    ],
  });
  applyKeyframeClip(clip, 0.25);
  applyKeyframeClip(clip, 0.75);
  assert.deepEqual(seen, [45, 75]);
  assert.deepEqual([...clip.properties[0].read()], [75]);
  const writeOnly = createKeyframeClip({ tracks: [{ target: camera, set() {}, keys: [{ time: 0, value: [1] }] }] });
  assert.throws(() => writeOnly.properties[0].read(), { name: 'TypeError', message: /get/ });
});

test('discrete, linear, eased and cubic spline keys sample as on transform tracks', () => {
  const o = { v: 0, w: [0, 0] };
  const keys = [
    { time: 0, value: [0], interpolation: 'discrete' },
    { time: 1, value: [1], interpolation: 'linear' },
    { time: 2, value: [3], interpolation: 'easeIn' },
    { time: 3, value: [4], interpolation: 'cubicSpline', outTangent: [2] },
    { time: 5, value: [6], inTangent: [0] },
  ];
  const clip = createKeyframeClip({ tracks: [{ target: o, property: 'v', keys }] }),
    track = clip.properties[0];
  const at = (t) => sampleKeyframes(track, t)[0];
  assert.equal(at(0.99), 0);
  assert.equal(at(1), 1);
  assert.equal(at(1.5), 2);
  assert.equal(at(2.5), 3 + 0.125);
  // Hermite: p0 = 4, m0 = 2 * 2 s, p1 = 6, m1 = 0 at u = 0.5.
  assert.equal(at(4), 0.5 * 4 + 0.125 * 2 * 2 + 0.5 * 6);
  assert.equal(at(9), 6);
  // The same keys on a transform track give the same numbers.
  const transform = createKeyframeClip({
    tracks: [
      {
        target: 'n',
        path: 'translation',
        keys: keys.map((k) => ({
          ...k,
          value: [k.value[0], 0, 0],
          ...(k.outTangent ? { outTangent: [2, 0, 0] } : {}),
          ...(k.inTangent ? { inTangent: [0, 0, 0] } : {}),
        })),
      },
    ],
  });
  for (const t of [0.5, 1.25, 2.5, 3.5, 4.75]) assert.equal(sampleKeyframes(transform.tracks[0], t)[0], at(t));
  assert.throws(
    () =>
      createKeyframeClip({
        tracks: [
          {
            target: o,
            property: 'v',
            keys: [{ time: 0, value: [0], interpolation: 'cubicSpline', outTangent: [1, 2] }],
          },
        ],
      }),
    { name: 'TypeError', message: /outTangent needs 1 numbers/ },
  );
});

test('delta and weighted blends on property tracks', () => {
  const o = { a: 0, b: 0 },
    big = Number.MAX_VALUE;
  const keys = [
    { time: 0, value: [-big] },
    { time: 1, value: [big] },
  ];
  const clip = createKeyframeClip({
    tracks: [
      { target: o, property: 'a', keys },
      { target: o, property: 'b', keys, blend: 'weighted' },
    ],
  });
  assert.equal(clip.properties[0].blend, undefined);
  assert.equal(clip.properties[1].blend, 'weighted');
  applyKeyframeClip(clip, 0.25);
  assert.ok(!Number.isFinite(o.a), "'delta' overflows on b - a");
  assert.equal(o.b, 0.75 * -big + 0.25 * big);
  applyKeyframeClip(clip, 1);
  assert.equal(o.b, big);
});

test('property paths and track data reject with messages that name the fix', () => {
  const o = { material: { roughness: 1, name: 'm' }, list: [1, 2], nothing: null };
  const bad = (track, name, pattern) =>
    assert.throws(() => createKeyframeClip({ tracks: [track] }), { name, message: pattern });
  const one = [{ time: 0, value: [0] }];
  bad({ target: o, property: 'material.roughnes', keys: one }, 'RangeError', /has no 'roughnes'.*check the spelling/);
  bad({ target: o, property: 'missing.roughness', keys: one }, 'RangeError', /stops at 'missing'.*undefined/);
  bad({ target: o, property: 'nothing.x', keys: one }, 'RangeError', /stops at 'nothing'.*null/);
  bad({ target: o, property: 'material..roughness', keys: one }, 'TypeError', /empty segment/);
  bad({ target: o, property: 'material.name', keys: one }, 'TypeError', /is string.*pass set/);
  bad(
    { target: o, property: 'material.roughness', keys: [{ time: 0, value: [0, 0] }] },
    'TypeError',
    /is a number, which 2 numbers per key cannot drive/,
  );
  bad({ target: o, property: 'list', keys: [{ time: 0, value: [0, 0, 0] }] }, 'TypeError', /holds 2 numbers/);
  bad(
    { target: o, property: 'list', type: 'color', keys: [{ time: 0, value: [0, 0] }] },
    'RangeError',
    /color keys need 3 or 4/,
  );
  bad({ target: o, property: 'list', type: 'rgb', keys: one }, 'TypeError', /type rgb is invalid/);
  bad({ target: o, keys: one }, 'TypeError', /either a property path or a set accessor/);
  bad({ target: o, property: 'material.roughness', set() {}, keys: one }, 'TypeError', /exactly one/);
  bad({ target: o, property: 'material.roughness', keys: [] }, 'TypeError', /nonempty keys/);
  bad(
    { target: o, property: 'material.roughness', keys: [{ time: 0, value: [Number.NaN] }] },
    'RangeError',
    /non-finite/,
  );
  const twice = { target: o, property: 'material.roughness', keys: one };
  assert.throws(() => createKeyframeClip({ tracks: [twice, twice] }), {
    name: 'TypeError',
    message: /repeats property material.roughness/,
  });
  // Two objects may each own the same path.
  createKeyframeClip({ tracks: [twice, { ...twice, target: { material: { roughness: 0 } } }] });
  assert.throws(() => applyKeyframeClip(createKeyframeClip({ tracks: [twice] }), Number.NaN), RangeError);
});

test('bake and sample agree for property tracks; clips mixing kinds bake only transform tracks', () => {
  const o = { v: 0, c: [0, 0, 0] };
  const clip = createKeyframeClip({
    name: 'Mixed',
    tracks: [
      {
        target: 'door',
        path: 'translation',
        keys: [
          { time: 0, value: [0, 0, 0] },
          { time: 1, value: [1, 0, 0] },
        ],
      },
      {
        target: o,
        property: 'v',
        keys: [
          { time: 0, value: [0], interpolation: 'easeInOut' },
          { time: 1, value: [1] },
        ],
      },
      {
        target: o,
        property: 'c',
        type: 'color',
        keys: [
          { time: 0, value: [0, 0, 0], interpolation: 'discrete' },
          { time: 0.5, value: [1, 1, 1], interpolation: 'discrete' },
        ],
      },
    ],
  });
  const baked = bakeKeyframeClip(clip, 10, (target) => (target === 'door' ? 0 : undefined));
  assert.equal(baked.channels.length, 1);
  assert.equal(baked.channels[0].path, 'translation');
  const eased = bakeKeyframeTrack(clip.properties[0], 10);
  assert.equal(eased.interpolation, 'LINEAR');
  assert.equal(eased.times.length, 11);
  for (let i = 0; i < eased.times.length; i++)
    assert.equal(eased.values[i], Math.fround(sampleKeyframes(clip.properties[0], eased.times[i])[0]));
  const stepped = bakeKeyframeTrack(clip.properties[1], 10);
  assert.equal(stepped.interpolation, 'STEP');
  assert.deepEqual([...stepped.times], [0, 0.5]);
  assert.deepEqual([...stepped.values], [0, 0, 0, 1, 1, 1]);
  assert.throws(() => bakeKeyframeTrack(clip.properties[0], 0), RangeError);
  // A skeleton target still poses bones while property tracks write.
  const skeleton = new Skeleton([{ name: 'door', parent: -1 }]);
  applyKeyframeClip(clip, skeleton, 0.5);
  assert.equal(o.v, 0.5);
  assert.deepEqual(o.c, [1, 1, 1]);
});
