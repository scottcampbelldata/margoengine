// Real-adapter check (run from the repository root after building packages): node packages/shader/test/subgroups-check.mjs
// Each operation is compared with what its lanes should see, worked out here from the lanes the hardware reported. The same graph
// then runs on a device without the features, as one-lane subgroups and f32.
// Under MARGO_COMPAT=1 the page runs on the WebGL2 layer, whose adapter offers neither 'subgroups' nor 'shader-f16'
// (webgl2-compat src/device/device.ts featuresOf; docs/limits.md "Subgroups and half floats": the fallback is a
// subgroup of one lane and f32). Asking for both then gives the fallback, which is asserted lane for lane like the
// featureless run; only the hardware assertions (more than one lane, f16 rounding) are skipped, with a printed note.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
const compat = compatRun();
const context = await openBrowser({ startPath: '/packages/shader/test/subgroups-check.html', port: 5235 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const fold = (list, f, first) => list.reduce(f, first);
function verify(r, { whole, small, bits, real }) {
  assert.deepEqual(r.errors, []);
  const groups = new Map();
  r.key.forEach((k, i) => groups.set(k, [...(groups.get(k) ?? []), i]));
  let lanes = 0;
  for (const members of groups.values()) {
    const list = [...members].sort((a, b) => r.lane[a] - r.lane[b]),
      w = list.map((i) => whole[i]),
      s = list.map((i) => small[i]),
      b = list.map((i) => bits[i]),
      big = w.map((x) => x > 32);
    lanes = Math.max(lanes, list.length);
    assert.deepEqual(
      list.map((i) => r.lane[i]),
      list.map((_, k) => k),
      'lanes number from 0',
    );
    list.forEach((i, k) => {
      const before = (v, f, first) => fold(v.slice(0, k), f, first),
        upTo = (v, f, first) => fold(v.slice(0, k + 1), f, first),
        add = (x, y) => x + y,
        mul = (x, y) => x * y,
        expected = {
          size: list.length,
          add: fold(w, add, 0),
          min: Math.min(...w),
          max: Math.max(...w),
          mul: fold(s, mul, 1),
          and: fold(b, (x, y) => (x & y) >>> 0, 0xffffffff),
          or: fold(b, (x, y) => (x | y) >>> 0, 0),
          xor: fold(b, (x, y) => (x ^ y) >>> 0, 0),
          inclusiveAdd: upTo(w, add, 0),
          exclusiveAdd: before(w, add, 0),
          inclusiveMul: upTo(s, mul, 1),
          exclusiveMul: before(s, mul, 1),
          all: +big.every(Boolean),
          any: +big.some(Boolean),
          broadcast: w[0],
          first: w[0],
          shuffle: w[k],
          shuffleXor: list.length > 1 ? w[k ^ 1] : w[k],
        };
      if (list.length <= 32) expected.ballot = big.reduce((m, x, j) => (x ? (m | (1 << j)) >>> 0 : m), 0);
      if (k > 0) expected.shuffleUp = w[k - 1];
      if (k < list.length - 1) expected.shuffleDown = w[k + 1];
      // Every result is read back as f32. WGSL 15.7 lets an implementation ignore the sign of a zero, and the lowest
      // lane's exclusive scan is T(0) (17.12.1.1): Metal gives -0 there. Zeros compare by value; all else exactly.
      for (const [name, value] of Object.entries(expected))
        assert.equal(r[name][i] === 0 ? 0 : r[name][i], value, `${name}, lane ${k} of ${list.length}`);
    });
    assert.equal(list.filter((i) => r.elect[i]).length, 1, 'one lane is elected');
  }
  assert.equal(r.total, bits.reduce((sum, x) => sum + (x % 1000), 0), 'one atomic per subgroup adds up');
  // Real numbers: f16 keeps 11 bits, so a sum near 0.5 lands within 2^-10 of the f32 answer, and something must round.
  const third = Math.fround(1 / 3);
  let worst = 0;
  real.forEach((x, i) => (worst = Math.max(worst, Math.abs(r.product[i] - (x * third + 0.25)))));
  if (r.half) assert.ok(worst > 1e-5 && worst < 2 ** -9, `f16 rounds, within its precision: ${worst}`);
  else assert.ok(worst < 1e-6, `f32 keeps its precision: ${worst}`);
  real.forEach((x, i) => {
    assert.ok(Math.abs(r.packed[i * 2] - x) <= 2 ** -10, `packed ${x} came back as ${r.packed[i * 2]}`);
    assert.ok(Math.abs(r.packed[i * 2 + 1] - 0.1) <= 2 ** -12);
  });
  return { lanes, worst };
}
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const inputs = await page.evaluate(() => window.check.inputs),
    run = (features) => page.evaluate((f) => window.check.run(f), features);
  const fast = await run(['subgroups', 'shader-f16']);
  if (compat) {
    assert.ok(!fast.supported && !fast.half, 'the WebGL2 layer offers neither subgroups nor shader-f16');
    const a = verify(fast, inputs);
    assert.equal(a.lanes, 1, 'asking the layer for subgroups gives one-lane subgroups');
    console.log('compat: no subgroups or shader-f16 on the WebGL2 layer, "more than one lane" and "f16 rounds" skipped');
    console.log('ok requested on compat: one lane, f32 off by', a.worst.toExponential(2));
  } else {
    assert.ok(fast.supported && fast.half, 'this check is meant for an adapter with subgroups and shader-f16');
    const a = verify(fast, inputs);
    assert.ok(a.lanes > 1, 'the hardware gave subgroups of more than one lane');
    console.log('ok hardware: subgroups of', a.lanes, 'lanes, f16 off by', a.worst.toExponential(2));
  }
  const plain = await run([]);
  assert.ok(!plain.supported && !plain.half);
  const b = verify(plain, inputs);
  assert.equal(b.lanes, 1);
  console.log('ok fallback: one lane, f32 off by', b.worst.toExponential(2));
  assert.deepEqual(pageErrors, []);
  console.log('subgroups check passed');
} finally {
  await context.close();
}
