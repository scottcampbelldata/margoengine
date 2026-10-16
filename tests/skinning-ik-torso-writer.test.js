import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { RigScratch } from '../examples/skinning-ik/rig-scratch.ts';
import { mapArmControl } from '../examples/skinning-ik/arm-controls.ts';

mkdirSync(resolve('test-results'), { recursive: true });
mkdirSync(resolve('test-results/torso-writer-ablation'), { recursive: true });
const temporary = mkdtempSync(resolve('test-results/torso-writer-')),
  file = join(temporary, 'torso.mjs'),
  bundle = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      target: 'es2022',
      minify: false,
      lib: { entry: resolve('examples/skinning-ik/torso-aim.ts'), formats: ['es'] },
      rollupOptions: { external: (id) => id.startsWith('@margoengine/') },
    },
  });
writeFileSync(file, bundle[0].output[0].code);
const { TorsoAim } = await import(pathToFileURL(file).href);
unlinkSync(file);
rmdirSync(temporary);
const bytes = readFileSync(new URL('../examples/assets/skinning-ik.glb', import.meta.url)),
  doc = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));

async function robot(optIn = false, before) {
  const store = await TransformStore.create(64),
    engine = new Engine({ width: 1, height: 1, clientWidth: 1, clientHeight: 1 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    root = engine.createMesh(),
    nodes = doc.nodes.map((n) =>
      engine
        .createMesh()
        .setParent(root)
        .setPosition(n.translation ?? [0, 0, 0])
        .setQuaternion(n.rotation ?? [0, 0, 0, 1])
        .setScale(n.scale ?? [1, 1, 1]),
    );
  doc.nodes.forEach((n, i) => n.children?.forEach((child) => nodes[child].setParent(nodes[i])));
  const body = nodes[doc.nodes.findIndex((n) => n.name === 'Body')],
    scratch = new RigScratch(),
    writes = [];
  before?.(body);
  store.tick(false);
  const t = store.transforms,
    rest = [t.qx[body.id], t.qy[body.id], t.qz[body.id], t.qw[body.id]],
    torso = new TorsoAim(
      body,
      root,
      0.85,
      optIn
        ? (rotation) => {
            assert.ok(Array.isArray(rotation), 'the opt-in receives only controller-owned normal arrays');
            writes.push(rotation);
            scratch.setQuaternion(body, rotation);
          }
        : undefined,
    );
  return { store, engine, root, nodes, body, torso, scratch, writes, rest };
}
function bodyState(f) {
  const t = f.store.transforms,
    id = f.body.id;
  return [t.qx[id], t.qy[id], t.qz[id], t.qw[id], ...f.body.euler, ...f.body.matrix];
}
function snapshot(f) {
  const t = f.store.transforms;
  return {
    yaw: f.torso.yaw,
    desired: f.torso.desiredYaw,
    nodes: [f.root, ...f.nodes, f.torso.frame].map((node) => {
      const id = node.id;
      return [
        id,
        f.store.parents[id],
        t.x[id],
        t.y[id],
        t.z[id],
        t.qx[id],
        t.qy[id],
        t.qz[id],
        t.qw[id],
        t.sx[id],
        t.sy[id],
        t.sz[id],
        ...node.euler,
        ...node.matrix,
      ];
    }),
  };
}

test('explicit torso writer is bit-exact for 2400 authored control/reversal frames, root changes, resets and store growth', async (t) => {
  const a = await robot(),
    b = await robot(true);
  t.after(() => {
    a.engine.dispose();
    b.engine.dispose();
  });
  const target = [0, 0, 0],
    controls = ['side', 'height', 'nearFar'];
  for (let frame = 0; frame < 2400; frame++) {
    const angle = frame * 0.017,
      scale = [0.7, 1, 1.7][Math.floor(frame / 240) % 3],
      parameter = frame % 73 === 0 ? 1 : 0.5 + 0.5 * Math.sin(angle),
      dt = frame % 19 === 0 ? 0 : [1 / 120, 1 / 60, 1 / 30, 1 / 240][frame % 4];
    mapArmControl(controls[Math.floor(frame / 400) % 3], parameter, target);
    for (const f of [a, b]) {
      // Animator restores its owned Body inputs before the coupled torso pass.
      f.body.setQuaternion(f.rest);
      f.root
        .setPosition([Math.sin(angle) * 0.3, -0.2, Math.cos(angle) * 0.2])
        .setRotation([Math.sin(angle) * 0.1, -0.55, Math.cos(angle) * 0.07])
        .setScale([scale, scale, scale]);
      if (frame % 53 === 0) f.body.euler[0] += 0.125;
      if (frame === 800) for (let i = 0; i < 80; i++) f.engine.createMesh();
      if (frame % 211 === 0) f.torso.reset();
      else f.torso.update(target, dt);
      const count = f.writes.length;
      f.torso.applyHeld();
      f.torso.update(target, 0);
      f.torso.applyHeld();
      assert.equal(f.writes.length, count, 'unchanged held repeats do not add writer commits');
    }
    assert.deepEqual(snapshot(b), snapshot(a), `frame ${frame}`);
  }
  assert.ok(b.writes.length > 100, 'the comparison must exercise real turns as well as own-side cache hits');
  assert.equal(new Set(b.writes).size, 1, 'the output rotation remains one reused normal array');
  writeFileSync(
    'test-results/torso-writer-ablation/parity.json',
    JSON.stringify(
      {
        frames: 2400,
        bitExact: true,
        writerCalls: b.writes.length,
        storeGrowth: true,
        rootTransforms: true,
        animatorRestoration: true,
        repeatedHeldCache: true,
      },
      null,
      2,
    ),
  );
});

test('default torso commits retain pre-existing and later dynamic public setter callbacks', async (t) => {
  let beforeCalls = 0,
    laterCalls = 0;
  const f = await robot(false, (body) => {
    const original = body.setQuaternion;
    body.setQuaternion = function (rotation) {
      beforeCalls++;
      return original.call(this, rotation);
    };
  });
  t.after(() => f.engine.dispose());
  f.torso.update([0.235, 1.16, -0.32], 1 / 60);
  assert.equal(beforeCalls, 1);
  const prior = f.body.setQuaternion;
  f.body.setQuaternion = function (rotation) {
    laterCalls++;
    return prior.call(this, rotation);
  };
  f.body.setRotation([0.1, -0.2, 0.03]);
  f.torso.applyHeld();
  assert.equal(beforeCalls, 2);
  assert.equal(laterCalls, 1);
  const accepted = bodyState(f);
  f.torso.update([0.235, 1.16, -0.32], 0);
  assert.deepEqual(bodyState(f), accepted);
  assert.equal(laterCalls, 1);
  f.torso.reset();
  assert.equal(laterCalls, 2);
});

test('torso writer configuration is validated before creating its collision frame or changing the body', async (t) => {
  const f = await robot();
  t.after(() => f.engine.dispose());
  const before = snapshot(f),
    count = f.engine.meshes.size;
  for (const invalid of [null, false, 1, 'writer', {}, []]) {
    assert.throws(() => new TorsoAim(f.body, f.root, 0.85, invalid), /Invalid torso rotation writer/);
    assert.equal(f.engine.meshes.size, count);
    assert.deepEqual(snapshot(f), before);
  }
});

test('opt-in torso commits preserve request, hierarchy, output and disposed guards', async (t) => {
  const a = await robot(),
    b = await robot(true);
  t.after(() => {
    a.engine.dispose();
    b.engine.dispose();
  });
  for (const f of [a, b]) f.torso.update([0.235, 1.16, -0.32], 1 / 60);
  for (const target of [
    [NaN, 0, 0],
    [Infinity, 0, 0],
    [1e40, 0, 0],
    ['1', 0, 0],
    [0, 0],
  ]) {
    const before = bodyState(b),
      calls = b.writes.length;
    assert.throws(() => b.torso.update(target, 1 / 60), /finite/);
    assert.deepEqual(bodyState(b), before);
    assert.equal(b.writes.length, calls);
  }
  for (const dt of [-1, NaN, Infinity]) {
    const before = bodyState(b),
      calls = b.writes.length;
    assert.throws(() => b.torso.update([0, 1, -0.4], dt), /finite/);
    assert.deepEqual(bodyState(b), before);
    assert.equal(b.writes.length, calls);
  }
  for (const invalid of [
    [0, 0, 0, 0],
    [NaN, 0, 0, 1],
    [Infinity, 0, 0, 1],
    [1e40, 0, 0, 1],
  ]) {
    const beforeA = bodyState(a),
      beforeB = bodyState(b),
      restA = [...a.torso.rest],
      restB = [...b.torso.rest];
    for (const f of [a, b]) {
      for (let i = 0; i < 4; i++) f.torso.rest[i] = invalid[i];
      f.torso.yaw = 0;
    }
    let originalError;
    try {
      a.torso.applyHeld();
    } catch (error) {
      originalError = error;
    }
    assert.ok(originalError);
    assert.throws(() => b.torso.applyHeld(), { name: originalError.name, message: originalError.message });
    assert.deepEqual(bodyState(a), beforeA);
    assert.deepEqual(bodyState(b), beforeB);
    for (let i = 0; i < 4; i++) {
      a.torso.rest[i] = restA[i];
      b.torso.rest[i] = restB[i];
    }
  }
  const before = bodyState(b),
    calls = b.writes.length,
    tform = b.store.transforms;
  tform.sx[b.root.id] = 0;
  assert.throws(() => b.torso.applyHeld(), /uniform/);
  assert.deepEqual(bodyState(b), before);
  assert.equal(b.writes.length, calls);
  tform.sx[b.root.id] = 1;
  b.body.dispose();
  assert.throws(() => b.torso.applyHeld(), /disposed|released|mesh/i);
  assert.equal(b.writes.length, calls);
});

test('a rejected opt-in write never advances the successful-commit cache', async (t) => {
  const f = await robot();
  t.after(() => f.engine.dispose());
  let calls = 0;
  const torso = new TorsoAim(f.body, f.root, 0.85, () => {
    calls++;
    throw new Error('refused rotation');
  });
  const before = bodyState(f);
  assert.throws(() => torso.update([0.235, 1.16, -0.32], 1 / 60), /refused rotation/);
  assert.throws(() => torso.applyHeld(), /refused rotation/);
  assert.equal(calls, 2);
  assert.deepEqual(bodyState(f), before);
  torso.dispose();
});
