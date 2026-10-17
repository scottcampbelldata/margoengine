import test from 'node:test';
import assert from 'node:assert/strict';
import { GPURenderer } from '../../core/dist/renderer.js';
import { Engine, TransformStore, PbrMaterial } from '../../core/dist/extension.js';
import { parseCAD, PartInstancer } from '../dist/index.js';

globalThis.GPUBufferUsage = {
  COPY_DST: 8,
  COPY_SRC: 4,
  MAP_READ: 1,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
};
globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, COPY_SRC: 1 };

/** A closed box as an OBJ object: eight corners and six outward quads (relative indices). */
function objBox(name, [x0, y0, z0], [x1, y1, z1]) {
  const corners = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const faces = [
    [1, 4, 3, 2],
    [5, 6, 7, 8],
    [1, 2, 6, 5],
    [4, 8, 7, 3],
    [1, 5, 8, 4],
    [2, 3, 7, 6],
  ];
  return [
    `o ${name}`,
    ...corners.map((c) => `v ${c.join(' ')}`),
    ...faces.map((f) => `f ${f.map((i) => i - 9).join(' ')}`),
  ].join('\n');
}
/** A closed box whose six faces are each an n x n grid: (n + 1)^2 vertices per face after welding. */
function objGridBox(name, size, n) {
  const lines = [`o ${name}`],
    s = size / 2;
  for (let axis = 0; axis < 3; axis++)
    for (const side of [-1, 1]) {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3,
        grid = (i, j) => {
          const p = [0, 0, 0];
          p[axis] = side * s;
          p[u] = -s + (size * i) / n;
          p[v] = -s + (size * j) / n;
          return p;
        };
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const quad = [grid(i, j), grid(i + 1, j), grid(i + 1, j + 1), grid(i, j + 1)];
          if (side < 0) quad.reverse();
          for (const p of quad) lines.push(`v ${p.join(' ')}`);
          lines.push('f -4 -3 -2 -1');
        }
    }
  return lines.join('\n');
}
/** 1,000 distinct small closed boxes (no two share dimensions), one large closed part and one open sheet. */
export function assemblyOBJ() {
  const parts = [];
  for (let i = 0; i < 1000; i++) {
    const x = i % 10,
      y = Math.floor(i / 10) % 10,
      z = Math.floor(i / 100),
      size = [0.2 + x * 0.011, 0.2 + y * 0.013, 0.2 + z * 0.017];
    parts.push(objBox(`part-${i}`, [x, y, z], [x + size[0], y + size[1], z + size[2]]));
  }
  parts.push(objGridBox('big-part', 2, 30));
  parts.push(['o open-sheet', 'v 20 0 0', 'v 21 0 0', 'v 21 1 0', 'v 20 1 0', 'f -4 -3 -2 -1'].join('\n'));
  return parts.join('\n') + '\n';
}

async function scene() {
  const calls = [],
    writes = [],
    pass = {
      setPipeline() {},
      setBindGroup() {},
      setIndexBuffer() {},
      setViewport() {},
      setScissorRect() {},
      end() {},
      setVertexBuffer() {},
      drawIndexed: (count, instances, first, base, firstInstance) =>
        calls.push(['draw', count, instances, first, firstInstance]),
      drawIndexedIndirect: () => calls.push(['indirect']),
    },
    pipeline = { getBindGroupLayout: () => ({}) },
    device = {
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy() {} }),
      createBuffer: (d) => ({ ...d, destroy() {} }),
      lost: new Promise(() => {}),
      addEventListener() {},
      destroy() {},
      limits: { maxBufferSize: 1 << 30 },
      queue: { writeBuffer: (buffer, offset, data) => writes.push([buffer, offset, data]), submit() {} },
      createCommandEncoder: () => ({ finish: () => ({}), beginRenderPass: () => pass }),
    },
    renderer = new GPURenderer(
      { width: 64, height: 64 },
      device,
      { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) },
      'bgra8unorm',
      pipeline,
      {
        multisample: { count: 4 },
        depthStencil: { format: 'depth32float-stencil8' },
        vertex: { buffers: [] },
        fragment: { targets: [] },
      },
      pipeline,
    ),
    engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      await TransformStore.create(2048),
      renderer,
      { position: [5, 5, 30], target: [5, 5, 5] },
      null,
    ),
    model = parseCAD(engine, assemblyOBJ(), 'obj');
  const frame = () => {
    calls.length = 0;
    engine.render({ culling: false });
    return calls.length;
  };
  return { engine, model, calls, writes, frame };
}

test('1,000 distinct small static parts from a loaded OBJ encode one pack draw; big and open parts keep their own', async () => {
  const { engine, model, calls, frame } = await scene();
  try {
    assert.equal(model.meshes.length, 1002, 'every OBJ object is its own part mesh');
    assert.equal(new Set(model.meshes.map((m) => m.geometry)).size, 1002, 'no two parts share a geometry');
    assert.equal(frame(), 1002, 'without the plugin core encodes one draw per part');
    const instancer = PartInstancer.attach(engine);
    const first = frame(),
      firstStats = engine.stats.drawCalls,
      draws = frame();
    console.log(`draws per frame: without pack 1002, first packed frame ${first}, steady ${draws}`);
    assert.equal(draws, 3, 'one pack draw plus the big part and the open sheet');
    assert.equal(first, 3, 'the frame that builds the pack already skips the claimed batches');
    assert.equal(firstStats, 1002, 'the stat counted before the first claim');
    assert.equal(engine.stats.drawCalls, 2, 'claimed batches are not counted');
    assert.deepEqual({ ...instancer.stats }, { parts: 1002, unique: 1002, packs: 1, packed: 1000 });
    assert.deepEqual(
      calls.find((c) => c[0] === 'draw'),
      ['draw', 36_000, 1, 0, 0],
      'the pack draws all 1,000 parts (36,000 indices) at once',
    );
    assert.ok(
      model.meshes.every((m) => m.visible && m.geometry && m.name),
      'packed parts stay visible meshes with their names and geometry',
    );
  } finally {
    engine.dispose();
  }
});

test('a moved, hidden or recolored part returns to its own draw and leaves the pack', async () => {
  const { engine, model, writes, frame } = await scene();
  try {
    const instancer = PartInstancer.attach(engine);
    frame();
    assert.equal(frame(), 3);
    const moved = model.meshes[5];
    moved.position.x += 0.5;
    writes.length = 0;
    assert.equal(frame(), 4, 'the moved part draws on its own again in the same frame');
    const pack = instancer.shadowPrimitives[0],
      collapse = writes.find(([buffer]) => buffer === pack.index);
    assert.ok(collapse, 'the moved part is removed from the pack index buffer');
    assert.equal(collapse[2].length, 36);
    assert.ok(
      collapse[2].every((value) => value === collapse[2][0]),
      'its triangles collapse to one vertex',
    );
    frame();
    assert.equal(engine.stats.drawCalls, 3);
    assert.equal(instancer.stats.packed, 999);
    model.meshes[6].visible = false;
    assert.equal(frame(), 4, 'a hidden part is drawn by nobody');
    assert.equal(instancer.stats.packed, 998);
    model.meshes[7].setMaterial(new PbrMaterial({ color: '#ff0000' }));
    assert.equal(frame(), 5, 'a recolored part draws on its own');
    assert.equal(instancer.stats.packed, 997);
    moved.position.x -= 0.5;
    assert.equal(frame(), 5, 'a part that left the pack is never claimed again');
  } finally {
    engine.dispose();
  }
});

test('an id-writing draw (partIds) draws the pack one part at a time with each part as its own instance', async () => {
  const { engine, model, calls, frame } = await scene();
  try {
    PartInstancer.attach(engine);
    frame();
    let ids = false;
    engine.frameGraph.add({
      name: 'test:id-draw',
      order: 1,
      execute: (c) => {
        if (ids) c.draw({ clear: false, partIds: true, pipeline: { getBindGroupLayout: () => ({}) } });
      },
    });
    model.meshes[3].position.y += 1;
    frame();
    ids = true;
    const total = frame(),
      perPart = calls.filter((c) => c[0] === 'draw' && c[1] === 36 && c[2] === 1);
    assert.equal(total, 4 + 3 + 999, 'main draw (pack + 3 own) and the id draw (3 own + 999 parts)');
    assert.equal(perPart.length, 999);
    assert.deepEqual(
      perPart.slice(0, 4).map((c) => [c[3], c[4]]),
      [
        [0, 0],
        [36, 1],
        [72, 2],
        [144, 4],
      ],
      'each part draws its own index range with its own instance (the moved part 3 is skipped)',
    );
  } finally {
    engine.dispose();
  }
});

test('turning the pack off restores one draw per part', async () => {
  const { engine, frame } = await scene();
  try {
    const instancer = PartInstancer.attach(engine);
    frame();
    assert.equal(frame(), 3);
    instancer.pack = false;
    assert.equal(frame(), 1002, 'every part is drawn by core again in the same frame');
    frame();
    assert.equal(engine.stats.drawCalls, 1002);
    assert.deepEqual([instancer.stats.packs, instancer.stats.packed], [0, 0]);
    instancer.pack = true;
    frame();
    assert.equal(frame(), 3, 'turning it back on packs again');
    assert.equal(new PartInstancer({ pack: false }).pack, false);
    assert.throws(() => new PartInstancer({ partVertices: 2 }), RangeError);
    assert.throws(() => new PartInstancer({ partVertices: 10, packVertices: 9 }), RangeError);
  } finally {
    engine.dispose();
  }
});
