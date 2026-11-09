import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { fault } from '../../shared/errors.js';
import { fullscreen } from '../../shared/gpu.js';
import { Transitions } from './index.js';

/** Cancellation for asynchronous shader validation. No resources are attached after cancellation. */
export interface CustomTransitionOptions {
  /** Cancels compilation waiting and attachment. Default: no signal. */
  signal?: AbortSignal;
}

class CustomTransition extends Transitions {
  constructor(code: string) {
    super();
    this.shaderCode = code;
  }
}

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

/**
 * Validates and attaches a custom WGSL transition. Supply
 * `fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f` plus optional helpers.
 * `sample(image,uv)` performs clamped nearest sampling. Endpoints always return the exact input image.
 * Call the returned `start('wipe', seconds)` to begin; built-in kind and displacement do not affect this shader.
 * @throws TypeError for empty/non-string WGSL or source longer than 65,536 UTF-16 code units.
 * @throws MargoError `unsupported` on WebGL2, `failed` for invalid WGSL or incompatible bindings.
 */
export async function createCustomTransition(
  engine: EngineKernel,
  wgsl: string,
  options: CustomTransitionOptions = {},
): Promise<Transitions> {
  const runtime = engineRuntime(engine);
  const device = runtime.gpu;
  if (!device) throw fault('unsupported', 'Custom transitions require WebGPU; select a WebGPU engine');
  if (typeof wgsl !== 'string' || !wgsl.trim() || wgsl.length > 65_536)
    throw new TypeError('Custom transition needs 1..65536 WGSL code units; supply a transition function');
  options.signal?.throwIfAborted();
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
 if(settings.x<=0.0){return sample(before,i.uv);}
 if(settings.x>=1.0){return sample(after,i.uv);}
 return transition(before,after,i.uv,settings.x);
}`;
  // Pop the scope immediately, before any await, so unrelated caller work cannot enter it.
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code });
  const validation = device.popErrorScope();
  const info = await wait(module.getCompilationInfo(), options.signal);
  const error = await wait(validation, options.signal);
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
      options.signal,
    );
  } catch (cause) {
    options.signal?.throwIfAborted();
    throw Object.assign(
      fault('failed', 'Custom transition interface failed; use the documented function and bindings'),
      { cause },
    );
  }
  options.signal?.throwIfAborted();
  // The caller may dispose the engine or lose the device while compilation runs.
  if (runtime.gpu !== device || runtime.disposed)
    throw fault('state', 'Custom transition engine changed during compilation; create it on a live engine');
  const effect = new CustomTransition(code);
  runtime.use(effect);
  return effect;
}
