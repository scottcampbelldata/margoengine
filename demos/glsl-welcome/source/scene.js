import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { RawMesh, RawShaders } from '@margoengine/shader/raw';
import { ShaderMaterial } from '@margoengine/shader/glsl-material';

const vertexShader = `#version 300 es
in vec2 position;
out vec2 uv;
void main() {
  uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;
const position = {data: new Float32Array([-1, -1, 3, -1, -1, 3]), type: 'vec2f'};

export async function openWorkspace(canvas, source, force, signal) {
  let engine, raw, current, closed = false, gpuError;
  const close = () => {
    if (closed) return;
    closed = true;
    current?.dispose();
    raw?.dispose();
    engine?.dispose();
  };
  signal.addEventListener('abort', close, {once: true});
  const legacy = force || !navigator.gpu;
  const install = async () => (await import('./compatibility.js')).installCompatibility(force, signal);
  const fit = () => {
    const ratio = Math.min(devicePixelRatio, 2, 1060 / Math.max(1, canvas.clientWidth));
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  };
  const draw = () => {
    signal.throwIfAborted();
    engine.render({delta: 0});
    if (gpuError) throw gpuError;
  };
  const fence = async () => {
    await engine.gpu.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
    if (gpuError) throw gpuError;
  };
  async function apply(fragmentShader, phase) {
    signal.throwIfAborted();
    const material = new ShaderMaterial({
      vertexShader, fragmentShader, uniforms: {phase: {value: phase}},
      depthTest: false, depthWrite: false,
    });
    let materialError;
    material.onError = error => { materialError = error; };
    const candidate = raw.add(new RawMesh({material, attributes: {position}}));
    try {
      fit();
      draw();
      await raw.ready();
      signal.throwIfAborted();
      if (materialError) throw materialError;
      draw();
      await fence();
    } catch (error) {
      candidate.dispose();
      if (!signal.aborted && !gpuError && current) {
        draw();
        await fence();
      }
      throw error;
    }
    current?.dispose();
    current = candidate;
  }

  if (legacy) await install();
  try {
    engine = await autoEngine(canvas, async target => {
      if (!target.gpu) {
        const error = new Error('This shader editor needs WebGPU or Margo’s full WebGL2 compatibility layer.');
        error.code = 'unsupported';
        throw error;
      }
      performance.mark('margo-device-open');
      current = undefined;
      engine = target;
      canvas = target.canvas;
      engine.onError = error => { gpuError = error; };
      gpuError = undefined;
      raw = RawShaders.attach(engine);
      await apply(source, 0);
      performance.mark('margo-material-ready');
    }, {
      backend: legacy ? 'webgpu' : undefined, loadCompat: async () => ({install}),
      signal, startupTimeout: 11000, exactSize: true, antialias: false, capacity: 2,
    });
  } catch (error) {
    close();
    throw error;
  }
  return {
    backend: engine.gpu.adapterInfo?.vendor === 'margo-webgl2' ? 'webgl2' : 'webgpu',
    async phase(value) {
      current.material.uniforms.phase.value = value;
      fit();
      draw();
      await fence();
    },
    apply, close,
  };
}
