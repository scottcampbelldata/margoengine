// Real GPU checks of @margoengine/bvh/gpu, run by bvh-browser.js: every answer is compared with the float64 CPU tree.
import { MeshBVH } from '@margoengine/bvh';
import { GPUMeshBVH, bvhWGSL, GPU_FAR } from '@margoengine/bvh/gpu';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function bumpySphere(segments, rings) {
  const positions = [],
    indices = [];
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= segments; s++) {
      const phi = (Math.PI * r) / rings,
        theta = (2 * Math.PI * (s % segments)) / segments,
        radius = 1 + 0.15 * Math.sin(phi * 9) * Math.cos(theta * 7);
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        -radius * Math.sin(phi) * Math.sin(theta),
      );
    }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const minWeight = (weights, o) => Math.min(weights[o], weights[o + 1], weights[o + 2]);

/** Runs every check on one device; pushes a line per check into `report.checks`. */
export async function gpuChecks(report) {
  const adapter = await navigator.gpu.requestAdapter();
  assert(adapter, 'no WebGPU adapter');
  const device = await adapter.requestDevice({
    requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
  });
  const errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const mesh = bumpySphere(220, 140),
    bvh = MeshBVH.build(mesh),
    gpu = await GPUMeshBVH.create(device, bvh),
    next = random(7);

  // Rays from around the shape toward it, as many grazing the silhouette as crossing the middle.
  const rays = [];
  for (let i = 0; i < 100000; i++) {
    const o = [next() * 6 - 3, next() * 6 - 3, next() * 6 - 3],
      target = [next() * 2.4 - 1.2, next() * 2.4 - 1.2, next() * 2.4 - 1.2];
    rays.push({ origin: o, direction: [target[0] - o[0], target[1] - o[1], target[2] - o[2]] });
  }
  const start = performance.now(),
    hits = await gpu.raycast(rays),
    gpuMs = performance.now() - start;
  let same = 0,
    edges = 0,
    grazing = 0,
    hitCount = 0;
  const cpuStart = performance.now(),
    cpu = rays.map((ray) => bvh.raycastFirst(ray)),
    cpuMs = performance.now() - cpuStart;
  cpu.forEach((hit, i) => {
    const face = hits.faceIndex[i];
    if (hit) hitCount++;
    if (!hit && face < 0) return void same++;
    if (!hit || face < 0) {
      // One side only: allowed solely on a triangle's very edge, where float32 and float64 round apart.
      const weight = hit ? Math.min(...hit.barycoord) : minWeight(hits.barycoord, i * 3);
      assert(weight < 1e-3, `ray ${i}: ${hit ? 'CPU' : 'GPU'} alone hit, inside the face (weight ${weight})`);
      grazing++;
      return;
    }
    assert(
      Math.abs(hit.distance - hits.distance[i]) <= 1e-4 * Math.max(1, hit.distance),
      `ray ${i}: distance ${hits.distance[i]} vs ${hit.distance}`,
    );
    if (hit.faceIndex === face) {
      same++;
      for (let k = 0; k < 3; k++)
        assert(Math.abs(hit.barycoord[k] - hits.barycoord[i * 3 + k]) < 2e-2, `ray ${i}: weight ${k}`);
      assert(hit.frontFace === !!hits.frontFace[i], `ray ${i}: side`);
    } else {
      assert(Math.min(...hit.barycoord) < 1e-2, `ray ${i}: face ${face} vs ${hit.faceIndex} away from an edge`);
      edges++;
    }
  });
  assert(hitCount > 30000, `only ${hitCount} rays met the mesh`);
  assert(same + edges + grazing === rays.length, 'every ray is accounted for');
  assert(same > rays.length * 0.995, `only ${same} of ${rays.length} rays agree exactly`);
  report.checks.push(
    `gpu: ${same} of ${rays.length} rays match the CPU tree exactly (${hitCount} hits), ${edges} shared-edge ties, ${grazing} edge grazes`,
  );

  // Watertight: every ray from inside a closed mesh hits, aimed at vertices, edge midpoints and corners of triangles.
  const inner = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b] = [mesh.indices[i], mesh.indices[i + 1]],
      pa = mesh.positions.subarray(a * 3, a * 3 + 3),
      pb = mesh.positions.subarray(b * 3, b * 3 + 3);
    inner.push({ origin: [0.01, 0.02, 0.03], direction: [pa[0] - 0.01, pa[1] - 0.02, pa[2] - 0.03] });
    inner.push({
      origin: [0.01, 0.02, 0.03],
      direction: [(pa[0] + pb[0]) / 2 - 0.01, (pa[1] + pb[1]) / 2 - 0.02, (pa[2] + pb[2]) / 2 - 0.03],
    });
  }
  const closed = await gpu.raycast(inner);
  let holes = 0;
  for (const face of closed.faceIndex) if (face < 0) holes++;
  assert(holes === 0, `${holes} of ${inner.length} rays leaked through the closed mesh`);
  report.checks.push(`gpu: watertight, ${inner.length} rays at vertices and shared edges from inside all hit`);

  // Sides, near and far, and any-hit against the same closed mesh.
  const front = await gpu.raycast(rays.slice(0, 20000), { side: 'front' }),
    back = await gpu.raycast(rays.slice(0, 20000), { side: 'back' });
  for (let i = 0; i < 20000; i++) {
    const options = [
      [front, 'front'],
      [back, 'back'],
    ];
    for (const [answer, side] of options) {
      const hit = bvh.raycastFirst(rays[i], { side }),
        face = answer.faceIndex[i];
      if (!hit || face < 0) continue;
      assert(
        Math.abs(hit.distance - answer.distance[i]) <= 1e-4 * Math.max(1, hit.distance),
        `side ${side} ray ${i}: ${answer.distance[i]} vs ${hit.distance}`,
      );
      assert(!!answer.frontFace[i] === (side === 'front'), `side ${side} ray ${i} met the other side`);
    }
  }
  const limited = await gpu.raycast(rays.slice(0, 20000), { near: 2, far: 3.5 });
  limited.distance.forEach((d, i) => {
    if (d !== Infinity) assert(d >= 2 && d <= 3.5, `range: ray ${i} at ${d}`);
  });
  const any = await gpu.raycast(rays.slice(0, 20000), { mode: 'any' });
  let anyDiff = 0;
  for (let i = 0; i < 20000; i++) {
    if (any.faceIndex[i] < 0 !== hits.faceIndex[i] < 0) anyDiff++;
    if (any.faceIndex[i] >= 0)
      assert(any.distance[i] >= hits.distance[i] - 1e-4, `any ray ${i} is nearer than the closest hit`);
  }
  assert(anyDiff === 0, `any and closest disagree on ${anyDiff} rays`);
  report.checks.push('gpu: front, back, near, far and any-hit agree with the CPU tree');

  // Axis-aligned rays have zero direction parts: the reciprocal must not turn them into misses.
  const box = MeshBVH.build({
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    }),
    flat = await GPUMeshBVH.create(device, box),
    axis = await flat.raycast([
      { origin: [0.25, -0.25, 3], direction: [0, 0, -2] },
      { origin: [0.25, -0.25, -3], direction: [0, 0, 1] },
      { origin: [0, 0, 1], direction: [0, 0, -1] },
      { origin: [5, 0, 0], direction: [-1, 0, 0] },
      { origin: [0, 0, 1], direction: [0, 0, 0] },
    ]);
  assert(Math.abs(axis.distance[0] - 3) < 1e-6 && axis.frontFace[0] === 1, 'axis ray from the front');
  assert(Math.abs(axis.distance[1] - 3) < 1e-6 && axis.frontFace[1] === 0, 'axis ray from the back');
  assert(axis.faceIndex[2] === 0, `a ray through the shared diagonal answers the lowest face, not ${axis.faceIndex[2]}`);
  assert(axis.faceIndex[3] < 0, 'a ray in the plane of the mesh misses');
  assert(axis.faceIndex[4] < 0, 'a zero direction misses');
  report.checks.push('gpu: axis-aligned rays, the lowest face on a shared edge, in-plane and zero rays');
  flat.dispose();

  // Refit: moved vertices answer at their new place after update().
  const moved = { positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
    tree = MeshBVH.build(moved),
    live = await GPUMeshBVH.create(device, tree),
    ray = [{ origin: [0, 0, 5], direction: [0, 0, -1] }];
  assert(Math.abs((await live.raycast(ray)).distance[0] - 5) < 1e-6, 'before the move');
  for (let i = 2; i < 9; i += 3) tree.positions[i] = 2;
  tree.refit();
  live.update();
  assert(Math.abs((await live.raycast(ray)).distance[0] - 3) < 1e-6, 'after refit and update');
  live.dispose();
  report.checks.push('gpu: refit and update move the answers');

  // More rays than one dispatch row: the last ray must still be traced.
  if (device.limits.maxStorageBufferBindingSize >= 2 ** 27) {
    const count = 65536 * 64,
      all = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) {
      all[i * 8 + 2] = 5;
      all[i * 8 + 6] = -1;
      all[i * 8 + 7] = GPU_FAR;
    }
    const answers = await gpu.raycast(all);
    assert(answers.faceIndex[count - 1] >= 0 && answers.faceIndex[0] >= 0, 'the last ray of a two-row dispatch was traced');
    assert(answers.distance[count - 1] === answers.distance[0], 'every ray of the batch is the same ray');
    report.checks.push(`gpu: ${count} rays span two dispatch rows`);
  }

  // Inside a user shader: bvhWGSL in group 1.
  const code = `${bvhWGSL({ group: 1, binding: 2 })}
    @group(0) @binding(0) var<storage, read_write> out: array<f32>;
    @compute @workgroup_size(1) fn main() {
      let hit = bvhClosest(vec3f(0.1, 0.2, 5.0), vec3f(0.0, 0.0, -1.0), 0.0, 1000.0, 0u);
      let shadow = bvhAny(vec3f(0.1, 0.2, 5.0), vec3f(0.0, 0.0, 1.0), 0.0, 1000.0, 0u);
      out[0] = hit.distance;
      out[1] = select(0.0, 1.0, shadow.face == BVH_MISS);
    }`,
    pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    }),
    out = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    read = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: out } }] }),
  );
  pass.setBindGroup(
    1,
    device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: gpu.bindings(2) }),
  );
  pass.dispatchWorkgroups(1);
  pass.end();
  encoder.copyBufferToBuffer(out, 0, read, 0, 16);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const [distance, clear] = new Float32Array(read.getMappedRange()),
    expected = bvh.raycastFirst({ origin: [0.1, 0.2, 5], direction: [0, 0, -1] });
  assert(Math.abs(distance - expected.distance) < 1e-4, `WGSL in a user shader: ${distance} vs ${expected.distance}`);
  assert(clear === 1, 'bvhAny outward from outside the mesh is clear');
  read.unmap();
  report.checks.push('gpu: bvhWGSL traces inside a user shader');

  gpu.dispose();
  const failure = await device.popErrorScope();
  assert(!failure, `WebGPU validation error: ${failure?.message}`);
  assert(errors.length === 0, `uncaptured WebGPU errors: ${errors.join('; ')}`);
  device.destroy();
  return { rays: rays.length, gpuMs: Math.round(gpuMs), cpuMs: Math.round(cpuMs) };
}
