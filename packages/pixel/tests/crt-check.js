// The page of crt-check.mjs: each picture is read back and compared with the CRT maths worked out on the CPU in float64
// here, within one step of 255 (the GPU works in float32). A pixel whose sample point lies within 0.001 texel of a texel
// edge is left out: float32 and float64 may pick different texels there.
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { CRT } from '/packages/pixel/dist/crt.js';

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
          const tx = (bx * 0.5 + 0.5) * SW,
            ty = (by * 0.5 + 0.5) * SH,
            near = (v) => Math.abs(v - Math.round(v)) < 1e-3;
          if (near(tx) || near(ty)) skip[y * vw + x] = 1;
          const ix = Math.min(Math.floor(tx), SW - 1),
            iy = Math.min(Math.floor(ty), SH - 1),
            f = ty - Math.floor(ty),
            beam = 1 - scanlines * (1 - Math.sin(Math.PI * f) ** 2),
            grille = [1 - mask, 1 - mask, 1 - mask];
          grille[ox % 3] = 1;
          const e = texel(ix, iy),
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
  return { out, skip };
};
const compare = (actual, { out, skip }) => {
  let wrong = 0,
    skipped = 0,
    first = null;
  for (let p = 0; p < skip.length; p++) {
    if (skip[p]) {
      skipped++;
      continue;
    }
    for (let ch = 0; ch < 4; ch++)
      if (Math.abs(actual[p * 4 + ch] - out[p * 4 + ch]) > 1) {
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
