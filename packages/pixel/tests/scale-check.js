// The page of scale-check.mjs: each picture is read back and compared with the filter's maths worked out on the CPU in
// float64 here: nearest byte for byte, the mixing filters within one step of 255 (the GPU mixes in float32).
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { PixelScale } from '/packages/pixel/dist/scale.js';

const SW = 7,
  SH = 5,
  canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [40, 30] }),
  engine = engineRuntime(instance),
  errors = [];
engine.scene.background = '#102030';
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

// A diagonal stair of one colour on a field of another, a block and one half-covered texel (premultiplied).
const picture = (() => {
  const data = new Uint8Array(SW * SH * 4);
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      const c = x === y + 1 ? [240, 200, 40, 255] : x >= 5 && y >= 3 ? [30, 140, 220, 255] : [20, 60, 30, 255];
      data.set(c, (y * SW + x) * 4);
    }
  data.set([100, 20, 60, 128], (4 * SW + 0) * 4);
  return data;
})();
const texture = (width, height, data) => {
  const t = engine.gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC,
  });
  if (data) engine.gpu.queue.writeTexture({ texture: t }, data, { bytesPerRow: width * 4 }, [width, height]);
  return t;
};
const read = async (t) => {
  const row = Math.ceil((t.width * 4) / 256) * 256,
    buffer = engine.gpu.createBuffer({
      size: row * t.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
    encoder = engine.gpu.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: t }, { buffer, bytesPerRow: row }, [t.width, t.height]);
  engine.gpu.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buffer.getMappedRange()),
    out = new Uint8Array(t.width * t.height * 4);
  for (let y = 0; y < t.height; y++) out.set(raw.subarray(y * row, y * row + t.width * 4), y * t.width * 4);
  buffer.destroy();
  return out;
};

// The reference. Scale2x: a corner takes its two neighbours toward it when they match and the other two differ.
const texel = (x, y) => {
  const at = (Math.min(SH - 1, Math.max(0, y)) * SW + Math.min(SW - 1, Math.max(0, x))) * 4;
  return [...picture.subarray(at, at + 4)];
};
const same = (a, b) => a.every((v, i) => v === b[i]);
const doubled = (jx, jy) => {
  const x = Math.floor(jx / 2),
    y = Math.floor(jy / 2),
    right = jx % 2,
    bottom = jy % 2,
    e = texel(x, y),
    b = texel(x, y - 1),
    h = texel(x, y + 1),
    d = texel(x - 1, y),
    f = texel(x + 1, y),
    side = right ? f : d,
    vert = bottom ? h : b,
    oside = right ? d : f,
    overt = bottom ? b : h;
  return same(side, vert) && !same(vert, oside) && !same(side, overt) ? side : e;
};
const fit = (vw, vh, mode) => {
  if (mode === 'stretch') return [0, 0, vw, vh];
  const wide = vw * SH <= vh * SW,
    w = wide ? vw : Math.floor((SW * vh) / SH),
    h = wide ? Math.floor((SH * vw) / SW) : vh;
  return [Math.floor((vw - w) / 2), Math.floor((vh - h) / 2), w, h];
};
const reference = (vw, vh, filter, fitMode = 'contain', under = [0, 0, 0, 0]) => {
  const [rx, ry, rw, rh] = fit(vw, vh, fitMode),
    grid = filter === 'edge' && Math.min(rw / SW, rh / SH) >= 2 ? 2 : 1,
    nx = SW * grid,
    ny = SH * grid,
    cell = (jx, jy) =>
      grid === 2 ? doubled(Math.min(nx - 1, Math.max(0, jx)), Math.min(ny - 1, Math.max(0, jy))) : texel(jx, jy),
    out = new Float64Array(vw * vh * 4),
    exact = new Uint8Array(vw * vh);
  for (let y = 0; y < vh; y++)
    for (let x = 0; x < vw; x++) {
      const at = (y * vw + x) * 4,
        ox = x - rx,
        oy = y - ry;
      let c = under;
      exact[y * vw + x] = 1;
      if (ox >= 0 && oy >= 0 && ox < rw && oy < rh) {
        if (filter === 'nearest')
          c = cell(Math.floor(((ox * 2 + 1) * nx) / (rw * 2)), Math.floor(((oy * 2 + 1) * ny) / (rh * 2)));
        else {
          const axis = (o, n, w) => {
            const right = ((o + 1) * n) / w,
              last = Math.floor(right);
            return [last, Math.min(1, Math.max(0, ((right - last) * w) / n))];
          };
          const [lx, kx] = axis(ox, nx, rw),
            [ly, ky] = axis(oy, ny, rh),
            mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k),
            top = mix(cell(lx - 1, ly - 1), cell(lx, ly - 1), kx),
            bottom = mix(cell(lx - 1, ly), cell(lx, ly), kx);
          c = mix(top, bottom, ky);
          if ((kx > 0 && kx < 1) || (ky > 0 && ky < 1)) exact[y * vw + x] = 0;
        }
        // Premultiplied over what was there.
        const a = c[3] / 255;
        c = c.map((v, i) => v + under[i] * (1 - a));
      }
      out.set(c, at);
    }
  return { out, exact };
};
const compare = (actual, { out, exact }) => {
  let wrong = 0,
    first = null;
  for (let p = 0; p < exact.length; p++)
    for (let ch = 0; ch < 4; ch++) {
      const expected = out[p * 4 + ch],
        off = Math.abs(actual[p * 4 + ch] - expected);
      if (exact[p] ? actual[p * 4 + ch] !== Math.round(expected) : off > 1) {
        wrong++;
        first ??= { pixel: p, channel: ch, actual: actual[p * 4 + ch], expected };
        break;
      }
    }
  return { wrong, first };
};

window.check = {
  async run() {
    const out = { checks: {} };
    engine.gpu.pushErrorScope('validation');
    const source = texture(SW, SH, picture);
    const into = async (name, width, height, options) => {
      const target = texture(width, height),
        pass = PixelScale.attach(instance, { source, target, ...options });
      instance.render({ delta: 1 / 60 });
      out.checks[name] = compare(
        await read(target),
        reference(width, height, options.filter ?? 'sharp-bilinear', options.fit),
      );
      pass.dispose();
      target.destroy();
    };
    // 23 x 16 inside 23 x 17: 3.29 x 3.2 per texel, not a whole number either way.
    await into('nearest at 3.29', 23, 17, { filter: 'nearest' });
    await into('sharp-bilinear at 3.29', 23, 17, {});
    await into('edge at 3.29', 23, 17, { filter: 'edge' });
    await into('sharp-bilinear stretched', 30, 11, { fit: 'stretch' });
    await into('edge stretched', 30, 11, { filter: 'edge', fit: 'stretch' });
    // Exactly 2x: sharp-bilinear never mixes, so it is nearest.
    await into('sharp-bilinear at 2x', 14, 10, {});
    // Below 2x 'edge' covers the plain texels, as sharp-bilinear does.
    await into('edge below 2x', 10, 8, { filter: 'edge' });

    // The live filter, and the canvas: the picture over the background, letterboxed in the middle.
    {
      const pass = PixelScale.attach(instance, { source: () => source, filter: 'nearest' });
      canvas.width = 40;
      instance.render({ delta: 1 / 60 });
      const bg = [16, 32, 48, 255];
      out.checks['canvas nearest'] = compare(await readCanvas(), reference(40, 30, 'nearest', 'contain', bg));
      pass.filter = 'edge';
      canvas.width = 40;
      instance.render({ delta: 1 / 60 });
      out.checks['canvas edge, filter changed live'] = compare(
        await readCanvas(),
        reference(40, 30, 'edge', 'contain', bg),
      );
      pass.filter = 'blur';
      try {
        instance.render({ delta: 1 / 60 });
      } catch (error) {
        out.badFilter = error instanceof RangeError;
      }
      pass.dispose();
      const self = PixelScale.attach(instance, { source, target: source });
      try {
        instance.render({ delta: 1 / 60 });
      } catch (error) {
        out.sameTexture = error.code;
      }
      self.dispose();
    }
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    source.destroy();

    // A lost device: the pass makes its pipeline and buffers again.
    {
      let pair = { source: texture(SW, SH, picture), target: texture(23, 17) };
      const pass = PixelScale.attach(instance, { source: () => pair.source, target: () => pair.target });
      instance.render({ delta: 1 / 60 });
      const previous = engine.gpu;
      previous.destroy();
      await previous.lost;
      await engine.rebootDevice();
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      pair = { source: texture(SW, SH, picture), target: texture(23, 17) };
      instance.render({ delta: 1 / 60 });
      out.checks['after device loss'] = compare(await read(pair.target), reference(23, 17, 'sharp-bilinear'));
      pass.dispose();
    }
    out.errors = errors.splice(0);
    return out;
  },
};
const readCanvas = async () => {
  const copy = document.createElement('canvas');
  copy.width = 40;
  copy.height = 30;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, 40, 30).data;
};
window.ready = true;
