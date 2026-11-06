import { Engine, TransformStore } from '@margoengine/core/extension';

/** An engine with no GPU: a renderer that keeps its geometries and draws nothing. */
export async function headlessEngine(capacity = 64, backend = 'webgl2') {
  const store = await TransformStore.create(capacity),
    resources = new Set(),
    renderer = {
      backend,
      add: (geometry) => resources.add(geometry),
      remove: (geometry) => resources.delete(geometry),
      render() {},
      dispose: () => resources.clear(),
    };
  const engine = new Engine(
    { width: 200, height: 200, clientWidth: 200, clientHeight: 200 },
    store,
    renderer,
    undefined,
    null,
  );
  return { engine, resources };
}

/** A glTF document over one buffer holding `views` (typed arrays or bytes), one bufferView each. */
export function documentOf(views, rest = {}) {
  const parts = views.map((view) => new Uint8Array(view.buffer ?? view, view.byteOffset ?? 0, view.byteLength)),
    padded = parts.map((part) => (part.length + 3) & ~3),
    bytes = new Uint8Array(padded.reduce((a, b) => a + b, 0)),
    bufferViews = [];
  let offset = 0;
  parts.forEach((part, i) => {
    bytes.set(part, offset);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: part.length });
    offset += padded[i];
  });
  return {
    doc: { asset: { version: '2.0' }, buffers: [{ byteLength: bytes.length }], bufferViews, ...rest },
    bytes,
  };
}

/** The xyz positions and normals of a core geometry. */
export function vertexData(geometry) {
  const positions = [],
    normals = [],
    v = geometry.vertices;
  for (let i = 0; i < v.length; i += 6) {
    positions.push(v[i], v[i + 1], v[i + 2]);
    normals.push(v[i + 3], v[i + 4], v[i + 5]);
  }
  return { positions, normals };
}
