import { EngineKernel } from '@margoengine/core';

const canvas = document.querySelector('#glasshouse');
const forced = new URLSearchParams(location.search).get('backend') === 'webgl2';

export async function start(settings) {
  const { signal } = settings;
  if (forced || !navigator.gpu) {
    const reason = new Error('Live spectral tracing requires native WebGPU on this build; see https://margoengine.com/errors#webgpu');
    throw Object.assign(reason, { code: 'unsupported' });
  }
  const scene = import('./scene.js');
  const width = Math.max(1, Math.min(1280, Math.round(canvas.parentElement.clientWidth * devicePixelRatio)));
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(width * 9 / 16));
  const options = { backend: 'webgpu', exactSize: true, signal, startupTimeout: 2500,
    camera: { position: [2.13, 1.23, 3.75], target: [.03, .48, -.13], near: .08, far: 30, fov: 27 } };
  const device = EngineKernel.create(canvas, options).then((engine) => {
    if (signal.aborted) { engine.dispose(); signal.throwIfAborted(); }
    signal.addEventListener('abort', () => engine.dispose(), { once: true });
    performance.mark('glasshouse-device-ready');
    return engine;
  });
  const [engine, exhibit] = await Promise.all([device, scene]);
  return exhibit.open(engine, settings);
}
