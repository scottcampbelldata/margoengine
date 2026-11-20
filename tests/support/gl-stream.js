// The WebGL2 work a frame hands the driver, as a comparable list, for checks on the WebGL2 compatibility layer.
//
// On an RTX A6000 under ANGLE Direct3D 11 the same GL calls with the same data draw a few pixels one code apart a few
// seconds into a page (docs/known-bugs.md, KB-WATER-SETTINGS-COMPAT1), so two frames drawn seconds apart cannot be
// compared pixel for pixel there. What Margo hands the driver can: `recordGL()` (in the page) wraps every
// WebGL2RenderingContext method and records each call with its arguments, typed arrays as a hash of their bytes and
// length, GL objects numbered by their first use in the recording (so a ping-pong pair of textures, swapped each
// frame, records the same), while programs, shaders, vertex arrays and uniform locations keep one name for the page. Calls that only read state or wait for the GPU (get*, is*, checkFramebufferStatus, sync
// objects, flush, finish) are left out: how often the layer polls a fence depends on the GPU's progress, not on the
// frame. Works in the page and in Node (`firstDifference`).

// Objects that keep their identity from frame to frame are named for the page; the rest (textures, framebuffers,
// renderbuffers, buffers, queries, samplers) by their first use in the recording.
const LASTING = /^(WebGLProgram|WebGLShader|WebGLVertexArrayObject|WebGLUniformLocation)$/;
const READS = /^(get|is|check)|^(fenceSync|clientWaitSync|waitSync|deleteSync|flush|finish)$/;

/** FNV-1a of the bytes of a typed array or ArrayBuffer, with its length. */
function hashBytes(value) {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  return `bytes:${(h >>> 0).toString(16)}/${bytes.length}`;
}

/**
 * Installs the recorder once per page and returns it: `start()` begins a recording (dropping any open one), `stop()`
 * ends it and returns the calls as strings.
 * @returns {{ start(): void, stop(): string[] }}
 */
export function recordGL() {
  if (globalThis.__margoGLStream) return globalThis.__margoGLStream;
  const proto = globalThis.WebGL2RenderingContext.prototype;
  let calls = null,
    ids = null,
    counts = null;
  const lasting = new WeakMap(),
    lastingCounts = new Map();
  const token = (value) => {
    if (value === null || value === undefined) return String(value);
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return hashBytes(value);
    if (Array.isArray(value)) return `[${value.map(token).join(',')}]`;
    if (typeof value === 'object') {
      const kind = value.constructor?.name ?? 'object';
      if (LASTING.test(kind)) {
        if (!lasting.has(value)) {
          const n = lastingCounts.get(kind) ?? 0;
          lastingCounts.set(kind, n + 1);
          lasting.set(value, `${kind}@${n}`);
        }
        return lasting.get(value);
      }
      let id = ids.get(value);
      if (id === undefined) {
        const n = counts.get(kind) ?? 0;
        counts.set(kind, n + 1);
        id = `${kind}#${n}`;
        ids.set(value, id);
      }
      return id;
    }
    if (typeof value === 'string')
      return value.length > 64 ? `text:${hashBytes(new TextEncoder().encode(value))}` : JSON.stringify(value);
    return String(value);
  };
  for (const name of Object.getOwnPropertyNames(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (name === 'constructor' || typeof descriptor.value !== 'function' || READS.test(name)) continue;
    const call = descriptor.value;
    proto[name] = function (...args) {
      if (calls) calls.push(`${name}(${args.map(token).join(',')})`);
      return call.apply(this, args);
    };
  }
  return (globalThis.__margoGLStream = {
    start() {
      calls = [];
      ids = new Map();
      counts = new Map();
    },
    stop() {
      const recorded = calls ?? [];
      calls = null;
      ids = null;
      counts = null;
      return recorded;
    },
  });
}

/** The first index where two recordings differ, with both calls, or null when they are the same. */
export function firstDifference(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return { index: i, a: a[i] ?? '(end)', b: b[i] ?? '(end)' };
  return null;
}
