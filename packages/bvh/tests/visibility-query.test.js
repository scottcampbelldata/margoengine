import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { Raycaster, RaycastSnapshot, RaycastProjection } from '../dist/index.js';
import { setMeshSource } from '../../shared/mesh-source.js';
import { setRenderLayers } from '../../cameras/dist/layers.js';

async function world(backend = 'webgl2') {
  return new Engine(
    { width: 600, height: 480, clientWidth: 600, clientHeight: 480 },
    await TransformStore.create(512),
    { backend, gpu: null, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
}
function quad(engine, z = 0, uv = null) {
  const root = engine.createMesh().setPosition([0, 0, z]),
    node = engine.createMesh(root),
    vertices = new Float32Array(80);
  [
    [-1, -1, 0],
    [1, -1, 0],
    [1, 1, 0],
    [-1, 1, 0],
  ].forEach((p, i) => {
    vertices.set(p, i * 20);
    vertices[i * 20 + 3] = 1;
    vertices.set([0, 0, 1], i * 20 + 4);
    vertices.set(
      uv ??
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ][i],
      i * 20 + 12,
    );
  });
  const primitive = {
    node,
    vertices,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    nodeIndex: 7,
    material: { settings: new Float32Array([0, 0, 1]) },
    deformed: false,
  };
  const model = { root, primitives: [primitive], disposed: false };
  setMeshSource(node, { model, primitives: [primitive] });
  return { root, node, primitive, model };
}
const image = () => ({ width: 4, height: 4, pixels: new Uint8Array(64).fill(255) });
const trim = (hit) => {
  const r = { distance: hit.distance, point: hit.point };
  if (hit.uv !== undefined) r.uv = hit.uv;
  return r;
};

test('projection has independent analytic CSS/depth/near/far and pixel-scale expectations', async () => {
  const engine = await world(),
    p = RaycastProjection.capture(engine);
  try {
    assert.deepEqual(p.project([0, 0, 0]), { x: 300, y: 240, depth: 4 });
    assert.equal(p.depth([0, 0, -3]), 7);
    assert.equal(p.project([0, 0, 5]), null);
    assert(p.project([0, 0, -100000]));
    assert(p.project([100, 0, 0]).x > 600);
    assert.equal(p.pixelWorldSize(4), (2 * 4 * Math.tan((engine.camera.fov * Math.PI) / 360)) / 480);
    assert.deepEqual(p.size(), { width: 600, height: 480 });
  } finally {
    p.dispose();
    engine.dispose();
  }
});

test('camera/projection/basis/returned objects are owned and mutable point coordinates invalidate only their projection', async () => {
  const engine = await world(),
    p = RaycastProjection.capture(engine),
    point = [0, 0, 0],
    old = p.project(point);
  try {
    p.project(point).x = 99;
    p.basis().forward.fill(99);
    p.size().width = 99;
    engine.camera.position[0] = 8;
    engine.camera.target[1] = 5;
    engine.camera.fov = 80;
    engine.canvas.clientWidth = 1000;
    assert.deepEqual(p.project(point), old);
    point[0] = 1;
    assert(p.project(point).x > old.x);
    point[0] = 0;
    assert.deepEqual(p.project(point), old);
  } finally {
    p.dispose();
    engine.dispose();
  }
});

test('standalone and scene-owned camera rays are exact in WebGPU/WebGL2,orthographic and vertical views', async () => {
  for (const backend of ['webgpu', 'webgl2']) {
    const engine = await world(backend),
      projection = CameraProjection.attach(engine, { mode: 'orthographic', height: 3 });
    try {
      for (const top of [false, true]) {
        projection.up = [0, 0, -1];
        engine.camera.position = top ? [0, 4, 0] : [0, 0, 4];
        const p = RaycastProjection.capture(engine, { orthographicHeight: 3 }),
          s = RaycastSnapshot.capture(engine, []);
        try {
          assert.equal(p.orthographic, true);
          assert.equal(p.pixelWorldSize(4), 3 / 480);
          for (const [x, y] of [
            [300, 240],
            [0, 0],
            [601, 481],
            [-0.25, 100],
          ]) {
            const a = p.setFromCanvas(new Raycaster(), x, y),
              b = s.setFromCanvas(new Raycaster(), x, y),
              c = new Raycaster().setFromEngine(engine, x, y);
            assert.deepEqual(a.origin, b.origin);
            assert.deepEqual(a.direction, b.direction);
            assert.deepEqual(a.origin, c.origin);
            assert.deepEqual(a.direction, c.direction);
          }
        } finally {
          p.dispose();
          s.dispose();
        }
      }
    } finally {
      engine.dispose();
    }
  }
});

test('depth-only hits preserve every rich point/UV/distance/order for affine core/PBR scenes and all ray settings', async () => {
  const engine = await world(),
    front = quad(engine),
    core = engine.createMesh().setGeometry(box()).setPosition([0, 0, -2]).setScale([-2, 1, 0.5]);
  const s = RaycastSnapshot.capture(engine, [front.model, core]);
  try {
    for (const side of ['material', 'front', 'back', 'double'])
      for (const first of [false, true])
        for (const near of [0, 3.8, 5]) {
          const ray = new Raycaster([0.13, 0.17, 4], [0, 0, -1], near, 10);
          ray.side = side;
          ray.firstHitOnly = first;
          assert.deepEqual(s.intersectDepth(ray), s.intersect(ray).map(trim));
        }
    const r = new Raycaster([0.13, 0.17, 4], [0, 0, -1]),
      old = s.intersectDepth(r);
    old[0].point.fill(99);
    old[0].uv.fill(99);
    assert.deepEqual(s.intersectDepth(r), s.intersect(r).map(trim));
  } finally {
    s.dispose();
    engine.dispose();
  }
});

test('depth-only proxy results and masked/filter candidates retain rich-query liveness/order', async () => {
  const engine = await world(),
    anchor = engine.createMesh().setPosition([0, 0, -1]),
    core = engine.createMesh().setGeometry(box());
  engine.use({ name: 'visibility-proxy', setup() {}, pickProxies: () => [{ anchor, sphere: [0, 0, 0, 1] }] });
  setRenderLayers(core, 2);
  setRenderLayers(anchor, 4);
  const s = RaycastSnapshot.capture(engine, [core, anchor]);
  try {
    for (const mask of [0, 2, 4, 6, 0xffffffff]) {
      const r = new Raycaster([0, 0, 4], [0, 0, -1]);
      r.layers = mask;
      const log = [];
      r.filter = (mesh) => {
        log.push(mesh.id);
        return true;
      };
      const rich = s.intersect(r);
      const old = [...log];
      log.length = 0;
      assert.deepEqual(s.intersectDepth(r), rich.map(trim));
      assert.deepEqual(log, old);
    }
    const r = new Raycaster([0, 0, 4], [0, 0, -1]);
    core.dispose();
    assert.deepEqual(s.intersectDepth(r), s.intersect(r).map(trim));
  } finally {
    s.dispose();
    engine.dispose();
  }
});

test('exact flat parallel rejection retains callback order while near-parallel and nonplanar triangles still hit', async () => {
  const engine = await world(),
    plane = quad(engine),
    s = RaycastSnapshot.capture(engine, [plane.model]);
  try {
    for (const side of ['front', 'back', 'double', 'material'])
      for (const first of [false, true]) {
        const calls = [],
          ray = new Raycaster([0, 0, 0], [0, 1, 0]);
        ray.side = side;
        ray.firstHitOnly = first;
        ray.filter = (mesh) => {
          calls.push(mesh.id);
          return true;
        };
        assert.deepEqual(s.intersect(ray), []);
        assert.deepEqual(calls, [plane.node.id]);
        calls.length = 0;
        assert.deepEqual(s.intersectDepth(ray), []);
        assert.deepEqual(calls, [plane.node.id]);
      }
    const grazing = new Raycaster([0, -1, 1e-8], [0, 1, -1e-8]);
    assert(s.intersectDepth(grazing).length > 0);
    plane.primitive.vertices[2 * 20 + 2] = 1e-4;
    const thick = RaycastSnapshot.capture(engine, [plane.model]);
    try {
      assert(thick.intersectDepth(new Raycaster([0.5, -0.9, 1e-5], [0, 1, 0])).length > 0);
    } finally {
      thick.dispose();
    }
  } finally {
    s.dispose();
    engine.dispose();
  }
});

test('independent opaque plane oracle classifies front,on-surface,behind and near-clipped points', async () => {
  const engine = await world(),
    f = quad(engine),
    s = RaycastSnapshot.capture(engine, [f.model]),
    q = s.createVisibilityQuery();
  try {
    assert.deepEqual(q.depthAtCanvas(300, 240), { depth: 4, missed: false });
    assert.equal(q.visible([0, 0, 1]), true);
    assert.equal(q.visible([0, 0, 0]), true);
    assert.equal(q.visible([0, 0, -1]), false);
    assert.equal(q.visible([0, 0, 5]), false);
    assert.equal(q.visible([100, 0, 0]), true);
  } finally {
    q.dispose();
    s.dispose();
    engine.dispose();
  }
});

test('transparent foreground scans all layers and uses exactly the alpha cutoff', async () => {
  const engine = await world(),
    front = quad(engine, 0, [0.25, 0.25]),
    rear = quad(engine, -2, [0.75, 0.75]),
    s = RaycastSnapshot.capture(engine, [front.model, rear.model]),
    texture = image();
  texture.pixels[(1 * 4 + 1) * 4 + 3] = 5;
  const q = s.createVisibilityQuery({ alphaTexture: texture });
  try {
    assert.deepEqual(q.depthAtCanvas(300, 240), { depth: 6, missed: false });
    assert.equal(q.visible([0, 0, -1]), true);
    assert.equal(q.visible([0, 0, -3]), false);
    texture.pixels[(1 * 4 + 1) * 4 + 3] = 6;
    const next = s.createVisibilityQuery({ alphaTexture: texture });
    try {
      assert.deepEqual(next.depthAtCanvas(300, 240), { depth: 4, missed: false });
    } finally {
      next.dispose();
    }
  } finally {
    q.dispose();
    s.dispose();
    engine.dispose();
  }
});

test('alpha is captured independently,unrelated RGB is ignored,and clamped UVs select edge texels', async () => {
  const engine = await world(),
    f = quad(engine, 0, [-1, 2]),
    s = RaycastSnapshot.capture(engine, [f.model]),
    texture = image();
  const pixels = Array.from(texture.pixels);
  pixels[0] = NaN;
  pixels[3 * 4 * 4 + 3] = 0;
  const q = s.createVisibilityQuery({ alphaTexture: { ...texture, pixels } });
  try {
    assert.deepEqual(q.depthAtCanvas(300, 240), { depth: null, missed: false });
    pixels.fill(255);
    assert.equal(q.visible([0, 0, -10]), true);
    assert.deepEqual(q.depthAtCanvas(300, 240), { depth: null, missed: false });
  } finally {
    q.dispose();
    s.dispose();
    engine.dispose();
  }
});

test('only true misses issue all eight ordered quarter-pixel rays;known transparent pixels do not', async () => {
  const engine = await world(),
    s = RaycastSnapshot.capture(engine, []),
    p = RaycastProjection.capture(engine),
    calls = [],
    original = p.setFromCanvas.bind(p);
  p.setFromCanvas = (ray, x, y) => {
    calls.push([x, y]);
    return original(ray, x, y);
  };
  let count = 0;
  s.intersectDepth = () => (++count === 1 ? [] : [{ distance: 3, point: [0, 0, 1] }]);
  const q = s.createVisibilityQuery({ projection: p });
  try {
    assert.equal(q.visible([0, 0, 0]), false);
    assert.deepEqual(calls, [
      [300, 240],
      [299.75, 240],
      [300.25, 240],
      [300, 239.75],
      [300, 240.25],
      [299.75, 239.75],
      [300.25, 239.75],
      [299.75, 240.25],
      [300.25, 240.25],
    ]);
    q.dispose();
    calls.length = 0;
    s.intersectDepth = () => [{ distance: 4, point: [0, 0, 0], uv: [0.5, 0.5] }];
    const texture = image();
    texture.pixels.fill(0);
    const clear = s.createVisibilityQuery({ projection: p, alphaTexture: texture });
    try {
      assert.equal(clear.visible([0, 0, -2]), true);
      assert.equal(calls.length, 1);
    } finally {
      clear.dispose();
    }
  } finally {
    q.dispose();
    p.dispose();
    s.dispose();
    engine.dispose();
  }
});

test('one-pixel world boundary tolerance retains a silhouette without accepting a substantially nearer occluder', async () => {
  const engine = await world(),
    s = RaycastSnapshot.capture(engine, []),
    p = RaycastProjection.capture(engine),
    pixel = p.pixelWorldSize(4);
  try {
    for (const factor of [0.25, 2]) {
      let count = 0;
      s.intersectDepth = () => (++count === 1 ? [] : [{ distance: 4 - factor * pixel, point: [0, 0, factor * pixel] }]);
      const q = s.createVisibilityQuery({ projection: p });
      try {
        assert.equal(q.visible([0, 0, 0]), factor < 1);
        assert.equal(count, 9);
      } finally {
        q.dispose();
      }
    }
  } finally {
    p.dispose();
    s.dispose();
    engine.dispose();
  }
});

test('query policy is captured while dynamic filters and parent handle liveness remain checked on every ray', async () => {
  const engine = await world(),
    f = quad(engine),
    s = RaycastSnapshot.capture(engine, [f.model]);
  let allowed = true;
  const options = { side: 'double', filter: () => allowed },
    q = s.createVisibilityQuery(options);
  try {
    options.side = 'back';
    options.filter = () => false;
    assert.equal(q.visible([0, 0, -1]), false);
    allowed = false;
    assert.equal(q.visible([0, 0, -1]), true);
    allowed = true;
    f.model.disposed = true;
    assert.equal(q.visible([0, 0, -1]), true);
  } finally {
    q.dispose();
    s.dispose();
    engine.dispose();
  }
});

test('visibility batch captures all point values before a callback can mutate later caller inputs', async () => {
  const engine = await world(),
    f = quad(engine),
    s = RaycastSnapshot.capture(engine, [f.model]),
    points = [
      [0, 0, 1],
      [0, 0, -1],
    ];
  const q = s.createVisibilityQuery({
    filter: () => {
      points[1][2] = 2;
      return true;
    },
  });
  try {
    assert.deepEqual(q.visibleMany(points), [true, false]);
    assert.deepEqual(points[1], [0, 0, 2]);
  } finally {
    q.dispose();
    s.dispose();
    engine.dispose();
  }
});

test('invalid metadata/points/options/alpha storage reject without poisoning subsequent valid operations', async () => {
  const engine = await world(),
    s = RaycastSnapshot.capture(engine, []),
    p = RaycastProjection.capture(engine),
    q = s.createVisibilityQuery();
  try {
    for (const options of [
      null,
      [],
      { side: 'wrong' },
      { filter: 1 },
      { projection: {} },
      { alphaTexture: { width: 1, height: 1, pixels: [] } },
    ])
      assert.throws(() => s.createVisibilityQuery(options), TypeError);
    for (const options of [
      { near: -1 },
      { far: NaN },
      { layers: -1 },
      { alphaThreshold: 256 },
      { orthographicHeight: 0 },
    ])
      assert.throws(() => s.createVisibilityQuery(options), RangeError);
    const texture = image();
    texture.pixels = Array.from(texture.pixels);
    texture.pixels[63] = NaN;
    assert.throws(() => s.createVisibilityQuery({ alphaTexture: texture }), /alpha channels/);
    assert.throws(() => p.project([NaN, 0, 0]), RangeError);
    assert.throws(() => p.project([0, 0]), TypeError);
    assert.throws(() => p.pixelWorldSize(-1), RangeError);
    assert.throws(() => q.visibleMany([undefined]), TypeError);
    assert.deepEqual(q.visibleMany([]), []);
    assert.equal(q.visible([0, 0, 0]), true);
  } finally {
    q.dispose();
    p.dispose();
    s.dispose();
    engine.dispose();
  }
});

test('reentrant callbacks fail with state and disposal inside a callback publishes no result', async () => {
  const engine = await world(),
    f = quad(engine),
    s = RaycastSnapshot.capture(engine, [f.model]);
  let action = 'reenter',
    q;
  q = s.createVisibilityQuery({
    filter: () => {
      if (action === 'reenter') q.visible([0, 0, 0]);
      if (action === 'dispose') q.dispose();
      return true;
    },
  });
  try {
    assert.throws(() => q.visible([0, 0, -1]), { code: 'state' });
    action = 'normal';
    assert.equal(q.visible([0, 0, -1]), false);
    action = 'dispose';
    assert.throws(() => q.visible([0, 0, -1]), { code: 'disposed' });
  } finally {
    q.dispose();
    s.dispose();
    engine.dispose();
  }
});

test('capture-time disposal,point getters and every borrowed dependency enforce disposal without stale output', async () => {
  const engine = await world(),
    s = RaycastSnapshot.capture(engine, []),
    p = RaycastProjection.capture(engine),
    q = s.createVisibilityQuery({ projection: p });
  try {
    const point = {
      length: 3,
      get 0() {
        p.dispose();
        return 0;
      },
      1: 0,
      2: 0,
    };
    assert.throws(() => q.visible(point), { code: 'disposed' });
    q.dispose();
    q[Symbol.dispose]();
    assert.throws(() => q.project([0, 0, 0]), { code: 'disposed' });
    assert.throws(() => p.basis(), { code: 'disposed' });
    const next = s.createVisibilityQuery();
    s.dispose();
    assert.throws(() => next.visible([0, 0, 0]), { code: 'disposed' });
    next.dispose();
    const s2 = RaycastSnapshot.capture(engine, []),
      texture = {
        width: 1,
        height: 1,
        pixels: {
          length: 4,
          get 3() {
            s2.dispose();
            return 255;
          },
        },
      };
    assert.throws(() => s2.createVisibilityQuery({ alphaTexture: texture }), { code: 'disposed' });
    const live = RaycastProjection.capture(engine);
    engine.dispose();
    assert.throws(() => live.project([0, 0, 0]), { code: 'disposed' });
    live.dispose();
  } finally {
    q.dispose();
    p.dispose();
    s.dispose();
    engine.dispose();
  }
});
