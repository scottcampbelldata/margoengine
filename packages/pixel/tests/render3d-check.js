// The page of render3d-check.mjs: read the view's colour and depth back, work out the outline on the CPU, compare bytes.
import { Camera, EngineKernel, PbrMaterial, box } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { LayerCompositor } from '/packages/pixel/dist/index.js';
import { outlineMask, Render3D, renderSpriteFrames } from '/packages/pixel/dist/render3d.js';

const SIZE = 32,
  canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [SIZE * 2, SIZE * 2] }),
  engine = engineRuntime(instance),
  errors = [];
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
const camera = new Camera({ position: [2.4, 2, 3], target: [0, 0, 0], fov: 40, near: 0.5, far: 50 }),
  mesh = instance
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: '#84d6bd', roughness: 0.6 }));

const read = async (texture, bytes = 4, aspect) => {
  const row = Math.ceil((texture.width * bytes) / 256) * 256,
    device = engine.gpu,
    buffer = device.createBuffer({
      size: row * texture.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture, ...(aspect ? { aspect } : {}) }, { buffer, bytesPerRow: row }, [
    texture.width,
    texture.height,
  ]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buffer.getMappedRange()),
    out = new Uint8Array(texture.width * texture.height * bytes);
  for (let y = 0; y < texture.height; y++)
    out.set(raw.subarray(y * row, y * row + texture.width * bytes), y * texture.width * bytes);
  buffer.destroy();
  return out;
};
const frameOf = async (render, withCamera = camera) => {
  const depthBytes = await read(render.depth, 4, 'depth-only'),
    length = Math.hypot(...withCamera.position.map((v, i) => withCamera.target[i] - v));
  return {
    depth: new Float32Array(depthBytes.buffer),
    width: render.width,
    height: render.height,
    matrix: Float64Array.from(withCamera.matrix),
    eye: withCamera.position,
    forward: withCamera.position.map((v, i) => (withCamera.target[i] - v) / length),
  };
};
const compare = (actual, expected, width = SIZE) => {
  let wrong = 0,
    first = null;
  for (let i = 0; i < expected.length; i += 4)
    for (let c = 0; c < 4; c++)
      if (actual[i + c] !== expected[i + c]) {
        wrong++;
        first ??= {
          x: (i / 4) % width,
          y: Math.floor(i / 4 / width),
          channel: c,
          actual: actual[i + c],
          expected: expected[i + c],
        };
        break;
      }
  return { wrong, first };
};
const outlined = (color, mask, rgb) => {
  const out = new Uint8Array(color);
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.set([...rgb, 255], i * 4);
  return out;
};
const count = (mask) => mask.reduce((a, b) => a + b, 0);

window.check = {
  async run() {
    const out = { checks: {} };
    {
      const early = new Render3D({ camera, width: SIZE, height: SIZE });
      try {
        void early.view;
      } catch (error) {
        out.notAttached = error.code;
      }
    }
    engine.gpu.pushErrorScope('validation');
    {
      const render = Render3D.attach(instance, { camera, width: SIZE, height: SIZE, outline: { crease: 0 } });
      instance.render({ delta: 0, views: [render.view] });
      const frame = await frameOf(render),
        color = await read(render.color),
        mask = outlineMask(frame, { crease: 0 });
      out.covered = frame.depth.reduce((n, d) => n + (d ? 1 : 0), 0);
      out.outlined = count(mask);
      out.checks['depth edges exact'] = compare(await read(render.output), outlined(color, mask, [0, 0, 0]));
      // Background keeps its transparent clear.
      let opaqueOutside = 0;
      for (let i = 0; i < frame.depth.length; i++) if (!frame.depth[i] && color[i * 4 + 3] !== 0) opaqueOutside++;
      out.checks['clear stays transparent'] = { wrong: opaqueOutside };

      render.outline = { color: '#ff8000', crease: 0.6 };
      instance.render({ delta: 0, views: [render.view] });
      const full = outlineMask(frame, { crease: 0.6 });
      out.creases = count(full) - count(mask);
      out.checks['creases and colour exact'] = compare(await read(render.output), outlined(color, full, [255, 128, 0]));

      render.outline = { depthEdge: 1000, crease: 0 };
      instance.render({ delta: 0, views: [render.view] });
      out.checks['a large depthEdge keeps only the silhouette'] = compare(
        await read(render.output),
        outlined(color, outlineMask(frame, { depthEdge: 1000, crease: 0 }), [0, 0, 0]),
      );

      render.outline = false;
      instance.render({ delta: 0, views: [render.view] });
      out.checks['outline off is the colour'] = compare(await read(render.output), color);
      render.dispose();
    }

    // Into a compositor layer, which draws the picture at 2x on the canvas.
    {
      const compositor = LayerCompositor.attach(instance, { camera: { width: SIZE, height: SIZE, zoom: 2 } }),
        layer = compositor.addLayer(),
        render = Render3D.attach(instance, { camera, width: SIZE, height: SIZE, target: layer.target }),
        view = {
          id: 'screen',
          camera,
          pixels: true,
          viewport: [0, 0, SIZE * 2, SIZE * 2],
          clear: { color: '#000000' },
          layers: 0,
        };
      instance.render({ delta: 0, views: [render.view, { ...view, layers: 1 }] });
      // The canvas is read before anything awaits: its frame is gone once the browser presents it.
      const copy = document.createElement('canvas');
      copy.width = copy.height = SIZE * 2;
      const ctx = copy.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0);
      const shown = ctx.getImageData(0, 0, SIZE * 2, SIZE * 2).data,
        picture = await read(layer.texture);
      let wrong = 0;
      for (let y = 0; y < SIZE * 2; y++)
        for (let x = 0; x < SIZE * 2; x++) {
          const a = (y * SIZE * 2 + x) * 4,
            s = ((y >> 1) * SIZE + (x >> 1)) * 4;
          // Only opaque pixels have one answer: empty ones show what the canvas view drew below.
          if (
            picture[s + 3] === 255 &&
            (shown[a] !== picture[s] || shown[a + 1] !== picture[s + 1] || shown[a + 2] !== picture[s + 2])
          )
            wrong++;
        }
      out.checks['through a compositor layer'] = { wrong };
      render.dispose();
      compositor.dispose();
    }

    // A sprite sheet: N frames of the right size, each what a single shot at that angle gives, and the mesh put back.
    {
      const angles = [0, Math.PI / 4, Math.PI / 8],
        before = mesh.rotation.y,
        sheet = renderSpriteFrames(instance, mesh, { camera, angles, width: 16, height: 16, columns: 2 });
      out.checks['sheet size and frames'] = {
        wrong:
          sheet.texture.width === 32 &&
          sheet.texture.height === 32 &&
          sheet.frames.length === 3 &&
          sheet.frames[2].x === 0 &&
          sheet.frames[2].y === 16
            ? 0
            : 1,
      };
      out.checks['mesh rotation restored'] = { wrong: mesh.rotation.y === before ? 0 : 1 };
      const bytes = await read(sheet.texture),
        single = Render3D.attach(instance, { camera, width: 16, height: 16 });
      for (let i = 0; i < angles.length; i++) {
        mesh.rotation.y = angles[i];
        instance.render({ delta: 0, views: [single.view] });
        const shot = await read(single.output),
          { x, y } = sheet.frames[i],
          cut = new Uint8Array(16 * 16 * 4);
        for (let row = 0; row < 16; row++)
          cut.set(bytes.subarray(((y + row) * 32 + x) * 4, ((y + row) * 32 + x + 16) * 4), row * 16 * 4);
        out.checks[`frame ${i} equals one shot`] = compare(cut, shot, 16);
        if (i) out.checks[`frame ${i} differs from frame 0`] = { wrong: compare(cut, out.frame0).wrong ? 0 : 1 };
        else out.frame0 = cut;
      }
      delete out.frame0;
      mesh.rotation.y = before;
      single.dispose();
      sheet.texture.destroy();
    }

    // A moving mesh leaves nothing behind on the transparent clear, and an opaque background fills what is empty.
    {
      const render = Render3D.attach(instance, { camera, width: SIZE, height: SIZE, outline: false }),
        at = mesh.position.x;
      instance.render({ delta: 0, views: [render.view] });
      mesh.position.x = at + 0.8;
      instance.render({ delta: 0, views: [render.view] });
      const frame = await frameOf(render),
        color = await read(render.color);
      let stale = 0;
      for (let i = 0; i < frame.depth.length; i++) if (!frame.depth[i] && color[i * 4 + 3] !== 0) stale++;
      out.checks['the clear repeats each frame'] = { wrong: stale };
      mesh.position.x = at;
      render.dispose();
      const solid = Render3D.attach(instance, {
        camera,
        width: SIZE,
        height: SIZE,
        outline: false,
        background: '#102030',
      });
      instance.render({ delta: 0, views: [solid.view] });
      const solidFrame = await frameOf(solid),
        bytes = await read(solid.output);
      let off = 0;
      for (let i = 0; i < solidFrame.depth.length; i++)
        if (!solidFrame.depth[i] && (bytes[i * 4] !== 16 || bytes[i * 4 + 1] !== 32 || bytes[i * 4 + 2] !== 48)) off++;
      out.checks['an opaque background'] = { wrong: off };
      solid.dispose();
    }

    // A view of another scene: the passes belong to that scene's frame graph.
    {
      const scene = instance.createScene('other'),
        other = scene
          .createMesh()
          .setGeometry(box())
          .setMaterial(new PbrMaterial({ color: '#d68484' })),
        render = Render3D.attach(instance, { camera, width: SIZE, height: SIZE, scene, outline: { crease: 0 } });
      void other;
      instance.render({ delta: 0, views: [render.view] });
      const frame = await frameOf(render),
        color = await read(render.color);
      out.checks['another scene'] = compare(
        await read(render.output),
        outlined(color, outlineMask(frame, { crease: 0 }), [0, 0, 0]),
      );
      out.otherScene = frame.depth.reduce((n, d) => n + (d ? 1 : 0), 0);
      render.dispose();
      scene.dispose();
    }
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;

    // Four samples per pixel on an engine without exactSize: a transparent clear and an outline from multisampled depth.
    {
      const big = document.createElement('canvas');
      big.width = big.height = 64;
      document.body.append(big);
      const four = await EngineKernel.create(big, { backend: 'webgpu' }),
        runtime = engineRuntime(four);
      four
        .createMesh()
        .setGeometry(box())
        .setMaterial(new PbrMaterial({ color: '#84d6bd' }));
      const device = runtime.gpu;
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      device.pushErrorScope('validation');
      const render = Render3D.attach(four, { camera, width: SIZE, height: SIZE, samples: 4 });
      four.render({ delta: 0, views: [render.view] });
      const texture = render.output,
        row = 256,
        buffer = device.createBuffer({ size: row * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [SIZE, SIZE]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const raw = new Uint8Array(buffer.getMappedRange()),
        alpha = (x, y) => raw[y * row + x * 4 + 3];
      out.fourSamples = {
        corner: alpha(0, 0),
        middle: alpha(SIZE >> 1, SIZE >> 1),
        validation: (await device.popErrorScope())?.message ?? null,
      };
      buffer.destroy();
      render.dispose();
      four.dispose();
    }

    // A lost device: the view and its textures come back.
    {
      const render = Render3D.attach(instance, { camera, width: SIZE, height: SIZE, outline: { crease: 0 } });
      instance.render({ delta: 0, views: [render.view] });
      const previous = engine.gpu;
      previous.destroy();
      await previous.lost;
      await engine.rebootDevice();
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      instance.render({ delta: 0, views: [render.view] });
      const frame = await frameOf(render),
        color = await read(render.color),
        mask = outlineMask(frame, { crease: 0 });
      out.checks['after device loss'] = compare(await read(render.output), outlined(color, mask, [0, 0, 0]));
      render.dispose();
    }
    out.errors = errors.splice(0);
    return out;
  },
};
window.ready = true;
