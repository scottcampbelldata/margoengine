import { Engine, box } from '@margoengine/core';
import { AudioListener, PositionalAudio } from '@margoengine/audio';
import { AudioOcclusion } from '@margoengine/audio/occlusion';

const assert = (value, message) => {
  if (!value) throw new Error(message);
};
const rms = (data) =>
  Math.sqrt(data.subarray(2400).reduce((sum, value) => sum + value * value, 0) / (data.length - 2400));

export async function runOcclusionTests() {
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
        backend: backend === 'webgl2' ? 'webgl2' : 'webgpu',
        fallback,
        camera: { position: [0, 0, 4], target: [0, 0, 0] },
      });
      if (compat) {
        const { isCompatDevice } = await import('@margoengine/webgl2-compat/device');
        assert(isCompatDevice(engine.gpu), 'Expected a real WebGL2 compatibility device');
      } else assert(engine.backend === backend, `Expected ${backend}, got ${engine.backend}`);
      const gpuErrors = [];
      engine.gpu?.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
      const wall = engine.createMesh().setGeometry(box()).setPosition([0, 0, 2]).setScale([4, 4, 0.1]);
      const mesh = engine.createMesh().setGeometry(box());
      async function render(frequency, blocked) {
        const context = new OfflineAudioContext(2, 7200, 48000);
        const listener = AudioListener.attach(engine, { context, autoResume: false });
        try {
          const buffer = context.createBuffer(1, 7200, 48000);
          buffer.getChannelData(0).forEach((_, i, data) => {
            data[i] = 0.5 * Math.sin((2 * Math.PI * frequency * i) / 48000);
          });
          const sound = new PositionalAudio(listener, { mesh, refDistance: 10, panningModel: 'equalpower' });
          const occlusion = await AudioOcclusion.create(sound);
          wall.visible = blocked;
          engine.render();
          assert(occlusion.blocked === (blocked ? 1 : 0), `Wall coverage ${occlusion.blocked}`);
          assert(sound.volume === 1, 'Occlusion changed user volume');
          sound.setBuffer(buffer).play();
          const audio = await context.startRendering();
          assert(audio.getChannelData(0).every(Number.isFinite), 'Nonfinite rendered audio');
          return rms(audio.getChannelData(0));
        } finally {
          engine.removePlugin(listener.name);
        }
      }
      const clearHigh = await render(2000, false),
        blockedHigh = await render(2000, true);
      const clearLow = await render(100, false),
        blockedLow = await render(100, true);
      const highRatio = blockedHigh / clearHigh,
        lowRatio = blockedLow / clearLow;
      assert(clearHigh > 0.1 && clearLow > 0.1, 'Clear audio is inaudible');
      // Bilinear Butterworth magnitude from the Web Audio biquad coefficients, times the 0.25 gain.
      // 0.0002 absolute ratio allows float32 rendering and the finite RMS window, not acoustic-model error.
      const expected = (frequency) =>
        0.25 / Math.sqrt(1 + (Math.tan((Math.PI * frequency) / 48000) / Math.tan((Math.PI * 800) / 48000)) ** 4);
      assert(Math.abs(highRatio - expected(2000)) < 0.0002, `High frequency obstruction ratio ${highRatio}`);
      assert(Math.abs(lowRatio - expected(100)) < 0.0002, `Low frequency attenuation ratio ${lowRatio}`);
      assert(gpuErrors.length === 0, `GPU validation errors: ${gpuErrors}`);
      reports.push({ backend, clearHigh, blockedHigh, clearLow, blockedLow, highRatio, lowRatio, gpuErrors });
    } finally {
      engine?.dispose();
      canvas.remove();
      compat?.uninstall();
    }
  }
  return { fixture: 'Generated sine waves and engine box geometry, stand-ins', reports };
}
