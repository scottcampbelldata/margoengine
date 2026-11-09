import { Engine } from '@margoengine/core';
import { AudioListener } from '@margoengine/audio';
import { AudioEventContainer } from '@margoengine/audio/events';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
function inspect(data, offset) {
  const start = Math.round((offset + 0.008) * 48000), end = Math.round((offset + 0.032) * 48000);
  let sum = 0;
  const crossings = [];
  for (let i = start; i < end; i++) {
    sum += data[i] ** 2;
    if (i + 1 < end && data[i] <= 0 && data[i + 1] > 0)
      crossings.push(i - data[i] / (data[i + 1] - data[i]));
  }
  assert(crossings.length > 10, 'Expected audible tone');
  return { rms: Math.sqrt(sum / (end - start)), hz: (crossings.length - 1) * 48000 / (crossings.at(-1) - crossings[0]) };
}

export async function runEventTests() {
  const reports = [];
  for (const backend of ['webgpu', 'webgl2', 'webgl2-compat']) {
    const compat = backend === 'webgl2-compat' ? await import('@margoengine/webgl2-compat') : null;
    if (compat) await compat.install({ force: true });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    document.body.append(canvas);
    let engine;
    try {
      const fallback = backend === 'webgl2' ? (await import('@margoengine/webgl')).webglRenderer : undefined;
      engine = await Engine.create(canvas, {
        backend: backend === 'webgl2' ? 'webgl2' : 'webgpu', fallback,
        camera: { position: [0, 0, 0], target: [0, 0, -1] },
      });
      if (compat) {
        const { isCompatDevice } = await import('@margoengine/webgl2-compat/device');
        assert(isCompatDevice(engine.gpu), 'Expected compatibility device');
      } else assert(engine.backend === backend, `Expected ${backend}`);
      const gpuErrors = [];
      engine.gpu?.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
      const context = new OfflineAudioContext(2, 24000, 48000);
      const listener = AudioListener.attach(engine, { context, smoothing: 0, autoResume: false });
      const buffers = [1000, 1500].map(hz => {
        const buffer = context.createBuffer(1, 3840, 48000);
        buffer.getChannelData(0).forEach((_, i, a) => { a[i] = 0.25 * Math.sin(2 * Math.PI * hz * i / 48000); });
        return buffer;
      });
      const container = new AudioEventContainer(listener, buffers, {
        mode: 'sequence', cooldown: 0.1, volume: [0.5, 0.5], pitch: [1200, 1200],
        voiceOptions: {rolloffFactor: 0, panningModel:'equalpower'},
      });
      const position = [0, 0, -1];
      engine.render();
      assert(container.play(position).buffer === buffers[0], 'Sequence begins with first buffer');
      assert(container.play(position) === null, 'Cooldown rejects second play');
      const firstPause = context.suspend(0.128), secondPause = context.suspend(0.256);
      const rendered = context.startRendering();
      await firstPause;
      assert(container.play(position).buffer === buffers[1], 'Sequence advances to second buffer');
      engine.render();
      await context.resume();
      await secondPause;
      assert(container.play(position).buffer === buffers[0], 'Sequence wraps to first buffer');
      engine.render();
      await context.resume();
      const pcm = await rendered;
      const data = pcm.getChannelData(0);
      assert(data.every(Number.isFinite), 'Nonfinite audio');
      const tones = [0, 0.128, 0.256].map(offset => inspect(data, offset));
      for (const [i, tone] of tones.entries()) {
        // Integer-cycle windows at these sample rates make RMS exact apart from float32 rounding.
        assert(Math.abs(tone.rms - 0.0625) < 1e-6, `Event volume: ${tone.rms}`);
        assert(Math.abs(tone.hz - (i === 1 ? 3000 : 2000)) < 0.1, `Event pitch: ${tone.hz}`);
      }
      assert(data.subarray(3072, 4608).every(value => Math.abs(value) < 1e-7), 'Cooldown gap must be silent');
      // Also exercise actual random-buffer playback with deterministic draws, independently of sequence state.
      const randomContext = new OfflineAudioContext(2, 4800, 48000);
      const randomListener = new AudioListener({context: randomContext, smoothing:0});
      const random = new AudioEventContainer(randomListener, buffers, {
        random: () => 0.99, volume:[0.5,0.5], pitch:[1200,1200],
        voiceOptions:{rolloffFactor:0,panningModel:'equalpower'},
      });
      random.play(position);
      assert(random.lastIndex === 1, 'Random draw selects second buffer');
      const randomTone = inspect((await randomContext.startRendering()).getChannelData(0), 0);
      assert(Math.abs(randomTone.hz - 3000) < 0.1 && Math.abs(randomTone.rms - 0.0625) < 1e-6, 'Random PCM');
      randomListener.dispose();
      container.dispose();
      assert(gpuErrors.length === 0, `GPU errors: ${gpuErrors}`);
      reports.push({backend, tones, randomTone, cooldownGap:'silent', gpuErrors});
    } finally {
      engine?.dispose();
      canvas.remove();
      compat?.uninstall();
    }
  }
  return {fixture:'Generated tones and event triggers, stand-ins', reports};
}
