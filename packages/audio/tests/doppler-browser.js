import { Engine, box } from '@margoengine/core';
import {measureLiveDoppler} from './doppler-live-browser.js';
import { AudioListener, PositionalAudio } from '@margoengine/audio';
import { AudioDoppler } from '@margoengine/audio/doppler';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
function frequency(data, start, end) {
  const crossings = [];
  for (let i = start; i < end - 1; i++)
    if (data[i] <= 0 && data[i + 1] > 0)
      crossings.push(i - data[i] / (data[i + 1] - data[i]));
  assert(crossings.length > 100, 'Tone must have measurable nonzero samples');
  return (crossings.length - 1) * 48000 / (crossings.at(-1) - crossings[0]);
}

export async function runDopplerTests() {
  const reports = [];
  for (const backend of ['webgpu', 'webgl2', 'webgl2-compat']) {
    const compat = backend === 'webgl2-compat' ? await import('@margoengine/webgl2-compat') : null;
    if (compat) await compat.install({ force: true });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    document.body.append(canvas);
    let engine;
    try {
      const fallback = backend === 'webgl2' ? (await import('@margoengine/webgl2-compat/preview')).webglRenderer : undefined;
      engine = await Engine.create(canvas, {
        backend: backend === 'webgl2' ? 'webgl2' : 'webgpu', fallback,
        camera: { position: [0, 0, 0], target: [0, 0, -1] },
      });
      if (compat) {
        const { isCompatDevice } = await import('@margoengine/webgl2-compat/device');
        assert(isCompatDevice(engine.gpu), 'Expected WebGL2 compatibility device');
      } else assert(engine.backend === backend, `Expected ${backend}`);
      const gpuErrors = [];
      engine.gpu?.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
      const mesh = engine.createMesh().setGeometry(box());
      const cases = [];
      for (const [name, sourceVelocity, listenerVelocity, expectedRatio] of [
        ['approach', -34.3, 0, 1 / 0.9],
        ['recede', 34.3, 0, 1 / 1.1],
        ['listener-approach', 0, 34.3, 1.1],
        ['co-motion', 34.3, 34.3, 1],
        ['stationary', 0, 0, 1],
      ]) {
        const context = new OfflineAudioContext(2, 24000, 48000);
        const listener = AudioListener.attach(engine, { context, smoothing: 0, autoResume: false });
        try {
          engine.camera.position = [0, 0, 0];
          mesh.setPosition([0, 0, -20]);
          const sound = new PositionalAudio(listener, { mesh, rolloffFactor: 0, panningModel: 'equalpower' });
          const buffer = context.createBuffer(1, 48000, 48000);
          buffer.getChannelData(0).forEach((_, i, a) => { a[i] = 0.3 * Math.sin(2 * Math.PI * 1000 * i / 48000); });
          sound.setBuffer(buffer).play();
          const doppler = new AudioDoppler(sound);
          engine.render();
          const suspended = context.suspend(0.128);
          const rendered = context.startRendering();
          await suspended;
          const dt = context.currentTime;
          mesh.setPosition([0, 0, -20 - sourceVelocity * dt]);
          engine.camera.position = [0, 0, -listenerVelocity * dt];
          engine.camera.target = [0, 0, -100];
          engine.render();
          assert(Math.abs(doppler.ratio - expectedRatio) < 2e-7, `${name}: wrong transform-derived ratio ${doppler.ratio}`);
          await context.resume();
          const pcm = await rendered;
          const data = pcm.getChannelData(0);
          assert(data.every(Number.isFinite), 'Nonfinite samples');
          const measuredHz = frequency(data, 9600, 21600);
          // Linear crossing interpolation of a sampled sine at these rates has <0.1 Hz error.
          assert(Math.abs(measuredHz - expectedRatio * 1000) < 0.1, `${name}: ${measuredHz} Hz`);
          cases.push({ name, ratio: doppler.ratio, expectedHz: expectedRatio * 1000, measuredHz });
        } finally { engine.removePlugin(listener.name); }
      }
      assert(gpuErrors.length === 0, `GPU errors: ${gpuErrors}`);
      reports.push({ backend, cases, gpuErrors });
    } finally {
      engine?.dispose();
      canvas.remove();
      compat?.uninstall();
    }
  }
  return { fixture: 'Generated 1 kHz sine and engine mesh motion, stand-ins', reports, live: await measureLiveDoppler() };
}
