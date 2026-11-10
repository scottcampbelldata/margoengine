// The page of crt-check.mjs: each picture is read back and compared with the CRT maths worked out on the CPU in float64
// here, within one step of 255 (the GPU works in float32). Curved samples within 0.001 texel of an edge are left out;
// flat mapping includes every boundary, and the all-off case requires exact bytes against rational nearest mapping.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { CRT } from '/packages/pixel/dist/crt.js';
import { PixelScale } from '/packages/pixel/dist/scale.js';
import { screenRegressions } from './screen-regressions.js';
import { crtSignal } from './crt-signal-reference.js';

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

const texel = (x, y) => {
  const at = (Math.min(SH - 1, Math.max(0, y)) * SW + Math.min(SW - 1, Math.max(0, x))) * 4;
  return [...picture.subarray(at, at + 4)].map((v) => v / 255);
};
const fit = (vw, vh) => {
  const wide = vw * SH <= vh * SW,
    w = wide ? vw : Math.floor((SW * vh) / SH),
    h = wide ? Math.floor((SH * vw) / SW) : vh;
  return [Math.floor((vw - w) / 2), Math.floor((vh - h) / 2), w, h];
};
const LOOK = { curvature: 0.08, scanlines: 0.5, mask: 0.2, glow: 0.25, brightness: 1.2 };
const reference = (vw, vh, look, under = [0, 0, 0, 0]) => {
  const composite = crtSignal(texel,look);
  const { curvature, scanlines, mask, glow, brightness } = { ...LOOK, ...look },
    [rx, ry, rw, rh] = fit(vw, vh),
    out = new Float64Array(vw * vh * 4),
    skip = new Uint8Array(vw * vh);
  for (let y = 0; y < vh; y++)
    for (let x = 0; x < vw; x++) {
      const ox = x - rx,
        oy = y - ry;
      let c = under.map((v) => v / 255);
      if (ox >= 0 && oy >= 0 && ox < rw && oy < rh) {
        const cx = ((ox + 0.5) / rw) * 2 - 1,
          cy = ((oy + 0.5) / rh) * 2 - 1,
          bx = cx * (1 + curvature * cy * cy),
          by = cy * (1 + curvature * cx * cx);
        let own;
        if (Math.abs(bx) > 1 || Math.abs(by) > 1) own = [0, 0, 0, 1];
        else {
          const tx = curvature === 0 ? ((2 * ox + 1) * SW) / (2 * rw) : (bx * 0.5 + 0.5) * SW,
            ty = curvature === 0 ? ((2 * oy + 1) * SH) / (2 * rh) : (by * 0.5 + 0.5) * SH,
            near = (v) => Math.abs(v - Math.round(v)) < 1e-3;
          if (curvature !== 0 && (near(tx) || near(ty))) skip[y * vw + x] = 1;
          const ix = Math.min(Math.floor(tx), SW - 1),
            iy = Math.min(Math.floor(ty), SH - 1),
            f = ty - Math.floor(ty),
            beam = 1 - scanlines * (1 - Math.sin(Math.PI * f) ** 2),
            grille = [1 - mask, 1 - mask, 1 - mask];
          grille[ox % 3] = 1;
          const e = composite(ix, iy),
            blur = [0, 0, 0, 0];
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const weight = (dx ? 1 : 2) * (dy ? 1 : 2),
                t = texel(ix + dx, iy + dy);
              for (let k = 0; k < 4; k++) blur[k] += (weight * t[k]) / 16;
            }
          const a = Math.min(1, Math.max(0, e[3] + glow * blur[3]));
          own = [0, 1, 2].map((k) => Math.min(a, e[k] * beam * grille[k] * brightness + glow * blur[k]));
          own.push(a);
        }
        // Premultiplied over what was there.
        c = own.map((v, k) => v + c[k] * (1 - own[3]));
      }
      out.set(
        c.map((v) => v * 255),
        (y * vw + x) * 4,
      );
    }
  const signalOn = ['colorBleed','chromaticOffset','redOffset','greenOffset','blueOffset'].some(key=>
    typeof look[key]==='number'?look[key]!==0:look[key]?.some(v=>v!==0));
  return { out, skip, exact: !signalOn && curvature === 0 && scanlines === 0 && mask === 0 && glow === 0 && brightness === 1 };
};
const compare = (actual, { out, skip, exact }) => {
  let wrong = 0,
    skipped = 0,
    first = null;
  for (let p = 0; p < skip.length; p++) {
    if (skip[p]) {
      skipped++;
      continue;
    }
    for (let ch = 0; ch < 4; ch++)
      if (
        exact ? actual[p * 4 + ch] !== Math.round(out[p * 4 + ch]) : Math.abs(actual[p * 4 + ch] - out[p * 4 + ch]) > 1
      ) {
        wrong++;
        first ??= { pixel: p, channel: ch, actual: actual[p * 4 + ch], expected: out[p * 4 + ch] };
        break;
      }
  }
  return { wrong, skipped, first };
};

window.check = {
  async run() {
    const out = { checks: {} };
    engine.gpu.pushErrorScope('validation');
    const source = texture(SW, SH, picture);
    const into = async (name, width, height, look) => {
      const target = texture(width, height),
        pass = CRT.attach(instance, { source, target, ...look });
      instance.render({ delta: 1 / 60 });
      out.checks[name] = compare(await read(target), reference(width, height, look));
      pass.dispose();
      target.destroy();
    };
    await into('defaults at 3.29x', 23, 17, {});
    await into('flat', 23, 17, { curvature: 0 });
    await into('strong look', 41, 30, { curvature: 0.5, scanlines: 1, mask: 1, glow: 1, brightness: 4 });
    // With every effect off the CRT is plain nearest sampling of the flat picture.
    await into('all off', 23, 17, { curvature: 0, scanlines: 0, mask: 0, glow: 0, brightness: 1 });
    const plain={curvature:0,scanlines:0,mask:0,glow:0,brightness:1};
    await into('NTSC bleed',23,17,{...plain,colorBleed:1});
    await into('NTSC partial bleed',31,24,{...plain,colorBleed:0.35});
    await into('RGB horizontal offset',23,17,{...plain,chromaticOffset:1});
    await into('RGB fractional offset',23,17,{...plain,chromaticOffset:[0.5,-0.25]});
    await into('independent RGB channels',23,17,{...plain,redOffset:[-1,0],greenOffset:[0,1],blueOffset:[1,-1]});
    await into('composite with tube effects',41,30,{colorBleed:0.8,chromaticOffset:0.5});
    out.checks['all-off rational nearest sweep'] = await nearestSweep();

    // Settings read each frame, and the canvas: the picture over the background, letterboxed in the middle.
    {
      const pass = CRT.attach(instance, { source: () => source }),
        bg = [16, 32, 48, 255];
      canvas.width = 40;
      instance.render({ delta: 1 / 60 });
      out.checks['canvas defaults'] = compare(await readCanvas(), reference(40, 30, {}, bg));
      pass.scanlines = 0.9;
      pass.curvature = 0.2;
      canvas.width = 40;
      instance.render({ delta: 1 / 60 });
      out.checks['canvas, look changed live'] = compare(
        await readCanvas(),
        reference(40, 30, { scanlines: 0.9, curvature: 0.2 }, bg),
      );
      pass.colorBleed=0.75;pass.chromaticOffset=[-0.5,0.25];pass.greenOffset=[0,0.5];
      canvas.width=40;instance.render({delta:1/60});
      out.checks['canvas composite live'] = compare(await readCanvas(),reference(40,30,
        {scanlines:0.9,curvature:0.2,colorBleed:0.75,chromaticOffset:[-0.5,0.25],greenOffset:[0,0.5]},bg));
      pass.glow = 2;
      try {
        instance.render({ delta: 1 / 60 });
      } catch (error) {
        out.badSetting = error instanceof RangeError;
      }
      pass.dispose();
      const self = CRT.attach(instance, { source, target: source });
      try {
        instance.render({ delta: 1 / 60 });
      } catch (error) {
        out.sameTexture = error.code;
      }
      self.dispose();
    }
    Object.assign(
      out.checks,
      await screenRegressions({
        instance,
        engine,
        Pass: CRT,
        options: { curvature: 0, scanlines: 0, mask: 0, glow: 0, brightness: 1 },
        read,
        readCanvas,
        texture,
        canvas,
      }),
    );
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    source.destroy();

    // A lost device: the pass makes its pipeline and buffers again.
    {
      let pair = { source: texture(SW, SH, picture), target: texture(23, 17) };
      const pass = CRT.attach(instance, { source: () => pair.source, target: () => pair.target });
      instance.render({ delta: 1 / 60 });
      const previous = engine.gpu;
      previous.destroy();
      await previous.lost;
      await engine.rebootDevice();
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      pair = { source: texture(SW, SH, picture), target: texture(23, 17) };
      instance.render({ delta: 1 / 60 });
      out.checks['after device loss'] = compare(await read(pair.target), reference(23, 17, {}));
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

async function nearestSweep() {
  const result = { wrong: 0, skipped: 0, tested: 0, first: null };
  for (let size = 1; size <= 11; size++) {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) data.set([x * 19, y * 23, (x + y) * 11, 255], (y * size + x) * 4);
    const source = texture(size, size, data);
    for (const width of [1, 2, 3, 4, 7, 11, 17, 23, 31, 47, 63, 95, 127, 191]) {
      const target = texture(width, width),
        crt = CRT.attach(instance, { source, target, curvature: 0, scanlines: 0, mask: 0, glow: 0, brightness: 1 });
      instance.render({ delta: 1 / 60 });
      const actual = await read(target);
      crt.dispose();
      const nearest = PixelScale.attach(instance, { source, target, filter: 'nearest' });
      instance.render({ delta: 1 / 60 });
      const scaled = await read(target);
      for (let y = 0; y < width; y++)
        for (let x = 0; x < width; x++) {
          const sx = Math.floor(((2 * x + 1) * size) / (2 * width)),
            sy = Math.floor(((2 * y + 1) * size) / (2 * width)),
            at = (y * width + x) * 4,
            from = (sy * size + sx) * 4;
          for (let k = 0; k < 4; k++)
            if (actual[at + k] !== data[from + k] || actual[at + k] !== scaled[at + k]) {
              result.wrong++;
              result.first ??= { size, width, x, y, channel: k, actual: actual[at + k], expected: data[from + k] };
              break;
            }
        }
      result.tested++;
      nearest.dispose();
      target.destroy();
    }
    source.destroy();
  }
  return result;
}
