// The page side of the shot tool: an init script installed before any of the page's own code runs. It puts the page
// on the shot's clock, so a frame is drawn only when the tool asks for it and every frame is the same on every render:
// - requestAnimationFrame callbacks wait in a queue the tool runs, each told the shot's time; performance.now(),
//   Date.now() and new Date() read that time too, never the wall clock.
// - Math.random is a seeded generator (mulberry32), seeded by the shot.
// - Work the page starts on the GPU or the network (buffer maps, pipelines compiled in the background, queue fences,
//   fetches, image decodes) is tracked, and the tool lets all of it settle after each frame, so a readback started in
//   frame N is always delivered before frame N + 1, however fast the machine is.
// - The shot's MSAA (`msaa` 1 or 4) is forced through what core reads to choose its scene samples, whatever the
//   page's quality tier sets.
// - capture() copies the canvas in the same task the frame was drawn in, before the browser presents it. A WebGPU
//   canvas is read from its own texture on the GPU (the driver adds COPY_SRC to the canvas configuration), so frames do
//   not depend on the browser compositing the canvas: in a session with no desktop, such as a Windows SSH session, the
//   compositor's copy is black while the GPU draws normally. Other canvases (WebGL2) are copied with drawImage.
//   The canvas renders at the shot's size times its supersampling; sub-frames add up in linear light, and the kept
//   frame is their area-filtered mean at the shot's size, encoded once to 8 bits with a blue-noise dither (pixels.js,
//   installed beside this as globalThis.__margoShotPixels). One sub-frame of an 8-bit canvas at the shot's own size
//   is kept as its bytes are.
// - masks() reads the shot's masks (AOVs) from textures the page gives, through a blit of their first channel into a
//   texture of its own, and works out the sky and water masks from the geometry mask and the camera; recordSky() and
//   skyCoverage() read the pixels the engine's sky drew (@margoengine/sky's coverage record) the same way.
// One self-contained function: Playwright serialises it into the page (page.addInitScript).

/**
 * @param {{ seed: number, start: number, epoch: number, cell: [number, number], cells: number, out: [number, number], msaa: 1 | 4 | null, noise: number[], noiseSize: number }} options
 * `start` is the clock's first reading in milliseconds, `epoch` what Date.now() adds to it; `cell` is one contact
 * sheet thumbnail's size and `cells` how many the sheet holds; `out` is the kept frame's size, `msaa` the forced
 * scene samples (null: the tier's own) and `noise` the blue-noise dither ranks of a `noiseSize` square.
 */
export function installShotDriver({ seed, start, epoch, cell, cells, out, msaa, noise, noiseSize }) {
  if (globalThis.__margoShot) return;
  // Core draws its scene passes with one sample when globalThis.margoLow (the light tier's pixel-ratio cap) is set and
  // four when it is not, and @margoengine/quality sets or deletes it for the tier before the engine is made. An
  // accessor on the window's prototype answers every read whatever the page sets or deletes on the window itself (a
  // delete finds no own property, a write calls the setter), so the shot's count holds from the engine's creation on.
  // The browser's pixel ratio is 1, so a cap of 1 changes no size.
  if (msaa) {
    let asked;
    Object.defineProperty(Object.getPrototypeOf(globalThis), 'margoLow', {
      configurable: true,
      get: () => (msaa === 1 ? 1 : undefined),
      set: (value) => {
        asked = value;
      },
    });
    Object.defineProperty(globalThis, '__margoShotAskedLow', { get: () => asked });
  }
  // mulberry32: a 32-bit state, a full period of 2^32, and the same stream from the same seed on every machine.
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  let now = start;
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true, writable: true });
  const RealDate = Date;
  class ShotDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(epoch + now);
    }
    static now() {
      return epoch + now;
    }
  }
  globalThis.Date = ShotDate;

  let queue = new Map(),
    next = 1;
  globalThis.requestAnimationFrame = (callback) => {
    const id = next++;
    queue.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => void queue.delete(id);

  const pending = new Set();
  const track = (promise) => {
    if (promise && typeof promise.then === 'function') {
      pending.add(promise);
      const done = () => pending.delete(promise);
      promise.then(done, done);
    }
    return promise;
  };
  const wrap = (owner, name) => {
    const original = owner?.[name];
    if (typeof original !== 'function') return;
    owner[name] = function (...args) {
      return track(original.apply(this, args));
    };
  };
  const devices = new Set();
  // The GPU interfaces are patched where the page's devices live. In a forced-compatibility run
  // (scripts/support/compat-shim.js, MARGO_COMPAT=1) the WebGL2 layer's classes replace the browser's own on the first
  // requestAdapter(), so a patch of the browser's classes now would track nothing the page does: no device, no map, no
  // canvas texture, and a readback could land after the next frame on one render and before it on the other
  // (KB-SHOT-COMPAT-DET1). The patch then waits on the shim's `__margoOnLayer` queue and runs on the layer's classes.
  const patchDevices = () => {
    if (typeof GPUAdapter === 'undefined') return;
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = function (...args) {
      return track(
        request.apply(this, args).then((device) => {
          devices.add(device);
          device.lost.then(() => devices.delete(device));
          return device;
        }),
      );
    };
    wrap(GPUBuffer.prototype, 'mapAsync');
    wrap(GPUDevice.prototype, 'createRenderPipelineAsync');
    wrap(GPUDevice.prototype, 'createComputePipelineAsync');
    wrap(GPUDevice.prototype, 'popErrorScope');
    wrap(GPUQueue.prototype, 'onSubmittedWorkDone');
    wrap(GPUShaderModule.prototype, 'getCompilationInfo');
  };
  wrap(globalThis, 'fetch');
  wrap(globalThis, 'createImageBitmap');
  for (const name of ['arrayBuffer', 'blob', 'json', 'text']) wrap(globalThis.Response?.prototype, name);
  wrap(globalThis.HTMLImageElement?.prototype, 'decode');

  // Real timers, kept before any page code can replace them: settle() waits a task between checks.
  const realTimeout = setTimeout.bind(globalThis),
    realClear = clearTimeout.bind(globalThis),
    task = () => new Promise((resolve) => realTimeout(resolve, 0));
  const sheet = document.createElement('canvas'),
    frame = document.createElement('canvas'),
    scratch = document.createElement('canvas');
  let sheetContext, frameContext, scratchContext;
  // The running sum of a kept frame's sub-frames in linear light (pixels.js addSubframe), and how many it holds.
  let sum = null,
    summed = 0;

  const get = (path) => path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), globalThis);

  // WebGPU canvases: each context's device and format from configure(), and the texture the page drew this frame.
  const canvases = new WeakMap();
  let frameSerial = 0;
  const patchCanvases = () => {
    if (typeof GPUCanvasContext === 'undefined') return;
    const configure = GPUCanvasContext.prototype.configure,
      current = GPUCanvasContext.prototype.getCurrentTexture;
    GPUCanvasContext.prototype.configure = function (config) {
      canvases.set(this.canvas, { device: config.device, format: config.format, texture: null, serial: -1 });
      return configure.call(this, { ...config, usage: (config.usage ?? 0x10) | 0x01 });
    };
    GPUCanvasContext.prototype.getCurrentTexture = function () {
      const texture = current.call(this),
        record = canvases.get(this.canvas);
      if (record) {
        record.texture = texture;
        record.serial = frameSerial;
      }
      return texture;
    };
  };
  const patchGPU = () => {
    patchDevices();
    patchCanvases();
  };
  if (globalThis.__margoCompat) (globalThis.__margoOnLayer ??= []).push(patchGPU);
  else patchGPU();
  /**
   * Starts the copy of the texture a WebGPU canvas drew this frame, in this task; resolves its RGBA bytes over black
   * (`rgba`), or for `rgba16float` its half floats (`half`, `stride` 16-bit words a row), row 0 at the top. Null when
   * the canvas is not a WebGPU canvas drawn this frame.
   */
  const readCanvas = (source) => {
    const record = canvases.get(source);
    if (!record?.texture || record.serial !== frameSerial) return null;
    const { device, format, texture } = record,
      { width, height } = texture,
      texel = { bgra8unorm: 4, rgba8unorm: 4, rgba16float: 8 }[format];
    if (!texel) throw new Error(`the canvas format ${format} is not one the shot tool reads; use bgra8unorm, rgba8unorm or rgba16float`);
    const bytesPerRow = Math.ceil((width * texel) / 256) * 256,
      buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 }),
      encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    return buffer.mapAsync(1).then(() => {
      const data = buffer.getMappedRange();
      if (format === 'rgba16float') {
        const half = new Uint16Array(data).slice();
        buffer.unmap();
        buffer.destroy();
        return { width, height, half, stride: bytesPerRow / 2 };
      }
      const rgba = new Uint8ClampedArray(width * height * 4);
      {
        const bytes = new Uint8Array(data),
          [r, b] = format === 'bgra8unorm' ? [2, 0] : [0, 2];
        for (let y = 0; y < height; y++)
          for (let x = 0, at = y * bytesPerRow, to = y * width * 4; x < width; x++, at += 4, to += 4) {
            rgba[to] = bytes[at + r];
            rgba[to + 1] = bytes[at + 1];
            rgba[to + 2] = bytes[at + b];
            rgba[to + 3] = 255;
          }
      }
      buffer.unmap();
      buffer.destroy();
      return { width, height, rgba };
    });
  };

  // Mask readback: one full-screen triangle per mask copies the texture's first channel (or its depth) into an
  // r32float target with textureLoad, so any single-sample float, normalised or depth texture with TEXTURE_BINDING
  // reads back, whatever its own copy usage and format.
  const readers = new WeakMap();
  const reader = (device) => {
    let found = readers.get(device);
    if (found) return found;
    const make = (sampleType, type, load) => {
      const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 2, texture: { sampleType } }] }),
        module = device.createShaderModule({
          code: `@group(0) @binding(0) var source:${type};
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));return vec4f(p*2.0-1.0,0.0,1.0);}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f{return vec4f(${load},0.0,0.0,1.0);}`,
        });
      const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
        primitive: { topology: 'triangle-list' },
      });
      return { layout, pipeline };
    };
    found = {
      color: make('unfilterable-float', 'texture_2d<f32>', 'textureLoad(source,vec2i(p.xy),0).r'),
      depth: make('depth', 'texture_depth_2d', 'textureLoad(source,vec2i(p.xy),0)'),
    };
    readers.set(device, found);
    return found;
  };
  /** A texture's first channel as 8-bit grey, row 0 at the top: 0 to 1 maps to 0 to 255, NaN and below 0 to 0. */
  const readMask = async (device, name, texture) => {
    if (!texture || typeof texture.createView !== 'function') throw new Error(`the page gave no texture for the ${name} mask`);
    if (texture.sampleCount > 1 || texture.dimension !== '2d')
      throw new Error(`the ${name} mask must be a single-sample 2D texture (it is ${texture.sampleCount}x ${texture.dimension})`);
    if (!(texture.usage & 4)) throw new Error(`the ${name} mask texture needs TEXTURE_BINDING usage to be read`);
    const depth = texture.format.startsWith('depth'),
      { layout, pipeline } = reader(device)[depth ? 'depth' : 'color'],
      { width, height } = texture,
      bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    device.pushErrorScope('validation');
    const target = device.createTexture({ size: [width, height], format: 'r32float', usage: 0x10 | 0x01 }),
      buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 }),
      view = texture.createView({ dimension: '2d', mipLevelCount: 1, arrayLayerCount: 1, ...(depth ? { aspect: 'depth-only' } : {}) }),
      encoder = device.createCommandEncoder(),
      pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout, entries: [{ binding: 0, resource: view }] }));
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    const error = await device.popErrorScope();
    if (error) {
      target.destroy();
      buffer.destroy();
      throw new Error(`the ${name} mask (${texture.format}) cannot be read: ${error.message}`);
    }
    await buffer.mapAsync(1);
    const data = new Float32Array(buffer.getMappedRange()),
      grey = new Uint8Array(width * height),
      stride = bytesPerRow / 4;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const v = data[y * stride + x];
        grey[y * width + x] = v > 0 ? (v >= 1 ? 255 : Math.round(v * 255)) : 0;
      }
    buffer.unmap();
    buffer.destroy();
    target.destroy();
    return { width, height, grey };
  };
  /**
   * Sky and water from the geometry mask: a pixel with no geometry (below 128) is water when its view ray through the
   * pixel centre meets the plane y = `level` in front of the camera, and sky when it does not. Perspective cameras.
   */
  const splitHorizon = ({ width, height, grey }, camera, level) => {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
      cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
      unit = (a) => {
        const l = Math.hypot(a[0], a[1], a[2]);
        return [a[0] / l, a[1] / l, a[2] / l];
      };
    const eye = [...camera.position],
      f = unit(sub([...camera.target], eye)),
      r = unit(cross(f, [...(camera.up ?? [0, 1, 0])])),
      u = cross(r, f),
      t = Math.tan((camera.fov * Math.PI) / 360),
      aspect = width / height,
      rise = level - eye[1],
      sky = new Uint8Array(width * height),
      water = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const ny = (1 - (2 * (y + 0.5)) / height) * t;
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (grey[i] >= 128) continue;
        const dy = f[1] + r[1] * ((2 * (x + 0.5)) / width - 1) * t * aspect + u[1] * ny;
        (dy !== 0 && rise / dy > 0 ? water : sky)[i] = 255;
      }
    }
    return { sky: { width, height, grey: sky }, water: { width, height, grey: water } };
  };
  const maskCanvas = document.createElement('canvas');
  const hex = async (bytes) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  // The masks after a frame, name to {width, height, grey} at the canvas size, taken to the frame's size: a
  // supersampled render's masks are area filtered, so an edge pixel holds the share of it each mask covers. Resolves
  // name: {sha256 of the grey bytes, mean 0 to 1, png in base64 when `png`}.
  const pack = async (read, png) => {
    const result = {};
    for (const name of Object.keys(read)) {
      const width = out[0],
        height = out[1],
        grey = globalThis.__margoShotPixels.resampleMask({ ...read[name], outWidth: width, outHeight: height });
      let sum = 0;
      for (let i = 0; i < grey.length; i++) sum += grey[i];
      result[name] = { sha256: await hex(grey), mean: sum / (255 * grey.length) };
      if (png) {
        if (maskCanvas.width !== width || maskCanvas.height !== height) {
          maskCanvas.width = width;
          maskCanvas.height = height;
        }
        const context = maskCanvas.getContext('2d', { alpha: false }),
          image = context.createImageData(width, height);
        for (let i = 0; i < grey.length; i++) {
          image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = grey[i];
          image.data[i * 4 + 3] = 255;
        }
        context.putImageData(image, 0, 0);
        result[name].png = await encode(maskCanvas);
      }
    }
    return result;
  };
  // The engine's sky that records its coverage (`@margoengine/sky`): the plugin of its scene with a coverageTexture.
  const skyOf = (engine) => {
    const plugins = get(engine)?.scene?.plugins;
    if (plugins) for (const plugin of plugins.values()) if (plugin && 'coverageTexture' in plugin && plugin.options) return plugin;
  };
  globalThis.__margoShot = {
    get time() {
      return now;
    },
    get pending() {
      return pending.size;
    },
    get queued() {
      return queue.size;
    },
    get,
    /** Runs the queued frame callbacks at `time` milliseconds; returns how many ran. */
    frame(time) {
      now = time;
      frameSerial++;
      const run = queue;
      queue = new Map();
      for (const callback of run.values()) callback(time);
      return run.size;
    },
    /**
     * Waits until no tracked work is in flight across two checks a task apart: the GPU queues done, every map,
     * pipeline and fetch settled, and what their handlers started settled too. Throws past `rounds` checks.
     */
    async settle(rounds = 400, limitMs = 120_000) {
      let timer;
      // wall-clock: a bound on a wait that normally ends in milliseconds; it fails the shot naming what hung.
      const stuck = new Promise((_, reject) => {
          timer = realTimeout(
            () => reject(new Error(`${pending.size} GPU or network operations were still in flight after ${limitMs} ms`)),
            limitMs,
          );
        }),
        waits = (work) => Promise.race([work, stuck]);
      stuck.catch(() => {});
      try {
        for (let round = 0, calm = 0; round < rounds; round++) {
          await waits(Promise.allSettled([...devices].map((device) => device.queue.onSubmittedWorkDone())));
          while (pending.size) await waits(Promise.allSettled([...pending]));
          await task();
          calm = pending.size ? 0 : calm + 1;
          if (calm >= 2) return round;
        }
      } finally {
        realClear(timer);
      }
      throw new Error(`the page kept starting GPU or network work for ${rounds} checks after a frame`);
    },
    /**
     * Copies `canvas` as the viewer sees it (over black) as sub-frame `sub` of `subs` of the kept frame. Call in the
     * same task as frame(): after it, the browser presents the canvas and the drawing is gone. The copy starts in this
     * task. The last sub-frame makes the kept frame (hash(), png()). Resolves the frame's size, the canvas's (`render`),
     * how it was read (`gpu` for a WebGPU canvas read from its texture, `2d` otherwise) and whether the frame is done.
     */
    async capture(selector, { sub = 0, subs = 1 } = {}) {
      const source = document.querySelector(selector);
      if (!source) throw new Error(`no canvas matches ${selector}`);
      const reading = readCanvas(source),
        width = source.width,
        height = source.height,
        via = reading ? 'gpu' : '2d';
      if (frame.width !== out[0] || frame.height !== out[1]) {
        frame.width = out[0];
        frame.height = out[1];
        frameContext = frame.getContext('2d', { alpha: false, willReadFrequently: true });
      }
      let pixels;
      if (reading) {
        pixels = await reading;
        if (pixels.width !== width || pixels.height !== height)
          throw new Error(`the canvas texture is ${pixels.width} x ${pixels.height}, the canvas ${width} x ${height}`);
      } else {
        if (scratch.width !== width || scratch.height !== height) {
          scratch.width = width;
          scratch.height = height;
          scratchContext = scratch.getContext('2d', { alpha: false, willReadFrequently: true });
        }
        scratchContext.fillStyle = '#000';
        scratchContext.fillRect(0, 0, width, height);
        scratchContext.drawImage(source, 0, 0);
        pixels = { width, height, rgba: scratchContext.getImageData(0, 0, width, height).data };
      }
      const result = (done) => ({ size: [...out], render: [width, height], via, done });
      // One sub-frame of 8-bit pixels at the frame's own size: the bytes as they are.
      if (subs === 1 && pixels.rgba && width === out[0] && height === out[1]) {
        frameContext.putImageData(new ImageData(pixels.rgba, width, height), 0, 0);
        return result(true);
      }
      const P = globalThis.__margoShotPixels;
      if (sub === 0) {
        sum = new Float32Array(width * height * 3);
        summed = 0;
      }
      if (!sum || sum.length !== width * height * 3) throw new Error(`sub-frame ${sub} of ${subs} changed the canvas size to ${width} x ${height}`);
      P.addSubframe(sum, pixels);
      summed++;
      if (sub < subs - 1) return result(false);
      if (summed !== subs) throw new Error(`the frame summed ${summed} sub-frames, not ${subs}`);
      const rgba = P.resolveFrame({ sum, width, height, count: subs, outWidth: out[0], outHeight: out[1], noise, noiseSize });
      frameContext.putImageData(new ImageData(rgba, out[0], out[1]), 0, 0);
      sum = null;
      return result(true);
    },
    /** What core reads to pick its scene samples now: 1 or 4 (sceneSamples of an engine without exactSize). */
    get samples() {
      return globalThis.margoLow || /Mobi|Android/.test(navigator.userAgent) ? 1 : 4;
    },
    /** SHA-256 of the RGBA bytes of the last capture, as hex. */
    async hash() {
      const pixels = frameContext.getImageData(0, 0, frame.width, frame.height).data,
        digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    },
    /** The last capture as PNG bytes, in base64. */
    png: () => encode(frame),
    /**
     * The shot's masks after a frame: `hook` (a page function) gives {device, textures: {name: GPUTexture}} for the
     * masks the page draws; `derived` names sky and water, worked out from `geometry` and the engine's camera with
     * the plane y = `horizon.y`. Resolves name: {sha256 of the grey bytes, mean 0 to 1, png in base64 when `png`}.
     */
    async masks({ hook, names, derived, horizon, engine, png }) {
      const give = get(hook);
      if (typeof give !== 'function') throw new Error(`${hook} is not a function in the page`);
      const given = await give({ names: names.filter((name) => !derived.includes(name)) });
      if (!given?.device || !given.textures) throw new Error(`${hook} must return {device, textures: {name: GPUTexture}}`);
      const read = {};
      for (const name of names) if (!derived.includes(name)) read[name] = await readMask(given.device, name, given.textures[name]);
      if (derived.length) {
        const camera = get(engine)?.camera;
        if (!camera) throw new Error(`no engine camera at ${engine} for the sky and water masks`);
        const split = splitHorizon(read.geometry, camera, horizon.y);
        for (const name of derived) read[name] = split[name];
      }
      return pack(Object.fromEntries(names.map((name) => [name, read[name]])), png);
    },
    /**
     * Switches on the coverage record of the engine's sky (`@margoengine/sky`'s `coverage` option), a plugin with a
     * `coverageTexture`, before a frame; true when the engine has such a sky. The record changes no pixel of the frame.
     */
    recordSky(engine) {
      const sky = skyOf(engine);
      if (sky && !sky.options.coverage) sky.options.coverage = true;
      return !!sky;
    },
    /**
     * The `sky-coverage` mask after a kept frame: the pixels the engine's sky drew, read and resampled as `masks` reads
     * a page mask. Resolves {'sky-coverage': {sha256, mean, png}} or null when the engine has no sky or no record yet.
     */
    async skyCoverage({ engine, png }) {
      const sky = skyOf(engine),
        texture = sky?.coverageTexture,
        device = get(engine)?.gpu;
      if (!texture || !device) return null;
      return pack({ 'sky-coverage': await readMask(device, 'sky-coverage', texture) }, png);
    },
    /** Puts the last capture into contact sheet thumbnail `index`. */
    thumbnail(index) {
      const columns = Math.min(cells, 4);
      if (!sheetContext) {
        sheet.width = cell[0] * columns;
        sheet.height = cell[1] * Math.ceil(cells / columns);
        sheetContext = sheet.getContext('2d', { alpha: false });
        sheetContext.fillStyle = '#000';
        sheetContext.fillRect(0, 0, sheet.width, sheet.height);
        sheetContext.imageSmoothingQuality = 'high';
      }
      sheetContext.drawImage(frame, (index % columns) * cell[0], Math.floor(index / columns) * cell[1], cell[0], cell[1]);
    },
    /** The contact sheet as PNG bytes in base64, or null when no thumbnail was drawn. */
    sheet: () => (sheetContext ? encode(sheet) : null),
  };
  const encode = (canvas) =>
    new Promise((resolve, reject) =>
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('the browser could not encode the frame as PNG'));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }, 'image/png'),
    );
}
