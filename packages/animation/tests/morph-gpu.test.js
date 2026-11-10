// MorphWeightPlayer on a stand-in device: what it uploads, when it rebuilds, and that the CPU's work stays flat per copy.
// The shader's arithmetic against sampleTrack runs on real WebGPU in scripts/animation-morph-gpu-tests.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation } from '../dist/index.js';
import { MorphWeightPlayer, morphWeightShader } from '../dist/morph-gpu.js';
import { GLTFAsset } from '../../gltf-pro/dist/index.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const talk = {
  name: 'Talk',
  duration: 2,
  tracks: [
    {
      node: 0,
      path: 'weights',
      times: new Float32Array([0, 2]),
      values: new Float32Array([0, 1]),
      width: 1,
      interpolation: 'LINEAR',
    },
  ],
};
function harness() {
  const h = optionalGPU(),
    fixture = animatedTriangle(),
    asset = new GLTFAsset(fixture.doc, fixture.buffers);
  h.engine.store.transforms = Object.fromEntries(
    ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'].map((name) => [
      name,
      new Float32Array(2).fill(['qw', 'sx', 'sy', 'sz'].includes(name) ? 1 : 0),
    ]),
  );
  let serial = 0;
  const vertices = Float32Array.from({ length: 60 }, (_, i) => i),
    make = (own = asset) => {
      const k = serial++,
        nodes = [0, 1].map((id) => ({
          id,
          engine: h.engine,
          matrix: identity(),
          check() {},
          setPosition() {
            return this;
          },
          position: { set() {} },
          scale: { set() {} },
          setScale() {
            return this;
          },
          setQuaternion() {
            return this;
          },
        })),
        animation = new Animation({
          name: 'model ' + k,
          root: nodes[0],
          nodes,
          primitives: [
            {
              definition: fixture.doc.meshes[0].primitives[0],
              nodeIndex: 0,
              node: nodes[0],
              vertices,
              weights: new Float32Array(1),
            },
          ],
          asset: own,
          onDispose() {
            return () => {};
          },
        });
      Object.defineProperty(animation, 'clips', { value: [talk] });
      animation.playing = false;
      h.engine.use(animation);
      return animation;
    };
  return { ...h, make, asset, fixture };
}
const dispatches = (h) => {
  const log = { passes: 0, groups: [] };
  h.context.encoder.beginComputePass = () => {
    log.passes++;
    return {
      setPipeline() {},
      setBindGroup() {},
      dispatchWorkgroups(x, y = 1) {
        log.groups.push([x, y]);
      },
      end() {},
    };
  };
  return log;
};

test('the shader bounds its threads by the page, so a part-filled workgroup writes no other copy', () => {
  assert.match(morphWeightShader, /if\(i>=arrayLength\(&items\)\)\{return;\}/);
  assert.doesNotMatch(morphWeightShader, /p\.count/);
});

test('the wrap cannot land on the end of the clip: f32 division may round a whole lap down', () => {
  // Regression: 0.85 + 0.85 equals the duration exactly, at/duration came back under 1, and the copy showed the last key.
  assert.match(morphWeightShader, /if\(at<0\.0\)\{at\+=p\.duration;\}/);
  assert.match(morphWeightShader, /if\(at>=p\.duration\)\{at-=p\.duration;\}/);
});

test('each copy gets one item per target at its own weight offset, with its offset and speed', () => {
  const h = harness(),
    a = h.make(),
    b = h.make(),
    player = MorphWeightPlayer.attach(h.engine, 'Talk');
  player.add(a).add(b, { offset: 0.5, speed: 2 });
  assert.equal(player.count, 2);
  dispatches(h);
  h.frame();
  const gpu = player['gpu'],
    items = new Uint32Array(gpu.pages[0].items.data),
    members = new Float32Array(gpu.members.data);
  assert.deepEqual(
    [...items],
    [a.resources[0].slot.weights.offset, 0, 0, 0, b.resources[0].slot.weights.offset, 0, 0, 1],
  );
  assert.deepEqual([...members], [0, 1, 0.5, 2]);
  assert.equal(items.byteLength, 32, 'exactly one record per item: arrayLength is the bound');
  player.dispose();
  a.dispose();
  b.dispose();
});

test('a frame writes 16 bytes and one dispatch however many copies play, and nothing is rebuilt', () => {
  const h = harness(),
    copies = Array.from({ length: 200 }, () => h.make()),
    player = MorphWeightPlayer.attach(h.engine, 0);
  for (const copy of copies) player.add(copy);
  const log = dispatches(h);
  h.frame();
  const queue = h.engine.gpu.queue,
    write = queue.writeBuffer,
    bindGroup = h.engine.gpu.createBindGroup,
    params = player['gpu'].params;
  let own = 0,
    groups = 0;
  queue.writeBuffer = function (buffer, ...rest) {
    if (buffer === params) own++;
    return write.call(this, buffer, ...rest);
  };
  h.engine.gpu.createBindGroup = function (...args) {
    groups++;
    return bindGroup.apply(this, args);
  };
  log.groups.length = 0;
  // A frame advances plugins too: hold the clock so the exact value can be read back.
  player.playing = false;
  player.time = 0.25;
  h.frame();
  assert.equal(own, 1, 'one 16-byte write');
  assert.equal(groups, 0, 'no rebuild');
  assert.equal(player.time, 0.25);
  assert.equal(new Float32Array(params.data)[0], 0.25, 'time reaches the shader');
  assert.deepEqual(log.groups[0], [Math.ceil(200 / 64), 1], 'one dispatch for 200 copies');
  queue.writeBuffer = write;
  h.engine.gpu.createBindGroup = bindGroup;
  player.dispose();
  for (const copy of copies) copy.dispose();
});

test('a copy that goes, and buffers that move, rebuild the items; disposal frees every buffer', async () => {
  const h = harness(),
    copies = [h.make(), h.make()],
    player = MorphWeightPlayer.attach(h.engine);
  player.add(copies[0]).add(copies[1]);
  dispatches(h);
  h.frame();
  copies[0].dispose();
  h.frame();
  assert.equal(player.count, 1, 'a disposed copy leaves by itself');
  assert.equal(player['gpu'].pages[0].items.data.byteLength, 16);
  // More copies grow the shared weights buffer: the bind group must follow it.
  const more = Array.from({ length: 40 }, () => h.make());
  h.frame();
  assert.equal(player['gpu'].version, copies[1]['arena'].version, 'rebuilt for the moved buffers');
  assert.ok(player.remove(copies[1]));
  assert.equal(player.remove(copies[1]), false);
  player.add(more[0]);
  h.frame();
  assert.equal(player['gpu'].pages[0].items.data.byteLength, 16);
  player.dispose();
  player.dispose();
  for (const copy of [copies[1], ...more]) copy.dispose();
  await h.engine.gpu.queue.onSubmittedWorkDone();
  assert.ok(
    h.resources.every((r) => r.destroyed),
    'nothing left on the device',
  );
});

test('bad input is refused with the fix in the message', () => {
  const h = harness(),
    a = h.make(),
    player = new MorphWeightPlayer('Talk'),
    other = h.make(new GLTFAsset(h.fixture.doc, h.fixture.buffers));
  assert.throws(() => new MorphWeightPlayer(-1), /clip name or an index/);
  assert.throws(() => new MorphWeightPlayer(0, { loop: 1 }), /loop must be a boolean/);
  assert.throws(() => player.add(a, { speed: -1 }), /speed a finite number/);
  assert.throws(() => player.add(a, { offset: NaN }), /offset must be finite/);
  assert.throws(() => new MorphWeightPlayer('Nope').add(a), /Unknown animation clip/);
  player.add(a);
  assert.throws(() => player.add(other), /share one asset/);
  assert.throws(() => player.onPreUpdate(-1), /Invalid animation delta/);
  player.dispose();
  assert.throws(() => player.add(a), /disposed/);
  a.dispose();
  other.dispose();
});
