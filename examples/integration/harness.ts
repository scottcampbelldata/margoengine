import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { waitForPipelines } from '../../scripts/support/gpu-ready.js';
import { resourceLedger } from './resources.mjs';

export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export type IntegrationScene = {
  tick?: (delta: number) => void;
  assert: () => unknown | Promise<unknown>;
  dispose: () => void | Promise<void>;
  assertDisposed?: () => void;
};
export function expose(id: string, build: (engine: Engine) => Promise<IntegrationScene>) {
  const errors: string[] = [];
  const rejection = (event: PromiseRejectionEvent) => errors.push(String(event.reason));
  addEventListener('unhandledrejection', rejection);
  async function run() {
    // This also completes the browser runner's lazy compatibility installation before instrumenting its device.
    const adapter = await navigator.gpu.requestAdapter();
    check(adapter, 'adapter required');
    const ledger = resourceLedger(GPUDevice.prototype);
    const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
    const engine = await Engine.create(canvas, {
      exactSize: [256, 192],
      backend: 'webgpu',
      signal: AbortSignal.timeout(60_000),
      camera: { position: [0, 3, 8], target: [0, 0.5, 0], near: 0.1, far: 100 },
    });
    engine.onError = (error) => errors.push(String(error));
    engine.scene.background = '#101820';
    const watch = (device: GPUDevice) =>
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    watch(engine.gpu!);
    let scene: IntegrationScene | undefined;
    const draw = async (delta = 0) => {
      scene?.tick?.(delta);
      engine.render({ delta });
      await engine.gpu!.queue.onSubmittedWorkDone();
    };
    const settle = () => waitForPipelines(() => draw(), { timeoutMs: 60_000 });
    const pixels = async () => {
      await settle();
      // Sample in the same task as the render, before the canvas presentation buffer is discarded.
      engine.render({ delta: 0 });
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d')!;
      context.drawImage(canvas, 0, 0);
      return [
        [64, 64],
        [128, 96],
        [192, 128],
        [8, 184],
      ].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
    };
    try {
      scene = await build(engine);
      for (let i = 0; i < 60; i++) await draw(1 / 60);
      const state = await scene.assert();
      const before = await pixels();
      const draws = engine.stats.drawCalls;
      check(draws > 0, `${id}: no scene draws`);
      check(
        before.some((pixel) => pixel.slice(0, 3).some((value, c) => value !== before[3][c])),
        `${id}: all probes equal background`,
      );
      const old = engine.gpu!;
      old.destroy();
      const lost = await old.lost;
      check(lost.reason === 'destroyed', `${id}: loss not observed`);
      // Core's loss handler has started recovery; this joins that operation rather than replacing the scene.
      await engine.rebootDevice();
      check(engine.gpu && engine.gpu !== old, `${id}: device not replaced`);
      watch(engine.gpu);
      const after = await pixels();
      check(engine.stats.drawCalls === draws, `${id}: draw count changed after loss`);
      for (let i = 0; i < before.length; i++)
        for (let c = 0; c < 4; c++)
          check(before[i][c] === after[i][c], `${id}: restored probe ${i}.${c}: ${before[i]} -> ${after[i]}`);
      await scene.assert();
      await scene.dispose();
      scene.assertDisposed?.();
      scene = undefined;
      engine.dispose();
      check(engineRuntime(engine).meshes.size === 0, `${id}: meshes retained`);
      check(engine.scene.plugins.size === 0, `${id}: plugins retained`);
      const resources = ledger.snapshot();
      check(
        resources.created > 0 && resources.live.length === 0,
        `${id}: live allocations ${JSON.stringify(resources)}`,
      );
      check(errors.length === 0, errors.join('\n'));
      return { id, before, after, draws, state, resources, errors, restored: true, disposed: true };
    } finally {
      await scene?.dispose();
      engine.dispose();
      ledger.restore();
    }
  }
  Object.assign(window, { integration: { id, run, errors } });
}
