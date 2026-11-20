// The page of pixel-restore-check.mjs: plain and function source and target textures of PixelScale and PaletteQuantize
// across engine.rebootDevice() (KB-RESTORE-BORROWED1, docs/conventions.md, "Borrowed GPU objects").
import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { PixelScale } from '/packages/pixel/dist/scale.js';
import { PaletteQuantize } from '/packages/pixel/dist/palette.js';

const canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [16, 16] }),
  engine = engineRuntime(instance),
  errors = [],
  reported = [];
const onError = (e) => reported.push(`${e?.code ?? ''} ${e?.message ?? e}`);
instance.onError = engine.onError = onError;
const watch = (device) => device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
watch(engine.gpu);

const texture = (size, color) => {
  const t = engine.gpu.createTexture({
    size: [size, size],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC,
  });
  if (color)
    engine.gpu.queue.writeTexture(
      { texture: t },
      Uint8Array.from({ length: size * size * 4 }, (_, i) => color[i & 3]),
      { bytesPerRow: size * 4 },
      [size, size],
    );
  return t;
};
const center = async (t) => {
  const buffer = engine.gpu.createBuffer({ size: 256 * t.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    encoder = engine.gpu.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: t }, { buffer, bytesPerRow: 256 }, [t.width, t.height]);
  engine.gpu.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buffer.getMappedRange()),
    at = (Math.floor(t.height / 2) * 256 + Math.floor(t.width / 2) * 4);
  const out = [...raw.subarray(at, at + 4)];
  buffer.destroy();
  return out;
};
const draw = async () => {
  try {
    instance.render({ delta: 1 / 60 });
  } catch (error) {
    errors.push(`render threw: ${error?.message ?? error}`);
  }
  await engine.gpu.queue.onSubmittedWorkDone();
};
async function restore(remake) {
  const previous = engine.gpu;
  previous.destroy();
  await previous.lost;
  await engine.rebootDevice();
  watch(engine.gpu);
  remake?.();
  await draw();
  return engine.gpu !== previous;
}
const RED = [200, 40, 40, 255];
const palette = ['#000000', '#ff0000'];
const kinds = {
  PixelScale: { make: (o) => new PixelScale({ ...o, filter: 'nearest' }), expected: RED, size: 8 },
  // The palette pass reads one texel for each output pixel, so its target is the source's size.
  PaletteQuantize: { make: (o) => new PaletteQuantize({ ...o, palette }), expected: [255, 0, 0, 255], size: 4 },
};

const lostReports = () => reported.filter((r) => /borrowed-lost/.test(r)).length;
window.check = {
  errors: () => errors,
  reported: () => reported,
  async run() {
    const out = {};
    for (const [name, kind] of Object.entries(kinds)) {
      const r = {};
      reported.length = 0;
      // Two passes live across one restore: a plain texture pair, lost with the device and brought back by the
      // setters, and a function pair, read every frame (the engine gives up after four losses, so one restore each).
      const target = texture(kind.size),
        pass = kind.make({ source: texture(4, RED), target });
      let fs = texture(4, RED),
        ft = texture(kind.size);
      const fn = kind.make({ source: () => fs, target: () => ft });
      engine.use(pass);
      engine.use(fn);
      await draw();
      r.live = await center(target);
      r.fn = await center(ft);
      // The getters hand out textures of the new device from the first frame after the restore.
      r.restored = await restore(() => {
        fs = texture(4, RED);
        ft = texture(kind.size);
      });
      await draw();
      r.fnAfter = await center(ft);
      r.lostReports = lostReports();
      r.reportsOther = reported.length - r.lostReports;
      const source2 = texture(4, RED),
        target2 = texture(kind.size);
      pass.setSource(source2);
      pass.setTarget(target2);
      await draw();
      r.replaced = await center(target2);
      r.reportsAfterSetters = lostReports();
      pass.dispose();
      fn.dispose();
      r.expected = kind.expected;
      out[name] = r;
    }
    return out;
  },
};
window.ready = true;
