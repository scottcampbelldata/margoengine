// Golden outputs: what an ongoing-guarantee proof's baseline emits, stored in the repository (baselines/), so `--current`
// runs on any clone. A proof's `--current` baseline used to be rebuilt from its reference commit with Git; those commits
// exist only in one checkout's pre-rewrite history, so a fresh clone failed `npm run verify`. Now each baseline value a
// --current proof compares with (a GPU call log, a shader text, function outputs) is captured once, on a checkout that
// has the commit, and stored losslessly (every byte of typed arrays, NaN, -0 and undefined kept) with its SHA-256; the
// commit stays as documentation of where the value came from. Old package sources are never stored: only what they
// emitted, which the working tree must still emit (the proof's guarantee), so nothing enters the repository that the
// working tree does not already produce.
//   PROOFS_GOLDEN=1 (run.mjs --current): read the stored values only; nothing from Git
//   PROOFS_GOLDEN_CAPTURE=1 (capture.mjs): rebuild from Git, and when the proof passes, store what it compared with
//   neither: rebuild from Git when this clone has the commit (and require the stored value to match), else read the store
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { strict } from './history.js';

const root = resolve(import.meta.dirname, '../../..'),
  // PROOFS_BASELINES: another folder (the golden tests use a temporary one).
  store = process.env.PROOFS_BASELINES || resolve(import.meta.dirname, 'baselines');

const TYPED = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};
/** A JSON-safe copy of `value` that decode() turns back into an identical value: typed arrays and ArrayBuffers keep
 * every byte, numbers keep NaN, the infinities and -0, undefined stays undefined, Maps and Sets keep their order. Any
 * other kind of object (a function, a class instance) throws, so a value is never stored partly. */
export function encode(value) {
  if (value === undefined) return { $: 'undefined' };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) && !Object.is(value, -0)
      ? value
      : { $: 'number', v: String(Object.is(value, -0) ? '-0' : value) };
  if (typeof value === 'bigint') return { $: 'bigint', v: String(value) };
  if (Array.isArray(value)) return value.map(encode);
  if (value instanceof ArrayBuffer) return { $: 'ArrayBuffer', v: Buffer.from(value).toString('base64') };
  if (ArrayBuffer.isView(value)) {
    const type = value.constructor.name;
    assert.ok(TYPED[type] === value.constructor, `golden: cannot store a ${type}`);
    return { $: type, v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }
  if (value instanceof Map) return { $: 'Map', v: [...value].map(([k, v]) => [encode(k), encode(v)]) };
  if (value instanceof Set) return { $: 'Set', v: [...value].map(encode) };
  const proto = Object.getPrototypeOf(value);
  assert.ok(
    proto === Object.prototype || proto === null,
    `golden: cannot store a ${typeof value === 'function' ? 'function' : (value.constructor?.name ?? 'value')}`,
  );
  const out = {};
  for (const key of Object.keys(value)) out[key === '$' ? '$$' : key] = encode(value[key]);
  return out;
}

/** The value encode() was given. */
export function decode(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decode);
  switch (value.$) {
    case 'undefined':
      return undefined;
    case 'number':
      return value.v === '-0' ? -0 : Number(value.v);
    case 'bigint':
      return BigInt(value.v);
    case 'ArrayBuffer': {
      const bytes = Buffer.from(value.v, 'base64');
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    case 'Map':
      return new Map(value.v.map(([k, v]) => [decode(k), decode(v)]));
    case 'Set':
      return new Set(value.v.map(decode));
    case undefined: {
      const out = {};
      for (const key of Object.keys(value)) out[key === '$$' ? '$' : key] = decode(value[key]);
      return out;
    }
    default: {
      const Type = TYPED[value.$];
      assert.ok(Type, `golden: unknown stored kind ${value.$}`);
      const bytes = Buffer.from(value.v, 'base64'),
        copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      return new Type(copy.buffer);
    }
  }
}

/** The SHA-256 of a stored (encoded) value. */
export const digest = (encoded) => createHash('sha256').update(JSON.stringify(encoded)).digest('hex');

// Per proof: baselines/<proof>.json (readable: the ref, its full commit id, the commit it was captured at, facts and
// each value's SHA-256) and baselines/<proof>.json.gz (the values).
const metaOf = (proof) => resolve(store, `${proof}.json`),
  fileOf = (proof) => resolve(store, `${proof}.json.gz`);

/** The stored golden outputs of `proof`: { ref, revision, capturedAt, facts, outputs: { key: encoded } }, each output
 * checked against its SHA-256 in baselines/<proof>.json; undefined when nothing is stored. */
export function stored(proof) {
  if (!existsSync(metaOf(proof))) return;
  const entry = JSON.parse(readFileSync(metaOf(proof), 'utf8'));
  assert.ok(existsSync(fileOf(proof)), `golden: baselines/${proof}.json.gz is missing`);
  const data = JSON.parse(gunzipSync(readFileSync(fileOf(proof))).toString('utf8'));
  assert.deepEqual(
    Object.keys(data.outputs).sort(),
    Object.keys(entry.outputs).sort(),
    `golden: baselines/${proof}.json.gz and ${proof}.json name different values`,
  );
  for (const [key, value] of Object.entries(data.outputs))
    assert.equal(
      digest(value),
      entry.outputs[key],
      `golden: ${proof} "${key}" does not match its SHA-256 in baselines/${proof}.json`,
    );
  return { ...entry, outputs: data.outputs };
}

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const has = (ref) => {
  try {
    git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

/** Golden-output state of this proof run, set by begin() (compare.js refs() in --current mode). */
const state = {
  proof: undefined,
  ref: undefined,
  mode: 'off',
  data: undefined,
  captured: {},
  facts: {},
  used: new Set(),
  finals: [],
  /** How many taped calls are running (deterministicMath fails an approximated Math function called inside one). */
  taping: 0,
  /** Approximated Math functions a taped call used that have no exact stand-in. */
  approximated: new Set(),
};

/** The Node, V8 and platform this process runs on (with a V8 pow flag it was given), for the stored meta and messages. */
const host = () =>
  `Node ${process.version} (V8 ${process.versions.v8}) ${process.platform}-${process.arch}${process.execArgv
    .filter((arg) => arg.includes('math-pow'))
    .map((arg) => ` ${arg}`)
    .join('')}`;

const taping = (run) => {
  state.taping++;
  try {
    return run();
  } finally {
    state.taping--;
  }
};

// Exact stand-ins for the Math functions ECMAScript lets each engine round its own way, written with + - * /, % and
// Math.sqrt (each exactly rounded, so every host gives the same bits). They stay within a few ulp of the true value for
// moderate arguments; for huge ones sin and cos reduce by the double nearest 2 pi, so they are not the true value there,
// but they are the same on every host, which is what a stored digest needs. A proof proves that two codes compute the
// same expression; they call Math at call time, so both call these, and an expression that differs still gives
// different bits.
const TWO_PI = 6.283185307179586,
  PI = 3.141592653589793,
  HALF_PI = 1.5707963267948966;
/** sin(t), |t| <= pi/4 or a little more: its Taylor series to t^17, nested (t (1 - t^2/(2*3) (1 - t^2/(4*5) ...))). */
function sinSeries(t) {
  const s = t * t;
  let sum = 1;
  for (let n = 16; n >= 2; n -= 2) sum = 1 - (s / (n * (n + 1))) * sum;
  return t * sum;
}
/** cos(t), |t| <= pi/4 or a little more: its Taylor series to t^16, nested the same way. */
function cosSeries(t) {
  const s = t * t;
  let sum = 1;
  for (let n = 15; n >= 1; n -= 2) sum = 1 - (s / (n * (n + 1))) * sum;
  return sum;
}
/** [quadrant 0..3, t] with x = quadrant * pi/2 + t (modulo the double nearest 2 pi), |t| <= pi/4 or a little more. */
function quadrant(x) {
  let r = x % TWO_PI; // exact (ECMAScript's % is the exact remainder)
  if (r > PI) r -= TWO_PI;
  else if (r < -PI) r += TWO_PI; // both exact: r is within a factor of two of TWO_PI
  const n = Math.round(r / HALF_PI); // -2 .. 2, so n * HALF_PI is exact
  return [n & 3, r - n * HALF_PI];
}
/** Exact stand-ins (see above), each following its Math function on NaN, the infinities and -0. */
export const exactMath = Object.freeze({
  sin(x) {
    x = Number(x);
    if (!Number.isFinite(x)) return NaN;
    if (x === 0) return x;
    const [q, t] = quadrant(x);
    return q === 0 ? sinSeries(t) : q === 1 ? cosSeries(t) : q === 2 ? -sinSeries(t) : -cosSeries(t);
  },
  cos(x) {
    x = Number(x);
    if (!Number.isFinite(x)) return NaN;
    const [q, t] = quadrant(x);
    return q === 0 ? cosSeries(t) : q === 1 ? -sinSeries(t) : q === 2 ? -cosSeries(t) : sinSeries(t);
  },
  hypot(...args) {
    const values = args.map(Number);
    let max = 0,
      nan = false;
    for (const v of values) {
      const a = Math.abs(v);
      if (a === Infinity) return Infinity;
      if (a !== a) nan = true;
      else if (a > max) max = a;
    }
    if (nan) return NaN;
    if (max === 0) return 0;
    let sum = 0;
    for (const v of values) {
      const r = v / max;
      sum += r * r;
    }
    return max * Math.sqrt(sum);
  },
});
/** The Math functions ECMAScript calls "implementation-approximated", besides those exactMath replaces. */
const APPROXIMATED = ['acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'atan2', 'cbrt', 'cos', 'cosh', 'exp', 'expm1']
  .concat(['hypot', 'log', 'log1p', 'log10', 'log2', 'pow', 'sin', 'sinh', 'tan', 'tanh'])
  .filter((name) => !(name in exactMath));

/**
 * For a --current proof whose stored digests cover function results (tape): replaces Math.sin, Math.cos and Math.hypot
 * with exactMath for the rest of the process, and fails the proof if a taped call uses another approximated Math
 * function (it would need an exact stand-in or a `canonical` form). Does nothing outside --current. `**` cannot be
 * replaced; tape's `canonical` covers it, and tests/proofs-golden.test.js replays the proof under the other pow.
 */
export function deterministicMath() {
  if (state.mode === 'off') return;
  Object.assign(Math, exactMath);
  for (const name of APPROXIMATED) {
    const original = Math[name];
    Math[name] = function approximated(...args) {
      if (state.taping) state.approximated.add(name);
      return original.apply(Math, args);
    };
  }
}

/**
 * Starts golden outputs for a --current proof whose baseline is `ref`. Mode 'read' (PROOFS_GOLDEN=1, or a clone
 * without `ref`): every baseline value comes from the store and Git is never asked about `ref`. 'capture'
 * (PROOFS_GOLDEN_CAPTURE=1): rebuilt from Git and stored when the proof exits 0. 'check': rebuilt from Git, and an
 * existing stored value must match it.
 */
export function begin(ref, env = process.env) {
  state.proof = basename(process.argv[1] ?? '').replace(/\.proof\.js$/, '');
  state.ref = ref;
  if (env.PROOFS_GOLDEN_CAPTURE === '1') state.mode = 'capture';
  else if (env.PROOFS_GOLDEN === '1' || !has(ref)) state.mode = 'read';
  else state.mode = 'check';
  if (state.mode === 'read') {
    strict.value = true;
    state.data = stored(state.proof);
    assert.ok(
      state.data,
      `golden: no stored baseline for ${state.proof} (--current against ${ref}); capture it on a checkout that has ${ref}: node examples/package-benchmarks/proofs/capture.mjs --only=${state.proof}`,
    );
    assert.equal(
      state.data.ref,
      ref,
      `golden: ${state.proof}'s stored baseline is for ${state.data.ref}, the proof names ${ref}; capture it again`,
    );
  } else state.data = state.mode === 'check' ? stored(state.proof) : undefined;
  process.on('exit', finish);
  return state.mode;
}

/** At exit, once the proof passed: finish the tapes, then store (capture) or check that every stored value was used. */
function finish(code) {
  if (code !== 0 || process.exitCode) return;
  if (state.approximated.size) {
    console.error(
      `golden: ${state.proof}: taped calls used Math.${[...state.approximated].join(', Math.')}, which hosts round differently, so the stored digest would hold for one host only; give it an exact stand-in (golden.js exactMath) or a canonical form (tape)`,
    );
    process.exitCode = 1;
    return;
  }
  for (const done of state.finals) done();
  if (process.exitCode) return;
  if (state.mode === 'capture') return save();
  if (state.mode !== 'read') return;
  // Every stored value must still be asked for: a proof that stops comparing one has changed and must be recaptured.
  const unused = Object.keys(state.data.outputs).filter((key) => !state.used.has(key));
  if (unused.length) {
    console.error(`golden: ${state.proof} never compared with stored ${unused.join(', ')}; capture it again`);
    process.exitCode = 1;
  }
}

/** Whether this run reads golden outputs only (nothing is built from Git). */
export const readOnly = () => state.mode === 'read';

/** Whether the baseline at `ref` must not be built (its values come from the store). */
export const reading = (ref) => state.mode === 'read' && ref === state.ref;

/** The baseline value `key` of this proof: `compute()` (built from Git), or the stored value in 'read' mode. */
export async function golden(key, compute) {
  if (state.mode === 'off') return compute();
  assert.ok(!state.used.has(key), `golden: ${state.proof} asks for "${key}" twice; give each value its own key`);
  state.used.add(key);
  if (state.mode === 'read') {
    assert.ok(key in state.data.outputs, `golden: ${state.proof} has no stored "${key}"; capture it again`);
    return decode(state.data.outputs[key]);
  }
  const value = await compute(),
    encoded = encode(value);
  if (state.mode === 'capture') state.captured[key] = encoded;
  else if (state.data && key in state.data.outputs)
    assert.equal(
      digest(encoded),
      digest(state.data.outputs[key]),
      `golden: ${state.proof} "${key}" built from ${state.ref} no longer matches the stored value; inspect, then capture again`,
    );
  return value;
}

/** A fact about the baseline commit a proof needs besides its outputs (e.g. whether it descends from a commit): computed
 * from Git, or read from the store. */
export function fact(name, compute) {
  if (state.mode === 'off') return compute();
  if (state.mode === 'read') {
    assert.ok(
      name in (state.data.facts ?? {}),
      `golden: ${state.proof} has no stored fact "${name}"; capture it again`,
    );
    return state.data.facts[name];
  }
  const value = compute();
  if (state.mode === 'capture') state.facts[name] = value;
  else if (state.data?.facts && name in state.data.facts)
    assert.deepEqual(value, state.data.facts[name], `golden: ${state.proof} fact "${name}" changed; capture it again`);
  return value;
}

/** `value` with every NaN in its float arrays (deeply) rewritten to the one quiet NaN: ECMAScript lets an engine store any
 * NaN bit pattern when it writes NaN into a typed array (SetValueInBuffer), and V8 does differ by code path and JIT tier
 * (x86's default NaN has the sign bit set, a folded constant does not), so NaN payloads are not part of any claim. */
export function canonicalNaN(value) {
  if (value instanceof Float32Array || value instanceof Float64Array) {
    if (!value.some(Number.isNaN)) return value;
    const copy = value.slice(),
      view = new DataView(copy.buffer),
      size = copy.BYTES_PER_ELEMENT;
    copy.forEach((v, i) => {
      if (!Number.isNaN(v)) return;
      if (size === 4) view.setUint32(i * 4, 0x7fc00000, true);
      else view.setBigUint64(i * 8, 0x7ff8000000000000n, true);
    });
    return copy;
  }
  if (Array.isArray(value)) return value.map(canonicalNaN);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonicalNaN(v)]));
  return value;
}

/** What one call did, for the tape's digest: its result (or which argument it returned, or what it threw) and every
 * array argument after the call. */
function effect(args, run) {
  let result, threw;
  try {
    result = run();
  } catch (error) {
    threw = [error?.constructor?.name ?? typeof error, String(error?.message ?? error)];
  }
  const after = args.map((arg) => (Array.isArray(arg) || ArrayBuffer.isView(arg) ? encode(canonicalNaN(arg)) : 0));
  if (threw) return { record: { threw, after }, threw };
  const same = args.findIndex((arg) => arg !== null && typeof arg === 'object' && arg === result);
  if (same >= 0) return { record: { returned: same, after }, result };
  if (typeof result === 'function') return { record: { returned: 'function', after }, result };
  return { record: { result: encode(canonicalNaN(result)), after }, result };
}
const rethrow = ([name, message]) => {
  const Type = { TypeError, RangeError, SyntaxError, ReferenceError }[name] ?? Error;
  throw new Type(message);
};
/** Copies of the array arguments that alias exactly as the originals do: one copy per distinct array, and typed arrays
 * over one ArrayBuffer (a subarray beside its parent) stay views of one copied buffer. */
const copyArgs = (args) => {
  const copies = new Map(),
    buffers = new Map();
  return args.map((arg) => {
    if (!(Array.isArray(arg) || ArrayBuffer.isView(arg))) return arg;
    if (!copies.has(arg)) {
      if (Array.isArray(arg)) copies.set(arg, arg.slice());
      else {
        if (!buffers.has(arg.buffer)) buffers.set(arg.buffer, arg.buffer.slice(0));
        copies.set(arg, new arg.constructor(buffers.get(arg.buffer), arg.byteOffset, arg.length));
      }
    }
    return copies.get(arg);
  });
};

/**
 * A baseline module whose function calls are recorded on a tape: `module` (built at the ref) in capture and check mode,
 * `standIn` in read mode. `standIn` holds, for each function the proof calls, today's code written to the old copy's
 * signature (the proof's claim is that today's code computes exactly what the copy did). In capture and check mode each
 * call runs the old copy and the stand-in on copies of the same arguments and requires the same effect (result,
 * argument returned, error thrown, every array argument afterwards); the SHA-256 over all effects in call order is the
 * stored value `key`. In read mode only the stand-in runs, and its digest must equal the stored one at exit. A function
 * a call returns (a seeded generator) is taped the same way, paired with the one the stand-in returned.
 *
 * The digest is compared on other machines, so it may only cover results that ECMAScript specifies exactly. `**` and
 * Math.pow are not: V8 14.6 (Node 26) computes them with the C library's pow (`--use-std-math-pow`), V8 12.4 (Node 22)
 * with its own, and the two differ in the last bit for 48 of the 256 sRGB bytes. For a function whose result goes through
 * `**`, `canonical[name](args, value)` (args after the call, value the result or the argument returned) checks the value
 * against the old copy's own expression evaluated on this host and returns what the digest records instead, the same
 * on every host. The other approximated Math functions get exact stand-ins during the proof (deterministicMath below).
 */
export function tape(key, module, standIn, canonical = {}) {
  if (state.mode === 'off') return module;
  assert.ok(!state.used.has(key), `golden: ${state.proof} tapes "${key}" twice; give each tape its own key`);
  state.used.add(key);
  const hash = createHash('sha256'),
    reading = state.mode === 'read';
  let calls = 0;
  const wrap = (name, real, stand) =>
    function taped(...args) {
      assert.ok(typeof stand === 'function', `golden: ${state.proof} "${key}" has no stand-in for ${name}`);
      const twin = copyArgs(args),
        other = taping(() => effect(twin, () => stand(...twin)));
      let own = other;
      if (!reading) {
        own = taping(() => effect(args, () => real(...args)));
        assert.deepEqual(
          other.record,
          own.record,
          `golden: ${state.proof} "${key}": the stand-in for ${name} differs from the copy at ${state.ref} (call ${calls}, ${JSON.stringify(args).slice(0, 400)})`,
        );
      } else
        args.forEach((arg, i) => {
          // The stand-in's effect on the copies, applied to the caller's arguments as the old copy would have.
          if (Array.isArray(arg) || ArrayBuffer.isView(arg)) for (let k = 0; k < arg.length; k++) arg[k] = twin[i][k];
        });
      // A result that goes through `**` is stored in the form `canonical[name]` gives it (see above), so the digest is
      // the same on every host; the caller's code still gets the real result.
      const form =
        canonical[name] && !own.threw
          ? canonical[name](args, own.record.returned === undefined ? own.result : args[own.record.returned])
          : undefined;
      hash.update(
        JSON.stringify([
          name,
          form === undefined ? own.record : { returned: own.record.returned, canonical: encode(canonicalNaN(form)) },
        ]),
      );
      calls++;
      if (own.threw) rethrow(own.threw);
      if (own.record.returned === 'function') return wrap(`${name}()`, reading ? undefined : own.result, other.result);
      if (own.record.returned !== undefined) return args[own.record.returned];
      return own.result;
    };
  state.finals.push(() => {
    const value = { calls, sha256: hash.digest('hex') };
    if (state.mode === 'capture') return void (state.captured[key] = encode(value));
    const stored = state.data?.outputs[key] && decode(state.data.outputs[key]);
    if (stored && (stored.calls !== value.calls || stored.sha256 !== value.sha256)) {
      console.error(
        `golden: ${state.proof} "${key}": ${calls} calls, digest ${value.sha256}; stored: ${stored.calls} calls, ${stored.sha256} (${reading ? "today's code no longer computes what the old copies did" : 'capture it again'}; captured on ${state.data.capturedOn ?? 'an unrecorded host'}, this run on ${host()})`,
      );
      process.exitCode = 1;
    }
  });
  return new Proxy(
    {},
    {
      get(_, name) {
        if (name === 'then' || typeof name === 'symbol') return;
        if (!reading && typeof module[name] !== 'function') return module[name];
        return wrap(String(name), reading ? undefined : module[name], standIn[name]);
      },
    },
  );
}

function save() {
  mkdirSync(store, { recursive: true });
  const outputs = state.captured;
  writeFileSync(fileOf(state.proof), gzipSync(JSON.stringify({ outputs }), { level: 9 }));
  const meta = {
    proof: state.proof,
    ref: state.ref,
    revision: git('rev-parse', `${state.ref}^{commit}`),
    capturedAt: git('rev-parse', 'HEAD'),
    capturedOn: host(),
    facts: state.facts,
    outputs: Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, digest(value)])),
  };
  writeFileSync(metaOf(state.proof), JSON.stringify(meta, null, 1) + '\n');
  console.error(`golden: stored ${Object.keys(outputs).length} baseline values of ${state.proof} (${state.ref})`);
}
