import { Painterly } from '../dist/paint.js';
import { reference } from './paint-reference.js';
import { Engine } from '/packages/core/dist/extension.js';
import { webglRenderer } from '/packages/webgl2-compat/dist/preview.js';
import { PostStack } from '/packages/post/dist/stack.js';

// Generated noise/step images are stand-ins. Every comparison runs on the real browser GPU.
export async function paintChecks() {
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  let comparisons = 0;
  const modules = [],
    errors = [];
  const watch = (device) => {
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const create = device.createShaderModule.bind(device);
    device.createShaderModule = (desc) => {
      const m = create(desc);
      modules.push(m);
      return m;
    };
  };
  const fixture = (w, h, flat = false, step = false) => {
    const data = new Uint8Array(w * h * 4);
    let state = 9381;
    for (let i = 0; i < data.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      data[i] = flat ? [64, 128, 192, 173][i % 4] : state >>> 24;
      if (step) data[i] = (Math.floor(i / 4) % w < w / 2 ? [24, 52, 76, 173] : [190, 210, 230, 91])[i % 4];
    }
    return data;
  };
  const compare = (actual, expected, w, h, rect = [0, 0, w, h], exact = false) => {
    for (let y = rect[1]; y < rect[1] + rect[3]; y++)
      for (let x = rect[0]; x < rect[0] + rect[2]; x++)
        for (let c = 0; c < 4; c++) {
          const i = 4 * (y * w + x) + c;
          // UNORM stores round once; the CPU uses double while WGSL uses f32, so allow one code of RGB error.
          assert(
            Math.abs(actual[i] - expected[i]) <= (c === 3 || exact ? 0 : 1),
            `paint pixel ${x},${y},${c}: ${actual[i]} != ${expected[i]}`,
          );
          comparisons++;
        }
  };
  const readback = async (d, texture, w, h, encoder) => {
    const pitch = Math.ceil((w * 4) / 256) * 256;
    const buffer = d.createBuffer({ size: pitch * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: pitch }, [w, h]);
    return async () => {
      await buffer.mapAsync(GPUMapMode.READ);
      const padded = new Uint8Array(buffer.getMappedRange()),
        out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) out.set(padded.subarray(y * pitch, y * pitch + w * 4), y * w * 4);
      buffer.unmap();
      buffer.destroy();
      return out;
    };
  };
  let d = await (await navigator.gpu.requestAdapter()).requestDevice();
  watch(d);
  const options = {},
    effect = new Painterly(options),
    stage = effect.joinStack(),
    // This numerical harness calls setup directly; it registers no scene plugin.
    host = () => ({ gpu: d, sceneOf: () => undefined });
  effect.setup(host());
  async function run(w, h, opts, { flat = false, step = false, views, samples = 1, bgra = false } = {}) {
    Object.keys(options).forEach((k) => delete options[k]);
    Object.assign(options, opts);
    const data = fixture(w, h, flat, step),
      input = d.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
    d.queue.writeTexture({ texture: input }, data, { bytesPerRow: w * 4 }, [w, h]);
    const format = bgra ? 'bgra8unorm' : 'rgba8unorm';
    const output = d.createTexture({
      size: [w, h],
      format,
      sampleCount: samples,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const resolved =
      samples === 1
        ? output
        : d.createTexture({
            size: [w, h],
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          });
    const encoder = d.createCommandEncoder(),
      inputView = input.createView(),
      outputView = output.createView();
    for (const [index, rect] of (views ?? [[0, 0, w, h]]).entries()) {
      const context = {
        backend: 'webgpu',
        device: d,
        encoder,
        width: w,
        height: h,
        ...(views ? { view: { id: `v${index}`, index, viewport: rect } } : {}),
      };
      stage.render(context, inputView, { view: outputView, format, multisample: { count: samples }, hdr: false });
    }
    if (samples > 1) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: outputView, resolveTarget: resolved.createView(), loadOp: 'load', storeOp: 'store' },
        ],
      });
      pass.end();
    }
    const get = await readback(d, resolved, w, h, encoder);
    d.queue.submit([encoder.finish()]);
    const actual = await get();
    if (bgra) for (let i = 0; i < actual.length; i += 4) [actual[i], actual[i + 2]] = [actual[i + 2], actual[i]];
    for (const rect of views ?? [[0, 0, w, h]])
      compare(actual, reference(data, w, h, opts, rect), w, h, rect, opts.strength === 0 || opts.enabled === false);
    input.destroy();
    output.destroy();
    if (resolved !== output) resolved.destroy();
    return { actual, data };
  }
  try {
    for (const mode of ['kuwahara', 'watercolour', 'sketch']) {
      for (const radius of [1, 3, 8]) {
        const { actual, data } = await run(13, 11, { mode, radius });
        assert(
          actual.some((v, i) => i % 4 !== 3 && v !== data[i]),
          `${mode} changes pixels`,
        );
      }
      await run(13, 11, { mode, strength: 0.35 });
      await run(13, 11, { mode, strength: 0 });
      await run(13, 11, { mode, enabled: false });
      await run(13, 11, { mode }, { flat: true });
      await run(1, 1, { mode, radius: 8 });
      await run(2, 3, { mode, radius: 8 });
      await run(
        13,
        11,
        { mode, radius: 3 },
        {
          views: [
            [0, 0, 6, 11],
            [6, 0, 7, 11],
          ],
        },
      );
      await run(13, 11, { mode }, { samples: 4, bgra: true });
    }
    for (const radius of [1, 3, 8]) {
      const { actual, data } = await run(13, 11, { mode: 'kuwahara', radius }, { step: true });
      compare(actual, data, 13, 11);
    }
    d.destroy();
    assert((await d.lost).reason === 'destroyed', 'real device loss');
    d = await (await navigator.gpu.requestAdapter()).requestDevice();
    watch(d);
    effect.onDeviceRestored(host());
    await run(7, 5, { mode: 'watercolour' });
    effect.dispose();
    effect.dispose();
    let terminal = false;
    try {
      effect.onDeviceRestored(host());
    } catch (e) {
      terminal = e.code === 'disposed';
    }
    assert(terminal, 'terminal restoration');
  } finally {
    effect.dispose();
    d.destroy();
  }

  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 24;
  const gl = await Engine.create(canvas, { backend: 'webgl2', fallback: webglRenderer });
  assert(gl.backend === 'webgl2', 'native WebGL2');
  let refused = false;
  try {
    Painterly.attach(gl);
  } catch (e) {
    refused = e.code === 'unsupported' && /https:/.test(e.message);
  }
  gl.dispose();
  assert(refused, 'WebGL2 coded linked refusal');

  // Engine + PostStack composition, resize and replacement device, reading both sides of the actual stage.
  const engine = await Engine.create(document.createElement('canvas'), { backend: 'webgpu' });
  let views = new WeakMap(),
    capture;
  const instrument = () => {
    watch(engine.gpu);
    views = new WeakMap();
    const create = engine.gpu.createTexture.bind(engine.gpu);
    engine.gpu.createTexture = (desc) => {
      const texture = create({
        ...desc,
        usage: desc.usage | ((desc.sampleCount ?? 1) === 1 ? GPUTextureUsage.COPY_SRC : 0),
      });
      const make = texture.createView.bind(texture);
      texture.createView = (desc) => {
        const v = make(desc);
        views.set(v, texture);
        return v;
      };
      return texture;
    };
  };
  instrument();
  engine.use({ name: 'paint-test', setup() {}, onDeviceRestored: instrument });
  const paint = new Painterly({ mode: 'watercolour' }),
    copy = new Painterly({ strength: 0 });
  copy.name = 'paint-test-copy';
  const draw = paint.draw.bind(paint);
  paint.draw = (c, input, output) => {
    draw(c, input, output);
    capture = Promise.all([
      readback(c.device, views.get(input), c.width, c.height, c.encoder),
      readback(c.device, views.get(output.view), c.width, c.height, c.encoder),
    ]);
  };
  const stack = PostStack.attach(engine, [paint, copy]);
  try {
    for (const [w, h, restore] of [
      [13, 11, false],
      [19, 7, false],
      [9, 9, true],
    ]) {
      if (restore) await engine.rebootDevice();
      engine.canvas.width = w;
      engine.canvas.height = h;
      engine.scene.background = '#406080';
      engine.render({ delta: 1 / 60 });
      assert(engine.canvas.width === w && engine.canvas.height === h, 'engine resize dimensions');
      const gets = await capture;
      const [source, actual] = await Promise.all(gets.map((get) => get()));
      compare(
        actual,
        reference(source, engine.canvas.width, engine.canvas.height, paint.options),
        engine.canvas.width,
        engine.canvas.height,
      );
    }
  } finally {
    stack.dispose();
    engine.dispose();
  }
  for (const module of modules)
    assert(!(await module.getCompilationInfo()).messages.some((m) => m.type === 'error'), 'shader compiles');
  assert(!errors.length, errors.join('\n'));
  return {
    comparisons,
    shaders: modules.length,
    webgl2: 'coded unsupported with help link',
    deviceLoss: 'real replacement device',
    integration: 'Engine/PostStack resize and restore',
  };
}
