// For packages whose public objects are not engine plugins but hold something with a lifetime (listeners, timers,
// workers, storage handles, signal subscriptions). The object is created in the owner's scope, as a user creates it, and
// tied to a plugin registration that releases it the way `engine.dispose()`, `scene.dispose()` or
// `scene.removePlugin()` do for anything else an app hangs off an engine. `release` must be safe to call again, which
// the harness does after a plugin is gone, so a double disposal is part of what a fixture checks. A `release` that
// returns a promise (an asynchronous stop) is returned by both disposals, and the harness awaits it before it checks.
export function ownedByEngine(scene, name, release, extra = {}) {
  const plugin = { name: `owner-lifetime:${name}`, setup() {}, dispose: () => release() };
  return {
    plugin,
    dispose() {
      if (scene.plugins.get(plugin.name) === plugin) scene.removePlugin(plugin.name);
      return release();
    },
    ...extra,
  };
}

export const lifetimeFault = (message) => {
  throw new Error(`OWNER_LIFETIME: ${message}`);
};

// One recorder for the whole page or process, installed on first use and left in place: a timer is cleared a few
// microtasks after a disposal, long after any scope has ended, and that clear must still be seen.
const armed = new Map();
let current = null,
  installed = false;
function installTimerRecorder() {
  if (installed) return;
  installed = true;
  // Bound: a browser's timer functions throw when called with any other `this` than the window.
  const real = Object.fromEntries(
    ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'].map((name) => [
      name,
      globalThis[name].bind(globalThis),
    ]),
  );
  const arm = (id) => {
    if (current) armed.set(id, current);
    return id;
  };
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = real.setTimeout(
      (...a) => {
        armed.delete(id);
        return fn(...a);
      },
      ms,
      ...args,
    );
    return arm(id);
  };
  globalThis.setInterval = (...args) => arm(real.setInterval(...args));
  globalThis.clearTimeout = (id) => {
    armed.delete(id);
    return real.clearTimeout(id);
  };
  globalThis.clearInterval = (id) => {
    armed.delete(id);
    return real.clearInterval(id);
  };
}

/**
 * Timers a package sets while `scope(fn)` runs. A timer stays in `pending` until it fires or is cleared (whenever
 * that is, also after the scope). Wrap the creating call and the disposing call in `scope`. `expectNone(what)` fails
 * when one is still armed.
 */
export function watchTimers() {
  installTimerRecorder();
  const token = {};
  const scope = (fn) => {
    const previous = current;
    current = token;
    try {
      return fn();
    } finally {
      current = previous;
    }
  };
  const pending = {
    get size() {
      return [...armed.values()].filter((t) => t === token).length;
    },
  };
  return {
    scope,
    pending,
    expectNone(what) {
      if (pending.size) lifetimeFault(`${what} leaves ${pending.size} timer(s) armed`);
    },
  };
}
