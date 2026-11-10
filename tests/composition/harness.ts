import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { PostStack } from '@margoengine/post/stack';
import { DepthTexture } from '@margoengine/post/depth';
import type { PassContext } from '@margoengine/core/extension';
import { readTexture } from './readback.ts';
import { installXRProbe } from './xr.ts';
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
type Constructors = {
  post?: typeof FXAA;
  taa?: typeof TAA;
  dof?: typeof DOF;
  tonemap?: typeof Tonemap;
  shadows?: typeof import('@margoengine/shadows').Shadows;
  clustered?: typeof import('@margoengine/clustered').Clustered;
  toon?: typeof import('@margoengine/toon').Toon;
  transitions?: typeof import('@margoengine/transitions').Transitions;
  lines?: Pick<typeof import('@margoengine/lines'), 'Lines' | 'Line'>;
  points?: Pick<typeof import('@margoengine/points'), 'PointsPlugin' | 'PointCloud'>;
  labels?: typeof import('@margoengine/labels').LabelRenderer;
  text?: Pick<typeof import('@margoengine/text'), 'TextRenderer' | 'Text'>;
  oit?: { OIT: typeof import('@margoengine/oit').OIT; addMesh: typeof import('@margoengine/oit/meshes').addMesh };
  pixel?: typeof import('@margoengine/pixel').LayerCompositor;
  creative?: typeof import('@margoengine/creative/particles').GPUParticles;
  scenery?: typeof import('@margoengine/scenery/moon').Moon;
  'voxel-pathtracer'?: typeof import('@margoengine/voxel-pathtracer').VoxelPathTracer;
  water?: typeof import('@margoengine/water').Water;
  sky?: typeof import('@margoengine/sky').Sky;
  vfx?: typeof import('@margoengine/vfx').VFX;
  sprites?: typeof import('@margoengine/sprites').SpriteLayer;
  splats?: typeof import('@margoengine/splats').Splats;
  lighting2d?: typeof import('@margoengine/lighting2d').Lighting2D;
  xr?: Pick<typeof import('@margoengine/xr'), 'XR' | 'createXREngine'>;
};

export function expose(scene: Scene, constructors: Constructors) {
  const errors: string[] = [];
  addEventListener('unhandledrejection', (event) => errors.push(`unhandled rejection: ${String(event.reason)}`));
  addEventListener('error', (event) => errors.push(event.message));
  async function run(samples: 1 | 4) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    canvas.style.cssText = `width:${SIZE}px;height:${SIZE}px`;
    document.body.append(canvas);
    const xrProbe = constructors.xr ? installXRProbe() : undefined;
    const create = constructors.xr?.createXREngine ?? Engine.create;
    const engine = await create(canvas, {
      backend: 'webgpu',
      exactSize: samples === 1 ? [SIZE, SIZE] : false,
      camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45, near: 0.1, far: 50 },
    });
    const runtime = engineRuntime(engine),
      device = runtime.gpu!;
    const cleanup: (() => void)[] = [];
    const frame = (delta = 0) =>
      engine.render({
        delta,
        views: [
          { camera: engine.camera, viewport: [0, 0, SIZE, SIZE], scissor: [4, 4, SIZE - 8, SIZE - 8], pixels: true },
        ],
      });
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
      const depth = DepthTexture.attach(engine);
      if (constructors.taa)
        engine.use(new constructors.taa({ historyWeight: 0, ...(stack ? { depth: () => stack.depthTexture } : {}) }));
      if (constructors.shadows) engine.use(new constructors.shadows({ resolution: 32, distance: 15 }));
      if (constructors.clustered) {
        const clustered = new constructors.clustered({ maxLights: 4 });
        engine.use(clustered);
        clustered.setLights([{ position: [0, 0, 1], range: 0.1, intensity: 1 }]);
      }
      if (constructors.toon) engine.use(new constructors.toon({ rim: 0, outline: 0.03 }));
      const transition = constructors.transitions ? new constructors.transitions() : undefined;
      if (transition) engine.use(transition);
      const checks: (() => void)[] = [];
      type GPUContext = Extract<PassContext, { backend: 'webgpu' }>;
      let initial: { color: GPUTextureView; depth: GPUTextureView; format: string; samples: number; rect: string };
      const rect = (c: GPUContext) => JSON.stringify([c.width, c.height, c.view?.viewport, c.view?.scissor]);
      runtime.frameGraph.add({
        name: 'composition:before',
        order: -1000,
        execute(c) {
          if (c.backend === 'webgpu')
            initial = {
              color: c.color,
              depth: c.depth,
              format: c.format,
              samples: c.descriptor.multisample?.count ?? 1,
              rect: rect(c),
            };
        },
      });
      runtime.frameGraph.add({
        name: 'composition:after',
        order: 2000,
        execute(c) {
          if (c.backend !== 'webgpu') throw new Error('composition did not use the full device route');
          requireValue(
            c.color === initial.color &&
              c.depth === initial.depth &&
              c.format === initial.format &&
              (c.descriptor.multisample?.count ?? 1) === initial.samples &&
              rect(c) === initial.rect,
            'render target, MSAA, viewport or scissor was not restored',
          );
        },
      });
      if (constructors.lines) {
        const { Lines, Line } = constructors.lines,
          lines = Lines.attach(engine);
        lines.add(new Line({ positions: [0, -0.15, 1, 0, 0.15, 1], color: '#ffffff', width: 3 }));
        checks.push(() => requireValue(lines.lines.size === 1, 'line lost from renderer'));
      }
      if (constructors.points) {
        const { PointsPlugin, PointCloud } = constructors.points,
          points = PointsPlugin.attach(engine);
        const cloud = points.add(
          new PointCloud({ positions: new Float32Array([0, 0.35, 1]), material: { size: 3, color: '#ffffff' } }),
        );
        checks.push(() => requireValue(cloud.stats.pointsDrawn === 1, `points drawn ${cloud.stats.pointsDrawn}`));
      }
      if (constructors.labels) {
        const labels = constructors.labels.attach(engine),
          element = document.createElement('span');
        element.textContent = 'C2';
        const label = labels.add(element, { position: [0, 0, 1] });
        checks.push(() =>
          requireValue(label.onScreen && Math.abs(label.screen.x - SIZE / 2) <= 1, 'label projection lost'),
        );
      }
      if (constructors.text) {
        const { TextRenderer, Text } = constructors.text,
          text = TextRenderer.attach(engine);
        text.add(new Text({ text: 'I', font: { family: 'monospace' }, fontSize: 0.2, position: [0, -0.35, 1] }));
        checks.push(() => requireValue(text.atlas.glyphs === 1, `text glyphs ${text.atlas.glyphs}`));
      }
      if (constructors.oit) {
        const oit = constructors.oit.OIT.attach(engine);
        const mesh = engine
          .createMesh()
          .setGeometry(box(0.12, 0.12, 0.1))
          .setPosition([0, 0, 1])
          .setMaterial(new PbrMaterial({ color: '#ffffff' }));
        cleanup.push(constructors.oit.addMesh(oit, engine, mesh, { opacity: 0.5 }));
      }
      if (constructors.pixel) {
        const pixel = constructors.pixel.attach(engine, { camera: { width: SIZE, height: SIZE, zoom: 1 } });
        pixel
          .addLayer({ width: 4, height: 4, x: 46, y: 46 })
          .write({ width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(255) });
      }
      if (constructors.sprites) {
        const sprites = constructors.sprites.attach(engine, {
          atlas: { width: 2, height: 2, data: new Uint8Array(16).fill(255) },
        });
        sprites.add({ x: 47, y: 47 });
        checks.push(() => requireValue(sprites.sprites.length === 1, 'sprite lost'));
      }
      if (constructors.splats) {
        const splats = constructors.splats.attach(engine, {
          positions: new Float32Array([0, 0, 1]),
          covariances: new Float32Array([0.0001, 0, 0, 0.0001, 0, 0.0001]),
          colors: new Float32Array([1, 1, 1, 1]),
        });
        checks.push(() => requireValue(splats.count === 1, 'splat lost'));
      }
      if (constructors.vfx)
        engine.use(
          new constructors.vfx({
            capacity: 1,
            initialCount: 1,
            rate: 0,
            position: [0, 0, 1],
            spread: 0,
            size: 0.08,
            gravity: [0, 0, 0],
            velocity: [0, 0, 0],
            turbulence: 0,
            color: [1, 1, 1, 1],
          }),
        );
      if (constructors.creative) {
        const particles = new constructors.creative({ count: 1, size: 0.03, gravity: [0, 0, 0], wind: [0, 0, 0] });
        particles.options.position = [0, 0, 1];
        particles.options.emissionExtent = [0.01, 0.01, 0.01];
        engine.use(particles);
      }
      if (constructors.water)
        engine.use(
          new constructors.water({
            depth: () => stack?.depthTexture ?? depth.texture,
            size: [1, 1],
            segments: 2,
            height: -1.6,
            waves: [{ direction: [1, 0], amplitude: 0, wavelength: 1 }],
          }),
        );
      if (constructors.sky)
        engine.use(
          new constructors.sky({
            hours: 0,
            timeScale: 0,
            night: {
              zenithColor: [0, 0, 0],
              horizonColor: [0, 0, 0],
              moonColor: [0, 0, 0],
              glowIntensity: 0,
              starIntensity: 0,
            },
          }),
        );
      if (constructors.scenery)
        engine.use(
          new constructors.scenery({
            albedo: { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) },
            angularRadius: 1,
            sunDirection: [0, 0, 1],
          }),
        );
      let lightTarget: GPUTexture | undefined;
      if (constructors.lighting2d) {
        lightTarget = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 16 | 1 | 4 });
        cleanup.push(() => lightTarget!.destroy());
        const light = constructors.lighting2d.attach(engine, { target: lightTarget, ambient: '#000000' });
        light.addLight({ kind: 'directional', color: '#808080', elevation: Math.PI / 2 });
      }
      if (constructors['voxel-pathtracer']) {
        const tracer = constructors['voxel-pathtracer'].attach(engine, {
          scene: {
            revision: 1,
            models: colors.map((_, i) => ({
              id: String(i),
              revision: 1,
              size: [1, 1, 1] as const,
              voxels: new Uint8Array([i + 1]),
            })),
            instances: colors.map((_, i) => ({
              id: String(i),
              modelId: String(i),
              matrix: [
                1.1,
                0,
                0,
                0,
                0,
                1.1,
                0,
                0,
                0,
                0,
                0.2,
                0,
                (i % 2 ? 0.7 : -0.7) - 0.55,
                (i < 2 ? 0.7 : -0.7) - 0.55,
                -0.1,
                1,
              ],
            })),
            materials: [
              [0.5, 0, 0],
              [0, 0.5, 0],
              [0, 0, 0.5],
              [0.5, 0.5, 0],
            ].map((color, i) => ({
              id: i + 1,
              type: 'emit' as const,
              color: color as [number, number, number],
              emission: 1,
            })),
            environment: { skyIntensity: 0, sunIntensity: 0, background: [0, 0, 0] },
          },
          maxSamples: 1,
          maxBounces: 1,
          samplesPerFrame: 1,
          denoise: false,
          toneMapping: 'linear',
        });
        await tracer.ready;
        checks.push(() => requireValue(tracer.stats.samples === 1, `trace samples ${tracer.stats.samples}`));
      }
      await waitForPipelines(
        async () => {
          frame();
          await device.queue.onSubmittedWorkDone();
        },
        { timeoutMs: 60_000 },
      );
      if (transition) {
        transition.start('wipe', 1);
        frame(0.5);
        requireValue(transition.progress === 0.5, `transition progress ${transition.progress}`);
      }
      // Capture in the render task, before a WebGL drawing buffer may be discarded.
      frame();
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
      const depthValues = await readTexture(device, depth.texture!);
      const expectedDepth = ((0.1 * 50) / 4.9 - 0.1) / (50 - 0.1);
      const depths = [
        [32, 32],
        [64, 32],
        [32, 64],
        [64, 64],
        [2, 2],
        [93, 93],
      ].map(([x, y]) => depthValues.depth(x, y));
      for (let i = 0; i < depths.length; i++)
        requireValue(Math.abs(depths[i] - (i < 4 ? expectedDepth : 0)) <= 1e-6, `depth probe ${i}: ${depths[i]}`);
      if (lightTarget) {
        const light = await readTexture(device, lightTarget);
        requireValue(
          light.rgba(2, 2).every((v, i) => Math.abs(v - (i === 3 ? 255 : 128)) <= 1),
          `lighting2d target ${light.rgba(2, 2)}`,
        );
      }
      const eyes: number[][][] = [];
      if (constructors.xr && xrProbe) {
        const xr = await constructors.xr.XR.create(engine);
        requireValue(xr.route === 'engine', 'XR did not draw through the engine pass graph');
        await xr.requestSession('immersive-vr');
        await waitForPipelines(
          async () => {
            xrProbe.session.step();
            await device.queue.onSubmittedWorkDone();
          },
          { timeoutMs: 60_000 },
        );
        for (const layer of [0, 1]) {
          const eye = await readTexture(device, xrProbe.color, layer);
          eyes.push(
            [
              [32, 32],
              [64, 32],
              [32, 64],
              [64, 64],
              [2, 2],
              [93, 93],
            ].map(([x, y]) => eye.rgba(x, y)),
          );
        }
        await xr.end();
        engine.stop();
      }
      await device.queue.onSubmittedWorkDone();
      const validation = await device.popErrorScope();
      scoped = false;
      requireValue(!validation, validation?.message ?? '');
      requireValue(errors.length === 0, errors.join('\n'));
      for (const check of checks) check();
      const expectedDraws =
        4 +
        Number(!!constructors.oit) +
        Number(!!constructors.vfx) +
        Number(!!constructors.creative) +
        Number(!!constructors.splats);
      requireValue(
        engine.stats.drawCalls === expectedDraws,
        `Expected ${expectedDraws} scene draws, got ${engine.stats.drawCalls}`,
      );
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
      for (const eye of eyes)
        for (let i = 0; i < pixels.length; i++)
          for (let c = 0; c < 4; c++)
            requireValue(Math.abs(eye[i][c] - pixels[i][c]) <= 1, `XR eye probe ${i}: ${eye[i]} != ${pixels[i]}`);
      return { ...scene, samples, pixels, depths, eyes, draws: engine.stats.drawCalls, errors: [...errors] };
    } finally {
      if (scoped) {
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
      }
      for (let i = cleanup.length - 1; i >= 0; i--) cleanup[i]();
      engine.dispose();
      xrProbe?.restore();
      canvas.remove();
    }
  }
  Object.assign(window, { composition: { ...scene, run, errors } });
}
