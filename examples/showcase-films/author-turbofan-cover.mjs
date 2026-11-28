import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  compressorTravel,
  coverTravel,
  engineAxis,
  fanTravel,
  housingRotation,
  turbofanAssembly,
} from './turbofan-assembly.js';

const asset = (name) => new URL('./assets/technical-films/' + name, import.meta.url);
const source = await readFile(asset('turbofan.glb'));
const jsonLength = source.readUInt32LE(12);
const data = JSON.parse(source.toString('utf8', 20, 20 + jsonLength));
const binary = source.subarray(28 + jsonLength);
const nacelle = data.nodes.find((node) => node.name === 'Nacelle');
const [primitive] = data.meshes[nacelle.mesh].primitives;
const axis = engineAxis;
const epsilon = 0.000001;
// Leave a narrow joint between separately capped surfaces.
const seamAngle = 0.0035;
const attributes = (accessor) => {
  const { bufferView, byteOffset = 0, count, componentType, type } = data.accessors[accessor];
  const view = data.bufferViews[bufferView];
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
  const bytes = componentType === 5123 ? 2 : 4;
  const offset = (view.byteOffset ?? 0) + byteOffset;
  const stride = view.byteStride ?? components * bytes;
  const read =
    componentType === 5126
      ? (at) => binary.readFloatLE(at)
      : componentType === 5123
        ? (at) => binary.readUInt16LE(at)
        : (at) => binary.readUInt32LE(at);
  return Array.from({ length: count }, (_, i) =>
    Array.from({ length: components }, (_, j) => read(offset + i * stride + j * bytes)),
  );
};
const positions = attributes(primitive.attributes.POSITION);
const normals = attributes(primitive.attributes.NORMAL);

const indices = attributes(primitive.indices).flat();
const isBackQuarter = ([x, y]) => x <= epsilon && y <= axis + epsilon;
const coverPositions = [];
const coverNormals = [];

const coverIndices = [];
const vertices = new Map();
const addVertex = (id, cap = false) => {
  const key = cap ? id + positions.length : id;
  if (!vertices.has(key)) {
    vertices.set(key, coverPositions.length / 3);
    const [x, y, z] = positions[id];
    const [nx, ny, nz] = normals[id];
    const [px, py] = cap ? [y - axis, x] : [-x, axis - y];
    const [vx, vy] = cap ? [-ny, -nx] : [-nx, -ny];
    const angle = Math.atan2(py, px);
    const adjustment = seamAngle * (1 - (4 * angle) / Math.PI);
    const c = Math.cos(adjustment);
    const s = Math.sin(adjustment);
    coverPositions.push(c * px - s * py, axis + s * px + c * py, z);
    coverNormals.push(c * vx - s * vy, s * vx + c * vy, cap ? -nz : nz);
  }
  coverIndices.push(vertices.get(key));
};
const onSeam = [([x, y]) => x > 0 && Math.abs(y - axis) < epsilon, ([x, y]) => y > axis && Math.abs(x) < epsilon];
for (let i = 0; i < indices.length; i += 3) {
  const triangle = indices.slice(i, i + 3);
  if (triangle.every((id) => isBackQuarter(positions[id]))) triangle.forEach((id) => addVertex(id));
  // The original cut faces point into the open quarter. Their reflected
  // faces close the panel, with winding preserved to face the other way.
  if (onSeam.some((test) => triangle.every((id) => test(positions[id])))) triangle.forEach((id) => addVertex(id, true));
}

// Match both cut edges of the original shell, including every axial step.
const profile = (points, accept) =>
  new Set(
    points.filter(accept).map(([x, y, z]) => [Math.hypot(x, y - axis), z].map((v) => Math.round(v * 1e5)).join()),
  );
const coverPoints = [];
for (let i = 0; i < coverPositions.length; i += 3) coverPoints.push(coverPositions.slice(i, i + 3));
for (const [i, test] of onSeam.entries()) {
  const angle = i === 0 ? seamAngle : Math.PI / 2 - seamAngle;
  const original = profile(positions, test);
  const derived = profile(coverPoints, ([x, y]) => Math.abs(Math.atan2(y - axis, x) - angle) < epsilon);
  if (original.size < 10 || original.size !== derived.size || [...original].some((point) => !derived.has(point)))
    throw Error('Cover does not match the original nacelle seam.');
}

function pointsFor(node) {
  return data.meshes[node.mesh].primitives.flatMap(({ attributes: entry }) => attributes(entry.POSITION));
}
const otherParts = data.nodes.filter((node) => node.mesh !== undefined && node !== nacelle);
const fan = pointsFor(otherParts.find(({ name }) => name === 'Fan_20_blades'));
const spinner = pointsFor(otherParts.find(({ name }) => name === 'Spinner'));
const core = otherParts.filter(({ name }) => name !== 'Fan_20_blades' && name !== 'Spinner').flatMap(pointsFor);
const radius = ([x, y]) => Math.hypot(x, y - axis);
const extent = (points, get, select) => points.reduce((bound, point) => select(bound, get(point)), get(points[0]));
const fanRadius = extent(fan, radius, Math.max);
const coreRadius = extent(core, radius, Math.max);
const fanStart = extent(fan, (point) => point[2], Math.min);
const fanEnd = extent(fan, (point) => point[2], Math.max);
const coreFront = extent(
  core.filter((point) => radius(point) > 0.075),
  (point) => point[2],
  Math.max,
);
const spinnerRadius = extent(spinner, radius, Math.max);
const shaftEnd = extent(core, (point) => point[2], Math.max);
const cowlRadius = extent(positions, radius, Math.max);
assert(fanStart > coreFront && fanTravel > compressorTravel, 'The fan assembly must slide clear of the compressor.');
assert(spinnerRadius < 0.55, 'The spinner must clear the inlet lip.');
assert(coverTravel[0] > cowlRadius, 'Park the small panel outside the large housing sweep.');
assert(
  coverPoints.every(([x, y]) => x > 0 && y > axis),
  'The small panel must leave through the open quarter.',
);

// Each triangle's swept projection is bounded by its vertices. During the lift, each triangle is either
// to one side of the core's circular envelope or entirely above it. Centered rotation preserves the
// radial distance, which is checked against the exact triangle plane below.
const centered = ([x, y, z]) => [x, y - axis, z];
const rotate = ([x, y, z]) => [
  Math.cos(housingRotation) * x - Math.sin(housingRotation) * y,
  Math.sin(housingRotation) * x + Math.cos(housingRotation) * y,
  z,
];
const segmentRadius = ([ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + t * dx, ay + t * dy);
};
const distanceFromAxis = (triangle) => {
  const signs = triangle.map(([x, y], i) => {
    const [bx, by] = triangle[(i + 1) % triangle.length];
    return x * by - y * bx;
  });
  if (signs.every((v) => v > 0) || signs.every((v) => v < 0)) return 0;
  return Math.min(...triangle.map((point, i) => segmentRadius(point, triangle[(i + 1) % triangle.length])));
};
let stationaryGap = Infinity;
let liftGap = Infinity;
let fanGap = Infinity;
const centeredPositions = positions.map(centered);
const rotatedPositions = centeredPositions.map(rotate);
for (let i = 0; i < indices.length; i += 3) {
  const corners = indices.slice(i, i + 3);
  const points = corners.map((id) => centeredPositions[id]);
  stationaryGap = Math.min(stationaryGap, distanceFromAxis(points) - coreRadius);
  const lifted = corners.map((id) => rotatedPositions[id]);
  liftGap = Math.min(
    liftGap,
    Math.max(
      Math.min(...lifted.map((p) => p[0])),
      Math.min(...lifted.map((p) => -p[0])),
      Math.min(...lifted.map((p) => p[1])),
    ) - coreRadius,
  );
  // The fan and housing travel together. Check the blade envelope at their actual relative z.
  if (Math.max(...points.map((p) => p[2])) >= fanStart && Math.min(...points.map((p) => p[2])) <= fanEnd)
    fanGap = Math.min(fanGap, distanceFromAxis(points) - fanRadius);
}
assert(stationaryGap > 0 && liftGap > 0 && fanGap > 0, JSON.stringify({ stationaryGap, liftGap, fanGap }));
for (let frame = 0; frame < 2160; frame++) {
  const { cover, inspection, turn, lift } = turbofanAssembly(frame / 24);
  if (turn !== 0) {
    assert(fanStart + fanTravel * inspection > coreFront + compressorTravel * inspection);
    assert(cover[0] > cowlRadius);
  }
  if (lift > 0) {
    assert.equal(turn, housingRotation);
    assert(fanStart + fanTravel * inspection > shaftEnd);
  }
}
console.log('Clearance bounds in mm:', { centered: stationaryGap * 1000, lifted: liftGap * 1000, fan: fanGap * 1000 });

const views = [];
let size = 0;
const pack = (values, elementSize, write) => {
  const buffer = Buffer.alloc(Math.ceil((values.length * elementSize) / 4) * 4);
  values.forEach((value, i) => write.call(buffer, value, i * elementSize));
  views.push({ buffer: 0, byteOffset: size, byteLength: values.length * elementSize });
  size += buffer.length;
  return buffer;
};
const chunks = [
  pack(coverPositions, 4, Buffer.prototype.writeFloatLE),
  pack(coverNormals, 4, Buffer.prototype.writeFloatLE),

  pack(coverIndices, 2, Buffer.prototype.writeUInt16LE),
];
const count = coverPositions.length / 3;
const bounds = [Math.min, Math.max].map((limit) =>
  [0, 1, 2].map((axis) => limit(...coverPoints.map((point) => point[axis]))),
);
const document = {
  asset: { version: '2.0', generator: 'Margo turbofan cover derived from CC0 Innerscene geometry' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'Inspection cover', mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [data.materials[primitive.material]],
  buffers: [{ byteLength: size }],
  bufferViews: views,
  accessors: [
    { bufferView: 0, componentType: 5126, count, type: 'VEC3', min: bounds[0], max: bounds[1] },
    { bufferView: 1, componentType: 5126, count, type: 'VEC3' },

    { bufferView: 2, componentType: 5123, count: coverIndices.length, type: 'SCALAR' },
  ],
};
const json = Buffer.from(JSON.stringify(document));
const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
json.copy(padded);
const header = Buffer.alloc(20);
header.writeUInt32LE(0x46546c67);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(header.length + padded.length + 8 + size, 8);
header.writeUInt32LE(padded.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(size);
binHeader.writeUInt32LE(0x004e4942, 4);
const output = asset('turbofan-inspection-cover.glb');
const generated = Buffer.concat([header, padded, binHeader, ...chunks]);
if (process.argv.includes('--check'))
  assert(generated.equals(await readFile(output)), 'Regenerate the inspection cover.');
else await writeFile(output, generated);
console.log('Matched both nacelle seams. Cover triangles:', coverIndices.length / 3);
