import { EngineKernel } from '/packages/core/dist/index.js';
import { Camera, engineRuntime } from '/packages/core/dist/extension.js';
import { SpriteLayer, packSprites } from '/packages/sprites/dist/index.js';
import { pickSprite } from '/packages/sprites/dist/pick.js';
const canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [32, 32] }),
  engine = engineRuntime(instance),
  errors = [];
engine.scene.background = '#000000';
engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const atlas = { width: 3, height: 3, data: new Uint8Array(36).fill(255) };
atlas.data[7] = 0;
atlas.data[15] = 0;
const layer = SpriteLayer.attach(instance, { atlas, camera: { x: -1, y: -2, zoom: 1.5 }, snap: true });
layer.add({ x: 5.2, y: 5.3, pivotX: 0.5, pivotY: 0.5, scaleX: 3, scaleY: 3, rotation: 0.37, tint: '#ff0000' });
layer.add({
  x: 8.2,
  y: 7.3,
  pivotX: 0.5,
  pivotY: 0.5,
  scaleX: -2,
  scaleY: 2,
  rotation: -0.52,
  flipY: true,
  tint: '#00ff00',
});
layer.add({ x: 6, y: 4, scaleX: 3, scaleY: 2, flipX: true, tint: '#0000ff' });
window.check = async () => {
  engine.gpu.pushErrorScope('validation');
  let wrong = 0,
    picked = 0;
  const failures = [],
    boundaryPixels = [];
  for (const mask of [undefined, { circle: [7, 7, 5] }])
    for (const ySort of [false, true]) {
      layer.mask = mask;
      layer.ySort = ySort;
      instance.render({ delta: 0 });
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 32;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0);
      const image = ctx.getImageData(0, 0, 32, 32).data;
      if (mask) boundaryPixels.push([...image.slice((7 * 32 + 16) * 4, (7 * 32 + 16) * 4 + 3)]);
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) {
          const hit = pickSprite(layer.sprites, x + 0.5, y + 0.5, {
              atlas,
              camera: layer.camera,
              snap: layer.snap,
              ySort,
              mask,
            }),
            tint = hit?.sprite.tint ?? 0;
          const rgb = [tint >> 16, (tint >> 8) & 255, tint & 255],
            at = (y * 32 + x) * 4;
          if (rgb.some((c, k) => image[at + k] !== c))
            failures.push({
              x,
              y,
              ySort,
              mask: !!mask,
              expected: rgb,
              actual: [...image.slice(at, at + 3)],
              hit: hit
                ? {
                    index: hit.sprite.index,
                    texelX: hit.texelX,
                    texelY: hit.texelY,
                    localX: hit.localX,
                    localY: hit.localY,
                  }
                : null,
              packed: layer.sprites.map((s) => {
                const d = new Float32Array(12);
                packSprites([s], d, layer.camera, 3, 3, layer.snap);
                return { index: s.index, data: [...d] };
              }),
            });
          if (hit) picked++;
          for (let k = 0; k < 3; k++) if (image[at + k] !== rgb[k]) wrong++;
        }
    }
  instance.render({
    delta: 0,
    views: [
      {
        id: 'pick-offset',
        camera: new Camera({ position: [0, 0, 6], target: [0, 0, 0] }),
        pixels: true,
        viewport: [4, 3, 24, 24],
      },
    ],
  });
  const viewCopy = document.createElement('canvas');
  viewCopy.width = 32;
  viewCopy.height = 32;
  const viewContext = viewCopy.getContext('2d', { willReadFrequently: true });
  viewContext.drawImage(canvas, 0, 0);
  const viewBoundary = [...viewContext.getImageData(20, 10, 1, 1).data].slice(0, 3);
  const validation = await engine.gpu.popErrorScope();
  layer.dispose();
  instance.dispose();
  return { wrong, picked, failures, boundaryPixels, viewBoundary, errors, validation: validation?.message ?? null };
};
window.ready = true;
