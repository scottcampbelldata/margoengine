import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { Animation } from '../packages/animation/dist/index.js';
import { Animator } from '../packages/animator/dist/index.js';
import { RigScratch } from '../examples/skinning-ik/rig-scratch.ts';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

function fixture() {
  const result = animatedTriangle(),
    { doc, buffers } = result;
  function add(values, type) {
    const data = new Float32Array(values),
      buffer = buffers.length,
      view = doc.bufferViews.length;
    buffers.push(data);
    doc.buffers.push({ byteLength: data.byteLength });
    doc.bufferViews.push({ buffer, byteLength: data.byteLength });
    const accessor = doc.accessors.length;
    doc.accessors.push({
      bufferView: view,
      componentType: 5126,
      count: data.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type],
      type,
    });
    return accessor;
  }
  const times = add([0, 1], 'SCALAR');
  const clip = (name, rotation, translation, scale, weights) => {
    const channels = [],
      samplers = [];
    for (const [path, values, type, node] of [
      ['rotation', rotation, 'VEC4', 0],
      ['translation', translation, 'VEC3', 0],
      ['scale', scale, 'VEC3', 0],
      ['weights', weights, 'SCALAR', 0],
    ]) {
      const sampler = samplers.length;
      samplers.push({ input: times, output: add(values, type), interpolation: 'LINEAR' });
      channels.push({ sampler, target: { node, path } });
    }
    return { name, channels, samplers };
  };
  doc.animations = [
    clip('TurnA', [0, 0, 0, 1, 0.1, 0.3, -0.2, 0.9], [0, 0, 0, 0.2, 0.1, -0.1], [1, 1, 1, 1.1, 1.1, 1.1], [0, 0.8]),
    clip(
      'TurnB',
      [0.1, -0.2, 0.05, 0.95, -0.3, -0.1, 0.1, 0.85],
      [-0.1, 0.1, 0.05, 0.1, -0.1, 0],
      [1, 1, 1, 0.9, 0.9, 0.9],
      [0.4, 0.1],
    ),
    { name: 'Rest', channels: [], samplers: [] },
  ];
  doc.nodes[1].translation = [0, 0.8, 0];
  doc.nodes[1].children = [2];
  doc.nodes.push(
    { name: 'Knee', translation: [0, -0.4, 0.05], children: [3] },
    { name: 'Ankle', translation: [0, -0.4, -0.05] },
  );
  return result;
}

const baseOptions = () => ({
  initial: 'a',
  parameters: { blend: 0.3, x: 0.2, y: 0.1 },
  states: {
    a: 'TurnA',
    b: 'TurnB',
    rest: 'Rest',
    line: {
      parameter: 'blend',
      samples: [
        { value: 0, clip: 'TurnA' },
        { value: 1, clip: 'TurnB' },
      ],
    },
    plane: {
      parameters: ['x', 'y'],
      samples: [
        { value: [0, 0], clip: 'Rest' },
        { value: [1, 0], clip: 'TurnA' },
        { value: [0, 1], clip: 'TurnB' },
      ],
    },
  },
});

async function scene(options = baseOptions()) {
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    f = fixture(),
    model = new PBRModel(engine, new GLTFAsset(f.doc, f.buffers)),
    animation = new Animation(model),
    animator = new Animator(animation, options);
  return { store, engine, model, animation, animator };
}
function release(f) {
  f.animator.dispose();
  f.animation.dispose();
  f.model.dispose();
  f.engine.dispose();
}
function snapshot(f) {
  f.store.tick(false);
  const t = f.store.transforms;
  return {
    time: f.animator.time,
    state: f.animator.state,
    nodes: f.model.nodes.map((n) => [
      t.x[n.id],
      t.y[n.id],
      t.z[n.id],
      t.sx[n.id],
      t.sy[n.id],
      t.sz[n.id],
      t.qx[n.id],
      t.qy[n.id],
      t.qz[n.id],
      t.qw[n.id],
      ...n.euler,
      ...n.matrix,
    ]),
    weights: f.model.primitives.map((p) => [...p.weights]),
  };
}
function writer(scratch, observed) {
  const identities = new WeakMap();
  let nextIdentity = 0;
  return (node, rotation) => {
    assert.equal(Array.isArray(rotation), true, 'all callback rotations are internally owned normal arrays');
    assert.equal(rotation.length, 4);
    const before = [...rotation];
    if (!identities.has(rotation)) identities.set(rotation, ++nextIdentity);
    observed.push({ node, rotationId: identities.get(rotation) });
    scratch.setQuaternion(node, rotation);
    assert.deepEqual(rotation, before, 'the application writer cannot mutate its borrowed input');
  };
}

test('explicit writer matches all stored bits through clips, blend trees, interrupted fades, additive layers, morphs and external edits', async (t) => {
  const calls = [],
    scratch = new RigScratch(),
    options = baseOptions();
  options.writeRotation = writer(scratch, calls);
  const baseline = await scene(),
    candidate = await scene(options);
  t.after(() => {
    release(baseline);
    release(candidate);
  });
  const scenes = [baseline, candidate],
    states = ['a', 'line', 'plane', 'b', 'rest'];
  let removeLayer;
  for (let frame = 0; frame < 360; frame++) {
    for (const f of scenes) {
      f.animator.parameters.blend = 0.5 + 0.5 * Math.sin(frame * 0.03);
      f.animator.parameters.x = 0.4 + 0.3 * Math.sin(frame * 0.02);
      f.animator.parameters.y = 0.3 + 0.2 * Math.cos(frame * 0.04);
      if (frame % 29 === 0)
        f.animator.transition(states[Math.floor(frame / 29) % states.length], frame % 58 ? 0.35 : 0);
      if (frame % 23 === 0) f.model.nodes[0].setRotation([0.2, -0.3, 0.1]);
      if (frame % 47 === 0) f.model.nodes[0].euler[2] += 0.125;
      if (frame === 110) for (let i = 0; i < 40; i++) f.engine.createMesh();
    }
    if (frame === 150)
      removeLayer = scenes.map((f) =>
        f.animator.addLayer({ clip: 'TurnA', weight: 0.35, mask: [0], referenceTime: 0.2 }),
      );
    if (frame === 190) for (const remove of removeLayer) remove();
    const dt = frame % 17 === 0 ? 0 : [1 / 120, 1 / 60, 1 / 30][frame % 3];
    for (const f of scenes) f.animator.onPreUpdate(dt);
    assert.deepEqual(snapshot(candidate), snapshot(baseline), `frame ${frame}`);
  }
  assert.ok(calls.length > 100);
  assert.ok(
    new Set(calls.map((c) => c.rotationId)).size > 1,
    'transitions/layers exercise independent owned rotations',
  );
});

test('FootIK corrections use the same writer and preserve full pose bits', async (t) => {
  const calls = [],
    options = baseOptions();
  options.initial = 'rest';
  options.writeRotation = writer(new RigScratch(), calls);
  const plain = baseOptions();
  plain.initial = 'rest';
  const baseline = await scene(plain),
    candidate = await scene(options),
    scenes = [baseline, candidate];
  t.after(() => scenes.forEach(release));
  for (const f of scenes) {
    // CPU fixture: satisfy the attachment registry without executing GPU deformation.
    f.engine.use({ name: f.animation.name, setup() {} });
    f.engine.use(f.animator);
    f.animator.addFootIK({
      hip: 1,
      knee: 2,
      ankle: 3,
      pole: [0.2, 0.7, 0.4],
      raycast: (origin, direction) => {
        assert.deepEqual(direction, [0, -1, 0]);
        return { position: [origin[0] + 0.04, origin[1] - 1 + 0.08, origin[2] + 0.05], normal: [0, 1, 0] };
      },
    });
  }
  for (let frame = 0; frame < 40; frame++) {
    const start = calls.length;
    for (const f of scenes) f.animator.onPreUpdate(frame % 7 ? 1 / 60 : 0);
    assert.deepEqual(snapshot(candidate), snapshot(baseline), `FootIK frame ${frame}`);
    const last = calls
      .slice(start)
      .slice(-3)
      .map((c) => c.node);
    assert.deepEqual(
      last,
      [candidate.model.nodes[1], candidate.model.nodes[2], candidate.model.nodes[3]],
      'hip, knee and ankle corrections all pass through the explicit writer',
    );
  }
});

test('default writer retains pre-import and later dynamic Mesh setter dispatch', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const url = (p) => pathToFileURL(root + p).href;
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    const { Engine, Mesh, TransformStore } = await import(${JSON.stringify(url('packages/core/dist/extension.js'))});
    const original = Mesh.prototype.setQuaternion;
    let before = 0, later = 0;
    Mesh.prototype.setQuaternion = function(q) { before++; return Reflect.apply(original, this, [q]); };
    const { Animator } = await import(${JSON.stringify(url('packages/animator/dist/index.js'))});
    const { Animation } = await import(${JSON.stringify(url('packages/animation/dist/index.js'))});
    const { GLTFAsset, PBRModel } = await import(${JSON.stringify(url('packages/gltf-pro/dist/index.js'))});
    const { animatedTriangle } = await import(${JSON.stringify(url('tests/support/gltf-pro-fixture.js'))});
    const store = await TransformStore.create(16), engine = new Engine({width:1,height:1,clientWidth:1,clientHeight:1}, store,
      {backend:'webgl2',add(){},remove(){},render(){},dispose(){}}), f=animatedTriangle(),
      model=new PBRModel(engine,new GLTFAsset(f.doc,f.buffers)), animation=new Animation(model),
      animator=new Animator(animation,{initial:'a',states:{a:'Move'}});
    before=0; animator.onPreUpdate(0); assert.ok(before>0);
    const count=before;
    Mesh.prototype.setQuaternion=function(q) {later++;return Reflect.apply(original,this,[q]);};
    store.transforms.qw[model.nodes[0].id]=0.5;
    animator.onPreUpdate(0); assert.ok(later>0); assert.equal(before,count);
    animator.dispose(); animation.dispose(); model.dispose(); engine.dispose();
    console.log(JSON.stringify({before,later}));
  `,
    ],
    { encoding: 'utf8' },
  );
  const counts = JSON.parse(result.trim());
  assert.ok(counts.before > 0 && counts.later > 0);
});

test('writer getter is read once and later option edits cannot substitute the captured callback', async (t) => {
  let reads = 0,
    writes = 0;
  const options = baseOptions(),
    scratch = new RigScratch();
  Object.defineProperty(options, 'writeRotation', {
    configurable: true,
    get() {
      reads++;
      if (reads > 1) throw new Error('writer getter read twice');
      return (node, q) => {
        writes++;
        scratch.setQuaternion(node, q);
      };
    },
  });
  const f = await scene(options);
  t.after(() => release(f));
  assert.equal(reads, 1);
  Object.defineProperty(options, 'writeRotation', {
    value: () => {
      throw new Error('later writer');
    },
  });
  f.animator.onPreUpdate(1 / 60);
  assert.ok(writes > 0);
  assert.equal(reads, 1);
  const count = writes;
  f.animator.onPreUpdate(0);
  assert.equal(writes, count, 'cached unchanged pose does not call the hook');
});

test('invalid writer fails before attachment/model mutation and preserves earlier state validation precedence', async (t) => {
  const f = await scene();
  t.after(() => release(f));
  const before = snapshot(f),
    playing = f.animation.playing;
  for (const invalid of [null, false, 1, 'writer', {}, []]) {
    const options = baseOptions();
    options.writeRotation = invalid;
    assert.throws(() => new Animator(f.animation, options), /Invalid animator rotation writer/);
    assert.throws(() => Animator.attach(f.animation, options), /Invalid animator rotation writer/);
    assert.equal(f.animation.playing, playing);
    assert.equal(f.engine.hasPlugin('animator:' + f.model.name), false);
    assert.deepEqual(snapshot(f), before);
    assert.throws(
      () => new Animator(f.animation, { initial: 'absent', states: {}, writeRotation: invalid }),
      /Invalid animator states/,
    );
  }
  let reads = 0;
  const options = { initial: 'absent', states: {} };
  Object.defineProperty(options, 'writeRotation', {
    get() {
      reads++;
      throw new Error('unread writer getter');
    },
  });
  assert.throws(() => new Animator(f.animation, options), /Invalid animator states/);
  assert.equal(reads, 0, 'earlier existing invalid states win before the new callback is read');
});

test('invalid update/blend and disposed-Animator guards do not invoke a rotation writer', async (t) => {
  let calls = 0;
  const options = baseOptions(),
    scratch = new RigScratch();
  options.writeRotation = (node, q) => {
    calls++;
    scratch.setQuaternion(node, q);
  };
  const f = await scene(options);
  t.after(() => release(f));
  f.animator.onPreUpdate(0.1);
  const count = calls,
    before = snapshot(f);
  for (const dt of [-1, NaN, Infinity]) {
    assert.throws(() => f.animator.onPreUpdate(dt), /Invalid animator delta/);
    assert.equal(calls, count);
    assert.deepEqual(snapshot(f), before);
  }
  f.animator.parameters.blend = NaN;
  assert.throws(() => f.animator.onPreUpdate(0.1), /Invalid blend parameter/);
  assert.equal(calls, count);
  assert.deepEqual(snapshot(f), before);
  f.animator.parameters.blend = 0.3;
  f.animator.dispose();
  assert.doesNotThrow(() => f.animator.onPreUpdate(NaN), 'disposed early-return precedence remains unchanged');
  assert.equal(calls, count);
});

test('writer failures before and after a real commit do not certify the cache and retry at the same time', async (t) => {
  for (const timing of ['before', 'after']) {
    let fail = false,
      calls = 0;
    const scratch = new RigScratch(),
      options = baseOptions();
    options.writeRotation = (node, q) => {
      calls++;
      if (fail && timing === 'before') throw new Error('refused commit');
      scratch.setQuaternion(node, q);
      if (fail) throw new Error('refused commit');
    };
    const baseline = await scene(),
      f = await scene(options);
    t.after(() => {
      release(f);
      release(baseline);
    });
    for (const s of [baseline, f]) s.animator.onPreUpdate(0.1);
    const cache = [...f.animator.applied[0]],
      initialCalls = calls;
    fail = true;
    assert.throws(() => f.animator.onPreUpdate(0.05), /refused commit/);
    const now = f.animator.time;
    assert.equal(f.animator.rotationWriteActive, false);
    assert.deepEqual([...f.animator.applied[0]].slice(6, 10), cache.slice(6, 10));
    assert.deepEqual([...f.animator.applied[0]].slice(19, 26), cache.slice(19, 26));
    assert.equal(calls, initialCalls + 1);
    fail = false;
    f.animator.onPreUpdate(0);
    baseline.animator.onPreUpdate(0.05);
    assert.equal(f.animator.time, now);
    assert.ok(calls > initialCalls + 1, 'the same failed rotation must reach the callback again');
    assert.deepEqual(snapshot(f), snapshot(baseline));
  }
});

test('recursive writer updates reject before changing time/playback/pose and the active flag clears on failure', async (t) => {
  const options = baseOptions(),
    scratch = new RigScratch();
  let f,
    nested = 0,
    fail = false;
  options.writeRotation = (node, q) => {
    const time = f.animator.time,
      playing = f.animation.playing,
      current = f.animator.current;
    if (fail) f.animator.onPreUpdate(1);
    assert.throws(() => f.animator.onPreUpdate(1), /cannot reenter/);
    nested++;
    assert.equal(f.animator.time, time);
    assert.equal(f.animation.playing, playing);
    assert.equal(f.animator.current, current);
    scratch.setQuaternion(node, q);
  };
  f = await scene(options);
  t.after(() => release(f));
  f.animator.onPreUpdate(0.1);
  assert.ok(nested > 0);
  assert.equal(f.animator.rotationWriteActive, false);
  fail = true;
  assert.throws(() => f.animator.onPreUpdate(0.1), /cannot reenter/);
  assert.equal(f.animator.rotationWriteActive, false);
  fail = false;
  f.animator.onPreUpdate(0);
  assert.equal(f.animator.rotationWriteActive, false);
});

test('a throw after restoring the previous successful cached rotation preserves the default unchanged-update skip', async (t) => {
  const plain = baseOptions(),
    options = baseOptions(),
    scratch = new RigScratch();
  plain.initial = options.initial = 'rest';
  let candidate,
    fail = false,
    writes = 0,
    defaults = 0;
  options.writeRotation = (node, q) => {
    writes++;
    scratch.setQuaternion(node, q);
    if (fail && node === candidate.model.nodes[0]) throw new Error('restored cached state');
  };
  const baseline = await scene(plain);
  candidate = await scene(options);
  t.after(() => {
    release(baseline);
    release(candidate);
  });
  for (const f of [baseline, candidate]) f.animator.onPreUpdate(0);
  const before = snapshot(baseline);
  assert.deepEqual(snapshot(candidate), before);
  const original = baseline.model.nodes[0].setQuaternion;
  baseline.model.nodes[0].setQuaternion = function (q) {
    defaults++;
    Reflect.apply(original, this, [q]);
    throw new Error('restored cached state');
  };
  writes = 0;
  fail = true;
  for (const f of [baseline, candidate]) {
    const cache = [...f.animator.applied[0]];
    f.model.nodes[0].setRotation([0.2, -0.3, 0.1]);
    assert.throws(() => f.animator.onPreUpdate(0), /restored cached state/);
    assert.deepEqual([...f.animator.applied[0]], cache, 'the earlier successful cache stays unchanged');
    assert.deepEqual(snapshot(f), before, 'the throwing commit restored the earlier accepted physical state');
    assert.doesNotThrow(
      () => f.animator.onPreUpdate(0),
      'the restored state and unchanged request match the earlier successful cache',
    );
    assert.deepEqual(snapshot(f), before);
  }
  assert.equal(defaults, 1);
  assert.equal(writes, 1, 'the opt-in must match the default skip rather than force a failure retry');
  assert.equal(candidate.animator.rotationWriteActive, false);
});

test('explicit commit preserves malformed quaternion and disposed-node guards without changing public typed-array setters', async (t) => {
  const calls = [],
    options = baseOptions(),
    scratch = new RigScratch();
  options.initial = 'rest';
  options.writeRotation = (node, q) => {
    calls.push(node);
    scratch.setQuaternion(node, q);
  };
  const plain = baseOptions();
  plain.initial = 'rest';
  const baseline = await scene(plain),
    candidate = await scene(options);
  t.after(() => {
    release(baseline);
    release(candidate);
  });
  for (const invalid of [
    [0, 0, 0, 0],
    [NaN, 0, 0, 1],
    [Infinity, 0, 0, 1],
    [1e40, 0, 0, 1],
    ['1', 0, 0, 1],
    [0, 0, 1],
    [0, 0, 0, 1, 0],
  ]) {
    const saved = [baseline, candidate].map((f) => f.animator.rest.rotation[0]);
    for (const f of [baseline, candidate]) f.animator.rest.rotation[0] = invalid;
    let expected;
    try {
      baseline.animator.onPreUpdate(0);
    } catch (error) {
      expected = error;
    }
    assert.ok(expected);
    assert.throws(() => candidate.animator.onPreUpdate(0), { name: expected.name, message: expected.message });
    for (const [i, f] of [baseline, candidate].entries()) f.animator.rest.rotation[0] = saved[i];
    for (const f of [baseline, candidate]) f.animator.onPreUpdate(0);
    assert.deepEqual(snapshot(candidate), snapshot(baseline));
  }
  for (const value of [new Float32Array([0.1, 0.2, 0.3, 0.9]), new Float64Array([0.1, 0.2, 0.3, 0.9])]) {
    for (const f of [baseline, candidate]) f.model.nodes[0].setQuaternion(value);
    assert.deepEqual(snapshot(candidate), snapshot(baseline), 'public typed-array setter behavior remains unchanged');
  }
  const count = calls.length;
  candidate.model.nodes[0].dispose();
  assert.throws(() => candidate.animator.onPreUpdate(0), /disposed|mesh/i);
  assert.equal(calls.length, count);
});
