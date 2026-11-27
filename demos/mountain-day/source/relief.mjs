export const columns = 513;
export const openingColumns = 129;
export const origin = [-22000, -29000];
export const extent = [44000, 43000];
export const heightUnit = 1 / 12;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export function blend(edge0, edge1, x) {
  const u = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return u * u * (3 - 2 * u);
}

function corner(x, y, seed) {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

export function noise(x, y, seed) {
  const a = Math.floor(x), b = Math.floor(y);
  const s = blend(0, 1, x - a), t = blend(0, 1, y - b);
  const south = corner(a,b,seed) * (1-s) + corner(a+1,b,seed) * s;
  const north = corner(a,b+1,seed) * (1-s) + corner(a+1,b+1,seed) * s;
  return south * (1-t) + north * t;
}

const peaks = [
  // Individual horns and the lower saddles connecting them.
  [-3250,-9400,3450,4120,5740,.35,2],
  [-2470,-8920,2660,1800,2910,-.33,5],
  [-3730,-8400,2910,2140,3110,.34,1],
  [-5750,-11200,2750,4200,5400,.42,8],
  [-7570,-12100,2540,3900,5900,.27,6],
  [-1600,-10600,2620,3600,4300,-.24,7],
  [-390,-11500,1750,3800,4100,-.19,4],
  [1630,-12300,2540,3400,4700,.40,5],
  [3530,-14900,2450,4500,6000,.29,8],
  [7020,-15000,2780,5200,6600,-.46,7],
  [9000,-18600,2190,6500,5800,.26,2],
  [-9300,-16100,2170,6000,6000,.12,3],
  [-11300,-19300,2940,7200,6800,.36,2],
  [680,-19200,2990,9800,7200,.20,6],
  [5370,-22400,2790,11200,6900,-.19,4],
  [-6500,-22900,2860,8000,5400,-.22,1],
  [-6500,-3100,1390,4300,4900,.15,5],
  [6500,-2300,1480,4500,7000,-.38,4],
  [1740,3870,660,1460,2450,.22,2],
  [-2020,4280,530,2100,2240,-.21,10],
  [-4500,2350,660,2700,4300,-.31,8],
  [5100,3740,730,4700,3900,.24,5],
  [-9500,3600,1250,7000,4500,-.24,4],
  [11300,1100,1390,5800,5600,.61,6],
].map(([x,z,h,w,d,a,seed]) => ({x,z,h,w,d,c:Math.cos(a),s:Math.sin(a),seed}));

function horn(peak, x, z) {
  const dx = x - peak.x, dz = z - peak.z;
  const u = (dx * peak.c + dz * peak.s) / peak.w;
  const v = (dz * peak.c - dx * peak.s) / peak.d;
  if (Math.abs(u) > 1.35 || Math.abs(v) > 1.35) return 0;
  const radius = Math.hypot(u, v);
  const azimuth = Math.atan2(v, u);
  const rib = .175 * Math.sin(azimuth * 5 + peak.seed * .53) + .084 * Math.sin(azimuth * 9 - radius * 4 + peak.seed);
  const fold = radius / (1 + rib * blend(.07,.32,radius));
  const shape = Math.max(0, 1 - fold);
  return peak.h * shape ** (1.30 + .20 * Math.sin(azimuth * 2 + peak.seed));
}

export function heightAt(x, z) {
  const bend = 860 * Math.sin(z / 4100) + 360 * Math.sin(z / 1700 - .76);
  const valley = 1 - blend(300, 3600, Math.abs(x - bend));
  const remote = 1 - blend(22000, 32000, Math.max(Math.abs(x), -z));
  const base = remote * (925 + 175 * noise(x / 1950, z / 1950, 4) - 290 * valley);
  const warpX = (noise(x / 1950,z / 1950, 41) - .5) * 430;
  const warpZ = (noise(x / 1650,z / 1650, 48) - .5) * 450;
  let tallest = 0, middle = 0;
  for (const peak of peaks) {
    const y = horn(peak, x + warpX, z + warpZ);
    if (y > tallest) { middle = tallest; tallest = y; }
    else if (y > middle) middle = y;
  }
  const strength = blend(120,1800,tallest);
  const ridge = (scale, seed) => 1 - Math.abs(2 * noise(x / scale, z / scale, seed) - 1);
  const folds = (ridge(1050,23) - .55) * 310 + (ridge(440,37) - .55) * 151
    + (ridge(175,57) - .55) * 46;
  const soil = (noise(x / 270, z / 270, 82) - .5) * 48;
  return Math.max(100, base + tallest + middle * .20 + strength * folds + soil);
}

export function decodeHeight(buffer, size = columns) {
  const count = size * size;
  const encoded = new Uint8Array(buffer);
  if (encoded.length !== count * 2) throw new Error('Mountain height field has the wrong dimensions.');
  const pixels = new Uint16Array(count);
  const meters = new Float32Array(count);
  for (let z = 0, i = 0; z < size; z++) {
    for (let x = 0; x < size; x++, i++) {
      const left = x ? pixels[i - 1] : 0;
      const above = z ? pixels[i - size] : 0;
      const diagonal = x && z ? pixels[i - size - 1] : 0;
      const code = encoded[i] | encoded[count + i] << 8;
      const difference = (code >>> 1) ^ -(code & 1);
      pixels[i] = left + above - diagonal + difference;
      meters[i] = pixels[i] * heightUnit;
    }
  }
  return meters;
}

export async function loadHeight(url, size, signal) {
  const response = await fetch(url,{signal});
  if (!response.ok) throw new Error('The mountain height field could not be loaded.');
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  return decodeHeight(await new Response(stream).arrayBuffer(),size);
}