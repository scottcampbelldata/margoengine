// The page of browser-check.mjs: each picture is read back and compared with the CPU form, pixel by pixel.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { LayerCompositor } from '/packages/pixel/dist/index.js';
import { SpriteLayer } from '/packages/sprites/dist/index.js';
import { inShadow, lightAt, Lighting2D, occluderEdges } from '/packages/lighting2d/dist/index.js';
import { SoftLighting2D, softLightAt } from '/packages/lighting2d/dist/soft.js';
import { CookieLighting2D, cookieLightAt, createSpotCookie } from '/packages/lighting2d/dist/cookie.js';
import { GILighting2D, RadianceCascade2D } from '/packages/lighting2d/dist/gi.js';
import { HeightLighting2D, createHeightOccluder, heightLightAt } from '/packages/lighting2d/dist/height.js';
import { EmissiveLighting2D, EmissiveSprite2D, emissiveLightAt } from '/packages/lighting2d/dist/emissive.js';

const WIDTH = 32,
  HEIGHT = 16,
  canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [WIDTH * 2, HEIGHT * 2] }),
  engine = engineRuntime(instance),
  errors = [];
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

const USAGE = () => GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING;
const texture = (format = 'rgba8unorm', width = WIDTH, height = HEIGHT) =>
  engine.gpu.createTexture({ size: [width, height], format, usage: USAGE() | GPUTextureUsage.COPY_DST });
const read = async (source) => {
  const device = engine.gpu,
    row = Math.ceil((source.width * 4) / 256) * 256,
    buffer = device.createBuffer({
      size: row * source.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow: row }, [source.width, source.height]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buffer.getMappedRange()),
    out = new Uint8Array(source.width * source.height * 4);
  for (let y = 0; y < source.height; y++)
    out.set(raw.subarray(y * row, y * row + source.width * 4), y * source.width * 4);
  buffer.destroy();
  return out;
};
const normalBytes = (fill) => {
  const out = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) out.set(fill(x, y), (y * WIDTH + x) * 4);
  return out;
};
const normalTexture = (bytes) => {
  const t = texture();
  engine.gpu.queue.writeTexture({ texture: t }, bytes, { bytesPerRow: WIDTH * 4 }, [WIDTH, HEIGHT]);
  return t;
};
/**
 * The expected picture: ambient plus each light not in shadow at each pixel centre. `lit` says how close a pixel must be;
 * every one must be within 1/255 of the sum in each channel, and an alpha of 255.
 */
const expected = ({ lights, ambient = [0, 0, 0], edges = [], normal, camera = { x: 0, y: 0, zoom: 1 } }) => {
  const out = new Float64Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const wx = camera.x + (x + 0.5) / camera.zoom,
        wy = camera.y + (y + 0.5) / camera.zoom,
        sum = [...ambient];
      for (const light of lights) {
        if (inShadow(light, edges, wx, wy)) continue;
        const add = lightAt(light, wx, wy, normal?.(x, y));
        for (let c = 0; c < 3; c++) sum[c] += add[c];
      }
      out.set(
        sum.map((v) => Math.min(1, v) * 255),
        (y * WIDTH + x) * 3,
      );
    }
  return out;
};
const compare = (actual, want) => {
  let wrong = 0,
    first = null;
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    let bad = actual[i * 4 + 3] !== 255;
    for (let c = 0; c < 3; c++) if (Math.abs(actual[i * 4 + c] - want[i * 3 + c]) > 1) bad = true;
    if (bad) {
      wrong++;
      first ??= {
        x: i % WIDTH,
        y: Math.floor(i / WIDTH),
        actual: [...actual.subarray(i * 4, i * 4 + 4)],
        expected: [...want.subarray(i * 3, i * 3 + 3)],
      };
    }
  }
  return { wrong, first };
};
const frame = () => instance.render({ delta: 0 });

window.check = {
  async run() {
    const out = { checks: {} };
    engine.gpu.pushErrorScope('validation');
    const target = texture(),
      lighting = Lighting2D.attach(instance, { target: () => target, ambient: '#000000' }),
      shows = async (name, options) => {
        frame();
        out.checks[name] = compare(await read(target), expected(options));
      };

    // One point light over nothing: the falloff per pixel.
    const lamp = lighting.addLight({ x: 12.25, y: 7.75, radius: 20, falloff: 1.5, height: 6 });
    await shows('a point light', { lights: [lamp] });
    {
      const bytes = await read(target);
      let lit = 0;
      for (let i = 0; i < WIDTH * HEIGHT; i++) if (bytes[i * 4]) lit++;
      out.lit = lit;
    }
    lamp.color = '#ff8040';
    lamp.intensity = 0.75;
    await shows('colour and intensity', { lights: [lamp] });
    lamp.color = '#ffffff';
    lamp.intensity = 1;

    // Ambient, read live.
    lighting.ambient = '#203040';
    await shows('ambient under the light', { lights: [lamp], ambient: [32 / 255, 48 / 255, 64 / 255] });
    lighting.ambient = '#000000';

    // A wall: the shadow is exactly the CPU's pixels. Nothing lies on a pixel centre, so each pixel has one answer.
    const wall = [{ shape: 'segment', from: [20.1, 3.2], to: [20.1, 11.3] }],
      edges = occluderEdges(wall);
    lighting.setOccluders(wall);
    lamp.x = 8.3;
    lamp.y = 7.2;
    lamp.radius = 40;
    lamp.height = 10;
    frame();
    {
      const bytes = await read(target),
        want = expected({ lights: [lamp], edges });
      out.checks['a wall casts exactly its shadow'] = compare(bytes, want);
      let shadowed = 0,
        leaks = 0;
      for (let y = 0; y < HEIGHT; y++)
        for (let x = 0; x < WIDTH; x++)
          if (inShadow(lamp, edges, x + 0.5, y + 0.5)) {
            shadowed++;
            if (bytes[(y * WIDTH + x) * 4]) leaks++;
          } else if (!bytes[(y * WIDTH + x) * 4]) leaks++;
      out.shadowed = shadowed;
      out.checks['each pixel lit or dark as the CPU says'] = { wrong: leaks };
    }
    lamp.shadows = false;
    await shows('shadows off', { lights: [lamp] });
    lamp.shadows = true;

    // Shapes: a box seen from outside, and the light moving.
    const box = [{ shape: 'box', width: 5.3, height: 4.7, offset: [22.1, 6.2], rotation: 0.4 }];
    lighting.setOccluders(box);
    await shows('a turned box', { lights: [lamp], edges: occluderEdges(box) });
    lamp.x = 27.3;
    lamp.y = 13.1;
    await shows('the light moves', { lights: [lamp], edges: occluderEdges(box) });

    // Spot and directional, shadows included, then several together.
    const spot = lighting.addLight({
      kind: 'spot',
      x: 3.2,
      y: 8.4,
      radius: 40,
      falloff: 1,
      height: 8,
      angle: 0.2,
      cone: 0.5,
      softness: 0.4,
    });
    lighting.removeLight(lamp);
    await shows('a spot with a fading edge', { lights: [spot], edges: occluderEdges(box) });
    spot.softness = 0;
    await shows('a spot with a hard edge', { lights: [spot], edges: occluderEdges(box) });
    const sun = lighting.addLight({
      kind: 'directional',
      angle: 0.7,
      elevation: 0.6,
      color: '#a0b0ff',
      intensity: 0.8,
    });
    lighting.removeLight(spot);
    await shows('a directional light', { lights: [sun], edges: occluderEdges(box) });
    lighting.lights.push(spot, lamp);
    spot.intensity = lamp.intensity = sun.intensity = 0.3;
    await shows('three lights add up', { lights: [sun, spot, lamp], edges: occluderEdges(box) });

    // More lights than the uniform buffer first held, and more edges than its first buffer.
    {
      const many = [];
      for (let i = 0; i < 40; i++)
        many.push(
          lighting.addLight({ x: (i * 7.3) % WIDTH, y: (i * 3.7) % HEIGHT, radius: 7, intensity: 0.15, height: 3 }),
        );
      const list = [...lighting.lights],
        // One wall of 30 edges across the target: a missing edge lets light through.
        wide = [
          {
            shape: 'polyline',
            points: Array.from({ length: 31 }, (_, i) => [1.17 + i * 0.95, 3.5 + 0.3 * Math.sin(i * 1.7)]),
          },
        ],
        wideEdges = occluderEdges(wide),
        // Rasterizers snap to about 1/256 px, so a pixel centre that close to a shadow boundary has no single answer.
        // This scene is chosen to have none, and this count proves it, so every pixel below is held to the CPU's answer.
        around = Array.from({ length: 16 }, (_, k) => [
          Math.cos((k * Math.PI) / 8) / 256,
          Math.sin((k * Math.PI) / 8) / 256,
        ]);
      let close = 0;
      for (const light of list)
        for (let y = 0.5; y < HEIGHT; y++)
          for (let x = 0.5; x < WIDTH; x++) {
            if (Math.max(...lightAt(light, x, y)) * 255 <= 1) continue;
            const here = inShadow(light, wideEdges, x, y);
            if (around.some(([a, b]) => inShadow(light, wideEdges, x + a, y + b) !== here)) close++;
          }
      out.checks['no pixel centre within 1/256 px of a shadow boundary'] = { wrong: close };
      lighting.setOccluders(wide);
      await shows('43 lights and 30 edges', { lights: list, edges: wideEdges });
      for (const light of list) lighting.removeLight(light);
    }
    lighting.setOccluders([]);

    // A camera: world units to pixels, for the light and the occluders.
    {
      const camera = { x: 10, y: 4, zoom: 2 },
        light = lighting.addLight({ x: 14.1, y: 8.2, radius: 30, height: 5 }),
        cut = [{ shape: 'segment', from: [19.05, 5.1], to: [19.05, 9.9] }];
      lighting.camera = camera;
      lighting.setOccluders(cut);
      await shows('through a camera', { lights: [light], edges: occluderEdges(cut), camera });
      lighting.removeLight(light);
      lighting.setOccluders([]);
      lighting.camera = { x: 0, y: 0, zoom: 1 };
    }
    lighting.dispose();

    // Normals: flat ones, turned ones, and alpha 0 meaning flat.
    {
      const flat = normalTexture(normalBytes(() => [128, 128, 255, 255])),
        turned = normalTexture(normalBytes((x) => (x < 16 ? [220, 128, 180, 255] : [128, 40, 180, 255]))),
        holes = normalTexture(normalBytes((x) => (x % 2 ? [40, 128, 180, 255] : [0, 0, 0, 0]))),
        decode = (b) => [(b[0] / 255) * 2 - 1, (b[1] / 255) * 2 - 1, (b[2] / 255) * 2 - 1],
        byName = { flat, turned, holes };
      for (const [name, normals] of Object.entries(byName)) {
        const pass = Lighting2D.attach(instance, { target: () => target, normals }),
          light = pass.addLight({ x: 9.7, y: 12.4, radius: 30, height: 12 });
        frame();
        const bytes = await read(normals);
        out.checks[`${name} normals`] = compare(
          await read(target),
          expected({
            lights: [light],
            normal: (x, y) => {
              const at = (y * WIDTH + x) * 4;
              return bytes[at + 3] ? decode(bytes.subarray(at, at + 3)) : [0, 0, 1];
            },
          }),
        );
        pass.dispose();
      }
      // The size mismatch names its fix.
      const small = texture('rgba8unorm', 4, 4),
        pass = Lighting2D.attach(instance, { target: () => target, normals: small });
      try {
        frame();
      } catch (error) {
        out.sizes = error.code;
      }
      pass.dispose();
      for (const t of [flat, turned, holes, small]) t.destroy();
    }

    // A sprite layer's normal target feeds the light, turned and flipped with its sprite.
    {
      const pixels = new Uint8Array(8 * 8 * 4).fill(255),
        bumps = new Uint8Array(8 * 8 * 4);
      for (let i = 0; i < 64; i++) bumps.set([200, 128, 200, 255], i * 4);
      const colour = texture(),
        normals = texture(),
        layer = SpriteLayer.attach(instance, {
          atlas: { width: 8, height: 8, data: pixels },
          target: () => colour,
          normals: { atlas: { width: 8, height: 8, data: bumps }, target: () => normals },
        }),
        sprite = layer.add({ x: 4, y: 4, rect: [0, 0, 8, 8], flipX: true });
      void sprite;
      const pass = Lighting2D.attach(instance, { target: () => target, normals: () => normals, order: 20 }),
        light = pass.addLight({ x: 10.3, y: 7.9, radius: 30, height: 8 });
      frame();
      const written = await read(normals);
      let covered = 0;
      const want = expected({
        lights: [light],
        normal: (x, y) => {
          const at = (y * WIDTH + x) * 4;
          if (!written[at + 3]) return [0, 0, 1];
          covered++;
          return [(written[at] / 255) * 2 - 1, (written[at + 1] / 255) * 2 - 1, (written[at + 2] / 255) * 2 - 1];
        },
      });
      out.checks['a sprite layer feeds its normals'] = compare(await read(target), want);
      out.checks['the sprite covers its pixels'] = { wrong: covered === 64 ? 0 : 1, covered };
      // Flipped in x: the map's +x points to -x on the screen.
      out.checks['flips follow the sprite'] = { wrong: written[(4 * WIDTH + 4) * 4] < 128 ? 0 : 1 };
      pass.dispose();
      layer.dispose();
      colour.destroy();
      normals.destroy();
    }

    // Another format, and a target that changes size.
    {
      const bgra = texture('bgra8unorm'),
        pass = Lighting2D.attach(instance, { target: () => bgra }),
        light = pass.addLight({ x: 11.2, y: 6.6, radius: 20, color: '#ff4020', height: 6 });
      frame();
      const bytes = await read(bgra);
      for (let i = 0; i < bytes.length; i += 4) [bytes[i], bytes[i + 2]] = [bytes[i + 2], bytes[i]];
      out.checks['a bgra8 target'] = compare(bytes, expected({ lights: [light] }));
      pass.dispose();
      bgra.destroy();
    }

    // Through a compositor: the layer below times the light, on the canvas.
    {
      const compositor = LayerCompositor.attach(instance, { camera: { width: WIDTH, height: HEIGHT, zoom: 2 } }),
        picture = compositor.addLayer(),
        shade = compositor.addLayer({ blend: 'multiply', z: 1 }),
        pass = Lighting2D.attach(instance, { target: shade.target, camera: shade.camera, ambient: '#404040' }),
        light = pass.addLight({ x: 16.4, y: 8.3, radius: 18, height: 8 }),
        base = new Uint8Array(WIDTH * HEIGHT * 4);
      for (let i = 0; i < WIDTH * HEIGHT; i++) base.set([200, 160, 120, 255], i * 4);
      picture.write({ width: WIDTH, height: HEIGHT, data: base });
      frame();
      const copy = document.createElement('canvas');
      copy.width = WIDTH * 2;
      copy.height = HEIGHT * 2;
      const ctx = copy.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0);
      const shown = ctx.getImageData(0, 0, WIDTH * 2, HEIGHT * 2).data,
        want = expected({ lights: [light], ambient: [64 / 255, 64 / 255, 64 / 255] }),
        tint = [200, 160, 120];
      let wrong = 0,
        first = null;
      for (let y = 0; y < HEIGHT * 2; y++)
        for (let x = 0; x < WIDTH * 2; x++)
          for (let c = 0; c < 3; c++) {
            const value = shown[(y * WIDTH * 2 + x) * 4 + c],
              sum = (want[((y >> 1) * WIDTH + (x >> 1)) * 3 + c] / 255) * tint[c];
            // Within 2/255: one for the light's own rounding, carried through the multiply, and one for the multiply's.
            if (Math.abs(value - sum) > 2) {
              wrong++;
              first ??= { x, y, c, value, sum };
            }
          }
      out.checks['multiplied through a compositor'] = { wrong, first };
      pass.dispose();
      compositor.dispose();
    }

    // Soft shadows check
    {
      const softTarget = texture();
      const wall = [{ shape: 'segment', from: [20.1, 3.2], to: [20.1, 11.3] }];
      const softPass = SoftLighting2D.attach(instance, {
        target: () => softTarget,
        ambient: '#000000',
        occluders: wall,
        sourceRadius: 4,
      });
      const softLamp = softPass.addLight({ x: 8.3, y: 7.2, radius: 40, height: 10, sourceRadius: 4, samples: 16 });
      frame();
      const bytes = await read(softTarget);
      const wantSoft = new Float64Array(WIDTH * HEIGHT * 3);
      const wallEdges = occluderEdges(wall);
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const wx = x + 0.5;
          const wy = y + 0.5;
          const add = softLightAt(softLamp, wx, wy, wallEdges, [0, 0, 1], { sourceRadius: 4, samples: 16 });
          for (let c = 0; c < 3; c++) wantSoft[(y * WIDTH + x) * 3 + c] = Math.min(1, add[c]) * 255;
        }
      }
      out.checks['soft shadows with penumbra'] = compare(bytes, wantSoft);
      softPass.dispose();
      softTarget.destroy();
    }
    {
      const cookieTarget = texture(),
        cookiePass = CookieLighting2D.attach(instance, { target: () => cookieTarget, ambient: '#000000' }),
        cookie = createSpotCookie(16, 0.4, 0.9),
        cookieLamp = cookiePass.addLight({
          x: 16,
          y: 8,
          radius: 20,
          height: 10,
          color: '#ffffff',
          intensity: 1,
          cookie,
          cookieScale: [20, 20],
          cookieMode: 'multiply',
        });
      frame();
      const bytes = await read(cookieTarget);
      const wantCookie = new Float64Array(WIDTH * HEIGHT * 3);
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const wx = x + 0.5;
          const wy = y + 0.5;
          const add = cookieLightAt(cookieLamp, wx, wy, [0, 0, 1]);
          for (let c = 0; c < 3; c++) wantCookie[(y * WIDTH + x) * 3 + c] = Math.min(1, add[c]) * 255;
        }
      }
      out.checks['cookie texture light shaping'] = compare(bytes, wantCookie);
      cookiePass.dispose();
      cookieTarget.destroy();
    }
    {
      const maskTarget = texture(),
        maskPass = Lighting2D.attach(instance, { target: () => maskTarget, ambient: '#000000', layer: 0b01 }),
        rectMask = { kind: 'rect', minX: 8, minY: 4, maxX: 24, maxY: 12 },
        matchingLight = maskPass.addLight({
          x: 16,
          y: 8,
          radius: 30,
          height: 10,
          color: '#ffffff',
          intensity: 1,
          layers: 0b01,
          mask: rectMask,
        }),
        ignoredLight = maskPass.addLight({
          x: 16,
          y: 8,
          radius: 30,
          height: 10,
          color: '#ffffff',
          intensity: 1,
          layers: 0b10,
        });
      frame();
      const bytes = await read(maskTarget);
      const wantMask = new Float64Array(WIDTH * HEIGHT * 3);
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const wx = x + 0.5;
          const wy = y + 0.5;
          const add = lightAt(matchingLight, wx, wy, [0, 0, 1], 0b01);
          for (let c = 0; c < 3; c++) wantMask[(y * WIDTH + x) * 3 + c] = Math.min(1, add[c]) * 255;
        }
      }
      out.checks['light mask and layer filtering'] = compare(bytes, wantMask);
      maskPass.dispose();
      maskTarget.destroy();
    }

    // 2D global illumination: radiance cascades bounce light and emissive sprites.
    {
      const giTarget = texture(),
        emitters = [{ x: 24, y: 8, radius: 4, color: [1, 0.6, 0.2], intensity: 2.0 }],
        occluders = [{ shape: 'segment', from: [16, -10], to: [16, 30] }],
        cascades = { cascades: 2, baseRays: 4, baseDistance: 16, bounces: 1, albedo: 0.8 },
        camera = { x: 16, y: 8, zoom: 1 },
        giPass = GILighting2D.attach(instance, {
          target: () => giTarget,
          camera,
          emitters,
          occluders,
          cascades,
          ambient: '#000000',
        });
      frame();
      const bytes = await read(giTarget);
      const wantGI = new Float64Array(WIDTH * HEIGHT * 3);
      const rc = new RadianceCascade2D(cascades);
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const wx = camera.x + (x + 0.5 - WIDTH * 0.5) / camera.zoom;
          const wy = camera.y + (y + 0.5 - HEIGHT * 0.5) / camera.zoom;
          const irr = rc.evaluateAt([wx, wy], undefined, { emitters, occluders });
          for (let c = 0; c < 3; c++) wantGI[(y * WIDTH + x) * 3 + c] = Math.min(1, irr[c]) * 255;
        }
      }
      out.checks['2d global illumination radiance cascades'] = compare(bytes, wantGI);
      giPass.dispose();
      giTarget.destroy();
    }

    // 2.5D height lighting and top-down self-shadowing
    {
      const heightTarget = texture(),
        camera = { x: 0, y: 0, zoom: 1 },
        occluders = [
          createHeightOccluder({
            shape: 'box',
            offset: [16, 8],
            width: 8,
            depth: 8,
            height: 12,
            elevation: 0,
            selfShadow: true,
          }),
        ],
        heightPass = HeightLighting2D.attach(instance, {
          target: heightTarget,
          camera,
          occluders,
          elevation: 0,
        }),
        light = heightPass.addLight({
          kind: 'point',
          x: 10,
          y: 8,
          radius: 30,
          height: 20,
          color: '#ffffff',
          intensity: 1.0,
        });

      frame();
      const bytes = await read(heightTarget);
      const wantHeight = new Float64Array(WIDTH * HEIGHT * 3);
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const wx = camera.x + (x + 0.5) / camera.zoom;
          const wy = camera.y + (y + 0.5) / camera.zoom;
          const rgb = heightLightAt(light, occluders, wx, wy, 0);
          for (let c = 0; c < 3; c++) wantHeight[(y * WIDTH + x) * 3 + c] = Math.min(1, rgb[c]) * 255;
        }
      }
      out.checks['2.5d height and self shadowing'] = compare(bytes, wantHeight);
      heightPass.dispose();
      heightTarget.destroy();
    }

    // Emissive sprites and bloom glow
    {
      const emissiveTarget = texture(),
        camera = { x: 0, y: 0, zoom: 1 },
        sprites = [
          new EmissiveSprite2D({
            x: 16,
            y: 8,
            shape: 'circle',
            radius: 4,
            glowRadius: 12,
            color: '#ffcc44',
            intensity: 1.5,
            bloomThreshold: 0.8,
            bloomStrength: 1.0,
          }),
        ],
        emissivePass = EmissiveLighting2D.attach(instance, {
          target: emissiveTarget,
          camera,
          sprites,
          bloom: true,
          bloomThreshold: 0.8,
          bloomIntensity: 1.0,
        });

      frame();
      const bytes = await read(emissiveTarget);
      const wantEmissive = new Float64Array(WIDTH * HEIGHT * 3);
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const wx = camera.x + (x + 0.5) / camera.zoom;
          const wy = camera.y + (y + 0.5) / camera.zoom;
          const rgb = emissiveLightAt(sprites[0], wx, wy);
          for (let c = 0; c < 3; c++) wantEmissive[(y * WIDTH + x) * 3 + c] = Math.min(1, rgb[c]) * 255;
        }
      }
      out.checks['emissive sprites and bloom glow'] = compare(bytes, wantEmissive);
      emissivePass.dispose();
      emissiveTarget.destroy();
    }
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    target.destroy();

    // A lost device: the pass makes its things again.
    {
      let lost = texture();
      const wallEdges = [{ shape: 'segment', from: [20.1, 3.2], to: [20.1, 11.3] }],
        pass = Lighting2D.attach(instance, { target: () => lost, occluders: wallEdges }),
        light = pass.addLight({ x: 8.3, y: 7.2, radius: 40, height: 10 });
      frame();
      const previous = engine.gpu;
      previous.destroy();
      await previous.lost;
      await engine.rebootDevice();
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      lost = texture();
      frame();
      out.checks['after device loss'] = compare(
        await read(lost),
        expected({ lights: [light], edges: occluderEdges(wallEdges) }),
      );
      pass.dispose();
    }
    out.errors = errors.splice(0);
    return out;
  },
};
window.ready = true;
