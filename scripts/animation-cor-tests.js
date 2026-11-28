// Real-GPU check of skinning about optimized centres of rotation (packages/animation/src/cor.ts). A tube bends 90
// degrees at a joint and twists 150 degrees past it under bones blended by smooth weights, four and eight influences.
// Every vertex read back from the GPU must match Animation's CPU pose (the mode's `blend`, what synchronous raycasts
// test); a bend must reach no farther out than dual quaternion skinning and no nearer in than linear skinning, and a
// twist must keep its radius. A linear clone of the same model deforms beside it, so the two modes' influence layouts
// (the centre-of-rotation one carries four more numbers per vertex) must never share one buffer block.
// Runs as `npm run test:gpu:cor -w @margoengine/animation`; MARGO_COMPAT=1 runs it on the WebGL2 layer.
import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
    errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { parseGLTF } = await import('/packages/gltf/dist/pbr.js'),
      { Animation } = await import('/packages/animation/dist/index.js'),
      { cloneModel } = await import('/packages/animation/dist/skeleton-utils.js'),
      { posedVertices } = await import('/packages/shared/pose-source.js'),
      { dualQuaternionSkinning } = await import('/packages/animation/dist/dqs.js'),
      { centerOfRotationSkinning } = await import('/packages/animation/dist/cor.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:64px;height:64px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
        capacity: 1024,
        camera: { position: [0, 0, 8], target: [0, 0, 0], near: 0.01, far: 50 },
      }),
      device = engine.gpu;
    // A tube along +X from 0 to 4, radius 0.25, joints one unit apart; each ring weighs on the joints near its x.
    const RINGS = 65,
      SIDES = 16,
      JOINTS = 5,
      RADIUS = 0.25;
    const tube = (eight) => {
      const buffers = [],
        bufferViews = [],
        accessors = [],
        add = (data, type, componentType = 5126) => {
          const id = buffers.length,
            width = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
          buffers.push(new Uint8Array(data.buffer));
          bufferViews.push({ buffer: id, byteLength: data.byteLength });
          accessors.push({
            bufferView: id,
            componentType,
            count: data.length / width,
            type,
            ...(id === 0 ? { min: [0, -1, -1], max: [4, 1, 1] } : {}),
          });
          return id;
        };
      const positions = [],
        normals = [],
        sets = [[], []],
        indices = [];
      for (let r = 0; r < RINGS; r++) {
        const x = (r / (RINGS - 1)) * 4,
          reach = eight ? 2.2 : 0.6,
          raw = Array.from({ length: JOINTS }, (_, j) => Math.max(0, 1 - Math.abs(x - j - 0.5) / reach) ** 2),
          used = raw
            .map((w, j) => [w, j])
            .filter(([w]) => w > 0)
            .sort((a, b) => b[0] - a[0])
            .slice(0, eight ? 8 : 4);
        if (!used.length) used.push([1, Math.min(JOINTS - 1, Math.floor(x))]);
        const sum = used.reduce((s, [w]) => s + w, 0);
        for (let s = 0; s < SIDES; s++) {
          const a = (s / SIDES) * Math.PI * 2;
          positions.push(x, Math.cos(a) * RADIUS, Math.sin(a) * RADIUS);
          normals.push(0, Math.cos(a), Math.sin(a));
          for (let k = 0; k < 8; k++) sets[k >> 2].push(used[k]?.[1] ?? 0, (used[k]?.[0] ?? 0) / sum);
        }
      }
      for (let r = 0; r + 1 < RINGS; r++)
        for (let s = 0; s < SIDES; s++) {
          const a = r * SIDES + s,
            b = r * SIDES + ((s + 1) % SIDES);
          indices.push(a, b, a + SIDES, b, b + SIDES, a + SIDES);
        }
      const pick = (set, k) => set.filter((_, i) => i % 2 === k),
        attributes = {
          POSITION: add(new Float32Array(positions), 'VEC3'),
          NORMAL: add(new Float32Array(normals), 'VEC3'),
          JOINTS_0: add(new Uint16Array(pick(sets[0], 0)), 'VEC4', 5123),
          WEIGHTS_0: add(new Float32Array(pick(sets[0], 1)), 'VEC4'),
        };
      if (eight) {
        attributes.JOINTS_1 = add(new Uint16Array(pick(sets[1], 0)), 'VEC4', 5123);
        attributes.WEIGHTS_1 = add(new Float32Array(pick(sets[1], 1)), 'VEC4');
      }
      const inverseBind = new Float32Array(JOINTS * 16);
      for (let j = 0; j < JOINTS; j++) inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -j, 0, 0, 1], j * 16);
      const index = add(new Uint32Array(indices), 'SCALAR', 5125),
        matrices = add(inverseBind, 'MAT4'),
        doc = {
          asset: { version: '2.0' },
          buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
          bufferViews,
          accessors,
          scene: 0,
          scenes: [{ nodes: [0, 1] }],
          nodes: [
            { mesh: 0, skin: 0 },
            { children: [2] },
            ...Array.from({ length: JOINTS - 1 }, (_, j) => ({
              translation: [1, 0, 0],
              ...(j + 1 < JOINTS - 1 ? { children: [j + 3] } : {}),
            })),
          ],
          meshes: [{ primitives: [{ attributes, indices: index }] }],
          skins: [{ joints: Array.from({ length: JOINTS }, (_, j) => j + 1), inverseBindMatrices: matrices }],
        };
      return { doc, buffers };
    };
    const read = async (primitive) => {
      const size = (primitive.vertices.length / 20) * 80,
        out = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(primitive.deformed, primitive.deformedOffset ?? 0, out, 0, size);
      device.queue.submit([encoder.finish()]);
      await out.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(out.getMappedRange()).slice();
      out.unmap();
      out.destroy();
      return values;
    };
    const q = (axis, degrees) => {
      const h = (degrees * Math.PI) / 360,
        s = Math.sin(h);
      return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
    };
    // Distance from a point to the posed bone polyline (joint world positions, then the tube's end).
    const toBones = (points, x, y, z) => {
      let best = Infinity;
      for (let i = 0; i + 1 < points.length; i++) {
        const [a, b] = [points[i], points[i + 1]],
          d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
          t = Math.max(0, Math.min(1, ((x - a[0]) * d[0] + (y - a[1]) * d[1] + (z - a[2]) * d[2]) / (d[0] ** 2 + d[1] ** 2 + d[2] ** 2)));
        best = Math.min(best, Math.hypot(x - a[0] - t * d[0], y - a[1] - t * d[1], z - a[2] - t * d[2]));
      }
      return best;
    };
    const report = { checks: 0, worstCpu: 0, radius: {}, shared: false };
    for (const eight of [false, true]) {
      const { doc, buffers } = tube(eight),
        corModel = parseGLTF(engine, doc, buffers);
      if (engine.plugins.get(corModel.name) !== corModel) engine.use(corModel);
      const linearModel = await cloneModel(corModel),
        dqModel = await cloneModel(corModel),
        cor = Animation.attach(corModel, { skinning: centerOfRotationSkinning }),
        linear = Animation.attach(linearModel),
        dq = Animation.attach(dqModel, { skinning: dualQuaternionSkinning });
      cor.playing = linear.playing = dq.playing = false;
      report.shared ||= cor['slots'][0].influences === linear['slots'][0].influences;
      for (const pose of [
        { bend: 0, twist: 0 },
        { bend: 90, twist: 0 },
        { bend: 0, twist: 150 },
        { bend: 120, twist: -100 },
      ]) {
        for (const model of [corModel, linearModel, dqModel]) {
          model.nodes[3].setQuaternion(q([0, 0, 1], pose.bend));
          model.nodes[4].setQuaternion(q([1, 0, 0], pose.twist));
        }
        engine.render({ culling: false });
        const key = `${eight ? 8 : 4}:${pose.bend}/${pose.twist}`;
        report.radius[key] = {};
        for (const [name, model] of [['cor', corModel], ['linear', linearModel], ['dq', dqModel]]) {
          const p = model.primitives[0],
            gpu = await read(p),
            joints = [1, 2, 3, 4, 5].map((n) => Array.from(model.nodes[n].matrix.subarray(12, 15)));
          let low = Infinity,
            high = 0;
          for (let i = 0; i < gpu.length; i += 20) {
            const d = toBones(joints, gpu[i], gpu[i + 1], gpu[i + 2]);
            low = Math.min(low, d);
            high = Math.max(high, d);
          }
          report.radius[key][name] = [low / RADIUS, high / RADIUS];
          if (name === 'cor') {
            const cpu = posedVertices(p).vertices;
            for (let i = 0; i < gpu.length; i += 20)
              for (const c of [0, 1, 2, 4, 5, 6]) {
                report.worstCpu = Math.max(report.worstCpu, Math.abs(cpu[i + c] - gpu[i + c]));
                report.checks++;
              }
          }
        }
      }
      cor.dispose?.();
      linear.dispose?.();
      dq.dispose?.();
    }
    engine.dispose();
    return report;
  });
  console.log(`${hardware.compat ? 'webgl2' : 'webgpu'}: ${JSON.stringify(result)}`);
  assert.deepEqual(errors, []);
  assert.ok(result.checks > 0, 'vertices were checked');
  assert.ok(result.worstCpu < 2e-4, `the CPU pose matches the GPU (worst ${result.worstCpu})`);
  assert.equal(result.shared, false, 'a centre-of-rotation slot never shares a linear slot influence block');
  for (const [key, r] of Object.entries(result.radius)) {
    const [low, high] = r.cor;
    // Distances to the posed bone polyline over the radius. A twist keeps the radius; a bend reaches no farther out
    // than dual quaternions and no nearer in than a linear blend (the panel test in cor.test.js measures the bulge).
    if (key.includes(':0/')) assert.ok(low > 0.999 && high < 1.001, `${key}: the twist keeps the radius (${low} to ${high})`);
    else {
      assert.ok(high <= r.dq[1] + 1e-6, `${key}: no farther out than dual quaternions (${high} against ${r.dq[1]})`);
      assert.ok(low >= r.linear[0] - 1e-6, `${key}: no nearer in than a linear blend (${low} against ${r.linear[0]})`);
    }
  }
} finally {
  await browser.close();
}
