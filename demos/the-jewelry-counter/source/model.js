import { applyMatrix4, computeTangents, geometryData, mergeGeometries } from '@margoengine/geometry/utils';
import { latheGeometry, sphereGeometry } from '@margoengine/geometry';
import { gemstoneOptics } from './gem-optics.js';
import { cameraPosition, NodeMaterial, normalWorld, positionWorld, wgslFn } from '@margoengine/shader';
import { createMesh, Material, Texture } from '@margoengine/materials';

const tau = Math.PI * 2;
const size = 0.00400;
const crown = Math.tan(34.5 * Math.PI / 180);
const pavilion = Math.tan(40.8 * Math.PI / 180);
const girdle = size * 0.027;
const tableSize = size * 0.57;
const tableY = girdle * 0.5 + (size - tableSize) * crown;
const culetY = -girdle * 0.5 - size * pavilion;

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
const subtract = (a, b) => a.map((x, i) => x - b[i]);
const point = (r, y, a) => [r * Math.cos(a), y, r * Math.sin(a)];

export function roundBrilliant(facets = []) {
  const positions = [], normals = [], uvs = [], indices = [];
  const step = tau / 8;
  const contour = (r, y, angle = 0) => Array.from({ length: 8 }, (_, i) => point(r, y, i * step + angle));
  const t = contour(tableSize, tableY);
  const starR = size * 0.776;
  const star = contour(starR, girdle * 0.5 + (size - starR * Math.cos(step * 0.5)) * crown, step * 0.5);
  const upper = contour(size, girdle * 0.5);
  const upperMid = contour(size, girdle * 0.5, step * 0.5);
  const lower = contour(size, -girdle * 0.5);
  const lowerMid = contour(size, -girdle * 0.5, step * 0.5);
  const heelR = size * 0.25;
  const heels = contour(heelR, culetY + heelR * Math.cos(step * 0.5) * pavilion, step * 0.5);
  const culet = [0, culetY, 0];

  function face(vertices) {
    const n = cross(subtract(vertices[1], vertices[0]), subtract(vertices[2], vertices[0]));
    const length = Math.hypot(...n);
    const sign = n.reduce((sum, value, i) => sum + value * vertices[0][i], 0) >= 0 ? 1 : -1;
    const normal = n.map((value) => sign * value / length);
    facets.push([...normal, normal.reduce((sum, value, i) => sum + value * vertices[0][i], 0)]);
    const start = positions.length / 3;
    for (const vertex of vertices) {
      positions.push(...vertex);
      normals.push(...normal);
      uvs.push(0.5 + vertex[0] / (2 * size), 0.5 + vertex[2] / (2 * size));
    }
    for (let i = 1; i + 1 < vertices.length; i++)
      indices.push(start, start + (sign > 0 ? i : i + 1), start + (sign > 0 ? i + 1 : i));
  }

  face(t);
  for (let i = 0; i < 8; i++) {
    const next = (i + 1) % 8;
    const previous = (i + 7) % 8;
    face([t[i], star[i], upper[i], star[previous]]);
    face([t[i], t[next], star[i]]);
    face([star[i], upper[i], upperMid[i]]);
    face([star[i], upperMid[i], upper[next]]);
    face([lower[i], heels[i], culet, heels[previous]]);
    face([heels[i], lowerMid[i], lower[i]]);
    face([heels[i], lower[next], lowerMid[i]]);
    face([upper[i], upperMid[i], lowerMid[i], lower[i]]);
    face([upperMid[i], upper[next], lower[next], lowerMid[i]]);
  }
  return geometryData(positions, normals, uvs, indices);
}

export function bandGeometry(rows = 142, sections = 30) {
  const positions = [], normals = [], uvs = [], indices = [];
  const start = 0;
  const span = tau;
  const centre = 0.01018;
  for (let i = 0; i <= rows; i++) {
    const a = start + i / rows * span;
    const shoulder = Math.max(0, Math.sin(a)) ** 2.7;
    const shoulderTaper = Math.max(0, (shoulder - 0.84) / 0.16);
    const radialBulge = shoulder * 0.00047;
    const thick = centre - 0.009 + radialBulge;
    const halfWidth = 0.00114 + shoulder * 0.00101 - shoulderTaper * 0.00051;
    const roll = 0.00013 * Math.cos(a) * shoulder;
    for (let j = 0; j <= sections; j++) {
      const angle = j / sections * tau;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const profile = Math.sign(c) * Math.abs(c) ** 0.71;
      const side = Math.sign(s) * Math.abs(s) ** 0.66;
      const radial = centre + thick * profile + radialBulge;
      positions.push(radial * Math.cos(a), radial * Math.sin(a), halfWidth * side + roll);
      const n = [Math.cos(a) * c * halfWidth, Math.sin(a) * c * halfWidth, thick * s];
      const len = Math.hypot(...n);
      normals.push(...n.map((v) => v / len));
      uvs.push(i / rows, j / sections);
      if (i < rows && j < sections) {
        const b = i * (sections + 1) + j;
        const next = b + sections + 1;
        indices.push(b, next, b + 1, next, next + 1, b + 1);
      }
    }
  }
  return computeTangents(geometryData(positions, normals, uvs, indices));
}

function clawGeometry(angle) {
  const positions = [], normals = [], uvs = [], indices = [];
  const sections = 16, rows = 21;
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const approach = Math.max(0, (t - 0.69) / 0.31);
    const sweep = 0.00194 + 0.00223 * Math.sin(Math.PI * t * 0.65) - 0.00081 * approach * approach;
    const y = -0.00383 + t * 0.00477;
    const dome = Math.sqrt(Math.max(0.001, 1 - Math.max(0, (t - 0.89) / 0.11) ** 2));
    const r = 0.000505 * (1.12 - t * 0.32) * dome;
    for (let j = 0; j <= sections; j++) {
      const a = j / sections * tau;
      positions.push(...point(sweep + r * Math.cos(a), y - r * Math.cos(a) * 0.31 * t, angle + r * Math.sin(a) / sweep));
      const n = [Math.cos(a + angle), 0.23 * Math.cos(a) + approach * approach * 0.68, Math.sin(a + angle)];
      const len = Math.hypot(...n);
      normals.push(...n.map((v) => v / len));
      uvs.push(t, j / sections);
      const q = i * (sections + 1) + j;
      if (i < rows && j < sections) indices.push(q, q + sections + 1, q + 1, q + 1, q + sections + 1, q + sections + 2);
    }
  }
  const end = rows * (sections + 1);
  for (let j = 1; j + 1 < sections; j++) indices.push(0, j + 1, j, end, end + j, end + j + 1);
  return geometryData(positions, normals, uvs, indices);
}



function wearTexture() {
  const size = 128;
  const surface = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = 193 + 17 * Math.sin(Math.PI * y / 8 + 0.7 * Math.sin(x / 4)) +
        9 * Math.sin((y * 11 + (x >> 3)) * 0.68) + 16 * Math.sin((x + y) * 0.031);
      surface.set([value, value, value, 255], (x + y * size) * 4);
    }
  }
  return new Texture({ data: surface, width: size, height: size }, { colorSpace: 'linear', wrapS: 'repeat', wrapT: 'repeat' });
}

function shoulderJewels(engine, geometry, metal, bearing, optics) {
  const set = [];
  const beads = [];
  const dots = sphereGeometry(1, 10, 6);
  const shadeAccent = wgslFn('fn accentStone(point:vec3f, normal:vec3f, camera:vec3f, spin:f32) -> vec3f {' +
    ' let n = normalize(normal); let v = normalize(camera - point); let reflected = reflect(-v,n);' +
    ' let direction=normalize(vec3f(-0.55*cos(spin)+0.60*sin(spin),0.75,0.60*cos(spin)+0.55*sin(spin)));' +
    ' let blue = smoothstep(0.75,0.95,dot(reflected,normalize(vec3f(0.65,0.54,-0.42))));' +
    ' let lamp = smoothstep(0.72,0.94,dot(reflected,direction));' +
    ' let internal = smoothstep(0.24,0.76,abs(dot(n,normalize(vec3f(0.61,0.24,0.79)))));' +
    ' return vec3f(0.10,0.14,0.19)*(0.75+0.6*internal) + internal*vec3f(0.34,0.29,0.24) + ' +
    ' lamp*vec3f(3.05,2.75,2.45) + blue*vec3f(0.85,1.8,3.3); }');
  const accent = new NodeMaterial({
    shading: 'basic', colorNode: shadeAccent(positionWorld, normalWorld, cameraPosition, optics.rotation),
  });
  for (const side of [-1, 1]) {
    for (let i = 0; i < 8; i++) {
      const a = Math.PI * 0.5 + side * (0.32 + i * 0.101);
      const up = [Math.cos(a), Math.sin(a), 0];
      const tangent = [up[1], -up[0], 0];
      const height = 0.01159 + (7 - i) * 0.000096;
      const center = [height * up[0], height * up[1], 0.00016 + 0.00012 * Math.sin(i * 0.68)];
      const radius = 0.00034 + (7 - i) * 0.000042;
      const scale = radius / size;
      const look = [up[0] * 0.9578, up[1] * 0.9578, 0.2873];
      const back = [-up[0] * 0.2873, -up[1] * 0.2873, 0.9578];
      set.push(applyMatrix4(geometry, [
        ...tangent.map((n) => n * scale), 0,
        ...look.map((n) => n * scale), 0,
        ...back.map((n) => n * scale), 0,
        ...center, 1,
      ]));
      for (const edge of [-1, 1]) {
        for (const direction of [-1, 1]) {
          const small = radius * 0.24;
          const x = center[0] + edge * tangent[0] * radius * 0.58 + up[0] * radius * 0.04;
          const y = center[1] + edge * tangent[1] * radius * 0.58 + up[1] * radius * 0.04;
          const z = center[2] + direction * radius * 0.79;
          beads.push(applyMatrix4(dots, [small, 0, 0, 0, 0, small, 0, 0, 0, 0, small, 0, x, y, z, 1]));
        }
      }
    }
  }
  const diamonds = createMesh(engine, mergeGeometries(set), accent);
  diamonds.root.name = 'Sixteen graduating bead-set diamonds';
  diamonds.root.setParent(bearing);
  const prongs = createMesh(engine, mergeGeometries(beads), metal);
  prongs.root.name = 'Hand-beaded shoulder settings';
  prongs.root.setParent(bearing);
  return [diamonds, prongs];
}


export function jewelry(engine) {
  const bearing = engine.createMesh().setPosition([0, 0.01092, 0]);
  const wear = wearTexture();
  const metal = new Material({ color: '#dfb261', metalness: 1, roughness: 0.235, roughnessMap: wear,
    anisotropyStrength: 0.3, anisotropyRotation: 0, doubleSided: true });
  const ring = createMesh(engine, bandGeometry(), metal);
  ring.root.name = 'Polished tapered shank';
  ring.root.setParent(bearing);
  const facets = [];
  const gemShape = roundBrilliant(facets);
  const optics = gemstoneOptics(facets, size);
  const gem = createMesh(engine, gemShape, optics.material);
  gem.root.name = 'Round brilliant center stone';
  const stoneHeight = 0.01482;
  gem.root.setParent(bearing).setPosition([0, stoneHeight, 0]);
  const claws = [];
  for (const angle of [0.64, 2.50, 3.78, 5.64]) {
    const claw = createMesh(engine, clawGeometry(angle), metal);
    claw.root.name = 'Polished setting claw';
    claw.root.setParent(bearing).setPosition([0, 0.01482, 0]);
    claws.push(claw);
  }
  const gallery = createMesh(engine, latheGeometry([
    [0.0016, -0.00035], [0.00255, -0.00032], [0.00282, -0.00008], [0.00282, 0.00016],
    [0.00267, 0.00034], [0.00168, 0.00034], [0.00162, -0.00028], [0.00160, -0.00035],
  ], 40), metal);
  gallery.root.setParent(bearing).setPosition([0, 0.01226, 0]);
  const girdleSupport = createMesh(engine, latheGeometry([
    [0.00308, -0.00022], [0.00330, -0.00015], [0.00340, 0.00006], [0.00328, 0.00022],
    [0.00309, 0.00020], [0.00301, 0.00002], [0.00308, -0.00022],
  ], 48), metal);
  girdleSupport.root.name = 'Openwork under-gallery rail';
  girdleSupport.root.setParent(bearing).setPosition([0, 0.01322, 0]);
  const shoulders = shoulderJewels(engine, gemShape, metal, bearing, optics);
  return { bearing, metal, optics, wear, gem, gallery, ring, claws, girdleSupport, shoulders, gemShape, facets, stoneHeight, stoneTable: tableY };
}

