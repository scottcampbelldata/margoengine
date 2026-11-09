import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { MAX_PARTICLE_LIGHTS } from '../dist/shadows.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect };
};

const codeOf = (pipeline) => (pipeline.compute ?? pipeline.vertex).module.code;

test('shadows packs lights in slot order and draws sphere impostors, without patching the simulation', async () => {
  assert.equal(MAX_PARTICLE_LIGHTS, 64);
  let source;
  let added;
  let removed = false;
  const cast = {
    add(next, options) {
      source = next;
      added = options;
      return () => {
        removed = true;
      };
    },
  };
  const seen = [];
  const into = {
    setLights(lights) {
      seen.push(lights);
    },
  };
  const options = { capacity: 4, shadows: { cast, into, count: 2, range: 5, intensity: 3 } };
  const { h, effect } = attach(options);
  assert.equal(added.static, false);
  assert.equal(typeof source.drawShadow, 'function');
  assert.equal(effect.options.shadows.buffer.size, (1 + 64 * 2) * 16);
  h.frame();
  const params = h.resources.find((r) => r.size === 16 && new Uint32Array(r.data)[0] === 4);
  assert.deepEqual([...new Uint32Array(params.data).subarray(0, 2)], [4, 2]);
  assert.deepEqual([...new Float32Array(params.data).subarray(2, 4)], [5, 3]);
  effect.options.shadows.count = 1;
  effect.options.shadows.range = 6;
  h.frame();
  assert.deepEqual([...new Uint32Array(params.data).subarray(0, 2)], [4, 1]);
  assert.equal(new Float32Array(params.data)[2], 6);
  const codes = h.pipelines.map(codeOf);
  const simulation = codes.find((code) => code.includes('fn update('));
  assert.equal(simulation.includes('particleShadows'), false);
  assert.ok(codes.some((code) => code.includes('fn pack(') && code.includes('fn prefix(')));
  const depth = codes.find((code) => code.includes('@builtin(frag_depth)'));
  assert.ok(depth.includes('sqrt(max(0.0,1.0-d))'));
  assert.match(depth, /back>=0\.0&&front<=1\.0/);
  assert.match(depth, /select\(clip\.z,kept\*clip\.w,overlaps&&outside\)/);
  let drawn = 0;
  source.drawShadow({
    cascade: 0,
    matrix: new Float32Array(16),
    pass: {
      setPipeline() {},
      setBindGroup() {},
      draw(vertices, instances) {
        drawn += 1;
        assert.equal(vertices, 6);
        assert.equal(instances, 4);
      },
    },
  });
  assert.equal(drawn, 1);
  assert.equal(h.engine.stats.drawCalls > 0, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.frame();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.frame();
  assert.deepEqual(seen.at(-1), []);
  effect.options.shadows = { count: 1 };
  assert.throws(() => h.frame(), /fixed at attach/);
  effect.dispose();
  assert.equal(removed, true);
  assert.equal(source.disposed, true);
});

test('shadows rejects a missing feature and a bad count, range, intensity or target', () => {
  assert.throws(() => new Base({ shadows: {} }, {}), /needs shadows from @margoengine\/vfx\/shadows/);
  assert.throws(() => new VFX({ shadows: null }), TypeError);
  assert.throws(() => new VFX({ shadows: { count: 2.5 } }), RangeError);
  assert.throws(() => new VFX({ shadows: { count: 65 } }), RangeError);
  assert.throws(() => new VFX({ shadows: { count: -1 } }), RangeError);
  assert.throws(() => new VFX({ shadows: { range: 0 } }), RangeError);
  assert.throws(() => new VFX({ shadows: { intensity: -0.1 } }), RangeError);
  assert.throws(() => new VFX({ shadows: { cast: {} } }), TypeError);
  assert.throws(() => new VFX({ shadows: { into: {} } }), TypeError);
  const { h, effect } = attach({ capacity: 2 });
  h.frame();
  assert.equal(
    h.pipelines.map(codeOf).some((code) => code.includes('particleShadows')),
    false,
  );
  effect.dispose();
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

const deferMaps = (engine) => {
  const create = engine.gpu.createBuffer;
  engine.gpu.createBuffer = (descriptor) => {
    const buffer = create(descriptor);
    let settle = null;
    buffer.mapAsync = () =>
      new Promise((resolve, reject) => {
        buffer.mapState = 'pending';
        settle = { resolve, reject };
      });
    const destroy = buffer.destroy.bind(buffer);
    buffer.destroy = () => {
      destroy();
      if (!settle) return;
      const reject = settle.reject;
      settle = null;
      reject(
        Object.assign(new Error('Buffer was destroyed before mapping was resolved'), { name: 'AbortError' }),
      );
    };
    return buffer;
  };
};

test('releasing the effect during the light readback settles the cancelled map', async () => {
  const rejections = [];
  const onReject = (reason) => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onReject);
  try {
    const disposed = optionalGPU();
    disposed.engine.stats = { drawCalls: 0 };
    deferMaps(disposed.engine);
    const disposedEffect = new VFX({ capacity: 1, shadows: { into: { setLights() {} } } });
    disposed.engine.use(disposedEffect);
    disposed.frame();
    disposed.frame();
    disposedEffect.dispose();
    await flush();
    assert.deepEqual(rejections, [], 'dispose destroyed the mapped buffer');

    const restored = optionalGPU();
    restored.engine.stats = { drawCalls: 0 };
    deferMaps(restored.engine);
    const restoredEffect = new VFX({ capacity: 1, shadows: { into: { setLights() {} } } });
    restored.engine.use(restoredEffect);
    restored.frame();
    restored.frame();
    restoredEffect.onDeviceRestored(restored.engine);
    await flush();
    assert.deepEqual(rejections, [], 'device restore destroyed the mapped buffer');
    restoredEffect.dispose();
  } finally {
    process.off('unhandledRejection', onReject);
  }
});

test('a light readback that fails on its own stays a rejection', async () => {
  const file = join(tmpdir(), `vfx-readback-${process.pid}.mjs`);
  const vfx = pathToFileURL(fileURLToPath(new URL('../dist/index.js', import.meta.url))).href;
  const harness = pathToFileURL(fileURLToPath(new URL('../../../tests/support/optional-gpu.js', import.meta.url))).href;
  await writeFile(
    file,
    `import { VFX } from ${JSON.stringify(vfx)};
import { optionalGPU } from ${JSON.stringify(harness)};
const seen = [];
process.on('unhandledRejection', (reason) => seen.push(String(reason)));
const h = optionalGPU();
h.engine.stats = { drawCalls: 0 };
const effect = new VFX({ capacity: 1, shadows: { into: { setLights() {} } } });
h.engine.use(effect);
h.frame();
const staging = h.resources.find((resource) => resource.usage === 9);
if (!staging) { console.error('no readback buffer'); process.exit(2); }
staging.mapAsync = () => Promise.reject(new TypeError('readback failed'));
h.frame();
setImmediate(() => {
  effect.dispose();
  setImmediate(() => {
    if (seen.length === 1 && seen[0].includes('readback failed')) process.exit(0);
    console.error(JSON.stringify(seen));
    process.exit(1);
  });
});
`,
  );
  try {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => out.push(chunk));
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('readback child hung'));
      }, 10000);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    assert.equal(code, 0, Buffer.concat(out).toString());
  } finally {
    await rm(file, { force: true });
  }
});

test('disposing a vfx removes the point lights it published', async () => {
  const copy = (lights) =>
    lights.map((light) => ({
      position: [...light.position],
      range: light.range,
      intensity: light.intensity,
    }));
  const seen = [];
  const { h, effect } = attach({
    capacity: 1,
    shadows: {
      into: {
        setLights(lights) {
          seen.push(copy(lights));
        },
      },
      count: 1,
      range: 4,
      intensity: 1,
    },
  });
  h.frame();
  const staging = h.resources.find((resource) => resource.usage === 9);
  assert.ok(staging, 'the light read-back buffer');
  const data = new Float32Array(staging.data);
  data[0] = 1;
  data[4] = 1;
  data[5] = 2;
  data[6] = 3;
  data[7] = 4;
  data[11] = 1;
  h.frame();
  await flush();
  h.frame();
  assert.equal(seen.at(-1).length, 1);
  assert.deepEqual(seen.at(-1)[0].position, [1, 2, 3]);
  assert.equal(seen.at(-1)[0].range, 4);
  assert.equal(seen.at(-1)[0].intensity, 1);
  effect.dispose();
  assert.equal(seen.at(-1).length, 0);

  const calls = [];
  const quiet = attach({ capacity: 1, shadows: { into: { setLights(lights) { calls.push(lights); } } } });
  quiet.effect.dispose();
  assert.equal(calls.length, 0);

  const again = [];
  const removed = attach({
    capacity: 1,
    shadows: {
      into: {
        setLights(lights) {
          again.push(lights.length);
        },
      },
      count: 1,
    },
  });
  removed.h.frame();
  const next = removed.h.resources.find((resource) => resource.usage === 9);
  assert.ok(next, 'the light read-back buffer');
  const packed = new Float32Array(next.data);
  packed[0] = 1;
  packed[4] = 1;
  packed[5] = 2;
  packed[6] = 3;
  packed[7] = 4;
  removed.h.frame();
  await flush();
  removed.h.frame();
  assert.equal(again.at(-1), 1);
  removed.h.engine.removePlugin(removed.effect.name);
  assert.equal(again.at(-1), 0);
});

test('shadows rejects a range or intensity that overflows f32', () => {
  const link = /https:\/\/margoengine.com\/errors#vfx-float/;
  assert.throws(
    () => new VFX({ shadows: { range: 1e40 } }),
    (error) => error instanceof RangeError && link.test(error.message) && /range/.test(error.message),
  );
  assert.throws(
    () => new VFX({ shadows: { intensity: 1e40 } }),
    (error) => error instanceof RangeError && link.test(error.message) && /intensity/.test(error.message),
  );
  assert.throws(() => new VFX({ shadows: { range: 0 } }), (error) => {
    assert.equal(error instanceof RangeError, true);
    assert.equal(link.test(error.message), false);
    return true;
  });
  assert.throws(
    () => new VFX({ shadows: { intensity: -0.1 } }),
    (error) => error instanceof RangeError && !link.test(error.message),
  );
  const { h, effect } = attach({ capacity: 1, shadows: { range: 4, intensity: 1 } });
  h.frame();
  effect.options.shadows.range = 1e40;
  assert.throws(() => h.frame(), (error) => error instanceof RangeError && link.test(error.message));
  effect.options.shadows.range = 4;
  effect.options.shadows.intensity = 1e40;
  assert.throws(
    () => h.frame(),
    (error) => error instanceof RangeError && link.test(error.message) && /intensity/.test(error.message),
  );
  effect.dispose();
});
