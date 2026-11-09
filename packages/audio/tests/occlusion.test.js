import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { AudioListener, PositionalAudio } from '../dist/index.js';
import { AudioOcclusion } from '../dist/occlusion.js';
import { FakeAudioContext } from './fake-web-audio.js';

// Real engine transforms and BVH geometry, with a renderer and Web Audio stand-in.
async function scene(backend = 'webgpu') {
  const engine = new Engine(
    { width: 64, height: 64 },
    await TransformStore.create(32),
    { backend, gpu: null, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const context = new FakeAudioContext();
  const listener = new AudioListener({ context, autoResume: false });
  listener.setup(engine);
  const wall = engine.createMesh().setGeometry(box()).setPosition([0, 0, 2]).setScale([4, 4, 0.1]);
  const source = engine.createMesh().setGeometry(box());
  const sound = new PositionalAudio(listener, { mesh: source, volume: 0.7 });
  return {
    engine,
    context,
    listener,
    wall,
    source,
    sound,
    update() {
      engine.store.tick();
      listener.update();
    },
    dispose() {
      listener.dispose();
      engine.dispose();
    },
  };
}

for (const backend of ['webgpu', 'webgl2'])
  test(`occlusion traces transformed scene walls on ${backend}`, async () => {
    const s = await scene(backend);
    const filter = s.context.createGain();
    s.sound.setFilters([filter]);
    const control = await AudioOcclusion.create(s.sound);
    s.update();
    assert.equal(control.blocked, 1);
    assert.equal(control.attenuation.gain.value, 0.25);
    assert.ok(Math.abs(control.lowpass.frequency.value - 800) < 1e-9);
    assert.equal(s.sound.volume, 0.7);
    assert.deepEqual(s.sound.getFilters(), [filter, control.lowpass, control.attenuation]);
    s.wall.setPosition([8, 0, 2]);
    s.update();
    assert.equal(control.blocked, 0);
    assert.equal(control.attenuation.gain.value, 1);
    assert.equal(control.lowpass.frequency.value, 20000);
    // Geometry behind the emitter does not occlude; source's own mesh is excluded.
    s.wall.setPosition([0, 0, -2]);
    s.update();
    assert.equal(control.blocked, 0);
    s.wall.visible = false;
    s.wall.setPosition([0, 0, 2]);
    s.update();
    assert.equal(control.blocked, 0);
    control.dispose();
    control.dispose();
    assert.deepEqual(s.sound.getFilters(), [filter]);
    assert.equal(control.lowpass.outputs.size, 0);
    assert.throws(
      () => control.update(s.engine),
      (e) => e.code === 'disposed' && /https:/.test(e.message),
    );
    s.dispose();
  });

test('partial cover, centred single ray, filter predicate and coincident source', async () => {
  const s = await scene();
  s.wall.setScale([0.2, 4, 0.1]);
  let control = await AudioOcclusion.create(s.sound, { radius: 1 });
  s.update();
  assert.equal(control.blocked, 3 / 5);
  assert.ok(control.attenuation.gain.value > 0.25 && control.attenuation.gain.value < 1);
  assert.ok(control.lowpass.frequency.value > 800 && control.lowpass.frequency.value < 20000);
  control.dispose();
  control = await AudioOcclusion.create(s.sound, { radius: 0 });
  s.update();
  assert.equal(control.blocked, 1);
  control.dispose();
  control = await AudioOcclusion.create(s.sound, { filter: (mesh) => mesh !== s.wall });
  s.update();
  assert.equal(control.blocked, 0);
  control.dispose();
  control = await AudioOcclusion.create(s.sound);
  s.source.setPosition([0, 0, 4]);
  s.update();
  assert.equal(control.blocked, 0);
  // Listener disposal runs after sound disposal and must not reconnect either owned node.
  s.dispose();
  assert.equal(control.attenuation.outputs.size, 0);
});

test('vertical propagation remains finite, smoothing affects only owned params and listener meshes are excluded', async () => {
  const s = await scene();
  s.engine.camera.position = [0, 4, 0];
  s.wall.setPosition([0, 2, 0]).setScale([4, 0.1, 4]);
  const control = await AudioOcclusion.create(s.sound, { smoothing: 0.1 });
  s.update();
  assert.equal(control.blocked, 1);
  s.context.state = 'running';
  s.wall.visible = false;
  s.update();
  assert.deepEqual(control.attenuation.gain.last('target'), ['target', 1, 0, 0.1]);
  s.listener.follow(s.wall);
  s.wall.visible = true;
  s.update();
  assert.equal(control.blocked, 0);
  s.dispose();
});

test('invalid options and aborted creation allocate no graph; missing engine retains state', async () => {
  const s = await scene();
  for (const options of [
    { radius: -1 },
    { blockedGain: 2 },
    { blockedFrequency: 24001 },
    { smoothing: Infinity },
    { filter: 7 },
  ])
    await assert.rejects(AudioOcclusion.create(s.sound, options), /needs/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(AudioOcclusion.create(s.sound, { signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(s.sound.getFilters(), []);
  const pending = new AbortController();
  const promise = AudioOcclusion.create(s.sound, { signal: pending.signal });
  pending.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.deepEqual(s.sound.getFilters(), []);
  const control = await AudioOcclusion.create(s.sound);
  assert.doesNotThrow(() => control.update(null));
  s.dispose();
});
test('disposed occluded sounds unregister before any BVH trace or transform refresh',async t=>{
 const s=await scene();const {Raycaster}=await import('@margoengine/bvh');let rays=0,ticks=0;
 t.mock.method(Raycaster.prototype,'intersectEngine',()=>{rays++;return [];});
 t.mock.method(s.engine.store,'tick',()=>{ticks++;});
 const removed=[],remove=s.listener.removeSource.bind(s.listener);
 t.mock.method(s.listener,'removeSource',value=>{removed.push(value);remove(value);});
 const control=await AudioOcclusion.create(s.sound);s.sound.dispose();
 assert.equal(s.sound.isDisposed,true);assert.doesNotThrow(()=>s.listener.update());
 assert.equal(rays,0);assert.equal(ticks,0);assert.ok(removed.includes(control));
 assert.throws(()=>control.update(s.engine),e=>e.code==='disposed');s.listener.update();assert.equal(rays,0);
 await assert.rejects(AudioOcclusion.create(s.sound),e=>e.code==='disposed');s.dispose();
});
test('occlusion without an engine and after engine disposal retains state and permits later sources',async()=>{
 const context=new FakeAudioContext(),listener=new AudioListener({context,autoResume:false});
 const sound=new PositionalAudio(listener).setPosition(0,0,-10),control=await AudioOcclusion.create(sound);
 let after=0;listener.addSource({update(){after++;},dispose(){}});
 assert.doesNotThrow(()=>listener.update());assert.equal(after,1);assert.equal(control.blocked,0);listener.dispose();
 const s=await scene(),blocked=await AudioOcclusion.create(s.sound);s.update();assert.equal(blocked.blocked,1);
 let later=0;s.listener.addSource({update(){later++;},dispose(){}});s.engine.dispose();
 assert.doesNotThrow(()=>s.listener.update());assert.equal(blocked.blocked,1);assert.equal(later,1);s.dispose();
});
test('disposing a sound while occlusion creation awaits its module leaves no registered graph',async()=>{
 const context=new FakeAudioContext(),listener=new AudioListener({context,autoResume:false});
 const sound=new PositionalAudio(listener),pending=AudioOcclusion.create(sound);
 sound.dispose();await assert.rejects(pending,e=>e.code==='disposed');
 assert.deepEqual(sound.getFilters(),[]);assert.doesNotThrow(()=>listener.update());listener.dispose();
});
