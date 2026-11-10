import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { PostStack } from '@margoengine/post/stack';
import { waitForPipelines } from '../../scripts/support/gpu-ready.js';
import type { FXAA } from '@margoengine/post';
import type { TAA } from '@margoengine/taa';
import type { DOF } from '@margoengine/dof';
import type { Tonemap } from '@margoengine/tonemap';

const SIZE = 96;
const requireValue = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
type Scene = { id: string; members: string[] };
type Constructors = { post?: typeof FXAA; taa?: typeof TAA; dof?: typeof DOF; tonemap?: typeof Tonemap };

export function expose(scene: Scene, constructors: Constructors) {
  const errors: string[] = [];
  addEventListener('unhandledrejection', (event) => errors.push(`unhandled rejection: ${String(event.reason)}`));
  addEventListener('error', (event) => errors.push(event.message));
  async function run(samples: 1 | 4) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    canvas.style.cssText = `width:${SIZE}px;height:${SIZE}px`;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      exactSize: samples === 1 ? [SIZE, SIZE] : false,
      camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45, near: 0.1, far: 50 },
    });
    const runtime = engineRuntime(engine),
      device = runtime.gpu!;
    let scoped = false;
    try {
      requireValue(runtime.renderTarget?.samples === samples, `Expected ${samples}x MSAA`);
      engine.onError = (error) => errors.push(String(error));
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      device.pushErrorScope('validation');
      scoped = true;
      runtime.lighting.direction.set([0, 0, 1, 0]);
      // Half intensity stays below the neutral curve's highlight desaturation knee.
      runtime.lighting.radiance.set([0, 0, 0, 0.5]);
      engine.scene.background = '#000000';
      const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
      for (let i = 0; i < 4; i++)
        engine
          .createMesh()
          .setGeometry(box(1.1, 1.1, 0.2))
          .setPosition([i % 2 ? 0.7 : -0.7, i < 2 ? 0.7 : -0.7, 0])
          .setMaterial(new PbrMaterial({ color: colors[i], roughness: 1 }));
      const effects = [];
      if (constructors.dof) effects.push(new constructors.dof({ focalDistance: 4.9, maxRadius: 1 }));
      if (constructors.tonemap) effects.push(new constructors.tonemap({ curve: 'linear' }));
      if (constructors.post) effects.push(new constructors.post());
      const stack = effects.length ? PostStack.attach(engine, effects) : undefined;
      if (constructors.taa)
        engine.use(new constructors.taa({ historyWeight: 0, ...(stack ? { depth: () => stack.depthTexture } : {}) }));
      await waitForPipelines(
        async () => {
          engine.render({ delta: 0 });
          await device.queue.onSubmittedWorkDone();
        },
        { timeoutMs: 60_000 },
      );
      // Capture in the render task, before a WebGL drawing buffer may be discarded.
      engine.render({ delta: 0 });
      const bitmap = await createImageBitmap(canvas);
      const copy = new OffscreenCanvas(SIZE, SIZE),
        ctx = copy.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = [
        [32, 32],
        [64, 32],
        [32, 64],
        [64, 64],
        [2, 2],
        [93, 93],
      ].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
      await device.queue.onSubmittedWorkDone();
      const validation = await device.popErrorScope();
      scoped = false;
      requireValue(!validation, validation?.message ?? '');
      requireValue(errors.length === 0, errors.join('\n'));
      requireValue(engine.stats.drawCalls === 4, `Expected 4 core batches, got ${engine.stats.drawCalls}`);
      for (let i = 0; i < 4; i++) {
        const expected = [i === 0 || i === 3, i === 1 || i === 3, i === 2];
        for (let c = 0; c < 3; c++)
          requireValue(Math.abs(pixels[i][c] - (expected[c] ? 188 : 0)) <= 1, `probe ${i}, channel ${c}: ${pixels[i]}`);
        requireValue(pixels[i][3] === 255, `probe ${i} alpha: ${pixels[i]}`);
      }
      for (let i = 4; i < 6; i++)
        requireValue(
          pixels[i].every((c, j) => c === (j === 3 ? 255 : 0)),
          `clear probe ${i}: ${pixels[i]}`,
        );
      return { ...scene, samples, pixels, draws: engine.stats.drawCalls, errors: [...errors] };
    } finally {
      if (scoped) {
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
      }
      engine.dispose();
      canvas.remove();
    }
  }
  Object.assign(window, { composition: { ...scene, run, errors } });
}
