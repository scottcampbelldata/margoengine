import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainOverlays } from '../dist/overlays.js';
import { TerrainVirtualTexture } from '../dist/rvt.js';
import { TerrainImagery } from '../dist/imagery.js';
import { lightingLayout } from '../src/lighting-layout.ts';

function fixture(options = {}) {
  const dirty = [],
    writes = [],
    providers = new Set(),
    buffers = [];
  const rvt = {
    texel: 0.25,
    levels: 3,
    invalidate(...args) {
      dirty.push(args);
    },
    addSurface(s) {
      providers.add(s);
      return () => providers.delete(s);
    },
  };
  const engine = {
    gpu: {
      limits: { maxStorageBufferBindingSize: 2 ** 27 },
      createBuffer(d) {
        const b = {
          ...d,
          destroy() {
            this.dead = true;
          },
        };
        buffers.push(b);
        return b;
      },
      queue: {
        writeBuffer(_b, _o, data) {
          writes.push(Array.from(data));
        },
      },
    },
    sceneOf: () => undefined,
  };
  const overlays = new TerrainOverlays(rvt, options);
  overlays.setup(engine);
  return { rvt, overlays, engine, dirty, writes, providers, buffers };
}
const line = [
  [-5, 0],
  [5, 0],
];
const ring = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];
const project = (p) => [p[0] * 100, p[1] * 100];
const feature = (geometry, properties = {}) => ({ type: 'Feature', geometry, properties });

test('metre-width strokes, closed polygon rings and holes are copied into ordered GPU primitives', () => {
  const f = fixture();
  const points = line.map((p) => [...p]);
  const a = f.overlays.addPolyline(points, { width: 4, color: [1, 0, 0, 0.5] });
  points[0][0] = 1000;
  const b = f.overlays.addPolygon([
    ring,
    [
      [2, 2],
      [8, 2],
      [8, 8],
      [2, 8],
    ],
  ]);
  const data = f.writes.at(-1);
  assert.equal(data[0], 2);
  assert.equal(data[15], 2, 'stroke half width');
  assert.deepEqual(data.slice(28, 32), [-5, 0, 5, 0], 'caller mutation did not alias segments');
  assert.equal(data[25], 8, 'four exterior and four hole segments');
  assert.equal(data[26], 1, 'filled polygon');
  assert.deepEqual(f.overlays.order, [a, b]);
  f.overlays.move(b, 0);
  assert.deepEqual(f.overlays.order, [b, a]);
  f.overlays.setStyle(a, { width: 8 });
  assert.equal(f.writes.at(-1)[27], 4);
  assert.ok(
    f.dirty.some((r) => r[0] <= -9 && r[2] >= 9),
    'width/AA included in invalidation',
  );
  f.overlays.dispose();
  assert.equal(f.providers.size, 0);
  assert.equal(f.buffers.at(-1).dead, true);
});

test('invalid edits and resource overflows leave prior overlay data and order intact', () => {
  const f = fixture({ maxPrimitives: 1, maxSegments: 2 });
  const a = f.overlays.addPolyline(line);
  const before = f.writes.length;
  assert.throws(
    () =>
      f.overlays.setPolyline(a, [
        ['1', 0],
        [0, 0],
      ]),
    RangeError,
  );
  assert.throws(() => f.overlays.setStyle(a, { width: '4' }), RangeError);
  assert.throws(
    () =>
      f.overlays.setPolyline(a, [
        [NaN, 0],
        [0, 0],
      ]),
    RangeError,
  );
  assert.throws(() => f.overlays.setPolygon(a, [ring]), /budget/);
  assert.throws(() => f.overlays.addPolyline(line), /budget/);
  assert.throws(() => f.overlays.setStyle(a, { color: [1, 2, 3, 4] }), RangeError);
  assert.equal(f.writes.length, before);
  assert.deepEqual(f.overlays.order, [a]);
  assert.equal(f.overlays.remove(a), true);
  assert.equal(f.overlays.remove(a), false);
  assert.equal(f.writes.at(-1)[0], 0);
  f.overlays.dispose();
  assert.throws(() => f.overlays.addPolyline(line), { code: 'disposed' });
});

test('GeoJSON imports all geometry families, holes, null features and per-feature styles with explicit projection', () => {
  const closed = [...ring.map(([x, y]) => [x / 100, y / 100]), [0, 0]];
  const geometries = [
    { type: 'Point', coordinates: [1, 2, 999] },
    {
      type: 'MultiPoint',
      coordinates: [
        [1, 2],
        [2, 3],
      ],
    },
    {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    {
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 0],
        ],
        [
          [0, 0],
          [0, 1],
        ],
      ],
    },
    { type: 'Polygon', coordinates: [closed] },
    { type: 'MultiPolygon', coordinates: [[closed], [closed]] },
    { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0] }] },
  ];
  const f = fixture(),
    seen = [];
  const input = {
    type: 'FeatureCollection',
    features: [...geometries.map((g, i) => feature(g, { index: i })), feature(null)],
  };
  const id = f.overlays.addGeoJSON(input, {
    project,
    style: (value) => {
      seen.push(value.properties.index);
      return { width: 3, color: [0, 1, 0, 1] };
    },
  });
  assert.equal(f.overlays.length, 1);
  assert.equal(f.writes.at(-1)[0], 10);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6]);
  const before = f.writes.length;
  assert.throws(() => f.overlays.setGeoJSON(id, { type: 'Polygon', coordinates: [ring] }, { project }), /Open GeoJSON/);
  assert.throws(() => f.overlays.setGeoJSON(id, { type: 'Point', coordinates: [181, 0] }, { project }), RangeError);
  assert.throws(() => f.overlays.setGeoJSON(id, geometries[0], {}), /projection/);
  assert.equal(f.writes.length, before);
  f.overlays.setGeoJSON(id, feature({ type: 'Point', coordinates: [-1, -2, 500] }), { project });
  const data = f.writes.at(-1);
  assert.equal(data[0], 1);
  assert.deepEqual(data.slice(16, 20), [-100, -200, -100, -200]);
  f.overlays.dispose();
});

test('restore retains vector data and one provider, frees owned buffers, and borrows the RVT', () => {
  const f = fixture();
  const id = f.overlays.addPolygon([ring]);
  const old = f.buffers.at(-1);
  f.overlays.onDeviceRestored(f.engine);
  assert.equal(old.dead, true);
  assert.equal(f.providers.size, 1);
  assert.deepEqual(f.overlays.order, [id]);
  assert.equal(f.writes.at(-1)[0], 1);
  f.overlays.dispose();
  f.overlays.dispose();
  assert.equal(f.rvt.disposed, undefined);
  assert.equal(f.providers.size, 0);
});

test('RVT providers compose in order at both bind groups, detect collisions and can be removed', () => {
  globalThis.GPUShaderStage ??= { FRAGMENT: 2 };
  const rvt = new TerrainVirtualTexture({ options: { layers: [{}] }, addLighting() {} }, {});
  const f = fixture();
  const remove = rvt.addSurface(f.overlays);
  assert.throws(() => rvt.addSurface(f.overlays), /collision/);
  const source =
    'fn terrainColor(position:vec3f,normal:vec3f)->vec3f {let dx=dpdx(position);let dy=dpdy(position);return vec3f(0);}\nlet base=terrainColor(i.position,n);';
  const code = rvt.shader(source, 1);
  assert.match(code, /terrainSurfaceColor=terrainOverlay120\(terrainSurfaceColor,position,footprint\)/);
  assert.match(code, /return mix\(cached.rgb,terrainVirtualSurface/);
  assert.equal(
    lightingLayout('@group(2) @binding(120) var<storage,read> d:array<vec4f>;', f.overlays.bindings(), 2)[0].buffer
      .type,
    'read-only-storage',
  );
  assert.equal(
    lightingLayout('@group(2) @binding(120) var<storage,read> d:array<vec4f>;', f.overlays.bindings()).length,
    0,
  );
  remove();
  assert.doesNotMatch(rvt.shader(source, 1), /terrainOverlay120/);
  f.overlays.dispose();
  rvt.dispose();
});

test('imagery virtualTexture refreshes changing layer declarations and uses explicit RVT derivatives', () => {
  const f = fixture();
  let refreshed = 0;
  f.rvt.refreshSurfaces = () => refreshed++;
  Object.assign(f.engine.gpu.limits, {
    maxSampledTexturesPerShaderStage: 16,
    maxTextureArrayLayers: 256,
    maxTextureDimension2D: 4096,
  });
  f.engine.gpu.createSampler = () => ({});
  const terrain = {
    options: { size: [10, 10] },
    addLighting() {
      throw new Error('imagery bypassed the RVT');
    },
  };
  const imagery = new TerrainImagery(terrain, { virtualTexture: f.rvt });
  imagery.setup(f.engine);
  const texture = {
    dimension: '2d',
    sampleCount: 1,
    depthOrArrayLayers: 1,
    usage: 4,
    format: 'rgba8unorm',
    createView: () => ({}),
  };
  imagery.add({ source: { texture: () => texture } });
  assert.ok(refreshed >= 2);
  for (const group of [1, 2]) {
    const code = imagery.shader(
      'fn terrainVirtualSurface(color:vec3f,position:vec2f,footprint:f32)->vec3f {var terrainSurfaceColor=color;return terrainSurfaceColor;}',
      group,
    );
    assert.match(code, /let gx=terrainDx.xz/);
    assert.doesNotMatch(code, /dpdx\(/);
  }
  imagery.dispose();
  f.overlays.dispose();
});
