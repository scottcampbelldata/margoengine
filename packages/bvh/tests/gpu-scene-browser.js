// Real GPU checks of @margoengine/bvh/gpu-scene, run by bvh-browser.js: every answer is compared with one float64 CPU
// tree over the same triangles flattened into world space.
import { MeshBVH } from '@margoengine/bvh';
import { GPUSceneBVH, sceneBvhWGSL } from '@margoengine/bvh/gpu-scene';
import { composeMatrix } from '@margoengine/math/mat4';

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

function sphere(segments, rings, bump) {
  const positions = [],
    indices = [];
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= segments; s++) {
      const phi = (Math.PI * r) / rings,
        theta = (2 * Math.PI * (s % segments)) / segments,
        radius = 1 + bump * Math.sin(phi * 7) * Math.cos(theta * 5);
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

function cube() {
  // Six faces of [-1, 1]^3, each wound counter-clockwise seen from outside.
  const p = [],
    idx = [];
  for (let n = 0; n < 3; n++)
    for (const sign of [1, -1]) {
      const a = (n + 1) % 3,
        b = (n + 2) % 3,
        base = p.length / 3;
      for (const [u, v] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const q = [0, 0, 0];
        q[a] = u * sign;
        q[b] = v;
        q[n] = sign;
        p.push(...q);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  return { positions: new Float32Array(p), indices: new Uint32Array(idx) };
}

const det3 = (m) =>
  m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

/** Every instance's triangles in world space in one CPU tree; a mirrored instance swaps b and c, so its world winding
 * names the faces of the transformed normal, as the GPU scene does. */
function flatten(meshes, placed) {
  const positions = [],
    indices = [],
    owner = [];
  placed.forEach(({ mesh, matrix }, instance) => {
    const { positions: p, indices: ix } = meshes[mesh],
      base = positions.length / 3,
      mirror = det3(matrix) < 0;
    for (let v = 0; v < p.length; v += 3)
      for (let a = 0; a < 3; a++)
        positions.push(matrix[a] * p[v] + matrix[4 + a] * p[v + 1] + matrix[8 + a] * p[v + 2] + matrix[12 + a]);
    for (let t = 0; t < ix.length; t += 3) {
      indices.push(base + ix[t], base + (mirror ? ix[t + 2] : ix[t + 1]), base + (mirror ? ix[t + 1] : ix[t + 2]));
      owner.push([instance, t / 3, mirror]);
    }
  });
  return {
    bvh: MeshBVH.build(
      { positions: new Float64Array(positions), indices: new Uint32Array(indices) },
      { precision: 'float64' },
    ),
    owner,
  };
}

function placements(next, count, meshes) {
  const placed = [];
  for (let i = 0; i < count; i++) {
    const axis = [next() - 0.5, next() - 0.5, next() - 0.5],
      length = Math.hypot(...axis) || 1,
      angle = next() * Math.PI,
      s = Math.sin(angle / 2) / length,
      scale = 0.4 + next() * 0.8,
      flip = i % 7 === 3 ? -1 : 1;
    placed.push({
      mesh: i % meshes,
      matrix: composeMatrix(
        [next() * 16 - 8, next() * 16 - 8, next() * 16 - 8],
        [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)],
        [scale * flip, scale * (0.7 + next() * 0.6), scale],
        new Float64Array(16),
      ),
    });
  }
  return placed;
}

function compare(label, hits, rays, oracle) {
  let same = 0,
    edges = 0,
    grazing = 0,
    count = 0;
  rays.forEach((ray, i) => {
    const hit = oracle.bvh.raycastFirst(ray),
      instance = hits.instance[i];
    if (hit) count++;
    if (!hit && instance < 0) return void same++;
    if (!hit || instance < 0) {
      const w = hit ? Math.min(...hit.barycoord) : Math.min(...hits.barycoord.subarray(i * 3, i * 3 + 3));
      assert(w < 1e-3, `${label} ray ${i}: ${hit ? 'CPU' : 'GPU'} alone hit, inside a face (weight ${w})`);
      grazing++;
      return;
    }
    assert(
      Math.abs(hit.distance - hits.distance[i]) <= 2e-4 * Math.max(1, hit.distance),
      `${label} ray ${i}: distance ${hits.distance[i]} vs ${hit.distance}`,
    );
    const [owner, face, mirror] = oracle.owner[hit.faceIndex];
    if (owner === instance && face === hits.faceIndex[i]) {
      same++;
      const w = hit.barycoord,
        cpu = mirror ? [w[0], w[2], w[1]] : w;
      for (let k = 0; k < 3; k++)
        assert(Math.abs(cpu[k] - hits.barycoord[i * 3 + k]) < 2e-2, `${label} ray ${i}: weight ${k}`);
      assert(hit.frontFace === !!hits.frontFace[i], `${label} ray ${i}: side`);
    } else {
      assert(Math.min(...hit.barycoord) < 1e-2, `${label} ray ${i}: other face away from an edge`);
      edges++;
    }
  });
  assert(same + edges + grazing === rays.length, `${label}: every ray is accounted for`);
  assert(same > rays.length * 0.995, `${label}: only ${same} of ${rays.length} rays agree exactly`);
  return { same, edges, grazing, hits: count };
}

function aimedRays(next, count) {
  const rays = [];
  for (let i = 0; i < count; i++) {
    const o = [next() * 30 - 15, next() * 30 - 15, next() * 30 - 15],
      t = [next() * 18 - 9, next() * 18 - 9, next() * 18 - 9];
    rays.push({ origin: o, direction: [t[0] - o[0], t[1] - o[1], t[2] - o[2]] });
  }
  return rays;
}

/** Runs every check on one device; pushes a line per check into `report.checks`. */
export async function gpuSceneChecks(report) {
  const adapter = await navigator.gpu.requestAdapter();
  assert(adapter, 'no WebGPU adapter');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const sources = [sphere(48, 32, 0.12), cube(), sphere(16, 10, 0)],
    trees = sources.map((source) => MeshBVH.build(source)),
    next = random(11),
    placed = placements(next, 50, sources.length),
    materials = placed.map((_, i) => ({
      color: [(i % 5) / 4, (i % 3) / 2, 0.25],
      emissive: [i % 4 === 0 ? 2 : 0, 0, 0],
      metalness: (i % 2) * 0.5,
      roughness: 0.25 + (i % 3) * 0.25,
    })),
    scene = await GPUSceneBVH.create(
      device,
      placed.map(({ mesh, matrix }, i) => ({ bvh: trees[mesh], matrix, material: materials[i] })),
    );
  const rays = aimedRays(next, 20000);
  let oracle = flatten(sources, placed);
  const closest = compare('closest', await scene.raycast(rays), rays, oracle);
  assert(closest.hits > 5000, `only ${closest.hits} rays met the scene`);
  report.checks.push(
    `gpu-scene (${globalThis.__margoCompat ? 'WebGL2 layer' : 'WebGPU'}): ${closest.same} of ${rays.length} rays match a world-space CPU tree (${closest.hits} hits, 50 instances of 3 meshes, 7 mirrored), ${closest.edges} edge ties, ${closest.grazing} grazes`,
  );

  // Any-hit answers a hit exactly where closest does, within the same far.
  const any = await scene.raycast(rays, { mode: 'any' }),
    closestHits = await scene.raycast(rays);
  let anyAgree = 0;
  for (let i = 0; i < rays.length; i++) {
    const a = any.instance[i] >= 0,
      c = closestHits.instance[i] >= 0;
    assert(a === c, `any ray ${i}: ${a} vs closest ${c}`);
    if (a) assert(any.distance[i] >= closestHits.distance[i] * (1 - 1e-6), `any ray ${i} is nearer than the closest`);
    anyAgree++;
  }
  report.checks.push(`gpu-scene: any-hit agrees with closest on all ${anyAgree} rays and is never nearer`);

  // Move ten instances a little: a refit, and the answers follow the CPU tree of the new placement.
  for (let i = 0; i < 10; i++) {
    const m = placed[i].matrix.slice();
    m[12] += 0.5;
    m[13] -= 0.25;
    placed[i] = { ...placed[i], matrix: m };
    scene.setMatrix(i, m);
  }
  const small = scene.update();
  assert(small === 'refit', `a small move ${small}`);
  oracle = flatten(sources, placed);
  const moved = compare('refit', await scene.raycast(rays), rays, oracle);
  // Then scatter everything far apart: the refit tree costs more than 1.5 times the built one, so it is rebuilt.
  for (let i = 0; i < placed.length; i++) {
    const m = placed[i].matrix.slice();
    m[12] = (next() - 0.5) * 200;
    m[13] = (next() - 0.5) * 200;
    m[14] = (next() - 0.5) * 200;
    placed[i] = { ...placed[i], matrix: m };
    scene.setMatrix(i, m);
  }
  assert(scene.update() === 'rebuilt', 'a scatter rebuilds');
  assert(scene.update() === 'unchanged', 'nothing changed');
  oracle = flatten(sources, placed);
  const wide = [];
  for (let i = 0; i < 4000; i++) {
    const p = placed[i % placed.length].matrix,
      o = [p[12] + next() * 8 - 4, p[13] + next() * 8 - 4, p[14] + 6];
    wide.push({ origin: o, direction: [p[12] - o[0], p[13] - o[1], p[14] - o[2]] });
  }
  const rebuilt = compare('rebuilt', await scene.raycast(wide), wide, oracle);
  report.checks.push(
    `gpu-scene: after a refit ${moved.same}/${rays.length} and after a rebuild ${rebuilt.same}/${wide.length} rays match the CPU tree of the new placement`,
  );

  // sceneBvhWGSL in a shader of our own: normal and material at the hit.
  const module = device.createShaderModule({
    code: `${sceneBvhWGSL({ group: 0, binding: 0 })}
struct Ray { origin: vec3f, near: f32, direction: vec3f, far: f32 }
@group(1) @binding(0) var<storage, read> rays: array<Ray>;
@group(1) @binding(1) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rays)) { return; }
  let r = rays[id.x];
  let h = sceneClosest(r.origin, r.direction, r.near, r.far);
  if (h.instance == SCENE_MISS) { out[id.x * 2u] = vec4f(0.0); out[id.x * 2u + 1u] = vec4f(-1.0); return; }
  let m = sceneMaterial(h.instance);
  out[id.x * 2u] = vec4f(sceneNormal(h), m.roughness);
  out[id.x * 2u + 1u] = vec4f(m.color.rg, m.emissive.r, m.metalness);
}`,
  });
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const sample = wide.slice(0, 2048),
    packed = new Float32Array(sample.length * 8);
  sample.forEach(({ origin, direction }, i) => {
    packed.set(origin, i * 8);
    packed.set(direction, i * 8 + 4);
    packed[i * 8 + 7] = 1e30;
  });
  const input = device.createBuffer({
      size: packed.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    output = device.createBuffer({ size: sample.length * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    read = device.createBuffer({ size: sample.length * 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(input, 0, packed);
  const encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: scene.bindings() }));
  pass.setBindGroup(
    1,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    }),
  );
  pass.dispatchWorkgroups(Math.ceil(sample.length / 64));
  pass.end();
  encoder.copyBufferToBuffer(output, 0, read, 0, sample.length * 32);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const values = new Float32Array(read.getMappedRange().slice(0));
  read.unmap();
  let shaded = 0;
  sample.forEach((ray, i) => {
    const hit = oracle.bvh.raycastFirst(ray);
    if (!hit || values[i * 8 + 7] < 0 || Math.min(...hit.barycoord) < 1e-3) return;
    const [instance] = oracle.owner[hit.faceIndex],
      material = materials[instance],
      n = values.subarray(i * 8, i * 8 + 3),
      dot = n[0] * hit.faceNormal[0] + n[1] * hit.faceNormal[1] + n[2] * hit.faceNormal[2];
    assert(dot > 0.999, `shader ray ${i}: normal ${[...n]} vs ${hit.faceNormal}`);
    assert(Math.abs(values[i * 8 + 3] - material.roughness) < 1e-6, `shader ray ${i}: roughness`);
    assert(
      Math.abs(values[i * 8 + 4] - material.color[0]) < 1e-6 && Math.abs(values[i * 8 + 5] - material.color[1]) < 1e-6,
      `shader ray ${i}: colour`,
    );
    assert(
      values[i * 8 + 6] === material.emissive[0] && values[i * 8 + 7] === material.metalness,
      `shader ray ${i}: pbr`,
    );
    shaded++;
  });
  assert(shaded > 500, `only ${shaded} shader rays compared`);
  report.checks.push(
    `gpu-scene: sceneBvhWGSL in a shader of our own gives the CPU face normal and the material on ${shaded} hits`,
  );

  // Front faces only: a ray from inside a closed instance meets only back faces, so it misses.
  const front = await GPUSceneBVH.create(device, [{ bvh: trees[1], matrix: placed[0].matrix, side: 'front' }]),
    p = placed[0].matrix,
    inside = [];
  for (let i = 0; i < 200; i++)
    inside.push({ origin: [p[12], p[13], p[14]], direction: [next() - 0.5, next() - 0.5, next() - 0.5] });
  const outsideHits = await front.raycast(inside);
  assert(
    outsideHits.instance.every((v) => v < 0),
    'a front-only instance is hit from inside',
  );
  const empty = await GPUSceneBVH.create(device, []);
  assert(
    (await empty.raycast(inside)).instance.every((v) => v < 0),
    'an empty scene answers a hit',
  );
  report.checks.push(
    'gpu-scene: front-only faces skip rays from inside a closed mesh, and an empty scene misses every ray',
  );

  const error = await device.popErrorScope();
  assert(!error, `validation: ${error?.message}`);
  for (const value of [scene, front, empty]) value.dispose();
  input.destroy();
  output.destroy();
  read.destroy();
  device.destroy();
  return { closest, moved, rebuilt, shaded };
}
