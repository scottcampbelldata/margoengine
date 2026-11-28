import { boxGeometry, cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { applyMatrix4, mergeGeometries } from '@margoengine/geometry/utils';
import { createMesh, Material, Texture } from '@margoengine/materials';
import { response, section, specimen } from './beam.js';

const FLAT_Z = 0.054;
const FOLD_Z = -0.055;
const SUPPORT_TOP = 0.070;
const LOAD_RADIUS = 0.014;
const BRASS_DENSITY = 8530;
const loadProfile = [[0, -.50], [.88, -.50], [1, -.28], [1, -.075], [.93, -.015], [1, .06], [1, .27], [.87, .50], [0, .50]];
const volumeFactor = loadProfile.slice(1).reduce((total, [r, h], index) => {
  const [previousR, previousH] = loadProfile[index];
  return total + (h - previousH) * (r * r + r * previousR + previousR ** 2) / 3;
}, 0);
const FULL_LOAD = 0.03 / (Math.PI * LOAD_RADIUS ** 2 * BRASS_DENSITY * volumeFactor);
const lengthSteps = 40;
const flatSection = section(0);
const colorRange = response(flatSection, 30).peakStress;

function choose(grey, color, amount) {
  return grey.map((base, i) => base + amount * (color[i] - base));
}

function paperTexture() {
  const width = 128;
  const data = new Uint8Array(width * width * 4);
  let state = 93187;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const tooth = Float32Array.from({ length: width * width }, random);
  const value = (x, y) => tooth[((y + width) % width) * width + ((x + width) % width)];
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const dx = .13 * (value(x - 2, y) - value(x + 2, y));
      const dy = .23 * (value(x, y - 1) - value(x, y + 1));
      const norm = Math.hypot(dx, dy, 1);
      data.set([127.5 * (dx / norm + 1), 127.5 * (dy / norm + 1), 127.5 * (1 / norm + 1), 255], (y * width + x) * 4);
    }
  }
  return new Texture({ width, height: width, data }, { colorSpace: 'linear', wrapS: 'repeat', wrapT: 'repeat' });
}

function planeRotation(slope) {
  const divisor = Math.hypot(1, slope);
  return [1 / divisor, slope / divisor];
}

function bridgeGeometry(profile, load, marked) {
  const geometry = { positions: [], normals: [], colors: [], uvs: [], indices: [] };
  const beam = response(profile, load);
  const height = SUPPORT_TOP - Math.min(...profile.bottom.map(([, y]) => y));
  const point = (x, z, y, down, cos, sin) => [
    x - (y - profile.neutral) * sin,
    height + profile.neutral - down + (y - profile.neutral) * cos,
    z,
  ];
  const tint = (stress, edge = false) => {
    if (!marked) return edge ? [.74, .68, .59] : [.92, .88, .79];
    return choose([.83, .80, .74], stress > 0 ? [.065, .37, .76] : [.94, .096, .032],
      Math.sqrt(Math.min(1, Math.abs(stress) / colorRange)));
  };
  const push = (position, normal, color, u, v) => {
    geometry.positions.push(...position);
    geometry.normals.push(...normal);
    geometry.colors.push(...color);
    geometry.uvs.push(u, v);
  };
  const quad = (a, b, c, d, flipped = false) => {
    if (flipped) geometry.indices.push(a, c, b, a, d, c);
    else geometry.indices.push(a, b, c, a, c, d);
  };
  const columns = profile.top.length;
  const row = (index) => (-.5 + index / lengthSteps) * specimen.length;
  for (const [side, points] of [profile.top, profile.bottom].entries()) {
    const face = geometry.positions.length / 3;
    for (let along = 0; along <= lengthSteps; along++) {
      const x = row(along);
      const { down, slope } = beam.at(x);
      const [cos, sin] = planeRotation(slope);
      for (let across = 0; across < columns; across++) {
        const [z, y] = points[across];
        const previous = points[Math.max(0, across - 1)];
        const next = points[Math.min(columns - 1, across + 1)];
        const dz = next[0] - previous[0];
        const dy = next[1] - previous[1];
        const sign = side ? -1 : 1;
        const norm = sign / Math.hypot(dz, dy);
        push(point(x, z, y, down, cos, sin), [-sin * dz * norm, cos * dz * norm, -dy * norm],
          tint(beam.at(x, y).stress), along / 10, across / 13);
        if (along && across) {
          const a = face + (along - 1) * columns + across - 1;
          quad(a, a + 1, a + columns + 1, a + columns, side === 1);
        }
      }
    }
  }
  const rim = (corners, reverse, lengthwise) => {
    const points = corners.map(([x, z, y]) => {
      const { down, slope } = beam.at(x);
      return point(x, z, y, down, ...planeRotation(slope));
    });
    const [a, b, c] = points;
    const u = b.map((v, i) => v - a[i]);
    const v = c.map((v, i) => v - a[i]);
    const xyz = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const norm = (reverse ? -1 : 1) / Math.hypot(...xyz);
    const base = geometry.positions.length / 3;
    corners.forEach(([x, z, y], index) => push(points[index], xyz.map((n) => n * norm), tint(beam.at(x, y).stress, true),
      (lengthwise ? x : z) * 60, index < 2 ? 0 : .02));
    quad(base, base + 1, base + 2, base + 3, reverse);
  };
  for (let index = 0; index < columns - 1; index++) {
    for (const [end, x] of [row(0), row(lengthSteps)].entries()) {
      rim([[x, ...profile.top[index]], [x, ...profile.top[index + 1]],
        [x, ...profile.bottom[index + 1]], [x, ...profile.bottom[index]]], end === 0, false);
    }
  }
  for (let index = 0; index < lengthSteps; index++) {
    for (const [edge, side] of [0, columns - 1].entries()) {
      rim([[row(index), ...profile.top[side]], [row(index + 1), ...profile.top[side]],
        [row(index + 1), ...profile.bottom[side]], [row(index), ...profile.bottom[side]]], edge === 1, true);
    }
  }
  return { geometry, beam, top: height + Math.max(...profile.top.map(([, y]) => y)) - beam.deflection };
}

function moved(geometry, [x, y, z], roll = 0) {
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  return applyMatrix4(geometry, [cos, sin, 0, 0, -sin, cos, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}
function roller(radius, length, [x, y, z]) {
  return applyMatrix4(cylinderGeometry(radius, radius, length, 20, 1),
    [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, x, y, z, 1]);
}

export function createBench(engine, shadows) {
  const owned = [];
  const materials = [];
  const material = (options) => {
    const result = new Material(options);
    materials.push(result);
    return result;
  };
  const soot = material({ color: '#404957', roughness: .82 });
  const enamel = material({ color: '#435e6b', roughness: .46, metalness: .09 });
  const table = material({ color: '#58606b', roughness: .90 });
  const dark = material({ color: '#65717b', roughness: .46, metalness: .24 });
  const steel = material({ color: '#b1b7b8', roughness: .28, metalness: .37 });
  const brass = material({ color: '#cf9d59', roughness: .38, metalness: .40 });
  const highlight = material({ color: '#bb4d38', roughness: .43, metalness: .04 });
  const ink = material({ color: '#bfc9cc', roughness: .80 });
  const tooth = paperTexture();
  const paper = material({ color: '#ebcfab', roughness: .90, normalMap: tooth, normalScale: .36 });
  const stressColors = material({ color: '#e5e1dc', roughness: .76, normalMap: tooth, normalScale: .32 });
  const staticBatch = new Map();
  const round = (x, y, z, r) => roundedBoxGeometry(x, y, z, 2, r);
  const add = (geo, mat, xy, roll = 0) => {
    if (!staticBatch.has(mat)) staticBatch.set(mat, []);
    staticBatch.get(mat).push(moved(geo, xy, roll));
  };
  const mesh = (geometry, mat, name, options) => {
    const result = createMesh(engine, geometry, mat);
    result.root.name = name;
    owned.push(result);
    if (options) shadows.add(result, options);
    return result;
  };
  mesh(moved(boxGeometry(14, .025, 14), [0, -.034, 0]), table, 'Studio tabletop', { static: true, castShadow: false });
  add(round(.315, .024, .242, .009), soot, [0, -.008, 0]);
  add(round(.306, .012, .232, .004), enamel, [0, .010, 0]);
  add(round(.266, .003, .208, .001), dark, [0, .017, 0]);
  add(round(.244, .002, .021, .001), soot, [0, .020, .103]);
  add(round(.244, .002, .009, .001), soot, [0, .020, -.106]);
  add(round(.072, .003, .022, .001), steel, [-.103, .021, .097]);
  add(round(.020, .001, .009, .0004), highlight, [-.120, .023, .099]);
  add(round(.024, .001, .0015, .0004), dark, [-.091, .023, .101]);
  add(round(.018, .001, .0015, .0004), dark, [-.094, .023, .097]);
  for (const x of [-.135, .135]) {
    for (const z of [-.101, .101]) {
      add(cylinderGeometry(.0045, .0045, .0018, 18, 1), steel, [x, .017, z]);
      add(boxGeometry(.0052, .0002, .00065), soot, [x, .018, z], .015);
    }
  }
  for (let tick = -9; tick <= 9; tick++) {
    const size = tick % 3 === 0 ? .0063 : .0037;
    add(boxGeometry(.0007, .0003, size), tick === 0 ? highlight : ink,
      [tick * .010, .022, .108]);
  }
  add(boxGeometry(.182, .0003, .00048), ink, [0, .022, .112]);

  for (const z of [FLAT_Z, FOLD_Z]) {
    for (const x of [-specimen.span / 2, specimen.span / 2]) {
      add(round(.039, .005, .097, .002), soot, [x, .023, z]);
      add(round(.021, .040, .091, .003), dark, [x, .0435, z]);
      add(round(.027, .008, .099, .002), enamel, [x, .059, z]);
      if (!staticBatch.has(steel)) staticBatch.set(steel, []);
      staticBatch.get(steel).push(roller(.004, .103, [x, SUPPORT_TOP - .004, z]));
      for (const end of [-1, 1]) {
        staticBatch.get(steel).push(roller(.0058, .003, [x, SUPPORT_TOP - .004, z + end * .050]));
        add(cylinderGeometry(.0022, .0022, .0015, 12, 1), steel, [x + .013, .0258, z + end * .035]);
      }
    }
  }
  add(round(.012, .004, .014, .0017), dark, [0, .024, .112]);
  add(round(.008, .052, .004, .0011), soot, [0, .049, .113]);
  add(round(.007, .026, .0005, .0002), steel, [0, .061, .11515]);
  for (let j = 0; j < 8; j++) {
    add(boxGeometry(j % 4 === 0 ? .0041 : .0026, .00033, .00025), soot, [0, .052 + .0025 * j, .11552]);
  }
  for (const [mat, pieces] of staticBatch) {
    mesh(mergeGeometries(pieces), mat, 'Bending fixture', { static: true });
  }

  const cursor = mesh(mergeGeometries([
    moved(round(.0086, .0016, .0025, .0004), [0, 0, 0]),
    moved(round(.0019, .0015, .013, .00055), [0, 0, -.0079]),
  ]), highlight, 'Flat-span displacement indicator', { castShadow: false });
  function buildSpan(name, z, profile, grams) {
    const initial = bridgeGeometry(profile, grams, false);
    const skin = mesh(initial.geometry, paper, name, {});
    skin.root.setPosition([0, 0, z]);
    const head = mesh(mergeGeometries([
      roller(.002, .069, [0, .002, 0]),
      moved(round(.011, .0055, .036, .0014), [0, .0051, 0]),
      moved(cylinderGeometry(.007, .009, .004, 22, 1), [0, .0085, 0]),
    ]), steel, name + ' load saddle', {});
    const base = latheGeometry(loadProfile.map(([r, h]) => [r * LOAD_RADIUS, h * FULL_LOAD]), 48);
    const crown = round(LOAD_RADIUS * 1.09, .0017, LOAD_RADIUS * 1.09, .0008);
    const weight = mesh(base, brass, name + ' calibrated weight', {});
    const insert = mesh(crown, highlight, name + ' weight mark', {});
    const place = (top, load) => {
      const stack = Math.max(.0001, load / 30);
      const platform = top + .0105;
      head.root.setPosition([0, top, z]);
      weight.root.setPosition([0, platform + FULL_LOAD * stack / 2, z]);
      weight.root.setScale([1, stack, 1]);
      insert.root.setPosition([0, platform + FULL_LOAD * stack + .00085, z]);
      if (z === FLAT_Z) cursor.root.setPosition([0, top, .1168]);
    };
    place(initial.top, grams);
    return {
      update(shape, load, marked) {
        const frame = bridgeGeometry(shape, load, marked);
        const material = marked ? stressColors : paper;
        if (skin.material !== material) skin.material = material;
        skin.setGeometry(frame.geometry);
        place(frame.top, load);
        return frame.beam;
      },
      beam: initial.beam,
    };
  }

  let depth = .008;
  let folded = section(depth);
  const control = buildSpan('Flat card', FLAT_Z, flatSection, 18);
  const test = buildSpan('Corrugated card', FOLD_Z, folded, 18);
  let flat = control.beam;
  let fold = test.beam;
  return {
    labels: [[-.078, .096, FLAT_Z], [-.078, .108, FOLD_Z]],
    values: () => [flat, fold],
    update(nextDepth, load, stress) {
      if (depth !== nextDepth) {
        depth = nextDepth;
        folded = section(depth);
      }
      flat = control.update(flatSection, load, stress);
      fold = test.update(folded, load, stress);
    },
    dispose() {
      for (const object of owned.reverse()) object.dispose();
      for (const mat of materials.reverse()) mat.dispose();
      tooth.dispose();
    },
  };
}
