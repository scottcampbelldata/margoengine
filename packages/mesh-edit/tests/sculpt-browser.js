import { Engine } from '@margoengine/core';
import { createPrimitiveMesh } from '@margoengine/mesh-edit';
import { subdivideMesh } from '@margoengine/mesh-edit/modeling';
import { MeshSculptSession } from '@margoengine/mesh-edit/sculpt';
import { SculptView } from '@margoengine/mesh-edit/sculpt-view';
import { paintMeshWeights, VertexGroups } from '@margoengine/mesh-edit/weights';
import { splitMeshByPlane } from '@margoengine/mesh-edit/section';
import { batchBooleanMeshes } from '@margoengine/mesh-edit/boolean-batch';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** A sphere of radius 1 as triangles. */
function ball(levels) {
  let mesh = createPrimitiveMesh('cube', 'box');
  for (let i = 0; i < levels; i++) mesh = subdivideMesh(mesh).mesh;
  return {
    vertices: mesh.vertices.map((p) => p.map((x) => x / Math.hypot(...p))),
    faces: mesh.faces.flatMap((face) =>
      face.vertices.slice(1, -1).map((_, i) => ({
        id: `${face.id}.${i}`,
        vertices: [face.vertices[0], face.vertices[i + 1], face.vertices[i + 2]],
        uv: [face.uv[0], face.uv[i + 1], face.uv[i + 2]],
      })),
    ),
  };
}

function snapshot(engine) {
  engine.canvas.setAttribute('width', engine.canvas.width);
  engine.render();
  const canvas = document.createElement('canvas');
  canvas.width = engine.canvas.width;
  canvas.height = engine.canvas.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(engine.canvas, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

function difference(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 4)
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) count++;
  return count;
}

window.runSculptTests = async () => {
  const checks = [],
    engine = await Engine.create(document.getElementById('view'), {
      camera: { position: [0, 0, 4], target: [0, 0, 0], fov: 45 },
    }),
    queue = engine.gpu.queue,
    write = queue.writeBuffer.bind(queue);
  let bytes = 0;
  queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
    if (buffer.size >= 1 << 20) bytes += (size ?? data.length - (dataOffset ?? 0)) * (data.BYTES_PER_ELEMENT ?? 1);
    return write(buffer, offset, data, dataOffset, size);
  };

  // A pointer stroke on a real drawn mesh: pick along the camera's ray, dab, and the next frame shows it.
  const session = new MeshSculptSession(ball(5), { radius: 0.35, strength: 1 }),
    view = SculptView.attach(engine, session),
    total = session.drawing().vertices.byteLength,
    before = snapshot(engine),
    started = performance.now();
  const hit = session.pick([0.3, 0.2, 4], [-0.3 / 4, -0.2 / 4, -1]);
  assert(hit, 'the ray hits the sphere');
  session.beginStroke({ brush: 'draw' });
  for (let i = 0; i < 6; i++) session.dab(hit.point);
  session.endStroke();
  const dabs = performance.now() - started;
  bytes = 0;
  const after = snapshot(engine),
    uploaded = bytes;
  assert(difference(before, after) > 200, `the stroke shows in the picture (${difference(before, after)} pixels)`);
  assert(uploaded > 0 && uploaded < total / 5, `a stroke uploads part of the mesh (${uploaded} of ${total} bytes)`);
  assert(view.stats.rewrites === 0, 'a stroke on fixed topology never rewrites the mesh');
  checks.push(
    `stroke on ${session.triangleCount} triangles: ${uploaded} of ${total} bytes uploaded, pick and dabs ${dabs.toFixed(1)} ms`,
  );

  session.undo();
  const undone = snapshot(engine);
  assert(difference(before, undone) === 0, `undo restores the picture (${difference(before, undone)} pixels)`);
  checks.push('undo draws the first picture again');
  view.dispose();

  // Dynamic topology draws too: new triangles reach the GPU.
  const growing = new MeshSculptSession(ball(4), { radius: 0.5, strength: 1, dynamicTopology: true, detailSize: 0.03 }),
    second = SculptView.attach(engine, growing),
    start = growing.triangleCount,
    plain = snapshot(engine),
    tip = growing.pick([0, 0, 4], [0, 0, -1]);
  growing.beginStroke({ brush: 'draw' });
  for (let i = 0; i < 4; i++) growing.dab(tip.point);
  growing.endStroke();
  const grown = snapshot(engine);
  assert(growing.triangleCount > start, 'dynamic topology added triangles');
  assert(second.stats.rewrites > 0, 'new triangles rewrite the mesh');
  assert(difference(plain, grown) > 100, 'the grown surface shows');
  checks.push(`dynamic topology ${start} to ${growing.triangleCount} triangles, drawn`);
  second.dispose();

  // Weight painting runs in a page as it does in Node.
  const mesh = createPrimitiveMesh('cube', 'body'),
    groups = new VertexGroups(mesh.vertices.length);
  paintMeshWeights(groups, mesh, 'hip', { center: [0, -0.5, 0], radius: 1 });
  paintMeshWeights(groups, mesh, 'chest', { center: [0, 0.5, 0], radius: 1, normalize: true });
  const { joints, weights } = groups.skinAttributes();
  assert(joints.length === mesh.vertices.length * 4 && weights.length === joints.length, 'skin attributes per vertex');
  checks.push('paintMeshWeights and skinAttributes run in the page');
  const empty = snapshot(engine),
    split = splitMeshByPlane(createPrimitiveMesh('cube', 'section'), { normal: [0, 0, 1], offset: 0 }),
    sectionSession = new MeshSculptSession(split.negative),
    sectionView = SculptView.attach(engine, sectionSession),
    capped = snapshot(engine);
  assert(split.section.polygons.length === 1, 'section has one square region');
  assert(difference(empty, capped) > 1000, 'capped half-solid reaches the renderer');
  sectionView.dispose();
  checks.push('splitMeshByPlane capped output renders');
  const batch = batchBooleanMeshes([createPrimitiveMesh('cube', 'a'), createPrimitiveMesh('cube', 'b')]),
    batchSession = new MeshSculptSession(batch.mesh),
    batchView = SculptView.attach(engine, batchSession);
  assert(batch.work.materializations === 1, 'batch rounds once');
  assert(difference(empty, snapshot(engine)) > 1000, 'batch union output reaches the renderer');
  batchView.dispose();
  checks.push('batchBooleanMeshes output renders');
  engine.dispose();
  return { checks };
};
