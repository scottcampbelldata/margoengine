import { Geometry, PbrMaterial, box } from '@margoengine/core';

function triangles(build) {
  const positions = [],
    normals = [],
    indices = [];
  build((a, b, c) => {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      length = Math.hypot(nx, ny, nz);
    if (length < 1e-8) throw new Error('Degenerate procedural triangle');
    const start = positions.length / 3;
    positions.push(...a, ...b, ...c);
    normals.push(
      nx / length,
      ny / length,
      nz / length,
      nx / length,
      ny / length,
      nz / length,
      nx / length,
      ny / length,
      nz / length,
    );
    indices.push(start, start + 1, start + 2);
  });
  return new Geometry(positions, normals, indices);
}

function roundTower(topRadius) {
  return triangles((add) => {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4 + Math.PI / 8,
        b = ((i + 1) * Math.PI) / 4 + Math.PI / 8;
      const p = [Math.cos(a), 0, Math.sin(a)],
        q = [Math.cos(b), 0, Math.sin(b)];
      const r = [q[0] * topRadius, 1, q[2] * topRadius],
        s = [p[0] * topRadius, 1, p[2] * topRadius];
      add(p, r, q);
      if (topRadius) {
        add(p, s, r);
        add([0, 1, 0], r, s);
      }
      add([0, 0, 0], p, q);
    }
  });
}

function buttress() {
  // An extruded curved rib; the gap beneath it remains open.
  return triangles((add) => {
    for (let i = 0; i < 8; i++) {
      const t = i / 8,
        u = (i + 1) / 8;
      const x = 1 + 4 * t,
        y = 5.5 - 4 * t * t,
        X = 1 + 4 * u,
        Y = 5.5 - 4 * u * u;
      const a = [x, y, -0.24],
        b = [X, Y, -0.24],
        c = [X, Y + 0.65, -0.24],
        d = [x, y + 0.65, -0.24];
      const A = [x, y, 0.24],
        B = [X, Y, 0.24],
        C = [X, Y + 0.65, 0.24],
        D = [x, y + 0.65, 0.24];
      add(a, b, c);
      add(a, c, d);
      add(A, C, B);
      add(A, D, C);
      add(d, c, C);
      add(d, C, D);
      add(a, B, b);
      add(a, A, B);
      if (i === 0) {
        add(a, d, D);
        add(a, D, A);
      }
      if (i === 7) {
        add(b, B, C);
        add(b, C, c);
      }
    }
  });
}

export function createCitadel() {
  let seed = 0xc17ade;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const stone = new PbrMaterial({ color: '#8992a7' }).data,
    roof = new PbrMaterial({ color: '#4c5874' }).data;
  const rock = new PbrMaterial({ color: '#6a7186' }).data,
    dark = new PbrMaterial({ color: '#101728' }).data,
    amber = new PbrMaterial({ color: '#dba761' }).data;
  const geometries = [box(), roundTower(1), roundTower(0), buttress()];
  const data = Array.from({ length: 7 }, () => []);
  function instance(group, x, y, z, sx, sy, sz, color, angle = 0, emission = 0) {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    data[group].push(
      c * sx,
      0,
      -s * sx,
      0,
      0,
      sy,
      0,
      0,
      s * sz,
      0,
      c * sz,
      0,
      x,
      y,
      z,
      1,
      color[0],
      color[1],
      color[2],
      1,
      emission,
      0,
      0,
      0,
    );
  }
  function block(x, y, z, w, h, d, color = stone, angle = 0, emission = 0) {
    instance(0, x, y, z, w, h, d, color, angle, emission);
  }
  function tower(x, z, r, h, spire) {
    instance(1, x, 0, z, r, h, r, stone);
    instance(1, x, h - 0.6, z, r * 1.12, 0.8, r * 1.12, stone);
    instance(2, x, h + 0.15, z, r * 1.28, spire, r * 1.28, roof);
    instance(1, x, h + spire, z, 0.1, 1.6, 0.1, stone);
    for (let floor = 0; floor < 3; floor++)
      for (let side = 0; side < 8; side++) {
        const angle = (side * Math.PI) / 4,
          a = Math.sin(angle),
          b = Math.cos(angle),
          level = 3 + (floor * (h - 5)) / 3;
        block(x + a * r * 0.935, level, z + b * r * 0.935, 0.36, 1.5, 0.045, dark, angle);
        if ((side + floor) % 3 === 0) {
          block(x + a * r * 0.96, level - 0.12, z + b * r * 0.96, 0.12, 1.13, 0.045, amber, angle, 1);
          const faceRadius = r * Math.cos(Math.PI / 8) + 0.012;
          instance(6, x + a * faceRadius, level - 0.58, z + b * faceRadius, 0.8, 2.3, 1, amber, angle, 0.065);
        }
      }
  }
  block(0, 0.5, 0, 25, 1, 21);
  block(0, 7, 1, 9, 13, 8);
  block(0, 14, 1, 9.5, 0.8, 8.5);
  tower(0, 1, 4, 23, 14);
  for (const x of [-4.8, 4.8]) {
    tower(x, -2.6, 1.6, 20, 9);
    tower(x, 4.6, 1.3, 17, 7);
  }
  for (const x of [-10.3, 10.3]) for (const z of [-8.2, 8.2]) tower(x, z, 2.15, z < 0 ? 12 : 14, 8);
  for (const x of [-7.5, 7.5]) tower(x, -0.5, 1.25, 17, 7);
  for (const z of [-8.2, 8.2]) {
    block(0, 4.1, z, 20.6, 8.2, 1.15);
    block(0, 8.4, z, 20.6, 0.6, 1.55);
    for (let x = -9; x <= 9; x += 1.5) block(x, 9.1, z, 0.8, 1.2, 1.6);
    for (let x = -8; x <= 8; x += 2.6) {
      block(x, 3.8, z + 0.61, 0.28, 1.6, 0.04, dark);
      if (z > 0) {
        block(x, 3.7, z + 0.64, 0.1, 1.2, 0.04, amber, 0, 1);
        instance(6, x, 3.25, z + 0.587, 0.75, 2.1, 1, amber, 0, 0.065);
      }
    }
  }
  for (const x of [-10.3, 10.3]) {
    block(x, 4.1, 0, 1.15, 8.2, 16.4);
    block(x, 8.4, 0, 1.55, 0.6, 16.4);
    for (let z = -7; z <= 7; z += 1.4) block(x, 9.1, z, 1.6, 1.2, 0.8);
  }
  // Layered pointed gate and staircase, with dark inset slits in the curtain wall.
  block(0, 2.7, 8.81, 2.6, 5.4, 0.06, dark);
  instance(2, 0, 5.2, 8.84, 1.3, 1.8, 0.07, dark);
  for (let step = 0; step < 9; step++) block(0, 0.35 - step * 0.2, 10.5 + step * 0.55, 3.8, 0.6, 0.65);
  for (const x of [-1, 1])
    for (const z of [-5, 0, 5]) {
      instance(3, x * 4.3, 1, z, 1, 1, 1, stone, x > 0 ? 0 : Math.PI);
      block(x * 9.2, 2, z, 0.65, 4, 0.85);
      instance(2, x * 9.2, 4, z, 0.55, 2, 0.55, roof);
    }
  for (let i = 0; i < 18; i++) {
    const a = (i * Math.PI) / 9;
    block(Math.sin(a) * 4.3, 15.5, 1 + Math.cos(a) * 4.3, 0.48, 1.3, 0.48);
  }

  const cliff = triangles((add) => {
    const rings = [];
    for (const [y, radius] of [
      [1, 14.8],
      [-5, 17],
      [-15, 13],
      [-29, 11],
      [-45, 5],
    ]) {
      const ring = [];
      for (let i = 0; i < 32; i++) {
        const a = (i * Math.PI) / 16,
          r = radius * (0.82 + random() * 0.28);
        ring.push([Math.cos(a) * r, y + random() * 2, Math.sin(a) * r * 0.82]);
      }
      rings.push(ring);
    }
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 32; i++) {
        const n = (i + 1) % 32;
        add(rings[j][i], rings[j][n], rings[j + 1][i]);
        add(rings[j][n], rings[j + 1][n], rings[j + 1][i]);
      }
    for (let i = 0; i < 32; i++) add([0, 0.9, 0], rings[0][(i + 1) % 32], rings[0][i]);
  });
  geometries.push(cliff);
  instance(4, 0, -0.9, 0, 1, 1, 1, rock);
  for (let i = 0; i < 23; i++) {
    const a = random() * Math.PI * 2,
      r = 13 + random() * 2;
    instance(
      2,
      Math.cos(a) * r,
      -9 - random() * 12,
      Math.sin(a) * r * 0.8,
      1.5 + random() * 2,
      7 + random() * 13,
      1.5 + random() * 2,
      rock,
    );
  }
  const ridges = triangles((add) => {
    for (let i = 0; i < 55; i++) {
      const a = (i * Math.PI * 2) / 55,
        b = ((i + 1) * Math.PI * 2) / 55,
        r = 150 + random() * 75,
        h = -18 + random() * 25;
      add(
        [Math.cos(a) * r, -75, Math.sin(a) * r],
        [Math.cos(b) * r, -75, Math.sin(b) * r],
        [Math.cos((a + b) / 2) * r, h, Math.sin((a + b) / 2) * r],
      );
    }
  });
  geometries.push(ridges);
  instance(5, 0, 0, 0, 1, 1, 1, rock);
  geometries.push(
    new Geometry(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
      [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 1, 2, 0, 2, 3],
    ),
  );
  return geometries.map((geometry, i) => ({
    name: [
      'masonry',
      'octagonal towers',
      'spires & shards',
      'flying buttresses',
      'foundation crag',
      'distant ridges',
      'lantern wash',
    ][i],
    geometry,
    instances: new Float32Array(data[i]),
    count: data[i].length / 24,
    glow: i === 6,
  }));
}

/** Convert the study's fixed geometry to the engine's optional PBR instance/light packages.
 * @returns {{batches: import('@margoengine/scatter').ScatterBatch[], lights: import('@margoengine/clustered').PointLight[]}}
 */
export function createCitadelPBR(scene = createCitadel()) {
  const batches = [],
    lights = [];
  for (const source of scene) {
    if (source.glow) continue;
    const vertices = new Float32Array((source.geometry.vertices.length / 6) * 20);
    for (let i = 0; i < source.geometry.vertices.length / 6; i++) {
      vertices.set(source.geometry.vertices.subarray(i * 6, i * 6 + 3), i * 20);
      vertices.set(source.geometry.vertices.subarray(i * 6 + 3, i * 6 + 6), i * 20 + 4);
      vertices.fill(1, i * 20 + 16, i * 20 + 20);
    }
    const groups = new Map();
    for (let offset = 0; offset < source.instances.length; offset += 24) {
      const color = source.instances.slice(offset + 16, offset + 19),
        emission = source.instances[offset + 20];
      const key = [...color, emission].join(',');
      let group = groups.get(key);
      if (!group) {
        group = { color, emission, transforms: [] };
        groups.set(key, group);
      }
      group.transforms.push(...source.instances.subarray(offset, offset + 16));
      if (emission > 0)
        lights.push({
          position: [source.instances[offset + 12], source.instances[offset + 13], source.instances[offset + 14]],
          range: 4,
          color: [1, 0.65, 0.25],
          intensity: 7,
        });
    }
    for (const group of groups.values())
      batches.push({
        name: source.name,
        vertices,
        indices: source.geometry.indices,
        transforms: new Float32Array(group.transforms),
        material: new PbrMaterial({ color: Array.from(group.color), roughness: 0.82, doubleSided: true }),
        emissive: Array.from(group.color, (v) => v * group.emission * 5),
      });
  }
  return { batches, lights };
}

/** @param {[number,number,number]} out @param {number} azimuth @param {number} elevation */
export function moonDirection(out, azimuth, elevation) {
  if (
    !Number.isFinite(azimuth) ||
    !Number.isFinite(elevation) ||
    azimuth < 0 ||
    azimuth > 360 ||
    elevation < 5 ||
    elevation > 85
  )
    throw new RangeError('Invalid moon angles');
  const a = (azimuth * Math.PI) / 180,
    e = (elevation * Math.PI) / 180;
  out[0] = Math.sin(a) * Math.cos(e);
  out[1] = Math.sin(e);
  out[2] = Math.cos(a) * Math.cos(e);
}

/** @param {Float32Array} out @param {readonly number[]} moon */
export function moonShadowMatrix(out, moon) {
  const zx = moon[0],
    zy = moon[1],
    zz = moon[2],
    h = Math.hypot(zx, zz),
    xx = zz / h,
    xz = -zx / h,
    yx = zy * xz,
    yy = h,
    yz = -zy * xx;
  out.fill(0);
  out[0] = xx / 35;
  out[4] = 0;
  out[8] = xz / 35;
  out[1] = yx / 45;
  out[5] = yy / 45;
  out[9] = yz / 45;
  out[13] = (-10 * yy) / 45;
  out[2] = zx / 219;
  out[6] = zy / 219;
  out[10] = zz / 219;
  out[14] = (120 - 10 * zy) / 219;
  out[15] = 1;
}
