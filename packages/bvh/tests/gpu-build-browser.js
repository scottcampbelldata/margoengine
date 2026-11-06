// Real GPU checks of @margoengine/bvh/gpu-build, run by bvh-browser.js: trees are read back and checked node by node, and
// rays through them are compared with a float64 CPU tree of the same pose.
import { MeshBVH } from '@margoengine/bvh';
import { GPUDynamicBVH } from '@margoengine/bvh/gpu-build';

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

function grid(segments, rings) {
  const rest = [],
    indices = [];
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= segments; s++) {
      const phi = (Math.PI * r) / rings,
        theta = (2 * Math.PI * (s % segments)) / segments;
      rest.push(Math.sin(phi) * Math.cos(theta), Math.cos(phi), -Math.sin(phi) * Math.sin(theta));
    }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return { positions: new Float32Array(rest), indices: new Uint32Array(indices) };
}

// The pose a compute pass writes: each point pushed along x by its height.
const bend = (positions, amount) => {
  const out = Float32Array.from(positions);
  for (let i = 0; i < out.length; i += 3) out[i] = Math.fround(out[i] + Math.fround(amount * out[i + 1] * out[i + 1]));
  return out;
};

const BEND_WGSL = /* wgsl */ `
struct Bend { amount: f32, count: u32 }
@group(0) @binding(0) var<storage, read> rest: array<f32>;
@group(0) @binding(1) var<storage, read_write> pose: array<f32>;
@group(0) @binding(2) var<uniform> bend: Bend;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * 65535u * 64u;
  if (i >= bend.count) { return; }
  let x = rest[i * 3u];
  let y = rest[i * 3u + 1u];
  pose[i * 3u] = x + bend.amount * y * y;
  pose[i * 3u + 1u] = y;
  pose[i * 3u + 2u] = rest[i * 3u + 2u];
}
`;

async function read(device, buffer) {
  const copy = device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, copy, 0, buffer.size);
  device.queue.submit([encoder.finish()]);
  await copy.mapAsync(GPUMapMode.READ);
  const bytes = copy.getMappedRange().slice(0);
  copy.destroy();
  return bytes;
}

// Every node inside its parent, every triangle reached once, every leaf's box round its triangle, at most 64 deep.
async function checkTree(device, dynamic, positions, indices, stride = 3, offset = 0) {
  const { tree } = dynamic,
    bytes = await read(device, tree.nodes),
    floats = new Float32Array(bytes),
    words = new Uint32Array(bytes),
    index = new Uint32Array(await read(device, tree.index)),
    faces = new Uint32Array(await read(device, tree.faces)),
    triangles = indices.length / 3,
    seen = new Uint8Array(triangles),
    stack = [[0, 1]];
  let reached = 0,
    deepest = 0;
  const inside = (node, p) => {
    for (let k = 0; k < 3; k++)
      assert(floats[node * 8 + k] <= p[k] && p[k] <= floats[node * 8 + 4 + k], `node ${node} leaves out ${p}`);
  };
  while (stack.length) {
    const [node, depth] = stack.pop(),
      right = words[node * 8 + 7],
      left = words[node * 8 + 3];
    deepest = Math.max(deepest, depth);
    if (right & 0x80000000) {
      const second = right & 0x7fffffff;
      for (const child of [left, second]) {
        for (let k = 0; k < 3; k++) {
          assert(floats[node * 8 + k] <= floats[child * 8 + k], `child ${child} of ${node} pokes out`);
          assert(floats[child * 8 + 4 + k] <= floats[node * 8 + 4 + k], `child ${child} of ${node} pokes out`);
        }
        stack.push([child, depth + 1]);
      }
      continue;
    }
    for (let t = left; t < left + right; t++) {
      const face = faces[t];
      assert(face < triangles && !seen[face], `face ${face} reached twice or out of range`);
      seen[face] = 1;
      reached++;
      for (let v = 0; v < 3; v++) {
        assert(index[t * 3 + v] === indices[face * 3 + v], `face ${face} corner ${v} does not match its source`);
        const o = index[t * 3 + v] * stride + offset;
        inside(node, positions.subarray(o, o + 3));
      }
    }
  }
  assert(reached === triangles, `${reached} of ${triangles} triangles reached`);
  assert(deepest <= 64, `depth ${deepest}`);
  return deepest;
}

function rayset(count, seed) {
  const next = random(seed),
    rays = [];
  for (let i = 0; i < count; i++) {
    const o = [next() * 6 - 3, next() * 6 - 3, next() * 6 - 3],
      target = [next() * 2 - 1, next() * 2 - 1, next() * 2 - 1];
    rays.push({ origin: o, direction: [target[0] - o[0], target[1] - o[1], target[2] - o[2]] });
  }
  return rays;
}

// Rays through the GPU tree against a CPU tree of the same pose: only a triangle's very edge may differ.
async function compare(dynamic, cpu, rays, label) {
  const hits = await dynamic.tree.raycast(rays);
  let same = 0,
    met = 0;
  rays.forEach((ray, i) => {
    const hit = cpu.raycastFirst(ray),
      face = hits.faceIndex[i];
    if (hit) met++;
    if (!hit && face < 0) return void same++;
    if (!hit || face < 0) {
      const weight = hit
        ? Math.min(...hit.barycoord)
        : Math.min(hits.barycoord[i * 3], hits.barycoord[i * 3 + 1], hits.barycoord[i * 3 + 2]);
      assert(weight < 1e-3, `${label} ray ${i}: one side alone hit, inside the face (weight ${weight})`);
      return;
    }
    assert(
      Math.abs(hit.distance - hits.distance[i]) <= 1e-4 * Math.max(1, hit.distance),
      `${label} ray ${i}: distance ${hits.distance[i]} vs ${hit.distance}`,
    );
    if (hit.faceIndex === face) same++;
    else assert(Math.min(...hit.barycoord) < 1e-2, `${label} ray ${i}: face ${face} vs ${hit.faceIndex} off an edge`);
  });
  assert(met > rays.length / 10, `${label}: only ${met} rays met the mesh`);
  assert(same > rays.length * 0.99, `${label}: only ${same} of ${rays.length} rays agree`);
  return same;
}

const storage = (device, data, extra = 0) => {
  const buffer = device.createBuffer({
    size: Math.max(data.byteLength, 16),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extra,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
};

/** Runs every check on one device; pushes a line per check into `report.checks`. */
export async function gpuBuildChecks(report) {
  const adapter = await navigator.gpu.requestAdapter();
  assert(adapter, 'no WebGPU adapter');
  const device = await adapter.requestDevice(),
    errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const mesh = grid(160, 100),
    rays = rayset(20000, 21),
    update = (dynamic) => {
      const encoder = device.createCommandEncoder();
      dynamic.encode(encoder);
      device.queue.submit([encoder.finish()]);
    };

  // A fresh build at rest, then again at a new pose written by the CPU: the same tree object follows.
  const vertices = storage(device, mesh.positions, GPUBufferUsage.COPY_SRC),
    built = await GPUDynamicBVH.create(device, { vertices, indices: mesh.indices });
  update(built);
  const depth = await checkTree(device, built, mesh.positions, mesh.indices);
  await compare(built, MeshBVH.build(mesh), rays, 'build');
  const posed = bend(mesh.positions, 0.8);
  device.queue.writeBuffer(vertices, 0, posed);
  update(built);
  await checkTree(device, built, posed, mesh.indices);
  const agreed = await compare(built, MeshBVH.build({ positions: posed, indices: mesh.indices }), rays, 'rebuilt');
  report.checks.push(
    `gpu build: ${mesh.indices.length / 3} triangles rebuilt a frame at depth ${depth}; ${agreed} of ${rays.length} rays match a CPU tree of the pose`,
  );

  // Refit from a rest-pose tree: a compute pass writes the pose, the tree follows and rays trace in one encoder, with
  // no readback of the vertices.
  const restBuffer = storage(device, mesh.positions),
    pose = storage(device, mesh.positions, GPUBufferUsage.COPY_SRC),
    count = mesh.positions.length / 3,
    uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const params = new ArrayBuffer(8);
  new Float32Array(params, 0, 1)[0] = 1.2;
  new Uint32Array(params, 4, 1)[0] = count;
  device.queue.writeBuffer(uniform, 0, params);
  const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: BEND_WGSL }), entryPoint: 'main' },
    }),
    group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [restBuffer, pose, uniform].map((buffer, binding) => ({ binding, resource: { buffer } })),
    }),
    refit = await GPUDynamicBVH.create(device, {
      vertices: pose,
      indices: mesh.indices,
      mode: 'refit',
      bvh: MeshBVH.build(mesh),
    }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(count / 64));
  pass.end();
  refit.encode(encoder);
  device.queue.submit([encoder.finish()]);
  const bent = bend(mesh.positions, 1.2),
    refitAgreed = await compare(refit, MeshBVH.build({ positions: bent, indices: mesh.indices }), rays, 'refit');
  await checkTree(device, refit, new Float32Array(await read(device, pose)), mesh.indices);
  report.checks.push(`gpu refit: ${refitAgreed} of ${rays.length} rays through a pose only the GPU wrote match the CPU`);

  // Interleaved vertices, a mesh of one triangle, of a count that pads the sort, and of many triangles at one place.
  const interleaved = new Float32Array((mesh.positions.length / 3) * 8);
  for (let i = 0; i < mesh.positions.length / 3; i++) interleaved.set(mesh.positions.subarray(i * 3, i * 3 + 3), i * 8 + 2);
  const wide = await GPUDynamicBVH.create(device, {
    vertices: storage(device, interleaved),
    indices: mesh.indices,
    stride: 8,
    offset: 2,
  });
  update(wide);
  await checkTree(device, wide, interleaved, mesh.indices, 8, 2);
  await compare(wide, MeshBVH.build(mesh), rays.slice(0, 4000), 'interleaved');

  const small = async (positions, indices) => {
    const dynamic = await GPUDynamicBVH.create(device, { vertices: storage(device, positions), indices });
    update(dynamic);
    const deepest = await checkTree(device, dynamic, positions, indices);
    dynamic.dispose();
    return deepest;
  };
  const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert((await small(triangle, new Uint32Array([0, 1, 2]))) === 1, 'one triangle is one node');
  await small(triangle, new Uint32Array(Array.from({ length: 5 * 3 }, (_, i) => i % 3)));
  const stacked = await small(triangle, new Uint32Array(Array.from({ length: 1000 * 3 }, (_, i) => i % 3)));
  await small(new Float32Array(9), new Uint32Array([0, 1, 2, 0, 1, 2, 0, 1, 2]));
  report.checks.push(`gpu build: lone, padded and coincident triangles build whole trees, 1000 at one place ${stacked} deep`);

  // Two updates in one encoder each start clean.
  const twice = device.createCommandEncoder();
  built.encode(twice);
  built.encode(twice);
  device.queue.submit([twice.finish()]);
  await checkTree(device, built, posed, mesh.indices);

  built.dispose();
  refit.dispose();
  wide.dispose();
  const scoped = await device.popErrorScope();
  assert(!scoped, `validation: ${scoped?.message}`);
  assert(!errors.length, `GPU errors: ${errors.join('; ')}`);
  vertices.destroy();
  device.destroy();
  return true;
}
