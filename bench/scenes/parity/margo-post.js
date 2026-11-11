// Margo implementation of the parity post-processing scenes (../parity.js, area 'post'): the 1,000-box yard (floor +
// boxes, as the catalog `post` scene) through ONE effect in data.effect. The chain is render -> that effect -> the
// display output every Margo frame ends with (Khronos PBR Neutral, then sRGB): a PostStack holding the effect and
// `Tonemap({curve: 'neutral'})` (the stack's display effect), or the effect's own display stage where it is one
// (creative PostProcessing) or wraps core's output (Selection, TAA, FXAA alone).
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { LIGHT } from '../catalog.js';
import { engineFor, floor, meshes, palette, sceneSamples } from '../margo.js';

const lightDir = (() => {
  const [x, y, z] = LIGHT.direction,
    l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
})();

/** engineFor with a single-sampled scene (exactSize keeps the 1280 x 720 backbuffer and turns MSAA off). */
async function engineSingle(canvas, c, capacity, marks) {
  const s = performance.now(),
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      capacity,
      exactSize: [canvas.width, canvas.height],
      camera: { fov: c.fov, near: c.near, far: c.far, position: c.at(0), target: c.target },
    });
  marks.createMs = +(performance.now() - s).toFixed(1);
  const { lighting } = engineRuntime(engine);
  lighting.direction.set([...LIGHT.direction, LIGHT.intensity]);
  lighting.radiance.set([1, 1, 1, LIGHT.ambient]);
  return engine;
}

/**
 * The yard (floor + 1,000 boxes) on a new engine; `attach(engine, list, floorMesh)` adds the effect. Frames advance
 * by the harness's fixed 1/60 s (`delta`), so time-based effects (afterimage) see the same frame step as three.js.
 */
async function yard(canvas, data, marks, attach, { single = false, floorMaterial, spin = false, note } = {}) {
  const n = data.items.length,
    engine = single
      ? await engineSingle(canvas, data.camera, n + 8, marks)
      : await engineFor(canvas, data.camera, n + 8, marks),
    s = performance.now();
  const ground = floorMaterial
    ? engine
        .createMesh()
        .setGeometry(box(...data.floor.size))
        .setPosition(data.floor.position)
        .setMaterial(new PbrMaterial({ color: data.floor.color, ...floorMaterial }))
    : floor(engine, data.floor);
  const list = meshes(engine, data, palette(data)),
    extra = (await attach(engine, list, ground)) ?? {};
  marks.buildMs = +(performance.now() - s).toFixed(1);
  return {
    samples: single ? 1 : sceneSamples(),
    render(t) {
      if (spin) for (let i = 0; i < n; i++) list[i].rotation.y = data.items[i].rotation[1] + t;
      engine.camera.position = data.camera.at(t);
      engine.render({ delta: 1 / 60 });
    },
    idle: () => engine.gpu.queue.onSubmittedWorkDone(),
    info: () => ({
      drawCalls: engine.stats.drawCalls,
      note: `core batches (post passes not counted). ${extra.note ?? note ?? ''}`.trim(),
    }),
  };
}

/** A radial gradient image (the scene's glow or ring), sRGB, as a texture of `device`. */
async function flareTexture(device, size, ring) {
  const c = new OffscreenCanvas(size, size),
    g = c.getContext('2d'),
    grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const stops = ring
    ? [
        [0, 'rgba(255,255,255,0)'],
        [0.7, 'rgba(255,255,255,0)'],
        [0.85, 'rgba(255,240,220,0.6)'],
        [1, 'rgba(255,255,255,0)'],
      ]
    : [
        [0, 'rgba(255,255,255,1)'],
        [0.2, 'rgba(255,230,200,0.5)'],
        [1, 'rgba(255,200,150,0)'],
      ];
  for (const [at, colour] of stops) grad.addColorStop(at, colour);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const texture = device.createTexture({
    size: [size, size],
    format: 'rgba8unorm-srgb',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: await createImageBitmap(c) }, { texture }, [size, size]);
  return texture;
}

const post = {
  stack: () => import('@margoengine/post/stack'),
  tonemap: async () => new (await import('@margoengine/tonemap')).Tonemap({ curve: 'neutral' }),
};
/** A PostStack of `effects` (HDR effects first, then the display effect, then LDR effects). */
async function stack(engine, effects) {
  const { PostStack } = await post.stack();
  return PostStack.attach(engine, effects);
}

export const builders = {
  async 'p-composer'(canvas, data, marks) {
    return yard(canvas, data, marks, async (engine) => {
      await stack(engine, [await post.tonemap()]);
      return { note: 'PostStack [Tonemap neutral]: HDR capture copied through the display transform, no effect.' };
    });
  },

  async 'p-bloom'(canvas, data, marks) {
    const { strength, radius, threshold } = data.effect;
    return yard(canvas, data, marks, async (engine) => {
      const { Bloom } = await import('@margoengine/post/bloom');
      await stack(engine, [new Bloom({ strength, radius, threshold }), await post.tonemap()]);
      return {
        note: `PostStack [Bloom {strength ${strength}, radius ${radius}, threshold ${threshold} (linear, brightest channel)}, Tonemap]; Margo's chain has 6 levels (1/2-1/64), not 5.`,
      };
    });
  },

  async 'p-ssao'(canvas, data, marks) {
    const { radius, samples } = data.effect;
    return yard(canvas, data, marks, async (engine) => {
      const { SSAO } = await import('@margoengine/post/ssao');
      await stack(engine, [new SSAO({ radius, samples }), await post.tonemap()]);
      return {
        note: `PostStack [SSAO {radius ${radius}, samples ${samples}}, Tonemap]; bilateral blur; darkens ambient light only.`,
      };
    });
  },

  async 'p-gtao'(canvas, data, marks) {
    const { radius } = data.effect;
    return yard(canvas, data, marks, async (engine) => {
      const { GTAO } = await import('@margoengine/post/gtao');
      // 16 depth samples per pixel: 2 slices x 2 sides x 4 steps.
      await stack(engine, [new GTAO({ radius, slices: 2, steps: 4 }), await post.tonemap()]);
      return {
        note: `PostStack [GTAO {radius ${radius}, slices 2, steps 4: 16 samples}, Tonemap]; SSAO's bilateral blur as denoiser; darkens ambient light only.`,
      };
    });
  },

  async 'p-ssr'(canvas, data, marks) {
    const { distance, thickness } = data.effect;
    return yard(
      canvas,
      data,
      marks,
      async (engine) => {
        const { SSR } = await import('@margoengine/post/ssr');
        await stack(engine, [new SSR({ maxDistance: distance, thickness }), await post.tonemap()]);
        return {
          note: `PostStack [SSR {maxDistance ${distance}, thickness ${thickness}, steps 64}, Tonemap]; floor metalness 1, roughness 0.1; no environment, so misses stay black.`,
        };
      },
      { floorMaterial: { roughness: 0.1, metalness: 1 } },
    );
  },

  async 'p-ssgi'(canvas, data, marks) {
    const { radius } = data.effect;
    return yard(canvas, data, marks, async (engine) => {
      const { SSGI } = await import('@margoengine/post/ssgi');
      await stack(engine, [new SSGI({ rays: 8, steps: 8, maxDistance: radius }), await post.tonemap()]);
      return {
        note: `PostStack [SSGI {rays 8, steps 8, maxDistance ${radius}}, Tonemap]: 8 cosine rays (for "8 slices") x 8 Hi-Z steps; bilateral blur as denoiser.`,
      };
    });
  },

  async 'p-taa'(canvas, data, marks) {
    return yard(
      canvas,
      data,
      marks,
      async (engine) => {
        const { TAA } = await import('@margoengine/taa');
        TAA.attach(engine, { historyWeight: 0.9 });
        return { note: 'TAA {historyWeight 0.9} on a 1x scene (MSAA off), core display output.' };
      },
      { single: true },
    );
  },

  async 'p-fxaa'(canvas, data, marks) {
    return yard(
      canvas,
      data,
      marks,
      async (engine) => {
        const { FXAA } = await import('@margoengine/post/fxaa');
        await stack(engine, [await post.tonemap(), new FXAA()]);
        return { note: 'PostStack [Tonemap, FXAA] on a 1x scene (MSAA off); FXAA on the display-encoded frame.' };
      },
      { single: true },
    );
  },

  async 'p-smaa'(canvas, data, marks) {
    return yard(
      canvas,
      data,
      marks,
      async (engine) => {
        const { SMAA } = await import('@margoengine/post/smaa');
        await stack(engine, [await post.tonemap(), new SMAA({ quality: 'high' })]);
        return {
          note: "PostStack [Tonemap, SMAA 'high'] on a 1x scene (MSAA off); SMAA on the display-encoded frame.",
        };
      },
      { single: true },
    );
  },

  async 'p-dof'(canvas, data, marks) {
    const { focus, maxBlur } = data.effect;
    return yard(canvas, data, marks, async (engine) => {
      const { DOF } = await import('@margoengine/dof');
      await stack(engine, [
        new DOF({ focalDistance: focus, aperture: 2.8, focalLength: 0.05, maxRadius: maxBlur }),
        await post.tonemap(),
      ]);
      return {
        note: `PostStack [DOF {focalDistance ${focus}, f/2.8, focalLength 0.05 (default), maxRadius ${maxBlur} px}, Tonemap]: a thin lens; the yard is 25-70 m away, so its CoC is about 1 px and maxRadius is not reached.`,
      };
    });
  },

  async 'p-outline'(canvas, data, marks) {
    const { every, color, thickness } = data.effect;
    return yard(canvas, data, marks, async (engine, list) => {
      const { Selection } = await import('@margoengine/selection'),
        rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
      Selection.attach(engine, { algorithm: 'jfa', width: thickness, color: rgb }).set(
        list.filter((_, i) => i % every === 0),
      );
      return {
        note: `Selection {jfa, width ${thickness} px, ${color} as display colour} on ${Math.ceil(list.length / every)} boxes; visible edges only, over core's display output.`,
      };
    });
  },

  async 'p-film'(canvas, data, marks) {
    const { intensity } = data.effect;
    return yard(canvas, data, marks, async (engine) => {
      const { PostProcessing } = await import('@margoengine/creative/post');
      await stack(engine, [new PostProcessing({ grain: intensity })]);
      return {
        note: `PostStack [creative PostProcessing {grain ${intensity}}] (its own PBR Neutral display transform, then per-pixel grain re-seeded each frame).`,
      };
    });
  },

  async 'p-glitch'(canvas, data, marks) {
    return yard(canvas, data, marks, async (engine) => {
      const { Glitch } = await import('@margoengine/post/glitch');
      await stack(engine, [await post.tonemap(), new Glitch({ wild: true, seed: 7 })]);
      return { note: 'PostStack [Tonemap, Glitch {wild: true, seed 7}]: a glitched frame every frame.' };
    });
  },

  async 'p-afterimage'(canvas, data, marks) {
    const { damp } = data.effect,
      // damp is a per-frame keep factor; Margo's keep is 0.5^(delta / halfLife) with delta = 1/60 s per frame.
      halfLife = Math.log(0.5) / Math.log(damp) / 60;
    return yard(canvas, data, marks, async (engine) => {
      const { Afterimage } = await import('@margoengine/post/afterimage');
      await stack(engine, [new Afterimage({ halfLife }), await post.tonemap()]);
      return {
        note: `PostStack [Afterimage {halfLife ${halfLife.toFixed(4)} s = keep ${damp} per 1/60 s frame}, Tonemap]: max(current, history x keep) in linear HDR.`,
      };
    });
  },

  async 'p-lut'(canvas, data, marks) {
    return yard(canvas, data, marks, async (engine) => {
      const tonemap = await post.tonemap();
      await stack(engine, [tonemap]);
      tonemap.setLUT(data.effect.lut);
      return {
        note: 'PostStack [Tonemap neutral + setLUT(33^3 .cube)]: the LUT is applied to display-linear colour after the curve, before sRGB encoding.',
      };
    });
  },

  async 'p-god-rays'(canvas, data, marks) {
    return yard(canvas, data, marks, async (engine) => {
      const { PostProcessing } = await import('@margoengine/creative/post');
      await stack(engine, [new PostProcessing({ atmosphere: { godRays: 1, sun: lightDir } })]);
      return {
        note: 'PostStack [creative PostProcessing {atmosphere.godRays 1, sun = the light direction}]: screen-space shafts over sky pixels with a fixed 16 samples and decay 0.95 (the spec asks 64 samples, density 0.9); the sun is behind the orbit camera here, so the shafts are off screen.',
      };
    });
  },

  async 'p-motion-blur'(canvas, data, marks) {
    const { samples } = data.effect;
    return yard(
      canvas,
      data,
      marks,
      async (engine) => {
        const [{ MotionBlur }, { TAA }] = await Promise.all([
          import('@margoengine/post/motion-blur'),
          import('@margoengine/taa'),
        ]);
        let taa;
        const s = await stack(engine, [
          new MotionBlur({ velocity: () => taa?.velocity, samples }),
          await post.tonemap(),
        ]);
        taa = TAA.attach(engine, { depth: () => s.depthTexture });
        return {
          note: `PostStack [MotionBlur {samples ${samples}, shutter 0.5}, Tonemap] fed by TAA's velocity: Margo's only motion-vector source is TAA, so this frame also runs TAA (and MotionBlur blurs TAA's resolved frame).`,
        };
      },
      { spin: true },
    );
  },

  async 'p-motion-blur-velocity'(canvas, data, marks) {
    const { samples } = data.effect;
    return yard(
      canvas,
      data,
      marks,
      async (engine) => {
        const [{ MotionBlur }, { TAA }] = await Promise.all([
          import('@margoengine/post/motion-blur'),
          import('@margoengine/taa'),
        ]);
        let taa;
        const s = await stack(engine, [
          new MotionBlur({ velocity: () => taa?.velocity, samples }),
          await post.tonemap(),
        ]);
        taa = TAA.attach(engine, { velocityOnly: true, depth: () => s.depthTexture });
        return { note: `PostStack [MotionBlur {samples ${samples}, shutter 0.5}, Tonemap] fed by TAA velocityOnly` };
      },
      { spin: true },
    );
  },

  async 'p-color-grading'() {
    throw new Error(
      'unsupported: hue rotation (creative PostProcessing has contrast, saturation, gain and lift and tonemap has contrast, but no grading stage rotates hue)',
    );
  },

  async 'p-screen-effects'(canvas, data, marks) {
    const { shift, pixel } = data.effect;
    return yard(canvas, data, marks, async (engine) => {
      const { pixelate, rgbShift, vignette } = await import('@margoengine/shader/effects');
      await stack(engine, [
        await post.tonemap(),
        pixelate({ size: pixel }),
        rgbShift({ amount: shift }),
        vignette({ darkness: 0.5, radius: 0, softness: 1 }),
      ]);
      return {
        note: `PostStack [Tonemap, pixelate ${pixel} px, rgbShift ${shift}, vignette {darkness 0.5, radius 0, softness 1}] (LDR NodePasses). Pixelation first, as three's pixelation is a render pass; Margo's vignette (1 - 0.5 smoothstep(0, 1, d), d = 1 at the corners) stands for three's offset 1 / darkness 1 (1 - d^2 / 2).`,
      };
    });
  },

  async 'p-lensflare'(canvas, data, marks) {
    const light = data.effect.light;
    return yard(canvas, data, marks, async (engine) => {
      const { LensFlare } = await import('@margoengine/post/lens-flare'),
        glow = await flareTexture(engine.gpu, 512, false),
        ring = await flareTexture(engine.gpu, 128, true);
      await stack(engine, [
        new LensFlare({
          position: () => light,
          elements: [
            { texture: glow, size: 512 },
            { texture: ring, size: 60, distance: 0.6 },
            { texture: ring, size: 90, distance: 0.7 },
            { texture: ring, size: 120, distance: 0.9 },
          ],
        }),
        await post.tonemap(),
      ]);
      return {
        note: `PostStack [LensFlare {position (${light}), glow 512 px + rings 60/90/120 px at 0.6/0.7/0.9}, Tonemap]; the light adds no lighting (flare only), as three's intensity-0 PointLight; the flare is added in HDR before the display curve.`,
      };
    });
  },
};
