import type { PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** What `setCapture` takes: gltf-pro's `PBRCapture`. */
export interface CaptureHook {
  readonly targets: readonly GPUColorTargetState[];
  declarations(code: string): string;
  begin(): GPURenderPassEncoder;
}
/** What a capture draws: a gltf-pro model or a materials mesh. */
export interface CaptureModel<Hook extends CaptureHook> {
  setCapture(hook: Hook): () => void;
  draw(context: Context, mode: 'capture', color: GPUTextureView, depth: GPUTextureView): void;
}
/** Lets `hook` capture `model` alongside any other effect; returns a remover. */
export function shareCapture<Hook extends CaptureHook>(model: CaptureModel<Hook>, hook: Hook): () => void;
/** Adds `model` to an effect's `models` once, sharing `hook`, until it is removed or disposed; returns the remover. */
export function captureModel<Hook extends CaptureHook, Model extends CaptureModel<Hook> & { onDispose(callback: () => void): () => void }>(
  models: Map<Model, () => void>,
  model: Model,
  hook: Hook,
): () => void;
/** Draws `model`'s capture into `hook`'s targets (`hook.begin()`'s pass). */
export function drawCapture<Hook extends CaptureHook>(model: CaptureModel<Hook>, hook: Hook, c: Context): void;
