import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { SliceLayer } from '/packages/sprites/dist/slice.js';
import { SpriteLayer } from '/packages/sprites/dist/index.js';

const canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [64, 32] });
const engine = engineRuntime(instance),
  errors = [];
engine.scene.background = '#000000';
engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const data = new Uint8Array(4 * 4 * 4);
for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) data.set([40 + x * 50, 30 + y * 60, 80, 255], (y * 4 + x) * 4);
const frame = () => {
  instance.render({ delta: 0 });
  const copy = document.createElement('canvas');
  copy.width = 64;
  copy.height = 32;
  const c = copy.getContext('2d', { willReadFrequently: true });
  c.drawImage(canvas, 0, 0);
  return c.getImageData(0, 0, 64, 32).data;
};
window.check = async () => {
  engine.gpu.pushErrorScope('validation');
  const checks = [];
  for (const filter of ['nearest', 'linear']) {
    const layer = SliceLayer.attach(instance, {
      atlas: { width: 4, height: 4, data },
      filter,
      mipmaps: false,
      snap: false,
    });
    const s = layer.addSlice({ rect: [0, 0, 4, 4], width: 13, height: 9, borders: [1, 1, 1, 1], middle: 'repeat' });
    const fill = layer.addSlice({ x: 20, rect: [0, 0, 4, 4], width: 11, height: 7, middle: 'repeat', scrollX: -1 });
    for (const flip of [false, true]) {
      s.flipX = flip;
      const image = frame();
      let wrong = 0;
      for (let y = 0; y < 9; y++)
        for (let x = 0; x < 13; x++) {
          const xx = flip ? 12 - x : x,
            u = xx === 0 ? 0 : xx === 12 ? 3 : 1 + ((xx - 1) % 2),
            v = y === 0 ? 0 : y === 8 ? 3 : 1 + ((y - 1) % 2);
          const at = (y * 64 + x) * 4,
            src = (v * 4 + u) * 4;
          for (let c = 0; c < 3; c++) if (image[at + c] !== data[src + c]) wrong++;
        }
      checks.push({ filter, flip, wrong });
      if (filter === 'nearest')
        for (let y = 0; y < 7; y++)
          for (let x = 0; x < 11; x++) {
            const at = (y * 64 + x + 20) * 4,
              src = ((y % 4) * 4 + ((x + 1) % 4)) * 4;
            for (let c = 0; c < 3; c++) if (image[at + c] !== data[src + c]) throw new Error('scroll texel mismatch');
          }
    }
    if (filter === 'linear') {
      fill.scrollX = 0.5;
      const image = frame(),
        decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
        v = (decode(40 / 255) + decode(190 / 255)) / 2,
        expected = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
      if (Math.abs(image[20 * 4] - expected) > 1) throw new Error(`repeat seam ${image[20 * 4]} != ${expected}`);
    }
    layer.mask = { rect: [0, 0, 6, 9] };
    const masked = frame();
    if (masked[(4 * 64 + 5) * 4 + 2] !== 80 || masked[(4 * 64 + 6) * 4 + 2] !== 0)
      throw new Error('masked slice pixel mismatch');
    layer.dispose();
  }
  const plain = SpriteLayer.attach(instance, {
    atlas: { width: 4, height: 4, data },
    filter: 'linear',
    mask: { rect: [0, 0, 2, 4] },
  });
  plain.add();
  const masked = frame();
  if (masked[(1 * 64 + 1) * 4 + 2] !== 80 || masked[(1 * 64 + 2) * 4 + 2] !== 0)
    throw new Error('masked smooth sprite regression');
  plain.dispose();
  const validation = await engine.gpu.popErrorScope();
  instance.dispose();
  return { checks, errors, validation: validation?.message ?? null };
};
window.ready = true;
