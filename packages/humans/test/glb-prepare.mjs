/** Material names of clothes and boots on the Character Creator cast. */
export const STRIP = /^TR_|Fauld|Boots|Frieze|Wool|Tweed|Coat|Shirt|Trousers/i;

// A GLB made ready for a pose picture: its images and textures removed, and with `bare` the meshes made only of
// `strip` materials (garments and boots by default) left out, so the joints show. Used by pose-frames and pose-sheet.
/** A GLB's bytes with its images and textures removed and, when `bare`, the meshes made only of `strip` materials. */
export function prepare(bytes, { bare = false, strip = STRIP } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    jsonLength = view.getUint32(12, true),
    doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))),
    binLength = view.getUint32(20 + jsonLength, true),
    bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + binLength);
  delete doc.images;
  delete doc.textures;
  delete doc.samplers;
  const drop = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const key of Object.keys(o))
      if (/Texture$/.test(key)) delete o[key];
      else drop(o[key]);
  };
  drop(doc.materials);
  for (const key of ['extensionsUsed', 'extensionsRequired'])
    if (doc[key]) doc[key] = doc[key].filter((e) => !/texture|KHR_materials/.test(e));
  if (bare)
    for (const node of doc.nodes)
      if (
        node.mesh !== undefined &&
        doc.meshes[node.mesh].primitives.every((p) => strip.test(doc.materials?.[p.material]?.name ?? ''))
      ) {
        delete node.mesh;
        delete node.skin;
      }
  // A clip's morph weights on a mesh left out have nothing to drive.
  for (const clip of doc.animations ?? [])
    clip.channels = clip.channels.filter(
      (c) => c.target.path !== 'weights' || doc.nodes[c.target.node]?.mesh !== undefined,
    );
  const raw = new TextEncoder().encode(JSON.stringify(doc)),
    json = new Uint8Array((raw.length + 3) & ~3).fill(0x20);
  json.set(raw);
  const out = new Uint8Array(28 + json.length + bin.length),
    dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, json.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  dv.setUint32(20 + json.length, bin.length, true);
  dv.setUint32(24 + json.length, 0x004e4942, true);
  out.set(bin, 28 + json.length);
  return out;
}
