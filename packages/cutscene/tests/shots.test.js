import assert from 'node:assert/strict';
import test from 'node:test';
import { Cutscene, CutscenePlayer, validateCutscene } from '@margoengine/cutscene';
import { shotOf, shotTrack } from '@margoengine/cutscene/shots';

const doc = (tracks, extra = {}) => ({ format: 'margo-cutscene', version: 1, duration: 10, tracks, ...extra });
const shots = (cameras, clips, extra = {}) => ({ type: 'shot', id: 'edit', cameras, clips, ...extra });
const build = (tracks, options, extra) => new Cutscene(doc(tracks, extra), { tracks: [shotTrack(options)] });
const close = (a, b, limit = 1e-9) =>
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= limit, `${a} is not ${b} within ${limit}`));
const length = (v) => Math.hypot(...v);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const angle = (a, b) => {
  const dot = a.reduce((sum, x, i) => sum + x * b[i], 0) / (length(a) * length(b));
  return Math.acos(Math.min(1, Math.max(-1, dot)));
};

const left = { position: [-4, 1, 0], target: [0, 1, 0], fov: 30 };
const right = { position: [4, 1, 0], target: [0, 1, 0], fov: 50, roll: 0.2 };

test('a shot without blendIn cuts, and a blend starts and ends on the two cameras', () => {
  const cut = build([shots({ left, right }, [{ start: 0, duration: 2, camera: 'left' }, { start: 2, duration: 2, camera: 'right' }])]);
  assert.deepEqual(cut.evaluate(1.999).camera.position, left.position);
  assert.deepEqual(cut.evaluate(2).camera.position, right.position);
  const blended = build([
    shots({ left, right }, [
      { start: 0, duration: 2, camera: 'left' },
      { start: 2, duration: 2, camera: 'right', blendIn: 1 },
    ]),
  ]);
  close(blended.evaluate(2).camera.position, left.position);
  assert.equal(blended.evaluate(2).camera.fov, 30);
  close(blended.evaluate(3).camera.position, right.position);
  assert.equal(blended.evaluate(3).camera.fov, 50);
  assert.equal(blended.evaluate(3).camera.roll, 0.2);
  // Smoothstep at the middle is one half, so the fov is the mean.
  assert.ok(Math.abs(blended.evaluate(2.5).camera.fov - 40) < 1e-12);
  assert.deepEqual(shotOf(blended.evaluate(2.5)), { camera: 'right', from: 'left', weight: 0.5, track: 'edit' });
  assert.deepEqual(shotOf(blended.evaluate(3.5)), { camera: 'right', weight: 1, track: 'edit' });
});

test('both cameras keep moving through a blend', () => {
  const move = (x) => ({
    keys: [
      { time: 0, position: [x, 0, 0], target: [x, 0, -5] },
      { time: 10, position: [x, 10, 0], target: [x, 10, -5] },
    ],
    path: 'linear',
  });
  const cutscene = build([
    shots({ a: move(0), b: move(4) }, [
      { start: 0, duration: 4, camera: 'a' },
      { start: 4, duration: 4, camera: 'b', blendIn: 2, ease: 'linear' },
    ]),
  ]);
  // At t = 5: a has run 5 seconds (y 5); b started at 4 and has run 1 (y 1); halfway between them is y 3.
  close(cutscene.evaluate(5).camera.position, [2, 3, 0]);
});

test('a direct blend between facing cameras never puts the target on the camera', () => {
  const cutscene = build([
    shots(
      { a: { position: [0, 0, 0], target: [0, 0, -6] }, b: { position: [0, 0, -6], target: [0, 0, 0] } },
      [
        { start: 0, duration: 1, camera: 'a' },
        { start: 1, duration: 4, camera: 'b', blendIn: 4, ease: 'linear' },
      ],
    ),
  ]);
  for (let t = 1; t <= 5; t += 0.05) {
    const { position, target, up } = cutscene.evaluate(t).camera;
    // Both views are 6 long, so the blended view is 6 long; a lerp of the targets would pass through the camera.
    assert.ok(Math.abs(length(sub(target, position)) - 6) < 1e-9, `view length at ${t}`);
    assert.ok(Math.abs(length(up) - 1) < 1e-9);
  }
  // Opposite views turn about the world's up, so the view stays level.
  assert.ok(Math.abs(cutscene.evaluate(3).camera.target[1]) < 1e-9);
});

test('the view turns at even speed', () => {
  const cutscene = build([
    shots(
      { a: { position: [0, 0, 0], target: [1, 0, 0] }, b: { position: [0, 0, 0], target: [0, 3, 0] } },
      [
        { start: 0, duration: 1, camera: 'a' },
        { start: 1, duration: 1, camera: 'b', blendIn: 1, ease: 'linear' },
      ],
    ),
  ]);
  for (const u of [0.1, 0.25, 0.5, 0.9]) {
    const { position, target } = cutscene.evaluate(1 + u).camera;
    assert.ok(Math.abs(angle(sub(target, position), [1, 0, 0]) - (u * Math.PI) / 2) < 1e-9);
    assert.ok(Math.abs(length(sub(target, position)) - (1 + 2 * u)) < 1e-9);
  }
});

test('an orbit blend swings around the subject at the same distance, and a direct one cuts through', () => {
  const clips = (blend) => [
    { start: 0, duration: 1, camera: 'left' },
    { start: 1, duration: 2, camera: 'right', blendIn: 2, ease: 'linear', blend },
  ];
  const orbit = build([shots({ left, right }, clips('orbit'))]),
    direct = build([shots({ left, right }, clips('direct'))]);
  for (let t = 1; t <= 3; t += 0.1) {
    const { position, target } = orbit.evaluate(t).camera;
    assert.ok(Math.abs(length(sub(position, target)) - 4) < 1e-9, `arm at ${t}`);
  }
  assert.ok(length(sub(direct.evaluate(2).camera.position, [0, 1, 0])) < 1e-9, 'direct passes through the subject');
});

test('scrubbing into a blend shows what playing to it shows', () => {
  const cutscene = build([
    shots({ left, right }, [
      { start: 0, duration: 2, camera: 'left' },
      { start: 2, duration: 2, camera: 'right', blendIn: 1.5, ease: 'easeInOutCubic' },
    ]),
  ]);
  const player = new CutscenePlayer(cutscene);
  void player.play();
  for (let i = 0; i < 165; i++) player.update(1 / 60);
  assert.deepEqual(player.state, cutscene.evaluate(player.time));
  assert.deepEqual(new CutscenePlayer(cutscene).seek(player.time).state.camera, player.state.camera);
});

test('a shot follows and aims at objects a transform track moves, wherever that track sits', () => {
  const cutscene = build([
    shots(
      { chase: { follow: 'car', position: [0, 2, 5], lookAt: 'car', lookOffset: [0, 1, 0] } },
      [{ start: 0, duration: 10, camera: 'chase' }],
    ),
    {
      type: 'transform',
      id: 'drive',
      target: 'car',
      keys: [
        { time: 0, position: [0, 0, 0] },
        { time: 10, position: [10, 0, 0] },
      ],
    },
  ]);
  const { position, target } = cutscene.evaluate(5).camera;
  close(position, [5, 2, 5]);
  close(target, [5, 1, 0]);
});

test('locate finds objects the cutscene does not move, and followRotation turns with them', () => {
  const turned = { position: [1, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }; // A quarter turn about +Y.
  const camera = { follow: 'hero', followRotation: true, position: [0, 0, 2], target: [0, 0, 0] };
  const cutscene = build([shots({ camera }, [{ start: 0, duration: 1, camera: 'camera' }])], {
    locate: (name) => (name === 'hero' ? turned : undefined),
  });
  close(cutscene.evaluate(0).camera.position, [3, 0, 0]);
  assert.throws(
    () => build([shots({ camera }, [{ start: 0, duration: 1, camera: 'camera' }])]).evaluate(0),
    /No object 'hero' for a shot/,
  );
});

test('a live camera blends out of play and back, and reads the game at each evaluate', () => {
  let x = 0;
  const live = { game: () => ({ position: [x, 1, 0], target: [x, 1, -1], fov: 70 }) };
  const cutscene = build(
    [
      shots({ game: { live: 'game' }, close: left }, [
        { start: 0, duration: 1, camera: 'game' },
        { start: 1, duration: 2, camera: 'close', blendIn: 1, ease: 'linear' },
        { start: 3, duration: 2, camera: 'game', blendIn: 1, ease: 'linear' },
      ]),
    ],
    { live },
  );
  x = 2;
  assert.deepEqual(cutscene.evaluate(0.5).camera.position, [2, 1, 0]);
  assert.equal(cutscene.evaluate(0.5).camera.fov, 70);
  x = 8;
  close(cutscene.evaluate(5).camera.position, [8, 1, 0]);
  assert.throws(
    () => new Cutscene(doc([shots({ game: { live: 'game' } }, [{ start: 0, duration: 1, camera: 'game' }])]), { tracks: [shotTrack()] }).evaluate(0),
    /No live camera 'game'/,
  );
});

test('a shot starts its move from offset at speed, between shots the last holds, before the first the first shows', () => {
  const dolly = {
    keys: [
      { time: 0, position: [0, 0, 0], target: [0, 0, -1] },
      { time: 4, position: [8, 0, 0], target: [8, 0, -1] },
    ],
    path: 'linear',
  };
  const cutscene = build([
    shots({ dolly, left }, [
      { start: 2, duration: 1, camera: 'dolly', speed: 2, offset: 1 },
      { start: 5, duration: 1, camera: 'left' },
    ]),
  ]);
  close(cutscene.evaluate(0).camera.position, [2, 0, 0]);
  close(cutscene.evaluate(2.5).camera.position, [4, 0, 0]); // offset 1 + 0.5 s at speed 2 = 2 s into a 2 unit/s move.
  close(cutscene.evaluate(4).camera.position, [8, 0, 0]); // After its end the shot holds, here on its last key.
  assert.equal(shotOf(cutscene.evaluate(4)).camera, 'dolly');
});

test('a shot track replaces a camera track, the first shot track wins, a muted one does nothing', () => {
  const keys = [{ time: 0, position: [9, 9, 9], target: [0, 0, 0] }];
  const one = [{ start: 0, duration: 1, camera: 'left' }],
    two = [{ start: 0, duration: 1, camera: 'right' }];
  const camera = { type: 'camera', id: 'raw', keys };
  assert.deepEqual(build([camera, shots({ left }, one)]).evaluate(0).camera.position, left.position);
  assert.deepEqual(
    build([shots({ right }, two, { id: 'a' }), shots({ left }, one, { id: 'b' })]).evaluate(0).camera.position,
    right.position,
  );
  assert.deepEqual(build([camera, shots({ left }, one, { muted: true })]).evaluate(0).camera.position, [9, 9, 9]);
});

test('the player fires shot starts and ends in order, and a nested timeline cuts them at its window', () => {
  const cutscene = build(
    [{ type: 'timeline', id: 'scene', clips: [{ start: 1, duration: 2, timeline: 'inner', offset: 1 }] }],
    undefined,
    {
      timelines: {
        inner: {
          duration: 6,
          tracks: [
            shots({ left, right }, [
              { start: 0, duration: 2, camera: 'left' },
              { start: 2, duration: 4, camera: 'right' },
            ]),
          ],
        },
      },
    },
  );
  const fired = cutscene.instants
    .filter((e) => e.type === 'shot')
    .map((e) => [e.kind, e.name, e.time, e.track]);
  assert.deepEqual(fired, [
    ['enter', 'left', 1, 'scene/edit'],
    ['exit', 'left', 2, 'scene/edit'],
    ['enter', 'right', 2, 'scene/edit'],
    ['exit', 'right', 3, 'scene/edit'],
  ]);
  assert.equal(cutscene.evaluate(2.5).camera.track, 'scene/edit');
  assert.deepEqual(cutscene.evaluate(2.5).camera.position, right.position);
  const seen = [];
  const player = new CutscenePlayer(cutscene);
  player.on('enter', (event) => seen.push(event.name));
  void player.play();
  player.skip();
  assert.deepEqual(seen.filter((name) => name !== 'inner'), ['left', 'right']);
});

test('the document survives JSON and a player builds it with the tracks option', () => {
  const text = JSON.stringify(doc([shots({ left }, [{ start: 0, duration: 1, camera: 'left' }])]));
  const player = new CutscenePlayer(text, { tracks: [shotTrack()] });
  assert.deepEqual(player.state.camera.position, left.position);
});

test('a track type nobody passed is refused and names the fix', () => {
  const text = doc([shots({ left }, [{ start: 0, duration: 1, camera: 'left' }])]);
  assert.throws(() => new Cutscene(text), /unknown track type "shot".*tracks option/);
});

test('every bad shot is reported with its path', () => {
  const issues = (track) => {
    const types = new Map([['shot', shotTrack()]]);
    return validateCutscene(doc([track]), new Set(), types).map((issue) => `${issue.path}: ${issue.message}`);
  };
  const expect = (track, pattern) => {
    const found = issues(track);
    assert.ok(found.some((line) => pattern.test(line)), `${pattern} in ${found.join(' | ')}`);
  };
  const one = [{ start: 0, duration: 1, camera: 'left' }];
  assert.deepEqual(issues(shots({ left }, one)), []);
  expect(shots(3, one), /cameras: must be an object/);
  expect(shots({ left: 3 }, one), /cameras\.left: must be an object/);
  expect(shots({ left }, [{ start: 0, duration: 1, camera: 'gone' }]), /clips\[0\]\.camera: must name one of the track's cameras \(left\)/);
  expect(shots({ left }, [{ start: 0, duration: 1, camera: 'constructor' }]), /clips\[0\]\.camera/);
  expect(shots({ a: {} }, [{ start: 0, duration: 1, camera: 'a' }]), /cameras\.a: must say what it looks at/);
  expect(shots({ a: { target: [0, 0] } }, [{ start: 0, duration: 1, camera: 'a' }]), /cameras\.a\.target: must be \[x, y, z\]/);
  expect(shots({ a: { ...left, fov: 200 } }, [{ start: 0, duration: 1, camera: 'a' }]), /cameras\.a\.fov/);
  expect(shots({ a: { keys: [] } }, [{ start: 0, duration: 1, camera: 'a' }]), /cameras\.a\.keys: must hold at least one key/);
  expect(shots({ a: { live: 'x', position: [0, 0, 0] } }, [{ start: 0, duration: 1, camera: 'a' }]), /cameras\.a\.position: cannot go with/);
  expect(shots({ left }, [{ start: 0, duration: 1, camera: 'left', blendIn: 0.5 }]), /clips\[0\]\.blendIn: has no shot before it/);
  expect(
    shots({ left }, [
      { start: 0, duration: 1, camera: 'left' },
      { start: 1, duration: 1, camera: 'left', blendIn: 2 },
    ]),
    /clips\[1\]\.blendIn: is longer than the shot/,
  );
  expect(
    shots({ left }, [
      { start: 0, duration: 2, camera: 'left' },
      { start: 1, duration: 1, camera: 'left' },
    ]),
    /clips\[1\]\.start: overlaps the shot before/,
  );
  expect(shots({ left }, [{ start: 0, duration: 1, camera: 'left', blend: 'wipe' }]), /clips\[0\]\.blend: must be 'direct' or 'orbit'/);
  expect(shots({ left }, [{ start: 0, duration: 1, camera: 'left', ease: 'nope' }]), /clips\[0\]\.ease: unknown easing/);
});
