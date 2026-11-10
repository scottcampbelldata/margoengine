import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Environment, EnvironmentBackground, EnvironmentLighting, parseHDR } from '../dist/index.js';
import { loadPrefilteredEnvironment, savePrefilteredEnvironment } from '../dist/prefiltered.js';
import { assert, openDevice, readTexture, readBuffer, hardware } from './gpu-read.js';

async function compare(device, a, b) {
  for (const key of ['cubeTexture', 'specularTexture'])
    for (let m = 0; m < a[key].mipLevelCount; m++) {
      const x = await readTexture(device, a[key], m),
        y = await readTexture(device, b[key], m);
      assert(
        x.data.every((v, i) => v === y.data[i]),
        `${key} mip ${m} is lossless`,
      );
    }
  for (const key of ['shBuffer', 'brdfLut']) {
    const x = await readBuffer(device, a[key], a[key].size),
      y = await readBuffer(device, b[key], b[key].size);
    const xb = new Uint32Array(x.buffer),
      yb = new Uint32Array(y.buffer);
    assert(
      xb.every((v, i) => v === yb[i]),
      `${key} is bit exact`,
    );
  }
}

window.runTests = async () => {
  const { adapter, device, finish } = await openDevice();
  // Greg Zaal / Poly Haven, Venice Sunset, CC0. Source and hash: fixtures/NOTICE.md.
  const image = parseHDR(await (await fetch('./fixtures/venice_sunset_1k.hdr')).arrayBuffer());
  const a = await Environment.create(device, image, {
    size: 16,
    specularSize: 16,
    specularMips: 4,
    samples: 32,
    brdfSize: 16,
    brdfSamples: 64,
    rotation: 0.25,
    intensity: 1.5,
  });
  const file = await savePrefilteredEnvironment(a);
  const b = await loadPrefilteredEnvironment(device, file);
  await compare(device, a, b);
  assert(b.rotation === a.rotation && b.intensity === a.intensity, 'saved transform');
  const abort = new AbortController();
  abort.abort();
  let cancelled = false;
  try {
    await savePrefilteredEnvironment(a, { signal: abort.signal });
  } catch (error) {
    cancelled = error.name === 'AbortError';
  }
  assert(cancelled, 'cancelled save');
  const url = URL.createObjectURL(new Blob([file]));
  const fromURL = await loadPrefilteredEnvironment(device, url, { intensity: 2, rotation: 0.5 });
  URL.revokeObjectURL(url);
  assert(fromURL.rotation === 0.5 && fromURL.intensity === 2, 'URL loading and overrides');
  fromURL.dispose();
  await finish();
  // Real rendering uses both Environment consumers; exact pixels before/after a native device replacement.
  const canvas = document.querySelector('canvas');
  const engine = await Engine.create(canvas, { backend: 'webgpu', antialias: false });
  const env = await loadPrefilteredEnvironment(engine, file);
  engine.use(env);
  EnvironmentBackground.attach(engine, env, { mode: 'cube' });
  EnvironmentLighting.attach(engine, env);
  engine.render();
  const version = env.version;
  await engine.rebootDevice();
  await env.restore(engine);
  assert(env.version === version + 1 && env.device === engineRuntime(engine).gpu, 'restored on real engine device');
  engine.render();
  const savedAgain = await savePrefilteredEnvironment(env);
  assert(
    savedAgain.length === file.length && savedAgain.every((v, i) => v === file[i]),
    'restore retains every baked bit',
  );
  engine.dispose();
  a.dispose();
  b.dispose();
  device.destroy();
  return {
    checks: [
      'real HDR cube, every specular mip, SH and LUT are lossless',
      'URL, overrides, cancellation',
      'background and IBL attach, device replacement reuploads without filtering',
    ],
    fileBytes: file.length,
    hardware: hardware(adapter),
  };
};
