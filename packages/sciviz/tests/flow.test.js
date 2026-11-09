import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { build } from 'vite';
import { tracePathline } from '@margoengine/sciviz/flow';

const steady = (velocity = [1, 0, 0]) => ({
  dims: [2, 2, 1],
  bounds: [-10, 10, -10, 10, 0, 0],
  frames: [{ time: 0, u: new Float32Array(4).fill(velocity[0]), v: new Float32Array(4).fill(velocity[1]) }],
});
const controls = { from: 0, to: 1, step: 0.1 };
const close = (actual, expected, tolerance = 1e-12) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((x, i) => assert.ok(Math.abs(x - expected[i]) <= tolerance, `${i}: ${x} versus ${expected[i]}`));
};

test('steady pathlines use physical velocity, exact final time and one frame at arbitrary times', async () => {
  const field = steady([2, -3, 0]);
  const traced = await tracePathline(field, [0, 0, 0], controls);
  assert.equal(traced.stop, 'end');
  close([...traced.samples.slice(-4)], [2, -3, 0, 1]);
  close([...traced.samples.slice(0, 4)], [0, 0, 0, 0]);
  const backward = await tracePathline(field, [2, -3, 0], { from: 1, to: 0, step: 0.3 });
  assert.equal(backward.stop, 'end');
  close([...backward.samples.slice(-4)], [0, 0, 0, 0]);
  const crossing = await tracePathline(steady(), [0, 0, 0], { from: -1, to: 1, step: 2, maxSteps: 1 });
  assert.equal(crossing.stop, 'end');
  close([...crossing.samples], [0, 0, 0, -1, 2, 0, 0, 1]);
});

test('unsteady flow integrates piecewise-linear velocities at RK4 stage times and frame kinks', async () => {
  const base = steady();
  const grid = {
    ...base,
    frames: [0, 0.3, 2].map((time, i) => ({
      time,
      u: new Float32Array(4).fill([1, 4, -2][i]),
      v: new Float32Array(4),
    })),
  };
  const out = await tracePathline(grid, [0, 0, 0], { from: 0, to: 2, step: 2 });
  assert.equal(out.stop, 'end');
  // Exact trapezoidal integral of the two linear time segments: .3*(1+4)/2 + 1.7*(4-2)/2 = 2.45.
  close([...out.samples], [0, 0, 0, 0, 0.75, 0, 0, 0.3, 2.45, 0, 0, 2]);
  const reverse = await tracePathline(grid, [2.45, 0, 0], { from: 2, to: 0, step: 2 });
  close([...reverse.samples.slice(-4)], [0, 0, 0, 0]);
});

test('3D trilinear sampling and RK4 agree with an analytic linear system across grid cells', async () => {
  const dims = [5, 5, 5],
    u = new Float32Array(125),
    v = new Float32Array(125),
    w = new Float32Array(125);
  for (let k = 0; k < 5; k++)
    for (let j = 0; j < 5; j++)
      for (let i = 0; i < 5; i++) {
        const n = i + 5 * (j + 5 * k);
        u[n] = -(j - 2);
        v[n] = i - 2;
        w[n] = 0.2 * (k - 2);
      }
  const out = await tracePathline(
    { dims, bounds: [-2, 2, -2, 2, -2, 2], frames: [{ time: 0, u, v, w }] },
    [1, 0, 0.5],
    { from: 0, to: 2, step: 0.01 },
  );
  assert.equal(out.stop, 'end');
  close([...out.samples.slice(-4)], [Math.cos(2), Math.sin(2), 0.5 * Math.exp(Math.fround(0.2) * 2), 2], 2e-9);
  // Over 128 accepted steps also crosses the facade's chunk boundary.
  assert.ok(out.samples.length > 129 * 4);
});

test('missing and out-of-domain samples stop before an invalid stage without inventing a boundary point', async () => {
  const field = steady();
  const boundary = await tracePathline(field, [9.5, 0, 0], controls);
  assert.equal(boundary.stop, 'invalid');
  assert.ok(boundary.samples.at(-4) <= 10);
  const outside = await tracePathline(field, [0, 0, 1], { ...controls, from: 1, to: 1 });
  assert.equal(outside.stop, 'invalid');
  assert.equal(outside.samples.length, 0);
  const missing = {
    ...field,
    frames: [field.frames[0], { ...field.frames[0], time: 1, u: new Float32Array(4).fill(NaN) }],
  };
  const exact = await tracePathline(missing, [0, 0, 0], { ...controls, to: 0 });
  assert.equal(exact.stop, 'end', 'inactive next frame NaNs have zero influence at the current frame time');
  const moves = await tracePathline(missing, [0, 0, 0], controls);
  assert.equal(moves.stop, 'invalid');
  assert.equal(moves.samples.length, 4);
});

test('step budgets, non-advancing time and cancellation have explicit outcomes', async () => {
  const limited = await tracePathline(steady(), [0, 0, 0], { ...controls, step: 0.1, maxSteps: 2 });
  assert.equal(limited.stop, 'steps');
  close([...limited.samples.slice(-4)], [0.2, 0, 0, 0.2]);
  await assert.rejects(tracePathline(steady(), [0, 0, 0], { from: 1e16, to: 1e16 + 4, step: 0.1 }), /cannot advance/);
  const controller = new AbortController(),
    reason = { canceled: true };
  controller.abort(reason);
  await assert.rejects(
    tracePathline(steady(), [0, 0, 0], { ...controls, signal: controller.signal }),
    (e) => e === reason,
  );
  const during = new AbortController();
  const instantiate = WebAssembly.instantiate;
  let stepped = 0;
  const intercept = mock.method(WebAssembly, 'instantiate', async (...args) => {
    const actual = await instantiate(...args),
      exports = actual.instance.exports;
    return {
      instance: {
        exports: {
          ...exports,
          trace(...values) {
            const result = exports.trace(...values);
            if (values.at(-1) > 0) {
              stepped++;
              during.abort(reason);
            }
            return result;
          },
        },
      },
    };
  });
  try {
    await assert.rejects(
      tracePathline(steady([0, 0, 0]), [0, 0, 0], {
        ...controls,
        step: 1e-6,
        maxSteps: 1_000_000,
        signal: during.signal,
      }),
      (e) => e === reason,
    );
    assert.equal(stepped, 1, 'cancellation after real integration prevents the next chunk and publication');
  } finally {
    intercept.mock.restore();
  }
});

test('calls are deterministic, isolated and return owned arrays', async () => {
  const field = steady();
  const [a, b] = await Promise.all([
    tracePathline(field, [0, 0, 0], controls),
    tracePathline(field, [1, 0, 0], controls),
  ]);
  assert.equal(a.stop, 'end');
  assert.equal(b.stop, 'end');
  assert.equal(b.samples[0], 1);
  const saved = a.samples.slice();
  field.frames[0].u.fill(2);
  await tracePathline(field, [0, 0, 0], controls);
  assert.deepEqual(a.samples, saved);
  field.frames[0].u.fill(1);
  assert.deepEqual((await tracePathline(field, [0, 0, 0], controls)).samples, saved);
});

test('malformed fields and unsafe memory/time controls reject with linked RangeErrors', async () => {
  const base = steady();
  for (const [field, seed, options] of [
    [{ ...base, dims: [1, 2, 1] }, [0, 0, 0], controls],
    [{ ...base, bounds: [0, 0, 0, 1, 0, 0] }, [0, 0, 0], controls],
    [{ ...base, frames: [] }, [0, 0, 0], controls],
    [{ ...base, frames: [null] }, [0, 0, 0], controls],
    [{ ...base, frames: [{ ...base.frames[0], u: [1, 1, 1, 1] }] }, [0, 0, 0], controls],
    [{ ...base, frames: [{ ...base.frames[0], u: new Float32Array(4).fill(Infinity) }] }, [0, 0, 0], controls],
    [{ ...base, frames: [base.frames[0], base.frames[0]] }, [0, 0, 0], controls],
    [base, [NaN, 0, 0], controls],
    [base, [0, 0, 0], { ...controls, step: 0 }],
    [base, [0, 0, 0], { ...controls, maxSteps: 0 }],
    [base, [0, 0, 0], { ...controls, to: Infinity }],
    [{ ...base, dims: [100_000, 100_000, 100_000] }, [0, 0, 0], controls],
    [{ ...base, frames: [base.frames[0], { ...base.frames[0], time: 0.5 }] }, [0, 0, 0], controls],
  ])
    await assert.rejects(
      tracePathline(field, seed, options),
      (e) => e instanceof RangeError && /errors#sciviz/.test(e.message),
    );
});

test('NOAA daily wind drives a repeatable unsteady trace in physical km and seconds', async () => {
  const bytes = gunzipSync(readFileSync(new URL('../../../examples/assets/sciviz/wind.bin', import.meta.url)));
  const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    size = 49 * 19;
  const radius = 6371,
    radians = Math.PI / 180,
    cosine = Math.cos(42.5 * radians);
  const bounds = [
    -60 * radians * radius * cosine,
    60 * radians * radius * cosine,
    -22.5 * radians * radius,
    22.5 * radians * radius,
    0,
    0,
  ];
  const frames = Array.from({ length: 8 }, (_, day) => {
    // Components of the fixed equirectangular projection, in km/s; no speed-preserving renormalisation.
    const u = Float32Array.from(
      data.subarray(day * 2 * size, (day * 2 + 1) * size),
      (v, k) => ((v / 1000) * cosine) / Math.cos((20 + Math.floor(k / 49) * 2.5) * radians),
    );
    const v = Float32Array.from(data.subarray((day * 2 + 1) * size, (day * 2 + 2) * size), (x) => x / 1000);
    return { time: day * 86400, u, v };
  });
  const grid = { dims: [49, 19, 1], bounds, frames };
  const out = await tracePathline(grid, [0, 0, 0], { from: 0, to: 2 * 86400, step: 600 });
  assert.equal(out.stop, 'end');
  const fine = await tracePathline(grid, [0, 0, 0], { from: 0, to: 2 * 86400, step: 300 });
  assert.equal(fine.stop, 'end');
  close([...out.samples.slice(-4)], [...fine.samples.slice(-4)], 0.02); // 20 m refinement difference, not accuracy of daily means.
  assert.ok(Math.hypot(out.samples.at(-4), out.samples.at(-3)) > 100);
  const again = await tracePathline(grid, [0, 0, 0], { from: 0, to: 2 * 86400, step: 600 });
  assert.deepEqual(out, again);
});

test('flow is optional, has a bounded feature-local binary and stays out of root/fallback', () => {
  const binary = readFileSync(new URL('../dist/flow.wasm', import.meta.url));
  assert.ok(WebAssembly.validate(binary));
  assert.ok(binary.length < 16000, `${binary.length} raw bytes`);
  assert.ok(gzipSync(binary).length < 8000);
  const root = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
  const cpu = readFileSync(new URL('../dist/fallback.js', import.meta.url), 'utf8');
  assert.doesNotMatch(root + cpu, /flow\.wasm|tracePathline/);
});

test('a consuming build emits exactly the lazy flow binary rather than embedding or combining kernels', {
  timeout: 30_000,
}, async () => {
  const entry = fileURLToPath(new URL('../dist/flow.js', import.meta.url));
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      lib: { entry, formats: ['es'] },
      rollupOptions: { external: (id) => !id.startsWith('.') && !id.startsWith('/') && !/^[A-Za-z]:/.test(id) },
    },
  });
  const output = [result].flat().flatMap((r) => r.output),
    assets = output.filter((r) => r.type === 'asset' && r.fileName.endsWith('.wasm'));
  assert.equal(assets.length, 1);
  assert.deepEqual(Buffer.from(assets[0].source), readFileSync(new URL('../dist/flow.wasm', import.meta.url)));
  const js = output
    .filter((r) => r.type === 'chunk')
    .map((r) => r.code)
    .join('\n');
  assert.doesNotMatch(js, /data:application\/wasm|fallback\.wasm/);
  assert.ok(js.includes(assets[0].fileName));
});
