// Scene additions derived from glTF 2.0 camera and KHR_lights_punctual specifications.
export const SETTINGS = {
  width: 512,
  height: 512,
  camera: { position: [12, 9, 18], target: [3, 3, -1.5], fov: 35, near: 0.1, far: 100 },
  light: { direction: [0.4, 0.7, 0.6], intensity: 3 },
};

const unit = (v) => v.map((x) => x / Math.hypot(...v));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function lookMatrix(position, target) {
  const z = unit(position.map((v, i) => v - target[i]));
  const x = unit(cross([0, 1, 0], z)),
    y = cross(z, x);
  return [...x, 0, ...y, 0, ...z, 0, ...position, 1];
}

/** Preserve the entire original scene and all material values; add only a shared scale, camera and sun. */
export function prepareScene(input) {
  const bytes = new Uint8Array(input),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('Expected GLB 2');
  const length = view.getUint32(12, true);
  const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  const binLength = view.getUint32(20 + length, true);
  const bin = bytes.slice(28 + length, 28 + length + binLength);
  const roots = doc.scenes[doc.scene ?? 0].nodes;
  const root = doc.nodes.push({ name: 'reference-world-units', scale: [1000, 1000, 1000], children: roots }) - 1;
  const camera =
    doc.nodes.push({
      name: 'Batch 160 camera',
      camera: 0,
      matrix: lookMatrix(SETTINGS.camera.position, SETTINGS.camera.target),
    }) - 1;
  const light =
    doc.nodes.push({
      name: 'Batch 160 sun',
      matrix: lookMatrix(SETTINGS.light.direction, [0, 0, 0]),
      extensions: { KHR_lights_punctual: { light: 0 } },
    }) - 1;
  doc.scenes = [{ name: 'Batch 160 matched scene', nodes: [root, camera, light] }];
  doc.scene = 0;
  doc.cameras = [
    {
      name: 'Batch 160 camera',
      type: 'perspective',
      perspective: {
        yfov: (SETTINGS.camera.fov * Math.PI) / 180,
        znear: SETTINGS.camera.near,
        zfar: SETTINGS.camera.far,
        aspectRatio: 1,
      },
    },
  ];
  doc.extensionsUsed = [...new Set([...(doc.extensionsUsed ?? []), 'KHR_lights_punctual'])];
  doc.extensions = {
    ...doc.extensions,
    KHR_lights_punctual: { lights: [{ type: 'directional', color: [1, 1, 1], intensity: SETTINGS.light.intensity }] },
  };
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const padded = Math.ceil(json.length / 4) * 4,
    binary = Math.ceil(bin.length / 4) * 4;
  const out = new Uint8Array(28 + padded + binary),
    header = new DataView(out.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, out.length, true);
  header.setUint32(12, padded, true);
  header.setUint32(16, 0x4e4f534a, true);
  out.fill(32, 20, 20 + padded);
  out.set(json, 20);
  header.setUint32(20 + padded, binary, true);
  header.setUint32(24 + padded, 0x004e4942, true);
  out.set(bin, 28 + padded);
  return { bytes: out, doc, bin };
}
