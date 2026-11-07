// Poses a parsed USD scene at a time by plain glTF rules: keyframes, node transforms, morph weights, skinning. Nothing of
// the engine runs here, so the tests compare the document itself with OpenUSD's own points.
const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};
const compose = (t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) => {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0],
    2 * (x * y + w * z) * s[0],
    2 * (x * z - w * y) * s[0],
    0,
    2 * (x * y - w * z) * s[1],
    (1 - 2 * (x * x + z * z)) * s[1],
    2 * (y * z + w * x) * s[1],
    0,
    2 * (x * z + w * y) * s[2],
    2 * (y * z - w * x) * s[2],
    (1 - 2 * (x * x + y * y)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
};
export const transform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
function between(a, b, f, path) {
  if (path !== 'rotation') return a.map((x, k) => x + (b[k] - x) * f);
  let dot = a.reduce((sum, x, k) => sum + x * b[k], 0);
  const sign = dot < 0 ? -1 : 1;
  dot = Math.abs(dot);
  let p = 1 - f,
    q = f;
  if (dot < 0.9999) {
    const angle = Math.acos(dot);
    p = Math.sin((1 - f) * angle) / Math.sin(angle);
    q = Math.sin(f * angle) / Math.sin(angle);
  }
  const out = a.map((x, k) => p * x + q * sign * b[k]),
    length = Math.hypot(...out);
  return out.map((x) => x / length);
}
/** World matrices and animated values of every node at `seconds`. */
export function pose(asset, seconds) {
  const doc = asset.document,
    data = (accessor) => asset.buffers[doc.bufferViews[doc.accessors[accessor].bufferView].buffer],
    animated = new Map();
  for (const animation of doc.animations ?? [])
    for (const { sampler, target } of animation.channels) {
      const { input, output, interpolation } = animation.samplers[sampler],
        times = data(input),
        values = data(output),
        width = values.length / times.length;
      let i = 0;
      while (i < times.length - 2 && times[i + 1] <= seconds) i++;
      const j = Math.min(i + 1, times.length - 1),
        f = j === i || interpolation === 'STEP' ? 0 : Math.min(1, Math.max(0, (seconds - times[i]) / (times[j] - times[i]))),
        at = (k) => Array.from(values.subarray(k * width, k * width + width));
      const pointer = target.extensions?.KHR_animation_pointer?.pointer,
        id = pointer ? Number(pointer.split('/')[2]) : target.node;
      if (!animated.has(id)) animated.set(id, {});
      if (pointer) animated.get(id).visible = at(seconds < times[0] ? 0 : times[j] <= seconds ? j : i)[0] !== 0;
      else animated.get(id)[target.path] = between(at(i), at(j), f, target.path);
    }
  const world = new Array(doc.nodes.length);
  const walk = (id, parent) => {
    const node = doc.nodes[id],
      over = animated.get(id) ?? {},
      local =
        node.matrix && !over.translation && !over.rotation && !over.scale
          ? node.matrix
          : compose(over.translation ?? node.translation, over.rotation ?? node.rotation, over.scale ?? node.scale);
    world[id] = multiply(parent, local);
    for (const c of node.children ?? []) walk(c, world[id]);
  };
  walk(0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return { world, animated, data };
}
/** Every vertex of the mesh on node `id` in world space, under a pose. */
export function vertices(asset, id, { world, animated, data }) {
  const doc = asset.document,
    node = doc.nodes[id],
    primitive = doc.meshes[node.mesh].primitives[0],
    { attributes } = primitive,
    positions = data(attributes.POSITION),
    weights = animated.get(id)?.weights ?? doc.meshes[node.mesh].weights ?? [],
    morphs = (primitive.targets ?? []).map((target) => data(target.POSITION)),
    skin = node.skin === undefined ? undefined : doc.skins[node.skin],
    binds = skin && data(skin.inverseBindMatrices),
    joints = skin?.joints.map((joint, i) => multiply(world[joint], Array.from(binds.subarray(i * 16, i * 16 + 16)))),
    sets = [0, 1].filter((i) => attributes['JOINTS_' + i] !== undefined).map((i) => [data(attributes['JOINTS_' + i]), data(attributes['WEIGHTS_' + i])]),
    out = [];
  for (let v = 0; v < positions.length / 3; v++) {
    const p = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    morphs.forEach((morph, k) => {
      for (let d = 0; d < 3; d++) p[d] += (weights[k] ?? 0) * morph[v * 3 + d];
    });
    if (!skin) {
      out.push(transform(world[id], p));
      continue;
    }
    const sum = [0, 0, 0];
    for (const [index, amount] of sets)
      for (let i = 0; i < 4; i++) {
        const q = transform(joints[index[v * 4 + i]], p);
        for (let d = 0; d < 3; d++) sum[d] += amount[v * 4 + i] * q[d];
      }
    out.push(sum);
  }
  return out;
}
/** The node of the prim at `path`, by the names on the way down. */
export function nodeAt(asset, path) {
  const { nodes } = asset.document;
  let id = 0;
  for (const name of path.split('/').slice(1)) {
    id = nodes[id].children?.find((child) => nodes[child].name === name);
    if (id === undefined) return undefined;
  }
  return id;
}
/** Whether a node shows under a pose: it and everything above it are visible. */
export function shown(asset, id, { animated }) {
  const { nodes } = asset.document,
    own = (at) => animated.get(at)?.visible ?? nodes[at].extensions?.KHR_node_visibility?.visible ?? true,
    above = (at) => nodes.findIndex((node) => node.children?.includes(at));
  for (let at = id; at >= 0; at = above(at)) if (!own(at)) return false;
  return true;
}
/** The node of the mesh at `path`. */
export function nodeOf(asset, path) {
  const mesh = asset.meshes.findIndex((m) => m.path === path);
  return asset.document.nodes.findIndex((node) => node.mesh === mesh);
}
