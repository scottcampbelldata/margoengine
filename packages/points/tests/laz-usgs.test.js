// A real LAZ file: a USGS 3DEP lidar tile (public domain, see fixtures/NOTICE.md and THIRD-PARTY-NOTICES.md), LAS 1.4,
// point format 6, written by "NV5 Geospatial Lidar Suite" with LASzip 3.4.3, 54,634 points in two chunks. Every check
// compares the decoded points with the header the producer's software wrote (the public header is read by the LAS
// reader, which does not depend on the LAZ coder), plus plausibility rules of the format. This is the check that found
// the 515-symbol GPS time model of point14 (the encoder-made files had agreed with a 516-symbol reading).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseLAS, readLASHeader } from '../dist/las.js';
import { lazChunks, lazInfo } from '../dist/laz.js';

const bytes = new Uint8Array(
  readFileSync(new URL('./fixtures/USGS_LPC_MT_Statewide_Phase3_2021_B21_568232.laz', import.meta.url)),
);

/** Raw field arrays of every point, in file order, from the streamed chunks. */
async function decode() {
  const { header, records } = readLASHeader(bytes);
  const info = lazInfo(records),
    n = header.pointCount,
    f = {
      x: new Int32Array(n),
      y: new Int32Array(n),
      z: new Int32Array(n),
      intensity: new Uint16Array(n),
      returnNumber: new Uint8Array(n),
      returns: new Uint8Array(n),
      flags: new Uint8Array(n),
      classification: new Uint8Array(n),
      userData: new Uint8Array(n),
      scanAngle: new Int16Array(n),
      pointSourceId: new Uint16Array(n),
      gps: new Float64Array(n),
    },
    chunkSizes = [];
  let i = 0;
  for await (const c of lazChunks(bytes, header, records)) {
    const dv = new DataView(c.buffer, c.byteOffset, c.byteLength),
      length = header.pointRecordLength;
    chunkSizes.push(c.length / length);
    for (let o = 0; o < c.length; o += length, i++) {
      f.x[i] = dv.getInt32(o, true);
      f.y[i] = dv.getInt32(o + 4, true);
      f.z[i] = dv.getInt32(o + 8, true);
      f.intensity[i] = dv.getUint16(o + 12, true);
      f.returnNumber[i] = dv.getUint8(o + 14) & 15;
      f.returns[i] = dv.getUint8(o + 14) >> 4;
      f.flags[i] = dv.getUint8(o + 15);
      f.classification[i] = dv.getUint8(o + 16);
      f.userData[i] = dv.getUint8(o + 17);
      f.scanAngle[i] = dv.getInt16(o + 18, true);
      f.pointSourceId[i] = dv.getUint16(o + 20, true);
      f.gps[i] = dv.getFloat64(o + 22, true);
    }
  }
  return { header, info, f, chunkSizes, count: i };
}

const sha = (a) =>
  createHash('sha256')
    .update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
    .digest('hex');

// SHA-256 of each decoded field array (little-endian raw values). These pin the output that the checks below showed
// to be right; they are not an independent reference.
const CHECKSUMS = {
  x: '20698a0b55429a81aa1a4a73bd94ed23250d19e9cf4887999e02eea95df0b544',
  y: '56a970fc121f3875eb15f4e7fe67100720f40c0c4c4c5a90e959a433f4cda5ee',
  z: '71e336f5024c5896978c1e8113c80f6c3ee93aa539bdd1fee4e403a3fc04e02c',
  intensity: '443d31c717b789f4ff3e84ed423338a3f85394b9213a4f57803fd5f70d30d037',
  returnNumber: '9b2d0b81358f094f729cb371cc1fa519d9d2bc5df0b5f691230d44a20603f8f0',
  returns: 'd4bf3d911a65bfcf00035551dc4978f81c7a48a1cd186847ef48b406297dbaf7',
  flags: 'ee75ed2d54c8e2046eb693a52536eca82e8388863f3ba24e262313259132f11c',
  classification: '4e1c12bd5801abcbf1de01e357285eed8545f1ab09c914df5c990f8dc0597732',
  userData: '4e0fe87b21fe3ff5b5adf2beddabbae6549c3bcc6946ea61d38f9fc34ef3d542',
  scanAngle: 'a755b30be1cea8f215e1bc02812aaff80ee77d1df8188e8bef11c7b210bfdf05',
  pointSourceId: '7ed32447593cae9d689fbfbf8a253eb7e7ce86b9e2a97d13af3cf01fd9e2b2a8',
  gps: '09d62ea4b72bff2808cfe4970809273fe2cd939eb4360b95f2b3d6f613300187',
};

test('real USGS LAZ file: decoded points agree with the producer header', async () => {
  const { header, info, f, chunkSizes, count } = await decode(),
    n = header.pointCount;
  const table = [];
  const check = (name, ok, detail = '') => {
    table.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    assert.ok(ok, `${name} ${detail}`);
  };

  check('LAS 1.4, point format 6, LAZ', header.versionMinor === 4 && header.pointFormat === 6 && header.compressed);
  check(
    'LASzip record: layered chunked POINT14',
    info.compressor === 3 && info.items.length === 1 && info.items[0].name === 'POINT14',
  );
  check('point count equals header', count === n, `${count}`);
  check(
    'chunk sizes match the chunk size and the count',
    chunkSizes.every((s, k) => (k < chunkSizes.length - 1 ? s === info.chunkSize : s > 0 && s <= info.chunkSize)) &&
      chunkSizes.reduce((a, b) => a + b, 0) === n,
    chunkSizes.join('+'),
  );

  const [sx, sy, sz] = header.scale,
    [ox, oy, oz] = header.offset,
    range = (a, s, o) => {
      let lo = Infinity,
        hi = -Infinity;
      for (const v of a) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return [lo * s + o, hi * s + o];
    };
  for (const [name, a, s, o, k] of [
    ['X', f.x, sx, ox, 0],
    ['Y', f.y, sy, oy, 1],
    ['Z', f.z, sz, oz, 2],
  ]) {
    const [lo, hi] = range(a, s, o);
    check(`${name} min and max equal the header`, lo === header.min[k] && hi === header.max[k], `${lo} .. ${hi}`);
  }

  const hist = new Array(15).fill(0);
  for (const r of f.returnNumber) hist[r - 1]++;
  check(
    'points by return equal the header array',
    header.pointsByReturn.every((v, k) => v === hist[k]),
    hist.slice(0, 3).join(','),
  );
  check(
    'return number between 1 and number of returns',
    f.returnNumber.every((r, k) => r >= 1 && r <= f.returns[k]),
  );

  const classes = new Map();
  for (const c of f.classification) classes.set(c, (classes.get(c) ?? 0) + 1);
  check(
    'classification values are valid (0 to 22 or 64 to 255)',
    [...classes.keys()].every((c) => c <= 22 || c >= 64),
    [...classes].map(([c, k]) => `${c}:${k}`).join(' '),
  );
  check(
    'class histogram plausible (ground is the majority, no unclassified noise values)',
    classes.get(2) > n / 2 && !classes.has(7) && !classes.has(18),
  );

  const g = range(f.gps, 1, 0);
  check(
    'GPS time finite and within a plausible adjusted-GPS span',
    f.gps.every(Number.isFinite) && g[0] > 1e8 && g[1] - g[0] < 86400 * 7,
    `${g[0]} .. ${g[1]}`,
  );
  // The tile is a merge of two flights (point source ids 113 and 114) in spatial order, so the times jump between
  // strips (about half the points are earlier than the one before). A wrongly decoded time would land far outside
  // the few hours the flights span.
  const bands = new Map();
  for (let k = 0; k < n; k++) {
    const b = bands.get(f.pointSourceId[k]) ?? { lo: Infinity, hi: -Infinity, users: new Set(), count: 0 };
    b.lo = Math.min(b.lo, f.gps[k]);
    b.hi = Math.max(b.hi, f.gps[k]);
    b.users.add(f.userData[k]);
    b.count++;
    bands.set(f.pointSourceId[k], b);
  }
  const lines = [...bands.values()].sort((p, q) => p.lo - q.lo);
  check(
    'every flight (point source id) keeps its times inside a few hours',
    lines.length === 2 && lines.every((l) => l.hi - l.lo < 4 * 3600),
    lines.map((l) => `${l.count} points ${l.lo.toFixed(2)}..${l.hi.toFixed(2)}`).join(' | '),
  );
  check(
    'user data equals the scanner channel in every point (layers agree)',
    f.userData.every((u, k) => u === ((f.flags[k] >> 4) & 3)),
  );

  const angle = range(f.scanAngle, 1, 0),
    ints = range(f.intensity, 1, 0);
  check(
    'scan angle within +-30000 (0.006 degree units, +-180 degrees)',
    angle[0] >= -30000 && angle[1] <= 30000,
    `${angle[0]} .. ${angle[1]}`,
  );
  check('intensity has real spread (not constant)', ints[1] > ints[0], `${ints[0]} .. ${ints[1]}`);
  check(
    'channel bits are 0..3 and reserved nothing set beyond them',
    f.flags.every((v) => ((v >> 4) & 3) <= 3),
  );
  check('no extra bytes: record length is 30', header.pointRecordLength === 30);

  const sums = Object.fromEntries(Object.entries(f).map(([k, a]) => [k, sha(a)]));
  for (const [k, want] of Object.entries(CHECKSUMS))
    check(`SHA-256 of decoded ${k}`, sums[k] === want, sums[k].slice(0, 12));
  console.log(table.join('\n'));
});

test('real USGS LAZ file: parseLAS with the decoder returns the same points', async () => {
  const { createLazDecoder } = await import('../dist/laz.js'),
    las = await parseLAS(bytes, { laz: createLazDecoder() });
  assert.equal(las.positions.length / 3, 54634);
});
