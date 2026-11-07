import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { margoToGLTF, loadAnimatedMargo } from "../dist/anim.js";
import { decodeMargo } from "../dist/index.js";

// anim.margo and anim-truth.json come from real Blender 5.2.3 running tools/blender-addon/tests/blender_anim.py:
// the truth is Blender's own deformed vertices (Armature modifier and shape key) per clip and frame, in Y-up metres.
const source = await readFile(
  new URL("./fixtures/anim.margo", import.meta.url),
);
const truth = JSON.parse(
  await readFile(
    new URL("./fixtures/anim-truth.json", import.meta.url),
    "utf8",
  ),
);
const triangle = await readFile(
  new URL("./fixtures/triangle.margo", import.meta.url),
);
const bytes = (from = source) => Uint8Array.from(from);

/** Reads an accessor of the converted document as plain numbers, honouring byteStride. */
function read({ document, buffer }, id) {
  const a = document.accessors[id],
    view = document.bufferViews[a.bufferView],
    width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type],
    size = { 5126: 4, 5123: 2, 5125: 4 }[a.componentType],
    stride = view.byteStride ?? width * size,
    data = new DataView(
      buffer.buffer,
      buffer.byteOffset + view.byteOffset + (a.byteOffset ?? 0),
    ),
    get = { 5126: "getFloat32", 5123: "getUint16", 5125: "getUint32" }[
      a.componentType
    ],
    out = [];
  for (let i = 0; i < a.count; i++) {
    const row = [];
    for (let k = 0; k < width; k++)
      row.push(data[get](i * stride + k * size, true));
    out.push(row);
  }
  return out;
}
const mul = (a, b) =>
  Array.from({ length: 16 }, (_, i) => {
    const c = Math.floor(i / 4),
      r = i % 4;
    return (
      a[r] * b[c * 4] +
      a[4 + r] * b[c * 4 + 1] +
      a[8 + r] * b[c * 4 + 2] +
      a[12 + r] * b[c * 4 + 3]
    );
  });
function trs(
  [tx, ty, tz] = [0, 0, 0],
  [x, y, z, w] = [0, 0, 0, 1],
  [sx, sy, sz] = [1, 1, 1],
) {
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}
const apply = (m, [x, y, z]) =>
  [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
function lerp(a, b, f, rotation) {
  if (!rotation) return a.map((v, k) => v + (b[k] - v) * f);
  const dot = a.reduce((s, v, k) => s + v * b[k], 0),
    sign = dot < 0 ? -1 : 1,
    angle = Math.acos(Math.min(1, Math.abs(dot))),
    [p, q] =
      angle < 1e-6
        ? [1 - f, f]
        : [
            Math.sin((1 - f) * angle) / Math.sin(angle),
            Math.sin(f * angle) / Math.sin(angle),
          ],
    out = a.map((v, k) => p * v + q * sign * b[k]),
    n = Math.hypot(...out);
  return out.map((v) => v / n);
}
/** glTF 2.0 rules, written for this test: sample the clip, walk the scene, morph then skin every vertex. */
function posed(asset, clip, seconds) {
  const { document } = asset,
    over = new Map();
  for (const channel of clip.channels) {
    const sampler = clip.samplers[channel.sampler],
      times = read(asset, sampler.input).map(([t]) => t),
      values = read(asset, sampler.output).flat(),
      width = values.length / times.length;
    let i = 0;
    while (i < times.length - 2 && times[i + 1] <= seconds) i++;
    const j = Math.min(i + 1, times.length - 1),
      f =
        j === i
          ? 0
          : Math.min(
              1,
              Math.max(0, (seconds - times[i]) / (times[j] - times[i])),
            ),
      at = (k) => values.slice(k * width, k * width + width);
    over.set(
      `${channel.target.node}/${channel.target.path}`,
      lerp(at(i), at(j), f, channel.target.path === "rotation"),
    );
  }
  const world = [];
  const walk = (id, parent) => {
    const n = document.nodes[id],
      get = (path) => over.get(`${id}/${path}`) ?? n[path];
    world[id] = mul(
      parent,
      trs(get("translation"), get("rotation"), get("scale")),
    );
    for (const child of n.children ?? []) walk(child, world[id]);
  };
  for (const root of document.scenes[0].nodes) walk(root, trs());
  const id = document.nodes.findIndex(
      (n) => n.mesh !== undefined && n.skin !== undefined,
    ),
    node = document.nodes[id],
    mesh = document.meshes[node.mesh],
    primitive = mesh.primitives[0],
    skin = document.skins[node.skin],
    binds = read(asset, skin.inverseBindMatrices),
    joints = skin.joints.map((joint, k) => mul(world[joint], binds[k])),
    weights = over.get(`${id}/weights`) ?? mesh.weights,
    rest = read(asset, primitive.attributes.POSITION),
    targets = primitive.targets.map((t) => read(asset, t.POSITION)),
    sets = [0, 1]
      .filter((k) => primitive.attributes[`JOINTS_${k}`] !== undefined)
      .map((k) => [
        read(asset, primitive.attributes[`JOINTS_${k}`]),
        read(asset, primitive.attributes[`WEIGHTS_${k}`]),
      ]);
  return rest.map((p, v) => {
    const morphed = p.map(
        (x, d) => x + targets.reduce((s, t, k) => s + weights[k] * t[v][d], 0),
      ),
      sum = [0, 0, 0];
    for (const [index, amount] of sets)
      for (let k = 0; k < 4; k++) {
        const q = apply(joints[index[v][k]], morphed);
        for (let d = 0; d < 3; d++) sum[d] += amount[v][k] * q[d];
      }
    return { rest: p, at: sum };
  });
}

test("Blender armature, shape key and three actions match Blender within 1e-5 at every frame", () => {
  const asset = margoToGLTF(bytes()),
    { document } = asset;
  assert.deepEqual(document.animations.map((a) => a.name).sort(), [
    "Bend",
    "Breathe",
    "Twist",
  ]);
  assert.equal(document.skins.length, 1);
  assert.deepEqual(
    document.skins[0].joints.map((j) => document.nodes[j].name),
    ["Root", "Tip"],
  );
  const mesh = document.meshes.find((m) => m.extras?.targetNames);
  assert.deepEqual(mesh.extras.targetNames, ["Bulge"]);
  assert.equal(
    document.nodes.find((n) => n.name === "Tube").extras.margo.properties[
      "margo:character"
    ],
    "hero",
  );
  let compared = 0,
    worst = 0;
  for (const clip of document.animations)
    for (const [seconds, points] of Object.entries(truth.clips[clip.name])) {
      for (const { rest, at } of posed(asset, clip, Number(seconds))) {
        const vertex = truth.rest.findIndex((r) =>
          r.every((x, d) => Math.abs(x - rest[d]) < 2e-6),
        );
        assert.ok(vertex >= 0, "every exported vertex is a Blender vertex");
        for (let d = 0; d < 3; d++)
          worst = Math.max(worst, Math.abs(points[vertex][d] - at[d]));
        compared++;
      }
    }
  assert.ok(compared > 1000, `compared ${compared} vertex positions`);
  assert.ok(worst < 1e-5, `largest difference from Blender ${worst} m`);
});

test("the converted document shares the file bytes and keeps static files loadable", () => {
  const input = bytes(),
    asset = margoToGLTF(input);
  assert.equal(asset.buffer.buffer, input.buffer);
  assert.equal(asset.document.buffers[0].byteLength, input.byteLength);
  const flat = margoToGLTF(bytes(triangle));
  assert.equal(flat.document.animations, undefined);
  assert.equal(flat.document.meshes[0].primitives[0].attributes.POSITION, 0);
  assert.equal(flat.images.length, 1);
});

test("the static reader names the animation entry; malformed animation data is refused", () => {
  assert.throws(
    () => decodeMargo(bytes()),
    /^TypeError: Animated \.margo .*@margoengine\/blender\/anim/,
  );
  // A static file may not carry animation fields: the header flag says which reader owns them.
  const view = new DataView(bytes().buffer);
  view.setUint32(20, 2, true);
  assert.throws(
    () => margoToGLTF(new Uint8Array(view.buffer)),
    /Unsupported \.margo flags/,
  );
  // Without the flag, the animation data section is an unknown section type.
  view.setUint32(20, 0, true);
  assert.throws(
    () => margoToGLTF(new Uint8Array(view.buffer)),
    /^RangeError: Invalid \.margo section bounds\/type/,
  );
});

test("loadAnimatedMargo refuses non-HTTP(S) URLs with the fix", async () => {
  await assert.rejects(
    loadAnimatedMargo({}, "file:///hero.margo"),
    /must use HTTP\(S\); .*parseAnimatedMargo/,
  );
});
