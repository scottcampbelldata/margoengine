// The page of browser-check.mjs: every frame is read back and compared byte for byte with an image composed on the CPU.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { Tonemap } from '/packages/tonemap/dist/index.js';
import { LayerCompositor, PixelCamera } from '/packages/pixel/dist/index.js';

const WIDTH = 64,
  HEIGHT = 32,
  BACKGROUND = [16, 32, 48, 255];
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};

/** An image of straight-alpha bytes from `color(x, y)`. */
const picture = (color, width = 16, height = 8) => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  return { width, height, data };
};
const texel = (image, x, y) =>
  x < 0 || y < 0 || x >= image.width || y >= image.height
    ? null
    : [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
const unique = (x, y) => [20 + x * 14, 30 + y * 25, 240 - x * 7 - y * 11, 255];
const base = picture(unique);
// Opaque blocks with holes and one half-see-through column.
const holes = picture((x, y) => {
  if (x === 5) return [200, 100, 60, 128];
  return (x + y) % 3 === 0 ? [250 - x * 9, 60 + y * 20, 90 + x * 5, 255] : [0, 0, 0, 0];
});
const line = picture((x, y) => (y === 3 && x >= 2 && x <= 13 ? [40 + x * 15, 240 - x * 10, 90, 255] : [0, 0, 0, 0]));

const blank = (color = BACKGROUND) => {
  const image = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < image.length; i += 4) image.set(color, i);
  return image;
};
const clampByte = (v) => Math.min(255, Math.round(v));
/** Writes one source texel over one output pixel, with the blend the compositor sets, on premultiplied colours. */
const put = (image, at, source, { opacity = 1, blend = 'normal' } = {}) => {
  const a = source[3] / 255,
    alpha = a * opacity;
  for (let c = 0; c < 3; c++) {
    const s = Math.round(source[c] * a) * opacity,
      d = image[at + c];
    image[at + c] =
      blend === 'add'
        ? clampByte(s + d)
        : blend === 'multiply'
          ? clampByte((s * d) / 255 + d * (1 - alpha))
          : blend === 'screen'
            ? clampByte(s + d * (1 - s / 255))
            : clampByte(s + d * (1 - alpha));
  }
};
/** Places `source` on the output with no turn: output pixel (x, y) shows texel floor((x - left - dx) / zoom). */
const compose = (
  image,
  source,
  { zoom = 4, left = 0, top = 0, width = 16, height = 8, dx = 0, dy = 0, ...mix } = {},
) => {
  for (let y = Math.max(0, top); y < Math.min(HEIGHT, top + height * zoom); y++)
    for (let x = Math.max(0, left); x < Math.min(WIDTH, left + width * zoom); x++) {
      const t = texel(source, Math.floor((x - left - dx) / zoom), Math.floor((y - top - dy) / zoom));
      if (t) put(image, (y * WIDTH + x) * 4, t, mix);
    }
  return image;
};
/** A quarter turn moved forward: each block pixel of the picture at 4x goes where turning it about the middle sends it. */
const turnedForward = (image, source, quarter) => {
  for (let y = 0; y < source.height * 4; y++)
    for (let x = 0; x < source.width * 4; x++) {
      const t = texel(source, Math.floor(x / 4), Math.floor(y / 4)),
        dx = x + 0.5 - 32,
        dy = y + 0.5 - 16;
      const [tx, ty] = quarter === 1 ? [-dy, dx] : quarter === 2 ? [-dx, -dy] : quarter === 3 ? [dy, -dx] : [dx, dy],
        outX = Math.floor(tx + 32),
        outY = Math.floor(ty + 16);
      if (outX >= 0 && outY >= 0 && outX < WIDTH && outY < HEIGHT) put(image, (outY * WIDTH + outX) * 4, t);
    }
  return image;
};
const difference = (actual, expected, channels = 3, within = 0) => {
  let wrong = 0,
    first = null;
  for (let i = 0; i < expected.length; i += 4)
    for (let c = 0; c < channels; c++)
      if (Math.abs(actual[i + c] - expected[i + c]) > within) {
        wrong++;
        first ??= {
          x: (i / 4) % WIDTH,
          y: Math.floor(i / 4 / WIDTH),
          channel: c,
          actual: actual[i + c],
          expected: expected[i + c],
        };
        break;
      }
  return { wrong, first };
};

const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:256px;height:128px;image-rendering:pixelated';
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [WIDTH, HEIGHT] }),
  engine = engineRuntime(instance),
  errors = [];
engine.scene.background = '#102030';
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

const readFrom = (from) => {
  const copy = document.createElement('canvas');
  copy.width = WIDTH;
  copy.height = HEIGHT;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(from, 0, 0);
  return context.getImageData(0, 0, WIDTH, HEIGHT).data;
};
const frame = (options) => {
  instance.render({ delta: 1 / 60, ...options });
  return readFrom(canvas);
};
const readTexture = async (texture) => {
  const row = Math.ceil((texture.width * 4) / 256) * 256,
    device = engine.gpu,
    buffer = device.createBuffer({
      size: row * texture.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [texture.width, texture.height]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buffer.getMappedRange()),
    out = new Uint8Array(texture.width * texture.height * 4);
  for (let y = 0; y < texture.height; y++)
    out.set(raw.subarray(y * row, y * row + texture.width * 4), y * texture.width * 4);
  buffer.destroy();
  return out;
};
const withCompositor = async (cameraOptions, run, options) => {
  const compositor = LayerCompositor.attach(instance, {
    camera: new PixelCamera({ width: 16, height: 8, ...cameraOptions }),
    ...options,
  });
  try {
    return await run(compositor);
  } finally {
    compositor.dispose();
  }
};

window.check = {
  size: () => [canvas.width, canvas.height],
  async run() {
    const out = { checks: {} },
      record = (name, result) => {
        out.checks[name] = result;
      };
    engine.gpu.pushErrorScope('validation');

    record('background', difference(frame(), blank()));

    await withCompositor({}, async (compositor) => {
      compositor.addLayer({ anchor: 'world' }).write(base);
      const expected = compose(blank(), base);
      record('one layer at 4x, zoom fitted', difference(frame(), expected));
      assert(compositor.camera.zoom === 4, 'fit found 4');
      const second = compositor.addLayer({ anchor: 'world' });
      second.write(holes);
      compose(expected, holes);
      record('two 16 x 8 layers at 4x', difference(frame(), expected));
      // Order: z first, then the order added.
      second.z = -1;
      record('z puts a layer below', difference(frame(), compose(compose(blank(), holes), base)));
      second.z = 0;
      second.visible = false;
      record('visible false', difference(frame(), compose(blank(), base)));
      compositor.removeLayer(second);
      record('removed layer', difference(frame(), compose(blank(), base)));
    });
    record('after dispose', difference(frame(), blank()));

    // Zoom below the fit: whole pixels, in the middle, with the background around it.
    await withCompositor({ zoom: 2 }, async (compositor) => {
      compositor.addLayer({ anchor: 'world' }).write(base);
      record('zoom 2 in the middle', difference(frame(), compose(blank(), base, { zoom: 2, left: 16, top: 8 })));
      compositor.camera.zoom = 3;
      record('zoom 3, middle rounds down', difference(frame(), compose(blank(), base, { zoom: 3, left: 8, top: 4 })));
      compositor.camera.zoom = 8;
      // Larger than the canvas: clipped, with no scissor error.
      record('zoom 8 clipped', difference(frame(), compose(blank(), base, { zoom: 8, left: -32, top: -16 })));
    });

    await withCompositor({}, async (compositor) => {
      const layer = compositor.addLayer({ anchor: 'world', x: 3, y: -1 });
      layer.write(base);
      record('layer offset', difference(frame(), compose(blank(), base, { dx: 12, dy: -4 })));
    });

    // Quarter turns against pixels moved forward, not the shader's formula.
    await withCompositor({}, async (compositor) => {
      const layer = compositor.addLayer({ anchor: 'world' });
      layer.write(line);
      for (const quarter of [1, 2, 3]) {
        layer.rotation = (quarter * Math.PI) / 2;
        record(`${quarter * 90} degrees of a 1-pixel line`, difference(frame(), turnedForward(blank(), line, quarter)));
      }
      layer.rotation = -Math.PI / 2;
      record('-90 degrees is 270', difference(frame(), turnedForward(blank(), line, 3)));
      layer.rotation = Math.PI * 2;
      record('360 degrees is none', difference(frame(), compose(blank(), line)));
    });

    // At zoom 1 about (7.5, 4), a quarter turn lands output pixels exactly on texel edges: quarter turns must be exact,
    // or cos(pi / 2) = 6e-17 tips them to the texel before.
    await withCompositor({ zoom: 1, width: 64, height: 32 }, async (compositor) => {
      const layer = compositor.addLayer({ anchor: 'world', pivot: [7.5, 4], rotation: Math.PI / 2 }),
        small = picture(unique, 15, 8);
      layer.write(small);
      const expected = blank();
      for (let oy = 0; oy < HEIGHT; oy++)
        for (let ox = 0; ox < WIDTH; ox++) {
          const qx = ox + 0.5 - 7.5,
            qy = oy + 0.5 - 4,
            t = texel(small, Math.floor(qy + 7.5), Math.floor(-qx + 4));
          if (t) put(expected, (oy * WIDTH + ox) * 4, t);
        }
      record('quarter turn with texel edges', difference(frame(), expected));
    });

    // 30 degrees: every output pixel is the source colour the turn names, or the background outside the picture.
    await withCompositor({}, async (compositor) => {
      compositor.addLayer({ anchor: 'world', rotation: Math.PI / 6 }).write(base);
      const actual = frame(),
        cos = Math.cos(Math.PI / 6),
        sin = Math.sin(Math.PI / 6);
      // Only a pixel a hair from a texel edge may land either way: the shader works in 32 bits, this in 64.
      const near = (w) => (Math.abs(w - Math.round(w)) < 1e-3 ? [Math.round(w) - 1, Math.round(w)] : [Math.floor(w)]);
      let wrong = 0,
        drawn = 0,
        first = null;
      for (let y = 0; y < HEIGHT; y++)
        for (let x = 0; x < WIDTH; x++) {
          const at = (y * WIDTH + x) * 4,
            pixel = [actual[at], actual[at + 1], actual[at + 2]],
            qx = x + 0.5 - 32,
            qy = y + 0.5 - 16,
            u = (qx * cos + qy * sin + 32) / 4,
            v = (qy * cos - qx * sin + 16) / 4,
            candidates = near(u)
              .flatMap((tu) => near(v).map((tv) => texel(base, tu, tv)))
              .map((t) => (t ? t.slice(0, 3) : BACKGROUND.slice(0, 3)));
          if (!candidates.some((c) => c.every((value, i) => value === pixel[i]))) {
            wrong++;
            first ??= { x, y, pixel, candidates };
          }
          if (texel(base, Math.floor(u), Math.floor(v))) drawn++;
        }
      record('30 degrees: only source colours', { wrong, drawn, first });
    });

    // Scrolling: a part of a pixel moves nothing until it reaches a whole one.
    await withCompositor({}, async (compositor) => {
      const layer = compositor.addLayer({ anchor: 'world' }),
        camera = compositor.camera;
      layer.write(base);
      const still = compose(blank(), base);
      for (const x of [0.5, 0.75, 0.99]) {
        camera.x = x;
        record(`scroll ${x} moves nothing`, difference(frame(), still));
      }
      camera.x = 1;
      record('scroll 1 moves one pixel', difference(frame(), compose(blank(), base, { dx: -4 })));
      camera.x = 0;
      for (let i = 0; i < 10; i++) camera.x += 0.1;
      record('ten steps of 0.1 move one pixel', difference(frame(), compose(blank(), base, { dx: -4 })));
      camera.x = 2.5;
      camera.y = 1.5;
      record('both axes', difference(frame(), compose(blank(), base, { dx: -8, dy: -4 })));
      camera.x = 3;
      camera.y = 0;
      layer.parallax = 0.5;
      record('parallax 0.5: 3 moves one', difference(frame(), compose(blank(), base, { dx: -4 })));
      camera.x = 4;
      record('parallax 0.5: 4 moves two', difference(frame(), compose(blank(), base, { dx: -8 })));
      layer.parallax = [0, 1];
      camera.y = 1;
      record('parallax per axis', difference(frame(), compose(blank(), base, { dy: -4 })));
    });

    // Two layers at their own parallax in one frame: each has its own uniform slot.
    await withCompositor({ x: 4 }, async (compositor) => {
      compositor.addLayer({ anchor: 'world', parallax: 0 }).write(base);
      compositor.addLayer({ anchor: 'world', parallax: 1 }).write(holes);
      record('two layers, two parallaxes', difference(frame(), compose(compose(blank(), base), holes, { dx: -16 })));
    });

    // Smooth: the rest of the scroll moves by whole output pixels.
    await withCompositor({ smooth: true }, async (compositor) => {
      const layer = compositor.addLayer({ anchor: 'world' }),
        camera = compositor.camera;
      layer.write(base);
      camera.x = 0.5;
      record('smooth 0.5 moves 2 output pixels', difference(frame(), compose(blank(), base, { dx: -2 })));
      camera.x = 0.25;
      record('smooth 0.25 moves 1 output pixel', difference(frame(), compose(blank(), base, { dx: -1 })));
      camera.x = 0.2;
      record('smooth 0.2 moves none', difference(frame(), compose(blank(), base)));
      camera.x = 1.5;
      record('smooth 1.5 moves 6 output pixels', difference(frame(), compose(blank(), base, { dx: -6 })));
      // A view layer draws whole pixels itself and has one spare pixel each way for the shift.
      const view = compositor.addLayer(),
        wide = picture(unique, 17, 9);
      view.write(wide);
      assert(view.texture.width === 17 && view.texture.height === 9, 'the spare pixel');
      assert(view.camera.x === 1, 'the drawer moves the whole pixel');
      camera.x = 0.5;
      compositor.removeLayer(layer);
      record(
        'smooth view layer shows its spare pixel',
        difference(frame(), compose(blank(), wide, { dx: -2, width: 17, height: 9, zoom: 4 })),
      );
    });

    // Opacity and blends over the background, on premultiplied colours.
    await withCompositor({}, async (compositor) => {
      const layer = compositor.addLayer({ anchor: 'world' });
      layer.write(holes);
      // A third, because thirds of whole bytes never land on x.5 with `add`, where the result is exact on any GPU.
      for (const [name, mix] of [
        ['add', { blend: 'add' }],
        ['add at 1/3', { blend: 'add', opacity: 1 / 3 }],
        ['multiply', { blend: 'multiply' }],
        ['screen', { blend: 'screen' }],
      ]) {
        layer.blend = mix.blend ?? 'normal';
        layer.opacity = mix.opacity ?? 1;
        record(name, difference(frame(), compose(blank(), holes, mix)));
      }
      // Source and alpha are both fractions of a byte here, and a GPU may round them to bytes before it blends (this RTX
      // does: 46 where unrounded maths gives 46.65), so this one is within 1. At opacity 1 they are whole bytes: exact above.
      layer.blend = 'normal';
      layer.opacity = 1 / 3;
      record('opacity 1/3, within 1', difference(frame(), compose(blank(), holes, { opacity: 1 / 3 }), 3, 1));
      layer.opacity = 0;
      record('opacity 0', difference(frame(), blank()));
      layer.opacity = 1.5;
      out.badOpacity = null;
      try {
        frame();
      } catch (error) {
        out.badOpacity = error.name;
      }
      layer.opacity = 1;
      assert(out.badOpacity === 'RangeError', 'an invalid opacity throws');
    });

    // The frame's own passes draw the target before the composite sees it, as a sprite layer does.
    await withCompositor({}, async (compositor) => {
      const layer = compositor.addLayer();
      const remove = engine.frameGraph.add({
        name: 'stub-drawer',
        order: 10,
        execute: (c) => {
          c.encoder
            .beginRenderPass({
              colorAttachments: [
                {
                  view: layer.target().createView(),
                  loadOp: 'clear',
                  clearValue: [64 / 255, 128 / 255, 192 / 255, 1],
                  storeOp: 'store',
                },
              ],
            })
            .end();
        },
      });
      record('a pass at order 10 draws the target', difference(frame(), blank([64, 128, 192, 255])));
      remove();
    });

    // A core view into a layer's target, then the canvas: the composite skips the target view, or it would read what it writes.
    await withCompositor({}, async (compositor) => {
      const layer = compositor.addLayer();
      const actual = frame({
          views: [
            {
              camera: engine.camera,
              viewport: [0, 0, 1, 1],
              target: { color: layer.texture },
              clear: { color: '#c08040' },
            },
            { camera: engine.camera, viewport: [0, 0, 1, 1] },
          ],
        }),
        bytes = await readTexture(layer.texture);
      record('core view into a layer', difference(actual, compose(blank(), { width: 16, height: 8, data: bytes })));
      out.viewTexel = [...bytes.subarray(0, 4)];
      assert(bytes[3] === 255 && bytes[0] > bytes[2], 'the view cleared the target to its colour');
    });

    // Two canvas views: each fits its own rectangle, with its own uniforms.
    await withCompositor({}, async (compositor) => {
      compositor.addLayer({ anchor: 'world' }).write(base);
      const camera = engine.camera,
        expected = compose(blank(), base, { zoom: 2, left: 0, top: 8 });
      compose(expected, base, { zoom: 2, left: 32, top: 8 });
      record(
        'two canvas views',
        difference(
          frame({
            views: [
              { camera, viewport: [0, 0, 0.5, 1] },
              { camera, viewport: [0.5, 0, 0.5, 1] },
            ],
          }),
          expected,
        ),
      );
      // A view whose layers share no bit with the compositor gets no composite.
      record('view layers', difference(frame({ views: [{ camera, viewport: [0, 0, 1, 1], layers: 2 }] }), blank()));
    });

    // A Tonemap at 31 grades what is drawn before it; order 40 keeps the bytes, as the README says.
    {
      const tonemap = Tonemap.attach(instance, {});
      await withCompositor(
        {},
        async (compositor) => {
          compositor.addLayer({ anchor: 'world' }).write(base);
          record('order 40 after a Tonemap', difference(frame(), compose(blank(), base)));
        },
        { order: 40 },
      );
      await withCompositor({}, async (compositor) => {
        compositor.addLayer({ anchor: 'world' }).write(base);
        const actual = frame(),
          at = (8 * WIDTH + 8) * 4;
        out.gradedAtOrder30 = [...actual.subarray(at, at + 3)];
      });
      tonemap.dispose();
    }

    // Real sprites in a layer, when that package is in this tree (browser-check.mjs insists once it is).
    const sprites = await fetch('/packages/sprites/dist/index.js').then((r) =>
      r.ok && /javascript/.test(r.headers.get('content-type') ?? '')
        ? import(/* @vite-ignore */ '/packages/sprites/dist/index.js')
        : null,
    );
    if (sprites)
      await withCompositor({ x: 2.5 }, async (compositor) => {
        const layer = compositor.addLayer(),
          group = sprites.SpriteLayer.attach(instance, { atlas: base, target: layer.target, camera: layer.camera });
        // World (5, 3), camera at pixel 2: pixel (3, 3) of the layer.
        group.add({ x: 5, y: 3, rect: [4, 2, 2, 2] });
        const small = picture(() => [0, 0, 0, 0]);
        for (let y = 0; y < 2; y++)
          for (let x = 0; x < 2; x++) small.data.set(texel(base, 4 + x, 2 + y), ((3 + y) * 16 + 3 + x) * 4);
        record('real sprite layer', difference(frame(), compose(blank(), small)));
        group.dispose();
      });

    // An engine with MSAA composites at its sample count: same picture, no validation error.
    {
      const other = document.createElement('canvas');
      other.style.cssText = 'width:64px;height:32px';
      document.body.append(other);
      const multi = await EngineKernel.create(other, { backend: 'webgpu' }),
        runtime = engineRuntime(multi);
      runtime.scene.background = '#102030';
      const compositor = LayerCompositor.attach(multi, { camera: { width: 16, height: 8 } });
      compositor.addLayer({ anchor: 'world' }).write(base);
      runtime.gpu.pushErrorScope('validation');
      let samples;
      const removeProbe = runtime.frameGraph.add({
        name: 'probe',
        order: 20,
        execute: (c) => {
          samples = c.descriptor.multisample?.count;
        },
      });
      multi.render({ delta: 1 / 60 });
      const actual = readFrom(other);
      await runtime.gpu.queue.onSubmittedWorkDone();
      const validation = await runtime.gpu.popErrorScope();
      removeProbe();
      out.msaa = { samples, validation: validation?.message ?? null, size: [other.width, other.height] };
      record('MSAA engine', difference(actual, compose(blank(), base)));
      compositor.dispose();
      multi.dispose();
      other.remove();
    }

    const validation = await engine.gpu.popErrorScope();
    out.validation = validation?.message ?? null;

    // A lost device: targets come back with the last picture written.
    {
      const compositor = LayerCompositor.attach(instance, { camera: { width: 16, height: 8 } }),
        layer = compositor.addLayer({ anchor: 'world' });
      layer.write(base);
      const first = layer.texture;
      frame();
      const previous = engine.gpu;
      previous.destroy();
      await previous.lost;
      await engine.rebootDevice();
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      record('after device loss', difference(frame(), compose(blank(), base)));
      assert(layer.texture !== first, 'a new target on the new device');
      compositor.dispose();
      record('dispose after device loss', difference(frame(), blank()));
    }

    out.errors = errors.splice(0);
    return out;
  },
};
window.ready = true;
