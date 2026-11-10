import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { fault } from '../../shared/errors.js';
import { fullscreen } from '../../shared/gpu.js';
async function wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function customCode(engine: EngineKernel, wgsl: string, signal?: AbortSignal): Promise<string> {
  const runtime = engineRuntime(engine);
  const device = runtime.gpu;
  if (!device) throw fault('unsupported', 'Custom transitions require WebGPU; select a WebGPU engine');
  if (typeof wgsl !== 'string' || !wgsl.trim() || wgsl.length > 65_536)
    throw new TypeError('Custom transition needs 1..65536 WGSL code units; supply a transition function');
  signal?.throwIfAborted();
  const code = `${fullscreen}
@group(0) @binding(0) var<uniform> settings:vec4f;
@group(0) @binding(1) var before:texture_2d<f32>;
@group(0) @binding(2) var after:texture_2d<f32>;
fn sample(t:texture_2d<f32>,uv:vec2f)->vec4f {
 let size=vec2i(textureDimensions(t));
 return textureLoad(t,clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1),0);
}
${wgsl}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let uv=i.position.xy/vec2f(textureDimensions(after));
 if(settings.x<=0.0){return sample(before,uv);}
 if(settings.x>=1.0){return sample(after,uv);}
 return transition(before,after,uv,settings.x);
}`;
  // Pop the scope immediately, before any await, so unrelated caller work cannot enter it.
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code });
  const validation = device.popErrorScope();
  const info = await wait(module.getCompilationInfo(), signal);
  const error = await wait(validation, signal);
  const diagnostic = info.messages.find((message) => message.type === 'error');
  if (diagnostic || error)
    throw fault(
      'failed',
      `Custom transition WGSL failed; correct the function: ${diagnostic?.message ?? error?.message}`,
    );
  const layout = device.createPipelineLayout({
    bindGroupLayouts: [
      device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
          { binding: 1, visibility: 2, texture: { sampleType: 'float' } },
          { binding: 2, visibility: 2, texture: { sampleType: 'float' } },
        ],
      }),
    ],
  });
  try {
    await wait(
      device.createRenderPipelineAsync({
        layout,
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] },
      }),
      signal,
    );
  } catch (cause) {
    signal?.throwIfAborted();
    throw Object.assign(
      fault('failed', 'Custom transition interface failed; use the documented function and bindings'),
      { cause },
    );
  }
  signal?.throwIfAborted();
  // The caller may dispose the engine or lose the device while compilation runs.
  if (runtime.gpu !== device || runtime.disposed)
    throw fault('state', 'Custom transition engine changed during compilation; create it on a live engine');
  return code;
}
