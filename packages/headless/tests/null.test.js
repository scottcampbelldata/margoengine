import test from 'node:test';
import assert from 'node:assert/strict';
import { createNullStage, NullStage } from '../dist/null.js';
import { Skeleton, createKeyframeClip, applyKeyframeClip } from '@margoengine/animation';

test('GPU-free stage uses real mesh hierarchy, scenes, plugins and callbacks with no context requests', async (t) => {
  const before = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    get() {
      throw Error('GPU requested');
    },
  });
  t.after(() => (before ? Object.defineProperty(navigator, 'gpu', before) : delete navigator.gpu));
  using stage = await createNullStage({ capacity: 2 });
  assert.ok(stage instanceof NullStage && stage.isNull);
  assert.equal(stage.engine.gpu, null);
  const parent = stage.box({ position: [2, 0, 0] }),
    child = stage.box({ parent, position: [1, 0, 0] }),
    scene = stage.engine.createScene('second'),
    other = scene.createMesh();
  other.setPosition([0, 3, 0]);
  const log = [];
  stage.onTick((dt) => {
    log.push(['tick', dt]);
    parent.position.x += dt;
  });
  const off = stage.engine.onFrame((engine, dt) => {
    assert.equal(engine, stage.engine);
    log.push(['frame', dt]);
  });
  stage.use({
    name: 'logic',
    setup() {
      log.push(['setup']);
    },
    onPreUpdate(dt) {
      log.push(['plugin', dt]);
    },
    registerPasses(graph) {
      graph.add({
        name: 'never',
        order: 1,
        execute() {
          throw Error('GPU pass executed');
        },
      });
    },
  });
  scene.use({
    name: 'other-logic',
    setup() {},
    onPreUpdate(dt) {
      log.push(['other', dt]);
    },
  });
  stage.step(0.25);
  assert.deepEqual(log, [['setup'], ['tick', 0.25], ['frame', 0.25], ['plugin', 0.25], ['other', 0.25]]);
  assert.equal(child.matrix[12], 3.25);
  assert.equal(other.matrix[13], 3);
  assert.equal(stage.time, 0.25);
  off();
  scene.dispose();
  stage.step(0);
  assert.equal(log.filter(([name]) => name === 'frame').length, 1);
  assert.equal(log.filter(([name]) => name === 'other').length, 1);
  await assert.rejects(stage.readPixels(), { code: 'unsupported' });
});

test('real property and skeleton animation advance from fixed plugin ticks without GPU deformation', async () => {
  using stage = await createNullStage();
  const mesh = stage.box(),
    skeleton = new Skeleton([{ name: 'root', parent: -1 }]),
    clip = createKeyframeClip({
      tracks: [
        {
          target: mesh,
          property: 'position',
          keys: [
            { time: 0, value: [0, 0, 0] },
            { time: 1, value: [4, 2, 0] },
          ],
          blend: 'weighted',
        },
        {
          target: 'root',
          path: 'translation',
          keys: [
            { time: 0, value: [0, 0, 0] },
            { time: 1, value: [0, 6, 0] },
          ],
          blend: 'weighted',
        },
      ],
    });
  let time = 0;
  stage.use({
    name: 'animation',
    setup() {},
    onPreUpdate(dt) {
      time += dt;
      applyKeyframeClip(clip, skeleton, time);
    },
  });
  stage.step(0.25);
  stage.step(0.25);
  assert.equal(mesh.matrix[12], 2);
  assert.equal(mesh.matrix[13], 1);
  assert.equal(skeleton.getPose(0).translation[1], 3);
});

test('invalid and reentrant steps fail before callbacks; disposal aborts and cleans plugins', async () => {
  const stage = await createNullStage();
  let calls = 0,
    disposed = 0;
  stage.onTick(() => calls++);
  stage.use({
    name: 'lifetime',
    setup() {},
    dispose() {
      disposed++;
    },
  });
  for (const delta of [-1, NaN, Infinity, 1.01]) assert.throws(() => stage.step(delta), RangeError);
  assert.equal(calls, 0);
  const off = stage.onTick(() => assert.throws(() => stage.step(0), { code: 'state' }));
  stage.step(0);
  off();
  stage.dispose();
  stage.dispose();
  assert.equal(stage.signal.aborted, true);
  assert.equal(disposed, 1);
  assert.throws(() => stage.step(0), { code: 'disposed' });
  assert.equal(calls, 1);
});

test('creation cancellation and invalid options preserve globals', async () => {
  const reason = new Error('cancel');
  await assert.rejects(createNullStage({ signal: AbortSignal.abort(reason) }), (error) => error === reason);
  await assert.rejects(createNullStage({ width: 0 }), RangeError);
  await assert.rejects(createNullStage({ onError: 'bad' }), TypeError);
});

