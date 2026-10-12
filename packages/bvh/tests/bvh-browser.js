import {Engine, Geometry, PbrMaterial, box} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {MeshBVH, Raycaster, buildAsync, computeGeometryBVHAsync, hasGeometryBVH, terminateBVHWorker} from '@margoengine/bvh';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const near = (a, b, eps, label) => assert(Math.abs(a - b) <= eps, `${label}: ${a} vs ${b}`);
const nearVec = (a, b, eps, label) => a.forEach((v, i) => near(v, b[i], eps, `${label}[${i}]`));
const sameBytes = (a, b) => {const x = new Uint8Array(a), y = new Uint8Array(b); return x.length === y.length && x.every((v, i) => v === y[i]);};

function sphere(segments, rings, radius = 0.5) {
  const positions = [], normals = [], indices = [];
  for (let r = 0; r <= rings; r++) for (let s = 0; s <= segments; s++) {
    const phi = Math.PI * r / rings, theta = 2 * Math.PI * s / segments, n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), -Math.sin(phi) * Math.sin(theta)];
    positions.push(...n.map(v => v * radius)); normals.push(...n);
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
    const a = r * (segments + 1) + s, b = a + segments + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return new Geometry(positions, normals, indices);
}

async function workerChecks(report) {
  const Original = globalThis.Worker;
  let created = 0;
  globalThis.Worker = class extends Original {constructor(...args) {super(...args); created++;}};
  try {
    const geometry = sphere(400, 250), triangles = geometry.indices.length / 3;
    let ticks = 0;
    const interval = setInterval(() => ticks++, 1);
    let start = performance.now();
    const pending = buildAsync(geometry);
    const callMs = performance.now() - start;
    const bvh = await pending;
    const workerMs = performance.now() - start;
    clearInterval(interval);
    start = performance.now();
    const sync = MeshBVH.fromGeometry(geometry);
    const syncMs = performance.now() - start;
    assert(sameBytes(bvh.nodes, sync.nodes) && sameBytes(bvh.index.buffer, sync.index.buffer) && sameBytes(bvh.triangles.buffer, sync.triangles.buffer), 'worker build differs from the synchronous build');
    assert(bvh.positions === geometry.vertices, 'worker BVH does not read the geometry vertices');
    assert(created === 1, `expected one worker, got ${created}`);
    assert(ticks > 0, 'main thread timers did not run during the worker build');
    report.checks.push(`Worker build of ${triangles} triangles is byte-identical to the synchronous build`);

    // Zero-copy transfer of raw arrays: detached while building, returned with the result.
    const positions = geometry.vertices.filter((_, i) => i % 6 < 3), indices = geometry.indices.slice(), length = positions.length;
    const moved = buildAsync({positions, indices}, {transfer: true});
    assert(positions.byteLength === 0 && indices.byteLength === 0, 'transfer: inputs were copied instead of moved');
    const movedBVH = await moved;
    assert(movedBVH.positions.length === length && movedBVH.positions[3] === geometry.vertices[6], 'transfer: positions did not come back');
    assert(sameBytes(movedBVH.nodes, sync.nodes), 'transfer: different tree');
    report.checks.push('transfer: true moves positions and indices to the worker and back without copies');

    // Concurrent builds share the worker; errors, aborts and termination reject only what they should.
    const small = [sphere(40, 20), sphere(30, 30, 2), box(1, 2, 3)];
    const parallel = await Promise.all(small.map(g => buildAsync(g, {maxLeafTriangles: 2})));
    parallel.forEach((b, i) => assert(sameBytes(b.nodes, MeshBVH.fromGeometry(small[i], {maxLeafTriangles: 2}).nodes), `parallel build ${i}`));
    let failure = '';
    await buildAsync({positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, NaN, 0])}).catch(error => {failure = error.message;});
    assert(/finite/.test(failure), `worker error was not reported: ${failure}`);
    const controller = new AbortController(), aborted = buildAsync(geometry, {signal: controller.signal});
    controller.abort();
    assert(await aborted.then(() => false, () => true), 'abort did not reject');
    const doomed = buildAsync(geometry);
    terminateBVHWorker();
    assert(await doomed.then(() => false, () => true), 'terminate did not reject pending builds');
    await computeGeometryBVHAsync(small[0]);
    assert(hasGeometryBVH(small[0]), 'computeGeometryBVHAsync did not cache the BVH');
    assert(created === 2, `expected a new worker after terminate, got ${created}`);
    report.checks.push('Concurrent builds, worker errors, abort, terminate and computeGeometryBVHAsync');
    terminateBVHWorker();
    return {triangles, workerMs: Math.round(workerMs), callMs: +callMs.toFixed(2), syncMs: Math.round(syncMs), mainThreadTimerTicks: ticks};
  } finally {
    globalThis.Worker = Original;
  }
}

function label(pixel) {
  const [r, g, b] = pixel;
  if (Math.abs(r - pixel.bg[0]) + Math.abs(g - pixel.bg[1]) + Math.abs(b - pixel.bg[2]) < 30) return 'none';
  return r > g && r > b ? 'red' : g > r && g > b ? 'green' : b > r && b > g ? 'blue' : 'unknown';
}

async function engineChecks(backend, report) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:256px;height:256px'; document.body.append(canvas);
  const engine = await Engine.create(canvas, {backend, camera: {position: [0, 0, 6], target: [0, 0, 0], fov: 50}});
  assert(engine.backend === backend, `${backend} requested, got ${engine.backend}: ${engine.fallbackReason}`);
  const runtime = engineRuntime(engine), errors = [];
  runtime.gpu?.addEventListener('uncapturederror', event => errors.push(event.error.message));
  runtime.gpu?.pushErrorScope('validation');
  try {
    const material = (color, doubleSided = true) => new PbrMaterial({color, doubleSided, roughness: 0.8});
    const red = engine.createMesh().setGeometry(box(1, 1, 1)).setMaterial(material('#ff2020'));
    const green = engine.createMesh().setGeometry(sphere(64, 48)).setMaterial(material('#20ff20')).setPosition([1.6, 0, 0]).setScale([1.2, 1.2, 1.2]);
    const hidden = engine.createMesh().setGeometry(box(1, 1, 1)).setMaterial(material('#2020ff')).setPosition([0, 0, 2]);
    hidden.visible = false;
    const parent = engine.createMesh().setPosition([-1.6, 0, 1]);
    parent.visible = false;
    const child = engine.createMesh(parent).setGeometry(box(0.8, 0.8, 0.8)).setMaterial(material('#2020ff'));
    const mirrored = engine.createMesh().setGeometry(box(1, 1, 1)).setMaterial(material('#2020ff', false)).setPosition([0, 1.6, 0]).setScale([-1, 1, 1]);
    const tilted = engine.createMesh().setGeometry(box(0.7, 0.7, 0.7)).setMaterial(material('#ff2020')).setPosition([-1.5, -1.4, 0]).setRotation([0.5, 0.8, 0.2]);
    const labels = new Map([[red, 'red'], [green, 'green'], [mirrored, 'blue'], [tilted, 'red'], [child, 'blue'], [hidden, 'blue']]);
    engine.render();
    const snapshot = document.createElement('canvas'); snapshot.width = canvas.width; snapshot.height = canvas.height;
    const context = snapshot.getContext('2d', {willReadFrequently: true});
    context.drawImage(canvas, 0, 0);
    const image = context.getImageData(0, 0, snapshot.width, snapshot.height).data, bg = [...image.slice(0, 3)];
    assert(canvas.width === 256 && canvas.height === 256, `canvas is ${canvas.width}x${canvas.height}`);

    // Known transforms: the center pixel sees the red box's front face.
    const raycaster = new Raycaster().setFromEngine(engine, 128, 128);
    nearVec([...raycaster.origin], [0, 0, 6], 1e-12, 'origin'); nearVec([...raycaster.direction], [0, 0, -1], 1e-6, 'direction');
    let hits = raycaster.intersectEngine(engine);
    // The center ray runs along the shared diagonal of both quads, so each face reports its two triangles.
    assert(hits.length === 4 && hits.every(h => h.mesh === red), `center hits: ${hits.map(h => labels.get(h.mesh))}`);
    hits.forEach((h, i) => near(h.distance, i < 2 ? 5.5 : 6.5, 1e-4, `center distance ${i}`));
    nearVec(hits[0].point, [0, 0, 0.5], 1e-4, 'center point'); nearVec(hits[0].normal, [0, 0, 1], 1e-6, 'center normal');
    assert(hits[0].frontFace && hits[1].frontFace && !hits[2].frontFace && !hits[3].frontFace, 'front/back faces of the red box');
    nearVec(hits[3].normal, [0, 0, -1], 1e-6, 'back face normal');
    // Sphere under translation and uniform scale: radius 0.6 at x = 1.6.
    raycaster.set([1.6, 0, 6], [0, 0, -1]); raycaster.firstHitOnly = true;
    hits = raycaster.intersectEngine(engine);
    assert(hits.length === 1 && hits[0].mesh === green, 'green sphere');
    near(hits[0].distance, 5.4, 2e-3, 'sphere distance'); nearVec(hits[0].normal, [0, 0, 1], 1e-3, 'sphere normal');
    // Hidden ancestor, then visible ancestor.
    raycaster.set([-1.6, 0, 6], [0, 0, -1]);
    assert(raycaster.intersectEngine(engine).length === 0, 'child of a hidden parent was hit');
    parent.visible = true;
    hits = raycaster.intersectEngine(engine);
    assert(hits.length === 1 && hits[0].mesh === child, 'child of a visible parent was missed');
    near(hits[0].distance, 4.6, 1e-4, 'child distance'); nearVec(hits[0].point, [-1.6, 0, 1.4], 1e-4, 'child point');
    parent.visible = false;
    // Mirrored, single-sided mesh: the renderer keeps its local front side, so the outside face is hit.
    raycaster.set([0, 1.6, 6], [0, 0, -1]);
    hits = raycaster.intersectEngine(engine);
    assert(hits.length === 1 && hits[0].mesh === mirrored && hits[0].frontFace, 'mirrored single-sided box');
    nearVec(hits[0].normal, [0, 0, 1], 1e-6, 'mirrored normal'); near(hits[0].distance, 5.5, 1e-4, 'mirrored distance');
    raycaster.set([0, 1.6, 0], [0, 0, -1]); raycaster.firstHitOnly = false;
    assert(raycaster.intersectEngine(engine).length === 0, 'single-sided box was hit from inside');
    report.checks.push(`${backend}: picked mesh, point, normal and distance for translated, scaled, mirrored, hidden and parented meshes`);

    // Every pixel of a 64x64 grid: CPU raycast against the rendered colors (silhouette pixels excluded).
    raycaster.firstHitOnly = true;
    const castAt = (x, y) => {raycaster.setFromEngine(engine, x, y); return raycaster.intersectEngine(engine, {refresh: false})[0]?.mesh ?? null;};
    let compared = 0, mismatches = 0, skipped = 0, covered = 0;
    const start = performance.now();
    for (let gy = 0; gy < 64; gy++) for (let gx = 0; gx < 64; gx++) {
      const x = gx * 4 + 2, y = gy * 4 + 2, mesh = castAt(x + 0.5, y + 0.5);
      if ([[-1.5, 0], [1.5, 0], [0, -1.5], [0, 1.5]].some(([dx, dy]) => castAt(x + 0.5 + dx, y + 0.5 + dy) !== mesh)) {skipped++; continue;}
      const offset = (y * 256 + x) * 4, pixel = [image[offset], image[offset + 1], image[offset + 2]];
      pixel.bg = bg;
      const expected = mesh ? labels.get(mesh) : 'none', seen = label(pixel);
      if (seen !== expected) mismatches++;
      if (mesh) covered++;
      compared++;
    }
    const gridMs = performance.now() - start;
    assert(mismatches === 0, `${backend}: ${mismatches} of ${compared} pixels disagree with the raycaster`);
    assert(covered > 300, `${backend}: only ${covered} grid pixels covered meshes`);
    report.checks.push(`${backend}: raycaster agrees with rendered pixels on ${compared} grid points (${covered} on meshes)`);

    // WebGPU: compare against the engine's GPU id-buffer picking.
    let gpuCompared = 0;
    if (backend === 'webgpu') {
      for (let i = 0; i < 48; i++) {
        const x = 20 + (i * 37) % 216 + 0.5, y = 20 + (i * 53) % 216 + 0.5, mesh = castAt(x, y);
        if ([[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => castAt(x + dx, y + dy) !== mesh)) continue;
        const picked = await engine.pick(x, y);
        assert(picked === mesh, `GPU pick at ${x},${y}: ${labels.get(picked) ?? 'none'} vs raycaster ${labels.get(mesh) ?? 'none'}`);
        gpuCompared++;
      }
      report.checks.push(`webgpu: raycaster matches engine.pick at ${gpuCompared} points`);
    }
    if (runtime.gpu) {
      const scoped = await runtime.gpu.popErrorScope();
      assert(!scoped, `WebGPU validation error: ${scoped?.message}`);
    }
    assert(errors.length === 0, `uncaptured WebGPU errors: ${errors.join('; ')}`);
    return {gridRaysPerSecond: Math.round(64 * 64 * 5 / gridMs * 1000), compared, skipped, covered, gpuCompared, background: bg};
  } finally {
    engine.dispose(); canvas.remove();
  }
}

window.runBVHTests = async () => {
  const report = {checks: []};
  report.worker = await workerChecks(report);
  report.webgpu = await engineChecks('webgpu', report);
  report.webgl2 = await engineChecks('webgl2', report);
  return report;
};
