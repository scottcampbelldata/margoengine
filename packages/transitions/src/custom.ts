import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { customCode } from './custom-code.js';
import { Transitions } from './index.js';

/** Cancellation for asynchronous shader validation. No resources are attached after cancellation. */
export interface CustomTransitionOptions {
  /** Cancels compilation waiting and attachment. Default: no signal. */
  signal?: AbortSignal;
}

class CustomTransition extends Transitions {
  override readonly name = 'transitions:custom';
  protected override readonly captureLayer = 2;
  constructor(code: string) {
    super();
    this.shaderCode = code;
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
  const code = await customCode(engine, wgsl, options.signal);
  const effect = new CustomTransition(code);
  runtime.use(effect);
  return effect;
}
