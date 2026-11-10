import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { parseSpineJSON, loadSpineJSON } from '/packages/sprites/dist/spine.js';
import { SkeletalLayer } from '/packages/sprites/dist/skeletal.js';
const canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [128, 64] }),
  engine = engineRuntime(instance),
  device = engine.gpu,
  errors = [];
engine.scene.background = '#000000';
device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const read = async (texture, x = 0) => {
  const buffer = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture, origin: [x, 0] }, { buffer, bytesPerRow: 256 }, [1, 1]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const value = [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)];
  buffer.unmap();
  buffer.destroy();
  return value;
};
const composite = (src, dst, mode) => {
  const alpha = src[3],
    backAlpha = dst[3],
    p = src.slice(0, 3).map((v) => v * alpha);
  return [
    ...p.map((v, i) =>
      Math.min(
        1,
        mode === 'add'
          ? v + dst[i]
          : mode === 'screen'
            ? v + dst[i] * (1 - v)
            : mode === 'multiply'
              ? v * (1 - backAlpha) + dst[i] * (1 - alpha) + v * dst[i]
              : v + dst[i] * (1 - alpha),
      ),
    ),
    Math.min(1, mode === 'add' ? alpha + backAlpha : alpha + backAlpha * (1 - alpha)),
  ];
};
const capture = () => {
  instance.render({ delta: 0 });
  const copy = document.createElement('canvas');
  copy.width = 128;
  copy.height = 64;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, 128, 64).data;
};
window.check = async () => {
  device.pushErrorScope('validation');
  let cases = 0,
    maximumError = 0;
  for (const mode of ['normal', 'add', 'multiply', 'screen'])
    for (const background of [
      [0, 0, 0, 0],
      [0.1, 0.2, 0.3, 0.5],
      [0.1, 0.2, 0.3, 1],
    ])
      for (const dark of [false, true])
        for (const weighted of [false, true])
          for (const clipped of [false, true]) {
            const vertices = weighted
              ? [1, 0, -2, 2, 1, 1, 0, 2, 2, 1, 1, 0, 2, -2, 1, 1, 0, -2, -2, 1]
              : [-2, 2, 2, 2, 2, -2, -2, -2];
            const data = {
              bones: [{ name: 'root', x: 2, y: -2 }],
              slots: [
                {
                  name: 'image',
                  bone: 'root',
                  attachment: 'a',
                  color: 'ffffffff',
                  dark: dark ? '204060' : '000000',
                  blend: mode === 'add' ? 'additive' : mode,
                },
              ],
              skins: [
                {
                  name: 'default',
                  attachments: {
                    image: {
                      a: { type: 'mesh', vertices, uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 2, 3, 0] },
                    },
                  },
                },
              ],
            };
            if (clipped) {
              data.slots.unshift({ name: 'clip', bone: 'root', attachment: 'c' });
              data.skins[0].attachments.clip = {
                c: { type: 'clipping', end: 'image', vertexCount: 4, vertices: [-2, 2, 0, 2, 0, -2, -2, -2] },
              };
            }
            const rig = parseSpineJSON(data).createSkeleton({ regions: { a: { x: 0, y: 0, width: 1, height: 1 } } }),
              layer = new SkeletalLayer({ atlas: { width: 1, height: 1, data: new Uint8Array([160, 80, 200, 128]) } });
            layer.addSkeleton(rig);
            const target = device.createTexture({
                size: [4, 4],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
              }),
              encoder = device.createCommandEncoder(),
              view = target.createView();
            encoder
              .beginRenderPass({
                colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: background }],
              })
              .end();
            device.queue.submit([encoder.finish()]);
            const clearBytes = await read(target, 3),
              drawEncoder = device.createCommandEncoder();
            // Exercise the real layer pass against a transparent target, independently of the canvas compositor.
            layer.draw({
              backend: 'webgpu',
              device,
              encoder: drawEncoder,
              color: view,
              width: 4,
              height: 4,
              format: 'rgba8unorm',
              descriptor: { multisample: { count: 1 } },
            });
            device.queue.submit([drawEncoder.finish()]);
            const actual = await read(target),
              light = [160, 80, 200].map((v, i) => v / 255 + (1 - v / 255) * (dark ? [32, 64, 96][i] / 255 : 0));
            const expected = composite(
              [...light, 128 / 255],
              clearBytes.map((v) => v / 255),
              mode,
            ).map((v) => Math.round(v * 255));
            for (let i = 0; i < 4; i++) maximumError = Math.max(maximumError, Math.abs(actual[i] - expected[i]));
            if (actual.some((v, i) => Math.abs(v - expected[i]) > 1))
              throw new Error(`${mode}, dark=${dark}, weighted=${weighted}: ${actual} != ${expected}`);
            if (clipped) {
              const outside = await read(target, 3),
                back = clearBytes;
              if (outside.some((v, i) => v !== back[i]))
                throw new Error(`clipping escaped its polygon: ${outside} != ${back}`);
            }
            cases++;
            layer.dispose();
            target.destroy();
          }
  // Render the openly licensed tree with its original packed image and exported JSON, without runtime source.
  const asset = await loadSpineJSON('/packages/sprites/tests/fixtures/trees/tree3.json');
  const atlas = await (await fetch('/packages/sprites/tests/fixtures/trees/tree3.atlas')).text(),
    regions = {};
  let name;
  for (const line of atlas.split(/\r?\n/)) {
    if (/^\w/.test(line) && !line.includes(':') && !line.endsWith('.png')) {
      name = line;
      regions[name] = {};
    } else if (name && /^  (xy|size):/.test(line)) {
      const [a, b] = line.split(':')[1].split(',').map(Number);
      Object.assign(regions[name], line.includes('xy:') ? { x: a, y: b } : { width: a, height: b });
    }
  }
  const bitmap = await createImageBitmap(
      await (await fetch('/packages/sprites/tests/fixtures/trees/tree3.png')).blob(),
    ),
    rig = asset.createSkeleton({ regions });
  const points = rig.slots.flatMap((slot) => [...(rig.getAttachment(slot.name)?.worldVertices() ?? [])]),
    xs = points.filter((_, i) => i % 2 === 0),
    ys = points.filter((_, i) => i % 2 === 1);
  const minX = Math.min(...xs),
    minY = Math.min(...ys),
    zoom = Math.min(124 / (Math.max(...xs) - minX), 60 / (Math.max(...ys) - minY));
  const layer = SkeletalLayer.attach(instance, {
    atlas: bitmap,
    camera: { x: minX - 2 / zoom, y: minY - 2 / zoom, zoom },
  });
  layer.addSkeleton(rig);
  const before = capture();
  rig.pose('animation', 1.9666, { loop: false });
  const after = capture();
  rig.pose('animation', 0, { loop: false });
  const seek = capture();
  let treeCoverage = 0,
    treeChanged = 0,
    seekDifferences = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (before[i] || before[i + 1] || before[i + 2]) treeCoverage++;
    if (before.slice(i, i + 3).some((v, k) => v !== after[i + k])) treeChanged++;
    if (before.slice(i, i + 4).some((v, k) => v !== seek[i + k])) seekDifferences++;
  }
  layer.dispose();
  bitmap.close();
  const validation = await device.popErrorScope();
  instance.dispose();
  return {
    cases,
    maximumError,
    treeCoverage,
    treeChanged,
    seekDifferences,
    validation: validation?.message ?? null,
    errors,
  };
};
window.ready = true;
