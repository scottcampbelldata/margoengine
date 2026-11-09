import { GILighting2D, RadianceCascade2D } from '/packages/lighting2d/dist/gi.js';
import { Light2D } from '/packages/lighting2d/dist/index.js';
import { rcCases, radialCases } from './gi-scenes.js';
import { readHDR } from './emission-regressions.js';
export async function giRegressions({ instance, engine, texture, frame, checks, errors }) {
  engine.gpu.pushErrorScope('validation');
  const orders = [];
  for (const c of [...rcCases, ...radialCases]) {
    const target = texture('rgba16float', 1, 1);
    const pass = GILighting2D.attach(instance, {
      target,
      camera: { x: c.point[0] - 0.5, y: c.point[1] - 0.5, zoom: 1 },
      cascades: c.options,
      ...c.scene,
    });
    frame();
    const values = await readHDR(engine.gpu, target);
    const cpu = new RadianceCascade2D(c.options).evaluateAt(c.point, undefined, c.scene);
    let wrong = cpu.some((v, i) => Math.abs(values[i] - v) > 0.001) ? 1 : 0;
    if (c.exact && c.exact.some((v, i) => values[i] !== v)) wrong++;
    if (c.positive && values[0] <= 0) wrong++;
    if (c.bounded !== undefined && [...values.slice(0, 3)].some((v) => v < 0 || v > c.bounded)) wrong++;
    if (c.analytic !== undefined && Math.abs(values[0] - c.analytic) / c.analytic >= 0.05) wrong++;
    if (c.bounceOrder !== undefined) orders.push(values[0]);
    checks[`GI ${c.name}`] = { wrong, gpu: [...values.slice(0, 3)], cpu };
    pass.dispose();
    target.destroy();
  }
  checks['GI F6 distinct finite bounce orders'] = {
    wrong: orders.some((v, i) => i && v <= orders[i - 1]) ? 1 : 0,
    values: orders,
  };
  const occluders = [{ shape: 'segment', from: [-10, -10], to: [-10, 10] }];
  for (const [label, options, exact] of [
    ['F3 point red', { x: 20, y: 0, color: '#ff0000' }, undefined],
    ['F24 point shadows blocked', { x: 20, y: 0 }, [0, 0, 0]],
    [
      'F24 directional position irrelevant',
      { kind: 'directional', x: 100000, angle: Math.PI, elevation: 0, color: '#ff0000' },
      undefined,
    ],
    ['F24 spot faces away', { kind: 'spot', x: 20, y: 0, angle: 0, cone: 0.1 }, [0, 0, 0]],
    [
      'F24 rect mask excludes surface',
      { x: 20, mask: { kind: 'rect', minX: 0, minY: 0, maxX: 1, maxY: 1 } },
      [0, 0, 0],
    ],
    [
      'F24 polygon mask excludes surface',
      {
        x: 20,
        mask: {
          kind: 'polygon',
          points: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
        },
      },
      [0, 0, 0],
    ],
    ['F24 mismatched light layer', { x: 20, layers: 2 }, [0, 0, 0]],
  ]) {
    const lights = [
      new Light2D(options),
      new Light2D({ x: 20, intensity: 0.2, color: label === 'F3 point red' ? '#0000ff' : '#000000' }),
    ];
    const walls =
      label === 'F24 point shadows blocked'
        ? [...occluders, { shape: 'box', width: 2, height: 2, offset: [20, 0] }]
        : occluders;
    let target = texture('rgba16float', 1, 1);
    const pass = GILighting2D.attach(instance, {
      name: `gi-${label}`,
      target: () => target,
      layer: 1,
      occluders: walls,
      lights,
      cascades: { cascades: 2, baseRays: 1, baseDistance: 32, bounces: 1 },
    });
    const rc = pass.cascades,
      point = [0.5, 0.5],
      expected = rc.evaluateAt(point, undefined, { occluders: walls, lights, layer: 1 });
    frame();
    let values = await readHDR(engine.gpu, target);
    checks[`GI ${label}`] = {
      wrong:
        expected.some((v, i) => Math.abs(values[i] - v) > 0.001) ||
        (exact ? values.slice(0, 3).some((v, i) => v !== exact[i]) : values[0] <= 0)
          ? 1
          : 0,
      values: [...values],
      expected,
    };
    // Format switch, resize, frame stability and removal also exercise buffer reuse and release.
    target.destroy();
    target = texture('rgba16float', 2, 2);
    frame();
    const resized = await readHDR(engine.gpu, target);
    checks[`GI ${label} resize`] = { wrong: Math.abs(resized[0] - expected[0]) <= 0.001 ? 0 : 1 };
    target.destroy();
    target = texture('rgba8unorm', 2, 2);
    frame();
    // Read the new format with a direct GPU buffer copy.
    const readUnorm = async () => {
      const buffer = engine.gpu.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = engine.gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [2, 2]);
      engine.gpu.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const rgb = [...new Uint8Array(buffer.getMappedRange()).slice(0, 3)];
      buffer.destroy();
      return rgb;
    };
    checks[`GI ${label} format switch`] = {
      wrong: (await readUnorm()).some((v, i) => Math.abs(v - Math.min(1, expected[i]) * 255) > 1) ? 1 : 0,
    };
    frame();
    checks[`GI ${label} frame stable`] = {
      wrong: (await readUnorm()).some((v, i) => Math.abs(v - Math.min(1, expected[i]) * 255) > 1) ? 1 : 0,
    };
    pass.lights = [];
    frame();
    checks[`GI ${label} removed lights`] = { wrong: (await readUnorm()).some((v) => v !== 0) ? 1 : 0 };
    pass.dispose();
    target.destroy();
  }
  const validation = await engine.gpu.popErrorScope();
  if (validation) errors.push(validation.message);
  // Keep GI alive across a real device replacement. Same public name can attach again after disposal.
  let target = texture('rgba16float', 2, 2);
  const pass = GILighting2D.attach(instance, {
    name: 'gi-restore',
    target: () => target,
    camera: { x: 0, y: 0, zoom: 1 },
    emitters: [{ x: 0.5, y: 0.5, radius: 1000, intensity: 0.25 }],
    cascades: { cascades: 3, bounces: 2 },
  });
  frame();
  const old = engine.gpu;
  old.destroy();
  await old.lost;
  await engine.rebootDevice();
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  target.destroy();
  target = texture('rgba16float', 2, 2);
  engine.gpu.pushErrorScope('validation');
  frame();
  checks['GI device restore and owned buffers'] = { wrong: (await readHDR(engine.gpu, target))[0] === 0.25 ? 0 : 1 };
  pass.emitters = [];
  frame();
  checks['GI removed sources leave no history'] = { wrong: (await readHDR(engine.gpu, target))[0] === 0 ? 0 : 1 };
  pass.dispose();
  const again = GILighting2D.attach(instance, {
    name: 'gi-restore',
    target,
    emitters: [{ x: 0, y: 0, radius: 100, intensity: 0.125 }],
  });
  frame();
  checks['GI dispose unregisters and reattaches'] = { wrong: (await readHDR(engine.gpu, target))[0] === 0.125 ? 0 : 1 };
  again.dispose();
  target.destroy();
  const restored = await engine.gpu.popErrorScope();
  if (restored) errors.push(restored.message);
}
