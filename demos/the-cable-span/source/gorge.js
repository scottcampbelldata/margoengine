import { triangulate } from '@margoengine/geometry/triangulate';
import { box, mix, randomFrom, rgb, scale, Surface } from './craft.js';

const riverHeight = -7.85;
const edge = (z, side) => 10.48 + .20 * Math.sin(z * .94 + side) +
  .29 * Math.sin(z * .53 - side) + .21 * Math.cos(z * 1.54) + .085 * Math.abs(z);

function plateau(x, z, side) {
  const path = Math.exp(-.34 * z ** 2);
  const distance = Math.abs(x) - 12;
  return -.50 + .55 * Math.sin(.35 * z + side) ** 2 * (1 - path) +
    (.23 * Math.sin(distance * .58 + z * .42) + .12 * Math.sin(z * 1.35 + distance * 2)) * (1 - path);
}

function trees(gorge, x, y, z, height, random) {
  const foliage = [rgb('#47574e'), rgb('#53665a'), rgb('#68766a')];
  const trunk = rgb('#615148');
  gorge.tube([[x, y, z], [x + .06, y + height * .87, z - .05]], height * .026, trunk, 5);
  const divisions = 7;
  for (let layer = 0; layer < 5; layer++) {
    const fraction = layer / 5;
    const crown = height * (.42 + fraction * .70);
    const width = height * (.26 - fraction * .20);
    const shift = random() * 6.28;
    const tip = [x + .19 * width, y + crown + height * .24, z - .35 * width];
    const ring = Array.from({ length: divisions }, (_, index) => {
      const angle = shift + index / divisions * Math.PI * 2;
      const reach = width * (.70 + .57 * random());
      return [x + reach * Math.cos(angle), y + crown - height * (.15 + .08 * random()), z + reach * Math.sin(angle)];
    });
    for (let index = 0; index < divisions; index++) {
      const a = ring[index];
      const b = ring[(index + 1) % divisions];
      const shade = foliage[(index + layer) % foliage.length];
      gorge.face(a, b, tip, scale(shade, .83 + .28 * random()), [a[0] + b[0] - 2 * x, .12, a[2] + b[2] - 2 * z]);
      gorge.face(a, b, [x, y + crown - height * .12, z], scale(shade, .67), [0, -1, 0]);
    }
  }
}

function fracturedBlock(gorge, x, y, z, size, color, random) {
  const count = 6;
  const shift = random() * 6;
  const ring = (radius, elevation) => Array.from({ length: count }, (_, i) => {
    const angle = i / count * 6.283 + shift;
    const width = size * radius * (.66 + random() * .38);
    return [x + width * Math.cos(angle), y + (elevation + .18 * random()) * size, z + width * Math.sin(angle)];
  });
  const base = ring(1, -.25);
  const upper = ring(.73, .42);
  const cap = [x + .13 * size, y + .58 * size, z - .20 * size];
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const a = upper[i];
    const b = upper[j];
    gorge.quad(base[i], base[j], b, a, scale(color, .70 + .26 * random()), [a[0] + b[0] - 2 * x, 0, a[2] + b[2] - 2 * z]);
    gorge.face(a, b, cap, scale(color, .94 + .20 * random()), [0, 1, 0]);
  }
}

export function buildGorge(add, materials) {
  const rng = randomFrom(530380);
  const cliff = new Surface();
  const scree = new Surface();
  const forest = new Surface();
  const moss = rgb('#72755e');
  const screeColor = rgb('#777475');
  const rockColors = ['#6c6969', '#7c7570', '#9a8980', '#655f66', '#837476', '#6b626c', '#766771', '#5b535e', '#6c6067'].map(rgb);
  const strata = [
    [0, 0], [-.63, .20], [-1.06, -.36], [-1.67, .65], [-2.52, 1.25],
    [-3.21, 1.05], [-4.39, 2.25], [-4.96, 2.92], [-6.25, 3.68], [-7.42, 4.44],
  ];
  const zNodes = Array.from({ length: 36 }, (_, index) => -11.4 + index * 22.8 / 35);
  for (const side of [-1, 1]) {
    const rock = strata.map(([height, reach], layer) => zNodes.map((z) => {
      const rim = edge(z, side);
      const erosion = layer === 0 ? 0 :
        Math.sin(.75 * z + .17 * layer) * (.26 + .037 * layer) + (rng() - .5) * .35;
      return [side * (rim - reach + erosion), Math.max(-8.08, plateau(rim, z, side) + height + (layer ? .21 * (rng() - .5) : 0)), z];
    }));
    const upper = rock[0];
    rock.push(rock.at(-1).map(([x, , z]) => [x - side * .07, -8.15, z]));
    const terraces = Array.from({ length: 7 }, (_, section) => upper.map(([x, , z]) => {
      const exterior = 21.5 + .12 * Math.sin(z * .71 + side);
      const coordinate = side * (Math.abs(x) + (exterior - Math.abs(x)) * section / 6);
      return [coordinate, plateau(coordinate, z, side), z];
    }));
    for (let row = 0; row < rock.length - 1; row++) {
      for (let col = 0; col < upper.length - 1; col++) {
        const shade = mix(rockColors[Math.min(row, rockColors.length - 1)], rockColors[Math.max(0, row - 1)], .30 * rng());
        const a = rock[row][col];
        const b = rock[row][col + 1];
        const c = rock[row + 1][col + 1];
        const d = rock[row + 1][col];
        cliff.face(a, b, c, scale(shade, .88 + .31 * rng()), [-side, 0, 0]);
        cliff.face(a, c, d, scale(shade, .91 + .16 * rng()), [-side, 0, 0]);
      }
    }
    for (let row = 0; row < terraces.length - 1; row++) {
      for (let col = 0; col < upper.length - 1; col++) {
        const stone = mix(rockColors[1], moss, .23 + .72 * rng());
        cliff.quad(terraces[row][col], terraces[row][col + 1], terraces[row + 1][col + 1],
          terraces[row + 1][col], scale(stone, .94 + .19 * rng()), [0, 1, 0]);
      }
    }
    for (const end of [0, upper.length - 1]) {
      const face = upper[end][2];
      const exterior = terraces.at(-1)[end];
      const profile = [...terraces.map((row) => row[end]).reverse(), ...rock.slice(1).map((row) => row[end]),
        [exterior[0], -8.15, face]];
      const triangles = triangulate(profile.flatMap(([x, y]) => [x, y]));
      for (let i = 0; i < triangles.length; i += 3) {
        const [a, b, c] = triangles.slice(i, i + 3).map((index) => profile[index]);
        cliff.face(a, b, c, rockColors[5], [0, 0, Math.sign(face)]);
      }
    }
    const outer = terraces.at(-1);
    for (let col = 0; col < outer.length - 1; col++) {
      const a = outer[col];
      const b = outer[col + 1];
      cliff.quad(a, b, [b[0], -8.15, b[2]], [a[0], -8.15, a[2]], rockColors[5], [side, 0, 0]);
    }

    for (let index = 0; index < 58; index++) {
      const z = (rng() - .5) * 21;
      const x = side * (edge(z, side) + .3 + rng() * 10.5);
      if (Math.abs(z) < 2.08 && Math.abs(x) < 20) continue;
      fracturedBlock(scree, x, plateau(x, z, side) + .025, z, .16 + rng() ** 2 * .60, screeColor, rng);
    }
    for (let index = 0; index < 18; index++) {
      const z = (rng() - .57) * 20;
      const x = side * (13.0 + rng() * 6.8);
      if (Math.abs(z) < 3.5 || (side === 1 && z > 2.3)) continue;
      trees(forest, x, plateau(x, z, side) + .018, z, 1.10 + rng() * 2.09, rng);
    }
    for (let index = 0; index < 22; index++) {
      const z = (rng() - .5) * 21.2;
      const x = side * (edge(z, side) - 4.35 - .95 * rng());
      fracturedBlock(scree, x, riverHeight + .02, z, .15 + rng() ** 1.5 * .70, rockColors[6], rng);
    }
  }

  const water = new Surface();
  const ripples = new Surface();
  const blue = rgb('#427f83');
  const dark = rgb('#284f59');
  const satin = rgb('#6da29e');
  const across = 10;
  const along = 26;
  for (let i = 0; i <= along; i++) {
    const z = -11.42 + 22.84 * i / along;
    for (let j = 0; j <= across; j++) {
      const width = 13.9 + .15 * Math.sin(z * .5);
      const x = (j / across - .5) * width;
      const a = x * 1.52 + z * .83;
      const b = z * 3.1 - x;
      const y = riverHeight + .018 * Math.sin(a) + .006 * Math.cos(b);
      const nx = -(.02736 * Math.cos(a) + .006 * Math.sin(b));
      const nz = -(.01494 * Math.cos(a) - .0186 * Math.sin(b));
      const n = 1 / Math.hypot(nx, 1, nz);
      const mid = Math.sin(Math.PI * j / across) ** .64;
      const shade = mix(dark, blue, mid * (.90 + .10 * Math.sin(z * .28 + x * .79)));
      const vertex = water.vertex([x, y, z], [nx * n, n, nz * n], shade);
      if (i && j) {
        const previous = vertex - across - 1;
        water.geometry.indices.push(previous - 1, vertex - 1, vertex, previous - 1, vertex, previous);
      }
    }
  }
  for (let index = 0; index < 116; index++) {
    const z = (rng() - .5) * 20.5;
    const x = (rng() - .5) * 10.9;
    const width = .025 + rng() * .055;
    const reach = .07 + rng() ** 2 * .94;
    const height = riverHeight + .048;
    const drift = .17 * Math.sin(z * .49 + x * .85);
    ripples.quad([x, height, z - reach], [x + width, height, z - reach * .32],
      [x + drift, height, z + reach], [x + drift - width * .61, height, z + reach * .28],
      mix(blue, satin, .19 + .41 * rng()), [0, 1, 0]);
  }

  add(cliff.geometry, materials.rock, 'Carved slate gorge', { static: true });
  add(scree.geometry, materials.rock, 'Weathered shale and river stones', { static: true });
  add(forest.geometry, materials.rock, 'Wind-shaped spruce specimens', { static: true });
  add(water.geometry, materials.water, 'Riverbed channel', { static: true, castShadow: false });
  add(ripples.geometry, materials.ripple, 'River surface broken highlights');
  add(box([43.8, .46, 23.45], [0, -8.37, 0], .17), materials.matte, 'Blackened bronze display base', { static: true });
  add(box([43.58, .10, 23.24], [0, -8.57, 0], .039), materials.brass, 'Fine engraved perimeter reveals');
  add(studioSweep(), materials.floor, 'Curved gallery cyclorama', { static: true, castShadow: false });
}

function studioSweep() {
  const skin = new Surface();
  const far = rgb('#3a4b59');
  const near = rgb('#52616a');
  const rim = rgb('#293e49');
  const courses = [[-8.72, 130, 0, near], [-8.72, 20, 0, near], [-8.72, -14, 0, rim]];
  for (let i = 1; i <= 17; i++) {
    const angle = Math.PI / 2 * i / 17;
    courses.push([-8.72 + 17 * (1 - Math.cos(angle)), -14 - 17 * Math.sin(angle), angle, mix(rim, far, Math.sin(angle))]);
  }
  courses.push([62, -31, Math.PI / 2, far]);
  for (const [i, [y, z, angle, color]] of courses.entries()) {
    for (const side of [-1, 1]) skin.vertex([side * 130, y, z], [0, Math.cos(angle), Math.sin(angle)], color);
    if (i) {
      const index = i * 2;
      skin.geometry.indices.push(index - 2, index - 1, index, index - 1, index + 1, index);
    }
  }
  return skin.geometry;
}