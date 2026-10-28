// The disposal helper for test files whose `using` / `await using` declarations scripts/lib/lower-using-hooks.mjs
// lowered to try/finally (Node 22 cannot parse them; Node 24 and later run them natively). The transform (Oxc,
// through vite's transformWithOxc) emits, per block:
//   try { var ctx = usingCtx(); const a = ctx.u(value); const b = ctx.a(value); ... }
//   catch (_) { ctx.e = _; } finally { ctx.d(); }   (or `await ctx.d()` when the block holds an `await using`)
// so this module implements that contract from the ECMAScript explicit resource management spec (AddDisposableResource,
// DisposeResources): resources are disposed in reverse order, `null` and `undefined` are skipped, a value without the
// dispose method throws a TypeError at the declaration, and an error thrown while disposing is chained with the one
// already pending as a SuppressedError (error = the newer one, suppressed = the older one). Written clean room from the
// spec text; it is test infrastructure only and never ships in a package.

/** Marks "no pending error", so that a thrown `undefined` still counts as an error. */
const NONE = Symbol('no pending error');

/** The runtime's SuppressedError where it exists, else a spec-shaped stand in (Node 22 has none). */
const Suppressed =
  globalThis.SuppressedError ??
  class SuppressedError extends Error {
    constructor(error, suppressed, message = 'An error was suppressed during disposal.') {
      super(message);
      this.name = 'SuppressedError';
      this.error = error;
      this.suppressed = suppressed;
    }
  };

/**
 * The dispose method of `value` as AddDisposableResource finds it: `Symbol.asyncDispose` first for `await using`
 * (falling back to `Symbol.dispose`, whose result is then ignored), `Symbol.dispose` for `using`.
 */
function disposeMethod(value, async) {
  if (typeof value !== 'object' && typeof value !== 'function')
    throw new TypeError(`${async ? 'await using' : 'using'} needs an object, null or undefined, not ${typeof value}`);
  if (async) {
    const method = value[Symbol.asyncDispose];
    if (method !== undefined) {
      if (typeof method !== 'function') throw new TypeError('Symbol.asyncDispose is not a function');
      return method;
    }
    const sync = value[Symbol.dispose];
    if (typeof sync !== 'function') throw new TypeError('the value has neither Symbol.asyncDispose nor Symbol.dispose');
    return function () {
      sync.call(this);
    };
  }
  const method = value[Symbol.dispose];
  if (typeof method !== 'function') throw new TypeError('the value has no Symbol.dispose method');
  return method;
}

/** Creates the disposal context of one block. */
export default function usingCtx() {
  const stack = [];
  let hasAsync = false;
  const add = (value, async) => {
    if (async) hasAsync = true;
    if (value === null || value === undefined) {
      // `await using x = null` still awaits once at the end of the block (the spec's needsAwait).
      if (async) stack.push({ value, method: undefined, async });
      return value;
    }
    stack.push({ value, method: disposeMethod(value, async), async });
    return value;
  };
  const ctx = {
    e: NONE,
    /** Adds a `using` resource; returns the value. */
    u: (value) => add(value, false),
    /** Adds an `await using` resource; returns the value. */
    a: (value) => add(value, true),
    /** Disposes every resource in reverse order, then rethrows the pending error (chained), if any. */
    d() {
      let error = ctx.e;
      const fail = (thrown) => {
        error = error === NONE ? thrown : new Suppressed(thrown, error);
      };
      const finish = () => {
        if (error !== NONE) throw error;
      };
      if (!hasAsync) {
        for (let i = stack.length - 1; i >= 0; i--) {
          const { value, method } = stack[i];
          try {
            method.call(value);
          } catch (thrown) {
            fail(thrown);
          }
        }
        return finish();
      }
      return (async () => {
        for (let i = stack.length - 1; i >= 0; i--) {
          const { value, method, async } = stack[i];
          try {
            const result = method?.call(value);
            if (async) await result;
          } catch (thrown) {
            fail(thrown);
          }
        }
        finish();
      })();
    },
  };
  return ctx;
}
