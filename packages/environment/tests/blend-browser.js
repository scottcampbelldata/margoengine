// Real-GPU checks for @margoengine/environment/blend: the blended source cube, prefiltered mips and SH equal the
// weighted sum of the two sources' own (exact up to rgba16float rounding), with each source's rotation and intensity,
// and the blend comes back after a device restore.
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Environment } from '../dist/index.js';
import { EnvironmentBlend, rotateSH } from '../dist/blend.js';
import {
  assert,
  cubeTexel,
  equirect,
  faceDirection,
  hardware,
  openDevice,
  readBuffer,
  readTexture,
  rotateY,
} from './gpu-read.js';

// rgba16float keeps 11 significant bits: half an ulp is 2^-11 relative; two rounded inputs and one rounded output.
const HALF = 3 * 2 ** -11;
const near = (got, want) => Math.abs(got - want) <= HALF * Math.max(1, Math.abs(want));
const day = (d) => [1 + d[0], 1 + d[1], 1 - d[2]].map((v) => v * 1.5);
const night = (d) => [0.2 + 0.1 * d[1], 0.3, 0.6 + 0.4 * Math.max(0, d[1])];
const small = { size: 32, specularSize: 32, specularMips: 4, samples: 64, brdfSize: 16, brdfSamples: 64 };

async function compareMix(device, blend, a, b, wa, wb, label) {
  let worst = 0;
  for (const [key, mips] of [
    ['cubeTexture', blend.environment.cubeTexture.mipLevelCount],
    ['specularTexture', blend.environment.specularMips],
  ])
    for (let mip = 0; mip < mips; mip++) {
      const [o, x, y] = await Promise.all([
        readTexture(device, blend.environment[key], mip),
        wa ? readTexture(device, a[key], mip) : null,
        wb ? readTexture(device, b[key], mip) : null,
      ]);
      for (let i = 0; i < o.data.length; i += 4)
        for (let c = 0; c < 3; c++) {
          // A zero-weight source may have another size: it is not read.
          const want = (wa ? wa * x.data[i + c] : 0) + (wb ? wb * y.data[i + c] : 0);
          worst = Math.max(worst, Math.abs(o.data[i + c] - want) / Math.max(1, Math.abs(want)));
          assert(near(o.data[i + c], want), `${label} ${key} mip ${mip} texel ${i / 4}: ${o.data[i + c]} vs ${want}`);
        }
    }
  return worst;
}

window.runTests = async () => {
  const { adapter, device, finish } = await openDevice();
  const report = { checks: [] };
  const a = await Environment.create(device, equirect(64, 32, day), small);
  const b = await Environment.create(device, equirect(64, 32, night), small);

  // 1. Same sizes, no rotation: every cube and specular mip and the SH are the weighted sum of the sources'.
  {
    const blend = await EnvironmentBlend.create(device, a, b, { t: 0.25 });
    const out = blend.environment;
    assert(out.size === 32 && out.specularSize === 32 && out.specularMips === 4, 'blend sizes follow the sources');
    const version = out.version;
    report.mixError = await compareMix(device, blend, a, b, 0.75, 0.25, 't 0.25');
    for (const key of ['irradiance', 'radiance'])
      for (let k = 0; k < 27; k++) {
        const want = 0.75 * a.sh[key][k] + 0.25 * b.sh[key][k];
        assert(Math.abs(out.sh[key][k] - want) <= 1e-5 * Math.max(1, Math.abs(want)), `SH ${key} ${k}`);
      }
    const gpu = await readBuffer(device, out.shBuffer, 512);
    for (let k = 0; k < 9; k++)
      for (let c = 0; c < 3; c++) {
        assert(Math.abs(gpu[k * 4 + c] - out.sh.irradiance[k * 3 + c]) < 1e-6, 'GPU irradiance SH');
        assert(Math.abs(gpu[64 + k * 4 + c] - out.sh.radiance[k * 3 + c]) < 1e-6, 'GPU radiance SH');
      }
    blend.t = 0;
    await compareMix(device, blend, a, b, 1, 0, 't 0');
    blend.t = 1;
    await compareMix(device, blend, a, b, 0, 1, 't 1');
    assert(out.version === version, 'reblending replaced the environment resources (bind groups would go stale)');
    let threw = false;
    try {
      blend.t = 1.5;
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assert(threw && blend.t === 1, 't outside 0..1 must throw RangeError and keep the old value');
    blend.dispose();
    assert(out.disposed && !a.disposed && !b.disposed, 'dispose frees the blend output only');
    report.checks.push('t 0, 0.25, 1: cube and specular mips and SH equal the weighted sources within rgba16float rounding');
  }

  // 2. Rotation and intensity: at t 1 a source turned a quarter turn with intensity 2 lands texel for texel in the
  // output (a quarter turn about +Y maps cube texel centres onto texel centres) and its SH turns with it.
  {
    b.rotation = Math.PI / 2;
    b.intensity = 2;
    const blend = await EnvironmentBlend.create(device, a, b, { t: 1 });
    const out = blend.environment;
    const [o, src] = await Promise.all([readTexture(device, out.cubeTexture), readTexture(device, b.cubeTexture)]);
    let worst = 0;
    for (let face = 0; face < 6; face++)
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) {
          const d = faceDirection(face, ((x + 0.5) / 32) * 2 - 1, ((y + 0.5) / 32) * 2 - 1);
          const [f, tx, ty] = cubeTexel(rotateY(d, Math.PI / 2), 32);
          const got = o.at(face, x, y),
            want = src.at(f, tx, ty);
          for (let c = 0; c < 3; c++) {
            worst = Math.max(worst, Math.abs(got[c] - 2 * want[c]) / Math.max(1, 2 * want[c]));
            assert(near(got[c], 2 * want[c]), `rotated face ${face} (${x}, ${y}): ${got[c]} vs ${2 * want[c]}`);
          }
        }
    for (const n of [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
      [0.48, -0.6, 0.64],
    ]) {
      const got = out.irradianceAt(n),
        want = b.irradianceAt(n);
      for (let c = 0; c < 3; c++)
        assert(Math.abs(got[c] - want[c]) <= 1e-5 * Math.max(1, want[c]), `rotated irradiance at ${n}: ${got} vs ${want}`);
    }
    const check = rotateSH(b.sh.irradiance, Math.PI / 2, 2);
    for (let k = 0; k < 27; k++) assert(Math.abs(out.sh.irradiance[k] - check[k]) < 1e-6, 'rotateSH matches the blend');
    report.rotationError = worst;
    b.rotation = 0;
    b.intensity = 1;
    blend.update();
    await compareMix(device, blend, a, b, 0, 1, 'after update');
    blend.dispose();
    report.checks.push('rotation and intensity: a quarter-turned source with intensity 2 matches texel for texel; SH turns with it');
  }

  // 3. Different sizes: the output takes the larger, reads the smaller at the matching level, and each source end
  // still matches the larger source exactly.
  {
    const c = await Environment.create(device, equirect(32, 16, night), {
      ...small,
      size: 16,
      specularSize: 16,
      specularMips: 3,
    });
    const blend = await EnvironmentBlend.create(device, a, c, { t: 0 });
    assert(blend.environment.size === 32 && blend.environment.specularMips === 4, 'blend takes the larger source');
    const [o, x] = await Promise.all([
      readTexture(device, blend.environment.specularTexture, 0),
      readTexture(device, a.specularTexture, 0),
    ]);
    for (let i = 0; i < o.data.length; i++) if (i % 4 !== 3) assert(near(o.data[i], x.data[i]), 'mixed sizes, t 0');
    blend.set(c, a, 1);
    await compareMix(device, blend, c, a, 0, 1, 'set(c, a, 1)');
    blend.dispose();
    c.dispose();
    report.checks.push('mixed sizes: the output takes the larger source; set() swaps sources');
  }
  await finish();
  a.dispose();
  b.dispose();
  device.destroy();

  // 4. Engine: attach as a plugin, light a scene with it, and blend again after a device restore.
  {
    const canvas = document.querySelector('#scene');
    const engine = await Engine.create(canvas, { backend: 'webgpu' });
    const runtime = engineRuntime(engine);
    const from = await Environment.attach(engine, equirect(64, 32, day), { ...small, name: 'day' });
    const to = await Environment.attach(engine, equirect(64, 32, night), { ...small, name: 'night' });
    const blend = await EnvironmentBlend.attach(engine, from, to, { t: 0.5 });
    engine.render();
    const previous = runtime.gpu;
    await engine.rebootDevice();
    assert(runtime.gpu !== previous, 'device was not replaced');
    await Promise.all([from.restore(engine), to.restore(engine), blend.environment.restore(engine)]);
    assert(blend.environment.device === runtime.gpu, 'blend output not restored');
    runtime.gpu.pushErrorScope('validation');
    await compareMix(runtime.gpu, blend, from, to, 0.5, 0.5, 'after restore');
    blend.t = 0.75;
    await compareMix(runtime.gpu, blend, from, to, 0.25, 0.75, 'after restore, t 0.75');
    await runtime.gpu.queue.onSubmittedWorkDone();
    const validation = await runtime.gpu.popErrorScope();
    assert(!validation, `validation after restore: ${validation?.message}`);
    engine.dispose();
    assert(blend.disposed && blend.environment.disposed, 'engine.dispose disposes the blend');
    report.checks.push('engine plugin: device restore rebuilds the sources and the output and blends again');
  }
  report.hardware = hardware(adapter);
  return report;
};
