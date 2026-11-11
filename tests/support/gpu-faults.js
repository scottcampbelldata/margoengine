// Fault injection for GPU tests: fail the n-th createBuffer, createTexture or mapAsync of one device, the way a real
// device fails, so a test can check that the code under test reports the failure, leaves its counters and resources as
// they were, and works again on the next try.
//
// How each failure looks (WebGPU specification, "Errors & Debugging" and GPUBuffer.mapAsync):
// - createBuffer and createTexture do not throw. They return an object that cannot be used and raise a
//   GPUOutOfMemoryError (or a GPUValidationError with `error: 'validation'`) in the innermost error scope whose filter
//   matches; with no such scope the device fires `uncapturederror`. The returned object here is the real one, destroyed
//   at once, so using it is a real validation error and mapping it rejects.
// - createBuffer with mappedAtCreation: true throws a RangeError when the allocation fails, as the specification says.
// - mapAsync rejects with an OperationError DOMException and the buffer stays unmapped.
//
// Calls are counted from installation, 1-based, per method; mapAsync counts calls on buffers created after it. The
// device's own methods are shadowed on the instance (the prototype is not touched), so other devices are unaffected.
// No imports and no Node APIs: browser test pages import this file, and tests/gpu-faults.test.js runs it on a mock.
//
//   using faults = injectGPUFaults(device, { createBuffer: 2, mapAsync: [1, 3] });
//   device.pushErrorScope('out-of-memory');
//   const buffer = device.createBuffer(...);     // the second createBuffer fails
//   const error = await device.popErrorScope();  // GPUOutOfMemoryError
//   faults.injected; // [{ method: 'createBuffer', call: 2, label, error }]

const METHODS = ['createBuffer', 'createTexture', 'mapAsync'];
const FILTERS = { 'out-of-memory': 'GPUOutOfMemoryError', validation: 'GPUValidationError' };

const calls = (value, method) => {
  if (value === undefined) return new Set();
  const list = Array.isArray(value) ? value : [value];
  for (const n of list)
    if (!Number.isInteger(n) || n < 1)
      throw new RangeError(`${method}: call numbers are whole numbers from 1, got ${n}`);
  return new Set(list);
};

function gpuError(filter, message) {
  const name = FILTERS[filter],
    Type = globalThis[name];
  if (typeof Type === 'function') return new Type(message);
  const error = new Error(message);
  error.name = name;
  return error;
}

function uncaptured(error) {
  const Type = globalThis.GPUUncapturedErrorEvent;
  if (typeof Type === 'function') return new Type('uncapturederror', { error });
  return Object.assign(new Event('uncapturederror'), { error });
}

/**
 * Makes the listed calls of `device` fail. `plan` maps createBuffer, createTexture and mapAsync to a call number or a
 * list of them; `error` is the error-scope filter the allocation failures raise ('out-of-memory', the default, or
 * 'validation'). Returns a handle with `calls` (counts per method), `injected` (one record per failure) and
 * `restore()`, also run by `using` through Symbol.dispose.
 */
export function injectGPUFaults(device, plan = {}) {
  for (const key of Object.keys(plan))
    if (key !== 'error' && !METHODS.includes(key)) throw new RangeError(`Unknown fault target ${key}`);
  const filter = plan.error ?? 'out-of-memory';
  if (!(filter in FILTERS)) throw new RangeError(`Unknown error filter ${filter}: use 'out-of-memory' or 'validation'`);
  const failing = Object.fromEntries(METHODS.map((method) => [method, calls(plan[method], method)])),
    handle = { calls: { createBuffer: 0, createTexture: 0, mapAsync: 0 }, injected: [] },
    scopes = [],
    owned = [],
    patched = [];

  const shadow = (target, name, value) => {
    const own = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
    patched.push(() => {
      if (own) Object.defineProperty(target, name, own);
      else delete target[name];
    });
  };
  const record = (method, label, error) => {
    const entry = { method, call: handle.calls[method], label: label ?? '', error };
    handle.injected.push(entry);
    return entry;
  };
  const raise = (error) => {
    for (let i = scopes.length - 1; i >= 0; i--)
      if (scopes[i].filter === filter) {
        scopes[i].errors.push(error);
        return;
      }
    device.dispatchEvent(uncaptured(error));
  };

  const push = device.pushErrorScope,
    pop = device.popErrorScope;
  shadow(device, 'pushErrorScope', function (scopeFilter) {
    const result = push.call(this, scopeFilter);
    scopes.push({ filter: scopeFilter, errors: [] });
    return result;
  });
  shadow(device, 'popErrorScope', async function () {
    const scope = scopes.pop(),
      real = await pop.call(this);
    // The first error raised in a scope is the one it reports; a real one raised earlier wins over an injected one.
    return real ?? scope?.errors[0] ?? null;
  });

  const wrapMap = (buffer) => {
    const map = buffer.mapAsync;
    shadow(buffer, 'mapAsync', function (...args) {
      handle.calls.mapAsync++;
      if (!failing.mapAsync.has(handle.calls.mapAsync)) return map.apply(this, args);
      const error = new DOMException(`Injected mapAsync failure (call ${handle.calls.mapAsync})`, 'OperationError');
      record('mapAsync', this.label, error);
      return Promise.reject(error);
    });
    owned.push(buffer);
  };
  for (const method of ['createBuffer', 'createTexture']) {
    const create = device[method];
    shadow(device, method, function (descriptor) {
      handle.calls[method]++;
      const fail = failing[method].has(handle.calls[method]);
      if (fail && method === 'createBuffer' && descriptor?.mappedAtCreation) {
        const error = new RangeError(
          `Injected createBuffer failure with mappedAtCreation (call ${handle.calls[method]})`,
        );
        record(method, descriptor.label, error);
        throw error;
      }
      const resource = create.call(this, descriptor);
      if (fail) {
        resource.destroy();
        const error = gpuError(filter, `Injected ${method} failure (call ${handle.calls[method]})`);
        record(method, descriptor?.label, error);
        raise(error);
      } else if (method === 'createBuffer') wrapMap(resource);
      return resource;
    });
  }

  handle.restore = () => {
    while (patched.length) patched.pop()();
    owned.length = 0;
  };
  handle[Symbol.dispose] = handle.restore;
  return handle;
}
