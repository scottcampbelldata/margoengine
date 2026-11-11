// Cutscene evaluation: every track type, easing, camera paths and cuts, nested timelines, purity of evaluate(t), the
// order of instants however a range is split, validation and fuzzed input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cutscene, EASING_NAMES, evaluate, parseCutscene, validateCutscene } from '../dist/index.js';

const doc = (tracks, extra = {}) => ({ format: 'margo-cutscene', version: 1, duration: 10, tracks, ...extra });
const near = (a, b, tolerance = 1e-9, label = '') =>
  assert.ok(Math.abs(a - b) <= tolerance, `${label} ${a} is not within ${tolerance} of ${b}`);
const nearAll = (a, b, tolerance = 1e-9) => a.forEach((x, i) => near(x, b[i], tolerance, `[${i}]`));

test('camera keys: linear and Catmull-Rom paths pass through every key, cuts jump, fov and roll blend', () => {
  const keys = [
    { time: 0, position: [0, 1, 0], target: [0, 0, -1], fov: 40 },
    { time: 2, position: [4, 1, 0], target: [4, 0, -1], fov: 60, roll: 0.2 },
    { time: 4, position: [4, 1, 4], target: [4, 0, 3] },
    { time: 6, position: [-5, 9, 0], target: [0, 0, 0], cut: true },
    { time: 8, position: [-5, 9, 5], target: [0, 0, 0] },
  ];
  for (const path of ['linear', 'catmull-rom']) {
    const cut = new Cutscene(doc([{ type: 'camera', id: 'cam', keys, path }]));
    for (const key of keys) nearAll(cut.evaluate(key.time).camera.position, key.position);
    const mid = cut.evaluate(1).camera;
    near(mid.fov, 50);
    near(mid.roll, 0.1);
    assert.equal(mid.track, 'cam');
    nearAll(cut.evaluate(5.999).camera.position, [4, 1, 4], 1e-9); // holds the shot until the cut
    nearAll(cut.evaluate(6).camera.position, [-5, 9, 0]);
    nearAll(cut.evaluate(99).camera.position, [-5, 9, 5]);
    nearAll(cut.evaluate(-5).camera.position, [0, 1, 0]);
  }
  const linear = new Cutscene(doc([{ type: 'camera', id: 'cam', keys, path: 'linear' }]));
  nearAll(linear.evaluate(1).camera.position, [2, 1, 0]);
  const spline = new Cutscene(doc([{ type: 'camera', id: 'cam', keys }]));
  assert.ok(spline.evaluate(3).camera.position[0] > 4, 'Catmull-Rom bends outward through the corner');
  // After the cut the spline ignores the previous shot: the segment 6..8 is straight.
  nearAll(spline.evaluate(7).camera.position, [-5, 9, 2.5]);
  assert.equal(new Cutscene(doc([{ type: 'camera', id: 'c', keys, muted: true }])).evaluate(1).camera, null);
  // Roll turns the up vector about the view direction; fov defaults to core Camera's 60.
  const roll = (value, target = [0, 0, -1]) =>
    new Cutscene(
      doc([{ type: 'camera', id: 'c', keys: [{ time: 0, position: [0, 0, 0], target, roll: value }] }]),
    ).evaluate(0).camera;
  nearAll(roll(0).up, [0, 1, 0]);
  nearAll(roll(Math.PI / 2).up, [1, 0, 0]);
  nearAll(roll(0, [0, -5, 0]).up, [0, 0, -1], 1e-12);
  assert.equal(roll(0).fov, 60);
});

test('easing: names from tween, step, smoothstep and cubic-bezier points', () => {
  const at = (ease, t) =>
    new Cutscene(
      doc([
        {
          type: 'property',
          id: 'p',
          target: 'light',
          property: 'intensity',
          keys: [
            { time: 0, value: 0 },
            { time: 10, value: 10, ease },
          ],
        },
      ]),
    ).evaluate(t).properties.light.intensity;
  near(at(undefined, 2.5), 2.5);
  near(at('step', 9.99), 0);
  near(at('step', 10), 10);
  near(at('smoothstep', 5), 5);
  near(at('easeInQuad', 5), 2.5);
  assert.ok(at([0.42, 0, 0.58, 1], 2) < 2, 'ease-in-out starts slow');
  assert.ok(EASING_NAMES.has('easeInOutCubic') && EASING_NAMES.has('linear'));
  assert.match(
    validateCutscene(
      doc([{ type: 'property', id: 'p', target: 'x', property: 'y', keys: [{ time: 0, value: 0, ease: 'wobble' }] }]),
      EASING_NAMES,
    )[0].message,
    /unknown easing 'wobble'/,
  );
});

test('transform channels are keyed separately, rotations slerp and stay unit length, later tracks win', () => {
  const s = Math.SQRT1_2;
  const cut = new Cutscene(
    doc([
      {
        type: 'transform',
        id: 'door',
        target: 'door',
        keys: [
          { time: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1] },
          { time: 2, rotation: [0, s, 0, s] },
          { time: 4, position: [2, 0, 0], scale: [2, 2, 2] },
        ],
      },
      {
        type: 'property',
        id: 'tint',
        target: 'door',
        property: 'color',
        keys: [
          { time: 0, value: [1, 0, 0] },
          { time: 4, value: [0, 0, 1] },
        ],
      },
    ]),
  );
  const at1 = cut.evaluate(1).transforms.door;
  nearAll(at1.position, [0.5, 0, 0]);
  near(Math.hypot(...at1.rotation), 1);
  nearAll(at1.rotation, [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)], 1e-9);
  nearAll(at1.scale, [2, 2, 2], 0, 'a single scale key holds');
  nearAll(cut.evaluate(2).properties.door.color, [0.5, 0, 0.5]);
});

test('animation, audio and subtitle clips: active spans, clip time, loops, blends and fades', () => {
  const cut = new Cutscene(
    doc([
      {
        type: 'animation',
        id: 'hero',
        target: 'hero',
        clips: [{ start: 1, duration: 4, clip: 'walk', speed: 2, loop: true, length: 1.5, blendIn: 1, blendOut: 1 }],
      },
      {
        type: 'audio',
        id: 'music',
        clips: [{ start: 0, duration: 10, sound: 'theme', volume: 0.5, fadeIn: 2, offset: 3 }],
      },
      {
        type: 'subtitle',
        id: 'subs',
        clips: [
          { start: 2, duration: 2, text: 'Hello.', speaker: 'Ada' },
          { start: 4, duration: 1, text: 'Bye.' },
        ],
      },
    ]),
  );
  const s = cut.evaluate(1.5);
  assert.equal(s.animations.length, 1);
  near(s.animations[0].time, 1 % 1.5);
  near(s.animations[0].weight, 0.5);
  near(s.audio[0].time, 4.5);
  near(s.audio[0].volume, 0.5 * 0.75);
  assert.deepEqual(s.subtitles, []);
  assert.deepEqual(cut.evaluate(3).subtitles, [{ text: 'Hello.', speaker: 'Ada', track: 'subs' }]);
  assert.deepEqual(cut.evaluate(4).subtitles, [{ text: 'Bye.', track: 'subs' }], 'end is exclusive, start inclusive');
  assert.deepEqual(cut.evaluate(5).animations, []);
});

const nested = () =>
  doc(
    [
      {
        type: 'event',
        id: 'cues',
        events: [
          { time: 1, name: 'start' },
          { time: 9, name: 'end', data: { score: 3 } },
        ],
      },
      { type: 'timeline', id: 'intro', clips: [{ start: 2, duration: 4, timeline: 'door', speed: 2, offset: 1 }] },
    ],
    {
      markers: [
        { time: 0, name: 'opening' },
        { time: 5, name: 'reveal' },
      ],
      timelines: {
        door: {
          duration: 12,
          tracks: [
            {
              type: 'transform',
              id: 'swing',
              target: 'door',
              keys: [
                { time: 0, position: [0, 0, 0] },
                { time: 10, position: [10, 0, 0] },
              ],
            },
            {
              type: 'event',
              id: 'sfx',
              events: [
                { time: 0.5, name: 'early' },
                { time: 3, name: 'creak' },
                { time: 11, name: 'late' },
              ],
            },
            {
              type: 'subtitle',
              id: 'sub',
              clips: [
                { start: 0, duration: 4, text: 'cut at the window start' },
                { start: 8, duration: 4, text: 'cut at the end' },
              ],
            },
          ],
        },
      },
    },
  );

test('nested timelines: state maps through speed and offset, events land on the parent time, cut clips still enter and exit', () => {
  const cut = new Cutscene(nested());
  // Parent t=3 -> nested 1 + (3 - 2) * 2 = 3.
  nearAll(cut.evaluate(3).transforms.door.position, [3, 0, 0]);
  assert.equal(cut.evaluate(5.5).marker, 'reveal');
  const events = cut.eventsBetween(0, 10).map((e) => `${e.time}:${e.kind}:${e.track}:${e.name}`);
  assert.deepEqual(events, [
    '0:marker::opening',
    '1:event:cues:start',
    '2:enter:intro:door',
    '2:enter:intro/sub:cut at the window start',
    '3:event:intro/sfx:creak',
    '3.5:exit:intro/sub:cut at the window start',
    '5:marker::reveal',
    '5.5:enter:intro/sub:cut at the end',
    '6:exit:intro/sub:cut at the end',
    '6:exit:intro:door',
    '9:event:cues:end',
  ]);
  assert.deepEqual(cut.eventsBetween(8, 10)[0].data, { score: 3 });
});

test('a cycle of nested timelines and unknown timelines are rejected', () => {
  const cyclic = doc([{ type: 'timeline', id: 't', clips: [{ start: 0, duration: 1, timeline: 'a' }] }], {
    timelines: {
      a: { duration: 1, tracks: [{ type: 'timeline', id: 'x', clips: [{ start: 0, duration: 1, timeline: 'b' }] }] },
      b: { duration: 1, tracks: [{ type: 'timeline', id: 'y', clips: [{ start: 0, duration: 1, timeline: 'a' }] }] },
    },
  });
  assert.match(
    validateCutscene(cyclic)
      .map((i) => i.message)
      .join(),
    /nests itself/,
  );
  assert.throws(() => new Cutscene(cyclic), TypeError);
  const missing = doc([{ type: 'timeline', id: 't', clips: [{ start: 0, duration: 1, timeline: 'nope' }] }]);
  assert.match(validateCutscene(missing)[0].message, /must name a timeline/);
});

// Seeded generator for the property and fuzz tests.
function lcg(seed) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
function randomDocument(random) {
  const duration = 2 + Math.floor(random() * 10);
  const times = (n) => Array.from({ length: n }, () => Math.round(random() * duration * 4) / 4).sort((a, b) => a - b);
  const v3 = () => [random() * 10 - 5, random() * 4, random() * 10 - 5];
  const clipsOf = (make) =>
    times(1 + Math.floor(random() * 4))
      .map((start) => ({
        start,
        duration: Math.max(0.25, Math.min(duration - start, Math.round(random() * 8) / 4)),
        ...make(),
      }))
      .filter((clip) => clip.start + clip.duration <= duration);
  const easings = [undefined, 'linear', 'step', 'easeInOutCubic', [0.25, 0.1, 0.25, 1]];
  const ease = () => easings[Math.floor(random() * easings.length)];
  const tracks = [
    {
      type: 'camera',
      id: 'cam',
      keys: times(1 + Math.floor(random() * 5)).map((time) => ({
        time,
        position: v3(),
        target: v3(),
        ease: ease(),
        cut: random() < 0.2,
      })),
    },
    {
      type: 'transform',
      id: 'box',
      target: 'box',
      keys: times(1 + Math.floor(random() * 4)).map((time) => ({ time, position: v3(), ease: ease() })),
    },
    {
      type: 'property',
      id: 'fade',
      target: 'box',
      property: 'opacity',
      keys: times(2).map((time) => ({ time, value: random() })),
    },
    { type: 'event', id: 'cues', events: times(Math.floor(random() * 5)).map((time, i) => ({ time, name: `e${i}` })) },
    { type: 'subtitle', id: 'subs', clips: clipsOf(() => ({ text: 'line' })) },
    { type: 'audio', id: 'sfx', clips: clipsOf(() => ({ sound: 'boom', fadeIn: 0.1 })) },
    { type: 'animation', id: 'anim', target: 'box', clips: clipsOf(() => ({ clip: 'spin', blendIn: 0.2 })) },
    { type: 'timeline', id: 'sub', clips: clipsOf(() => ({ timeline: 'inner', speed: 0.5 + random() })) },
  ];
  for (const track of tracks)
    for (const list of [track.keys, track.events, track.clips])
      if (list) for (const item of list) if (item.ease === undefined) delete item.ease;
  return {
    format: 'margo-cutscene',
    version: 1,
    duration,
    tracks,
    markers: times(2).map((time, i) => ({ time, name: `m${i}` })),
    timelines: {
      inner: {
        duration: 3,
        tracks: [
          {
            type: 'event',
            id: 'ping',
            events: times(3)
              .map((time, i) => ({ time: Math.min(3, time), name: `p${i}` }))
              .sort((a, b) => a.time - b.time),
          },
          {
            type: 'transform',
            id: 'spin',
            target: 'box2',
            keys: [
              { time: 0, position: [0, 0, 0] },
              { time: 3, position: [3, 3, 3] },
            ],
          },
        ],
      },
    },
  };
}

test('property: evaluate(t) is pure, a JSON round trip changes nothing, and instants do not depend on how a range is split', () => {
  const random = lcg(2024);
  for (let n = 0; n < 120; n++) {
    const document = randomDocument(random);
    assert.deepEqual(validateCutscene(document, EASING_NAMES), [], `document ${n} is valid`);
    const cut = new Cutscene(document),
      again = new Cutscene(JSON.stringify(cut.document));
    const samples = Array.from({ length: 30 }, () => random() * (document.duration + 2) - 1);
    const first = samples.map((t) => cut.evaluate(t));
    // Evaluate in a scrambled order, interleaved with other times: the same states come back.
    const order = samples.map((_, i) => i).sort(() => random() - 0.5);
    for (const i of order) {
      cut.evaluate(random() * document.duration);
      assert.deepEqual(cut.evaluate(samples[i]), first[i]);
      assert.deepEqual(again.evaluate(samples[i]), first[i], 'round trip');
    }
    assert.deepEqual(evaluate(document, samples[0]), first[0]);
    // Splitting [0, duration] at random points fires the same instants, in the same order.
    const whole = cut.eventsBetween(0, document.duration);
    const cuts = [
      0,
      ...Array.from({ length: 1 + Math.floor(random() * 8) }, () => random() * document.duration).sort((a, b) => a - b),
      document.duration,
    ];
    const pieces = cuts.slice(1).flatMap((to, i) => cut.eventsBetween(cuts[i], to));
    assert.deepEqual(pieces, whole, `document ${n}: split ranges fire the same instants`);
    const back = cuts
      .slice()
      .reverse()
      .slice(1)
      .flatMap((to, i, list) => cut.eventsBetween(i === 0 ? document.duration : list[i - 1], to));
    assert.deepEqual(back, cut.eventsBetween(document.duration, 0), `document ${n}: reverse splits agree too`);
    assert.deepEqual(new Set(back), new Set(whole), 'reverse play passes the same instants');
  }
});

test('validateCutscene reports every problem with its path and fix', () => {
  const issues = validateCutscene({
    format: 'margo-cutscene',
    version: 1,
    duration: 5,
    tracks: [
      {
        type: 'camera',
        id: 'cam',
        keys: [
          { time: 2, position: [0, 0, 0], target: [0, 0, 1] },
          { time: 1, position: [0, 0], target: [0, 0, 1], fov: 200 },
        ],
      },
      { type: 'audio', id: 'cam', clips: [{ start: 4, duration: 2, sound: 'x' }] },
      { type: 'hologram', id: 'h' },
      {
        type: 'property',
        id: 'p',
        target: 'a',
        property: 'b',
        keys: [
          { time: 0, value: 1 },
          { time: 1, value: [1, 2] },
        ],
      },
    ],
  });
  assert.deepEqual(
    issues.map((issue) => issue.path),
    [
      'tracks[0].keys[1].position',
      'tracks[0].keys[1].fov',
      'tracks[0].keys[1].time',
      'tracks[1].id',
      'tracks[1].clips[0].duration',
      'tracks[2].type',
      'tracks[3].keys[1].value',
    ],
  );
  assert.match(issues[2].message, /sort the list by time/);
  assert.match(issues[4].message, /runs past the end of its timeline/);
  assert.throws(() => parseCutscene('{"format":'), /not valid JSON/);
  assert.throws(
    () => parseCutscene({ format: 'margo-cutscene', version: 1, duration: 0, tracks: [] }),
    /fix duration: must be a finite number/,
  );
  const parsed = parseCutscene({ format: 'margo-cutscene', version: 1, duration: 1, tracks: [] });
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.tracks), 'parsed documents are deep-frozen');
});

test('fuzz: mutated and random input never crashes validateCutscene; parseCutscene throws only TypeError; what parses evaluates', () => {
  const random = lcg(77);
  const junk = [null, undefined, 0, -1, 1e308, NaN, '', 'x', true, [], {}, [1, 2, 3], [NaN, 0, 0], { time: 0 }];
  const mutate = (value, depth = 0) => {
    if (value === null || typeof value !== 'object' || depth > 7)
      return random() < 0.5 ? junk[Math.floor(random() * junk.length)] : value;
    const copy = Array.isArray(value) ? [...value] : { ...value };
    const keys = Object.keys(copy);
    for (let k = 0; k < 2 && keys.length; k++) {
      const key = keys[Math.floor(random() * keys.length)];
      copy[key] = random() < 0.3 ? junk[Math.floor(random() * junk.length)] : mutate(copy[key], depth + 1);
    }
    return copy;
  };
  let parsedCount = 0;
  for (let i = 0; i < 1500; i++) {
    const input = mutate(randomDocument(random));
    assert.ok(Array.isArray(validateCutscene(input, EASING_NAMES)));
    let cut;
    try {
      cut = new Cutscene(input);
    } catch (error) {
      assert.ok(error instanceof TypeError, `only TypeError escapes, got ${error}`);
      continue;
    }
    parsedCount++;
    for (const t of [0, 0.5, cut.duration / 2, cut.duration]) {
      const state = cut.evaluate(t);
      for (const value of [
        state.camera?.position,
        ...Object.values(state.transforms).flatMap((x) => [x.position, x.rotation, x.scale]),
      ])
        if (value) assert.ok(value.every(Number.isFinite), 'no NaN in a state');
    }
    cut.eventsBetween(0, cut.duration);
  }
  assert.ok(parsedCount > 50, `some mutated documents still parse (${parsedCount})`);
  for (let i = 0; i < 300; i++) {
    const text = Array.from({ length: Math.floor(random() * 60) }, () =>
      String.fromCharCode(32 + Math.floor(random() * 95)),
    ).join('');
    assert.ok(Array.isArray(validateCutscene(text)));
    assert.throws(() => parseCutscene(text), TypeError);
  }
  assert.throws(() => new Cutscene(doc([])).evaluate(NaN), RangeError);
});

test('a property or transform target named __proto__ or constructor never writes to Object.prototype', () => {
  const keys = (value) => [
    { time: 0, value },
    { time: 2, value: value + 2 },
  ];
  const cut = new Cutscene(
    doc([
      { type: 'property', id: 'a', target: '__proto__', property: 'polluted', keys: keys(1) },
      { type: 'property', id: 'b', target: 'x', property: '__proto__', keys: keys(5) },
      { type: 'property', id: 'c', target: 'constructor', property: 'polluted', keys: keys(7) },
      {
        type: 'transform',
        id: 'd',
        target: '__proto__',
        keys: [
          { time: 0, position: [1, 2, 3] },
          { time: 2, position: [4, 5, 6] },
        ],
      },
    ]),
  );
  const state = cut.evaluate(1);
  assert.equal({}.polluted, undefined, 'Object.prototype.polluted');
  assert.equal({}.position, undefined, 'Object.prototype.position');
  assert.equal(Object.getPrototypeOf(state.properties.x), Object.prototype);
  assert.equal(state.properties.x.__proto__, 6);
  assert.equal(Object.getOwnPropertyDescriptor(state.properties, '__proto__').value.polluted, 2);
  assert.equal(state.properties.constructor.polluted, 8);
  assert.deepEqual(Object.getOwnPropertyDescriptor(state.transforms, '__proto__').value.position, [2.5, 3.5, 4.5]);
});
