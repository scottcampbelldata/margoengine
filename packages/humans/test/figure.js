// A two-bone figure for the humans tests: one triangle in a 'Suit' material and two clips, 'stand' and 'wave', that
// turn the 'arm' node (glTF node 1) about z from 0 to 0.2 and from 0 to 1 radian over one second. `skinned` binds the
// triangle to the arm joint instead of leaving it on its own node.
export function figure({ skinned = false } = {}) {
  const buffers = [],
    bufferViews = [],
    accessors = [];
  const accessor = (data, type, extra = {}) => {
    buffers.push(new Uint8Array(data.buffer));
    bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: data.length / { VEC4: 4, VEC3: 3, SCALAR: 1 }[type],
      type,
      ...extra,
    });
    return accessors.length - 1;
  };
  const position = accessor(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]), 'VEC3', {
      min: [0, 0, 0],
      max: [0.1, 0.1, 0],
    }),
    times = accessor(new Float32Array([0, 1]), 'SCALAR', { min: [0], max: [1] }),
    skin = skinned
      ? {
          JOINTS_0: accessor(new Uint16Array(12), 'VEC4', { componentType: 5123 }),
          WEIGHTS_0: accessor(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 'VEC4'),
        }
      : {};
  const clip = (name, angle) => {
    const output = accessor(new Float32Array([0, 0, 0, 1, 0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]), 'VEC4');
    return {
      name,
      samplers: [{ input: times, output }],
      channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
    };
  };
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 2] }],
    nodes: [
      { name: 'root', children: [1] },
      { name: 'arm', translation: [0, 1, 0] },
      { name: 'body', mesh: 0, ...(skinned ? { skin: 0 } : {}) },
    ],
    ...(skinned ? { skins: [{ joints: [1] }] } : {}),
    meshes: [{ primitives: [{ attributes: { POSITION: position, ...skin }, material: 0 }] }],
    materials: [{ name: 'Suit' }],
    animations: [clip('stand', 0.2), clip('wave', 1)],
    accessors,
    bufferViews,
    buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
  };
  return { doc, buffers };
}
/** The figure as one GLB file (one binary buffer), for loadGLTF in a page; `edit` may change the document first. */
export function figureGLB(edit, options) {
  const { doc, buffers } = figure(options);
  edit?.(doc);
  let offset = 0;
  const views = buffers.map((b) => {
    const at = offset;
    offset += (b.byteLength + 3) & ~3;
    return at;
  });
  const bin = new Uint8Array(offset);
  buffers.forEach((b, i) => bin.set(b, views[i]));
  const json = {
    ...doc,
    buffers: [{ byteLength: offset }],
    bufferViews: doc.bufferViews.map((v, i) => ({ ...v, buffer: 0, byteOffset: views[i] })),
  };
  let text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array((text.length + 3) & ~3).fill(0x20);
  padded.set(text);
  text = padded;
  const out = new Uint8Array(12 + 8 + text.length + 8 + bin.length),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  view.setUint32(20 + text.length, bin.length, true);
  view.setUint32(24 + text.length, 0x004e4942, true);
  out.set(bin, 28 + text.length);
  return out;
}
