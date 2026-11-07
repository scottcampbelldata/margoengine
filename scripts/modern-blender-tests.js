import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import { findPython } from "./support/find-python.mjs";
import { openBrowser } from "./browser.js";
import { decodePNG } from "../tests/support/png.js";
import { decodeMargo } from "../packages/blender/dist/index.js";
import { GLTFAsset } from "../packages/gltf-pro/dist/index.js";

await mkdir("test-results/blender", { recursive: true });
const fixtures = [
  await readFile("packages/blender/tests/fixtures/triangle.margo"),
  await readFile("packages/blender/tests/fixtures/compact-triangle.margo"),
];
if (process.env.MARGO_BLENDER) {
  execFileSync(findPython(), ["tools/blender-addon/package_addon.py"], {
    stdio: "inherit",
  });
  execFileSync(
    process.env.MARGO_BLENDER,
    [
      "--background",
      "--factory-startup",
      "--python-exit-code",
      "1",
      "--python",
      "tools/blender-addon/tests/blender_install.py",
      "--",
      "dist/margo-blender-addon-v1.0.0.zip",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        BLENDER_USER_RESOURCES: resolve("test-results/blender/install-profile"),
      },
    },
  );
  execFileSync(
    process.env.MARGO_BLENDER,
    [
      "--background",
      "--factory-startup",
      "--python-exit-code",
      "1",
      "--python",
      "tools/blender-addon/tests/blender_roundtrip.py",
      "--",
      "test-results/blender",
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    process.env.MARGO_BLENDER,
    [
      "--background",
      "--factory-startup",
      "--python-exit-code",
      "1",
      "--python",
      "tools/blender-addon/tests/blender_anim.py",
      "--",
      "test-results/blender/anim",
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    process.env.MARGO_BLENDER,
    [
      "--background",
      "--factory-startup",
      "--python-exit-code",
      "1",
      "--python",
      "tools/blender-addon/tests/blender_components.py",
      "--",
      "test-results/blender/components",
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    process.env.MARGO_BLENDER,
    [
      "--background",
      "--factory-startup",
      "--python-exit-code",
      "1",
      "--python",
      "tools/blender-addon/tests/blender_bake.py",
      "--",
      "test-results/blender/bake",
    ],
    { stdio: "inherit" },
  );
  const { bakeErrors } = await import("../packages/blender/tests/bake-truth.js");
  const fresh = await bakeErrors(
    decodeMargo(await readFile("test-results/blender/bake/bake.margo")),
  );
  for (const channel of ["r", "g", "b"])
    assert.ok(
      fresh.errors[channel] <= fresh.bounds.color,
      `Blender's fresh bake differs from the node maths in ${channel}: ${JSON.stringify(fresh)}`,
    );
  for (const channel of ["roughness", "metallic"])
    assert.ok(
      fresh.errors[channel] <= fresh.bounds.linear,
      `Blender's fresh bake differs from the node maths in ${channel}: ${JSON.stringify(fresh)}`,
    );
  // Lights and cameras: a fresh Blender export carries the committed fixture's tags and Blender's same numbers.
  execFileSync(
    process.env.MARGO_BLENDER,
    [
      "--background",
      "--factory-startup",
      "--python-exit-code",
      "1",
      "--python",
      "tools/blender-addon/tests/blender_scene.py",
      "--",
      "test-results/blender/scene",
    ],
    { stdio: "inherit" },
  );
  {
    const tags = (bytes) =>
      decodeMargo(bytes).document.nodes.map((n) => [n.name, n.extras.margo.properties, n.translation, n.rotation]);
    const close = (a, b, path) => {
      if (typeof a === "number") assert.ok(Math.abs(a - b) < 1e-6, `fresh scene export differs at ${path}: ${a} against ${b}`);
      else if (a && typeof a === "object") for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) close(a[key], b[key], `${path}.${key}`);
      else assert.equal(a, b, `fresh scene export differs at ${path}`);
    };
    close(
      tags(await readFile("test-results/blender/scene/scene.margo")),
      tags(await readFile("packages/blender/tests/fixtures/scene.margo")),
      "nodes",
    );
    close(
      JSON.parse(await readFile("test-results/blender/scene/scene-truth.json", "utf8")),
      JSON.parse(await readFile("packages/blender/tests/fixtures/scene-truth.json", "utf8")),
      "truth",
    );
  }
  // Curves, points and volumes: a fresh Blender export carries the committed fixture's shapes and Blender's same numbers.
  execFileSync(
    process.env.MARGO_BLENDER,
    [
      "--background",
      "--factory-startup",
      "--python-exit-code",
      "1",
      "--python",
      "tools/blender-addon/tests/blender_curves.py",
      "--",
      "test-results/blender/curves",
    ],
    { stdio: "inherit" },
  );
  {
    const { decodeMargoCurves } = await import("../packages/blender/dist/curves.js");
    const shapes = (bytes) => {
      const { curves, points, volumes } = decodeMargoCurves(bytes);
      return {
        curves: curves.map((c) => [c.name, [...c.matrix], c.splines.map((s) => ({ ...s, positions: [...s.positions], radius: s.radius && [...s.radius], tilt: s.tilt && [...s.tilt], weight: s.weight && [...s.weight], handleLeft: s.handleLeft && [...s.handleLeft], handleRight: s.handleRight && [...s.handleRight], handleTypeLeft: s.handleTypeLeft && [...s.handleTypeLeft], handleTypeRight: s.handleTypeRight && [...s.handleTypeRight] }))]),
        points: points.map((p) => [p.name, [...p.matrix], [...p.positions], [...p.radius], [...p.colors]]),
        volumes: volumes.map((v) => [v.name, [...v.matrix], v.grids]),
      };
    };
    const close = (a, b, path) => {
      if (typeof a === "number") assert.ok(Math.abs(a - b) < 1e-6, `fresh curves export differs at ${path}: ${a} against ${b}`);
      else if (a && typeof a === "object") for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) close(a[key], b[key], `${path}.${key}`);
      else assert.equal(a, b, `fresh curves export differs at ${path}`);
    };
    close(
      shapes(await readFile("test-results/blender/curves/curves.margo")),
      shapes(await readFile("packages/blender/tests/fixtures/curves.margo")),
      "shapes",
    );
    close(
      JSON.parse(await readFile("test-results/blender/curves/curves-truth.json", "utf8")),
      JSON.parse(await readFile("packages/blender/tests/fixtures/curves-truth.json", "utf8")),
      "truth",
    );
  }
  const { margoComponents } =
    await import("../packages/blender/dist/components.js");
  assert.deepEqual(
    margoComponents(
      decodeMargo(
        await readFile("test-results/blender/components/components.margo"),
      ),
    ).document,
    margoComponents(
      decodeMargo(
        await readFile("packages/blender/tests/fixtures/components.margo"),
      ),
    ).document,
    "Blender's tagged level must give the committed fixture's components",
  );
  const { margoToGLTF } = await import("../packages/blender/dist/anim.js");
  assert.deepEqual(
    margoToGLTF(await readFile("test-results/blender/anim/anim.margo"))
      .document.animations.map((a) => a.name)
      .sort(),
    ["Bend", "Breathe", "Twist"],
    "Blender armature, NLA and shape-key actions must export as three clips",
  );
  const exported = await readFile("test-results/blender/blender.margo"),
    asset = decodeMargo(exported);
  assert.equal(
    asset.document.meshes.length,
    1,
    "Identical Blender meshes must share packed geometry",
  );
  assert.equal(asset.document.nodes.length, 2);
  const mirrored = asset.document.nodes.find((n) => n.name === "Mirrored");
  assert.ok(
    mirrored.scale.reduce((a, b) => a * b, 1) < 0,
    "Mirrored transform lost its determinant",
  );
  assert.equal(
    asset.document.nodes.find((n) => n.name === "Triangle").extras.margo
      .properties["margo:shadow_caster"],
    true,
  );
  assert.deepEqual(
    asset.document.nodes.find((n) => n.name === "Triangle").extras.margo
      .properties["margo:lod_dist"],
    [15, 45, 90],
  );
  const png = await decodePNG(asset.images[0]),
    expected = await decodePNG(
      await readFile("test-results/blender/texture.png"),
    );
  assert.deepEqual(
    png.data,
    expected.data,
    "Blender changed source texture color/alpha or orientation",
  );
  const native = await readFile("test-results/blender/native.glb"),
    jsonLength = native.readUInt32LE(12),
    document = JSON.parse(native.subarray(20, 20 + jsonLength).toString()),
    binary = native.subarray(28 + jsonLength);
  const gltf = new GLTFAsset(document, [binary]),
    attributes = document.meshes[0].primitives[0].attributes;
  const positions = gltf.accessor(attributes.POSITION, "VEC3"),
    normals = gltf.accessor(attributes.NORMAL, "VEC3"),
    tangents = gltf.accessor(attributes.TANGENT, "VEC4"),
    uv = gltf.accessor(attributes.TEXCOORD_0, "VEC2");
  const packed = asset.geometry[0][0].vertices;
  for (let i = 0; i < packed.length / 20; i++) {
    const match = Array.from(
      { length: positions.length / 3 },
      (_, j) => j,
    ).find((j) =>
      [0, 1, 2].every(
        (c) => Math.abs(positions[j * 3 + c] - packed[i * 20 + c]) < 1e-5,
      ),
    );
    assert.notEqual(
      match,
      undefined,
      "Position differs from Blender glTF export",
    );
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(normals[match * 3 + c] - packed[i * 20 + 4 + c]) < 1e-5,
        "Normal differs from Blender glTF export",
      );
    for (let c = 0; c < 4; c++)
      assert.ok(
        Math.abs(tangents[match * 4 + c] - packed[i * 20 + 8 + c]) < 1e-5,
        "Tangent differs from Blender glTF export",
      );
    for (let c = 0; c < 2; c++)
      assert.ok(
        Math.abs(uv[match * 2 + c] - packed[i * 20 + 12 + c]) < 1e-5,
        "UV differs from Blender glTF export",
      );
  }
  const modified = decodeMargo(
    await readFile("test-results/blender/modifier.margo"),
  );
  assert.ok(
    modified.geometry.some((parts) => parts[0].indices.length > 3),
    "Export ignored evaluated modifiers",
  );
  const instanced = decodeMargo(
    await readFile("test-results/blender/instances.margo"),
  );
  assert.equal(
    instanced.document.nodes.length,
    3,
    "Collection prototype absent from scene was not exported",
  );
  assert.deepEqual(
    instanced.document.nodes.find((n) => n.name === "Prototype").translation,
    [0, -2, 0],
  );
  const centimeters = decodeMargo(
    await readFile("test-results/blender/centimeters.margo"),
  );
  assert.ok(
    Math.abs(centimeters.geometry[0][0].vertices[0] + 0.006) < 1e-7,
    "Geometry units were not converted to meters",
  );
  assert.ok(
    Math.abs(
      centimeters.document.nodes.find((n) => n.name === "Mirrored")
        .translation[0] - 0.02,
    ) < 1e-7,
    "Transform units were not converted to meters",
  );
  const compact = decodeMargo(
    await readFile("test-results/blender/compact-instances.margo"),
  );
  assert.equal(compact.document.nodes.length, 100);
  assert.equal(compact.geometry.length, 1);
  assert.equal(compact.geometry[0][0].vertices.length, 60);
  const overrides = decodeMargo(
    await readFile("test-results/blender/compact-overrides.margo"),
  );
  assert.equal(overrides.geometry.length, 2);
  fixtures.push(exported);
}
const demo = await build({
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    rollupOptions: { input: "examples/blender-loader/index.html" },
  },
});
assert.ok(
  demo.output.some((c) => c.type === "chunk" && c.isEntry),
  "Blender viewer build failed",
);
const browser = await openBrowser({
    startPath: "/tests/modern-extension.html",
  }),
  { page, hardware } = browser,
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
try {
  for (let i = 0; i < fixtures.length; i++)
    await page.route("**/fixture-" + i + ".margo", (route) =>
      route.fulfill({
        body: fixtures[i],
        contentType: "application/octet-stream",
      }),
    );
  const results = await page.evaluate(async (count) => {
    const { Engine } = await import("/packages/core/dist/index.js");
    const { createStage } = await import("/packages/stage/dist/index.js");
    const { decodeMargo, loadMargo, parseMargo } =
      await import("/packages/blender/dist/index.js");
    const { Shadows } = await import("/packages/shadows/dist/index.js");
    const { SSAO } = await import("/packages/post/dist/index.js");
    const assert = (ok, message) => {
      if (!ok) throw new Error(message);
    };
    const results = [];
    for (let i = 0; i < count; i++) {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "width:256px;height:256px";
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: "webgpu",
        capacity: 16,
        camera: { position: [0, 0, 3], target: [0, 0, 0] },
      });
      const device = engine.gpu;
      device.pushErrorScope("validation");
      const model = await loadMargo(engine, "/fixture-" + i + ".margo");
      assert(
        model.nodes.length === 2 && model.primitives.length === 2,
        "Missing scene instances",
      );
      assert(
        model.primitives[0].vertices === model.primitives[1].vertices,
        "Geometry was repacked per instance",
      );
      const p = model.primitives[0],
        first = p.vertices[0];
      assert(first < -0.59 && first > -0.61, "Packed geometry changed");
      const shadows = Shadows.attach(engine, { resolution: 64, distance: 10 });
      shadows.add(model);
      const ssao = SSAO.attach(engine, { samples: 4 });
      ssao.add(model);
      engine.render({ culling: false });
      await device.queue.onSubmittedWorkDone();
      // Two nodes on one geometry merge into one static batch, so one draw and one shadow record.
      assert(
        engine.stats.drawCalls === 1,
        "Packed model did not draw as one batch",
      );
      assert(
        model.shadowPrimitives.length === 1,
        "The two nodes were not merged",
      );
      const validation = await device.popErrorScope();
      assert(!validation, validation?.message);
      window.margoCanvas = canvas;
      const screenshot = canvas.toDataURL();
      await engine.rebootDevice();
      engine.gpu.pushErrorScope("validation");
      engine.render({ culling: false });
      await engine.gpu.queue.onSubmittedWorkDone();
      const restored = await engine.gpu.popErrorScope();
      assert(!restored, restored?.message);
      assert(p.vertices[0] === first, "Device restoration lost CPU geometry");
      model.destroy();
      assert(engine.meshes.size === 0, "Model destruction leaked handles");
      shadows.destroy();
      ssao.destroy();
      engine.dispose();
      canvas.remove();
      results.push({ instances: model.primitives.length, screenshot });
    }
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:256px;height:256px";
    document.body.append(canvas);
    const small = await Engine.create(canvas, {
      backend: "webgpu",
      capacity: 1,
    });
    const bytes = await (await fetch("/fixture-0.margo")).arrayBuffer();
    let failed = false;
    small.store.grow = () => {
      throw new Error("Transform allocation");
    };
    try {
      await parseMargo(small, bytes);
    } catch (error) {
      failed = /Transform allocation/.test(error.message);
    }
    assert(
      failed && small.meshes.size === 0,
      "Capacity failure did not roll back",
    );
    small.dispose();
    canvas.remove();
    const container = document.createElement("div");
    container.style.cssText = "width:256px;height:256px";
    document.body.append(container);
    const stage = await createStage(container, {
      backend: "webgpu",
      capacity: 16,
      controls: false,
      autoStart: false,
    });
    const device = stage.engine.gpu,
      createBuffer = device.createBuffer,
      allocated = [];
    device.createBuffer = function (descriptor) {
      const buffer = createBuffer.call(this, descriptor),
        destroy = buffer.destroy,
        record = { buffer, destroys: 0 };
      allocated.push(record);
      buffer.destroy = function () {
        record.destroys++;
        destroy.call(this);
      };
      return buffer;
    };
    let mounted;
    try {
      mounted = await loadMargo(stage.engine, "/fixture-0.margo");
    } finally {
      device.createBuffer = createBuffer;
    }
    // The geometry once (vertices, indices), the uniform ring, and the static batch the two nodes merge into.
    assert(
      allocated.map((r) => r.buffer.size).join(" ") === "240 12 65536 480 24",
      "Expected one shared vertex/index buffer, one uniform ring and one merged batch",
    );
    assert(
      allocated.every((record) => record.destroys === 0),
      "Model buffers were destroyed before unmount",
    );
    stage.dispose();
    stage.dispose();
    assert(
      allocated.every((record) => record.destroys === 1),
      "Stage disposal did not destroy every model buffer exactly once",
    );
    assert(
      stage.engine.meshes.size === 0 && !container.querySelector("canvas"),
      "Stage disposal leaked handles or owned canvas",
    );
    mounted.destroy();
    assert(
      allocated.every((record) => record.destroys === 1),
      "Model cleanup after unmount destroyed buffers twice",
    );
    container.remove();
    results[0].stageCleanupBuffers = allocated.length;
    const asset = decodeMargo(bytes);
    assert(
      asset.geometry[0][0].vertices.buffer === bytes,
      "Decoder copied geometry",
    );
    return results;
  }, fixtures.length);
  // Animated .margo (real Blender 5.2.3 export): glTF Pro draws it and Animation's GPU skinning and morphs reach
  // Blender's own deformed vertices.
  const animTruth = JSON.parse(
    await readFile("packages/blender/tests/fixtures/anim-truth.json", "utf8"),
  );
  await page.route("**/anim.margo", async (route) =>
    route.fulfill({
      body: await readFile("packages/blender/tests/fixtures/anim.margo"),
      contentType: "application/octet-stream",
    }),
  );
  const animated = await page.evaluate(async (truth) => {
    const { Engine } = await import("/packages/core/dist/index.js");
    const { loadAnimatedMargo } =
      await import("/packages/blender/dist/anim.js");
    const { Animation } = await import("/packages/animation/dist/index.js");
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:256px;height:256px";
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: "webgpu",
      capacity: 64,
      camera: { position: [0, 2, 6], target: [0.5, 1, -2] },
    });
    engine.gpu.pushErrorScope("validation");
    const model = await loadAnimatedMargo(engine, "/anim.margo"),
      animation = Animation.attach(model, { loop: false }), // a looping clip shows its first frame at its end time
      primitive = model.primitives.find((p) => p.deformed),
      count = primitive.vertices.length / 20,
      order = Array.from({ length: count }, (_, v) =>
        truth.rest.findIndex((r) =>
          r.every(
            (x, d) => Math.abs(x - primitive.vertices[v * 20 + d]) < 2e-6,
          ),
        ),
      );
    let worst = 0,
      compared = 0;
    const clips = {};
    for (const [name, frames] of Object.entries(truth.clips))
      for (const seconds of Object.keys(frames).filter(
        (_, i, all) => i % 3 === 0 || i === all.length - 1,
      )) {
        animation.play(name);
        animation.playing = false;
        animation.seek(Number(seconds));
        engine.render({ culling: false });
        const copy = engine.gpu.createBuffer({
            size: primitive.vertices.byteLength,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          }),
          encoder = engine.gpu.createCommandEncoder();
        encoder.copyBufferToBuffer(
          primitive.deformed,
          primitive.deformedOffset ?? 0,
          copy,
          0,
          copy.size,
        );
        engine.gpu.queue.submit([encoder.finish()]);
        await copy.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(copy.getMappedRange()).slice();
        copy.destroy();
        for (let v = 0; v < count; v++)
          for (let d = 0; d < 3; d++) {
            const difference = Math.abs(
              out[v * 20 + d] - frames[seconds][order[v]][d],
            );
            worst = Math.max(worst, difference);
            clips[name] = Math.max(clips[name] ?? 0, difference);
          }
        compared += count;
      }
    const validation = await engine.gpu.popErrorScope();
    animation.destroy();
    model.destroy();
    engine.dispose();
    canvas.remove();
    return {
      worst,
      clips,
      compared,
      matched: !order.includes(-1),
      validation: validation?.message ?? null,
    };
  }, animTruth);
  assert.ok(animated.matched, "Every animated vertex is a Blender vertex");
  assert.equal(animated.validation, null);
  assert.ok(animated.compared > 500, "Too few animated vertices compared");
  assert.ok(
    animated.worst < 1e-4,
    `GPU skinning differs from Blender by ${JSON.stringify(animated.clips)} m`,
  );
  results.push({ animated });
  // Components (real Blender 5.2.3 export): physics bodies move the model's nodes, the sun becomes the engine's
  // light and each script runs once per object that names it.
  await page.route("**/components.margo", async (route) =>
    route.fulfill({
      body: await readFile("packages/blender/tests/fixtures/components.margo"),
      contentType: "application/octet-stream",
    }),
  );
  const components = await page.evaluate(async () => {
    const { Engine } = await import("/packages/core/dist/index.js");
    const { loadMargoComponents } =
      await import("/packages/blender/dist/components.js");
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:256px;height:256px";
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: "webgpu",
      capacity: 64,
      camera: { position: [0, 4, 10], target: [0, 0, 0] },
    });
    engine.gpu.pushErrorScope("validation");
    const ran = [],
      cleaned = [];
    const scene = await loadMargoComponents(engine, "/components.margo", {
      scripts: {
        door: ({ node, properties }) => {
          ran.push(["door", node.name, Object.keys(properties).length]);
          return () => cleaned.push(node.name);
        },
        glow: ({ node, physics }) => void ran.push(["glow", node.name, !!physics]),
      },
    });
    const index = (name) =>
        scene.model.asset.doc.nodes.findIndex((n) => n.name === name),
      crate = scene.model.nodes[index("Crate")];
    const start = crate.position.y;
    for (let i = 0; i < 300; i++) scene.physics.physics.step();
    engine.store.tick(false);
    engine.render({ culling: false });
    const result = {
      start,
      rest: crate.position.y,
      sun: engine.lighting.direction[3],
      lights: scene.model.lights.map((l) => l.type),
      ran,
    };
    scene.dispose();
    result.cleaned = cleaned;
    result.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    engine.dispose();
    canvas.remove();
    return result;
  });
  assert.equal(components.validation, null);
  assert.ok(Math.abs(components.start - 3) < 1e-6, `crate starts at ${components.start}`);
  assert.ok(
    Math.abs(components.rest - 0.5) < 0.01,
    `the crate's node rests at ${components.rest}, not on the floor`,
  );
  assert.equal(components.sun, 3, "the tagged sun's 3 lux must light the engine");
  assert.deepEqual(components.lights, ["point", "directional", "spot"]);
  assert.deepEqual(components.ran, [
    ["door", "Pad", 2],
    ["glow", "Pad", true],
    ["door", "Sun", 3],
  ]);
  assert.deepEqual(components.cleaned, ["Sun", "Pad"]);
  results.push({ components });

  // Node graph baking (real Blender 5.2.3 export): the baked base colour and metallic-roughness images draw. Seen
  // from straight above, the procedural plane's baked red (u) rises from left to right, the baked Diffuse BSDF
  // draws blue like its colour (0.2, 0.5, 0.8) and the direct Principled plane red-brown like (0.6, 0.3, 0.1).
  await page.route("**/bake.margo", async (route) =>
    route.fulfill({
      body: await readFile("packages/blender/tests/fixtures/bake.margo"),
      contentType: "application/octet-stream",
    }),
  );
  const bakedShots = await page.evaluate(async () => {
    const { Engine } = await import("/packages/core/dist/index.js");
    const { loadMargo } = await import("/packages/blender/dist/index.js");
    const { waitForPipelines } = await import("/scripts/support/gpu-ready.js");
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:256px;height:256px";
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: "webgpu",
      capacity: 16,
    });
    engine.gpu.pushErrorScope("validation");
    const model = await loadMargo(engine, "/bake.margo");
    const shots = {};
    // Blender x -3, 0 and 3 (Procedural, Painted, Plain); Blender +Y (the planes' +v) is the engine's -Z.
    for (const [name, x] of [["Procedural", -3], ["Painted", 0], ["Plain", 3]]) {
      engine.camera.position = [x, 2.5, 0];
      engine.camera.target = [x, 0, 0];
      engine.camera.up = [0, 0, -1];
      await waitForPipelines(async () => {
        engine.render({ culling: false });
        await engine.gpu.queue.onSubmittedWorkDone();
      });
      shots[name] = canvas.toDataURL();
    }
    const validation = (await engine.gpu.popErrorScope())?.message ?? null;
    model.destroy();
    engine.dispose();
    canvas.remove();
    return { shots, validation };
  });
  assert.equal(bakedShots.validation, null);
  const shot = async (name) => {
    const bytes = Buffer.from(bakedShots.shots[name].split(",")[1], "base64");
    await writeFile(`test-results/blender/bake-${name}.png`, bytes);
    return decodePNG(bytes);
  };
  /** Mean RGB of the shot over a box given in fractions of its width and height. */
  const mean = (image, x0, x1, y0, y1) => {
    const sum = [0, 0, 0];
    let count = 0;
    for (let y = Math.round(y0 * image.height); y < Math.round(y1 * image.height); y++)
      for (let x = Math.round(x0 * image.width); x < Math.round(x1 * image.width); x++, count++)
        for (let c = 0; c < 3; c++) sum[c] += image.data[(y * image.width + x) * 4 + c];
    return sum.map((s) => s / count);
  };
  // The 2 m plane fills the middle 69% of a 60-degree view from 2.5 m, so x = 0.35 and 0.65 of the width are
  // u = 0.28 and 0.72 on it.
  const procedural = await shot("Procedural"),
    left = mean(procedural, 0.33, 0.37, 0.45, 0.55),
    right = mean(procedural, 0.63, 0.67, 0.45, 0.55);
  assert.ok(
    right[0] > left[0] + 20,
    `the baked base colour's red does not rise with u: left ${left}, right ${right}`,
  );
  const painted = mean(await shot("Painted"), 0.45, 0.55, 0.45, 0.55),
    plain = mean(await shot("Plain"), 0.45, 0.55, 0.45, 0.55);
  assert.ok(
    painted[2] > painted[1] && painted[1] > painted[0],
    `the baked Diffuse BSDF does not draw blue: ${painted}`,
  );
  assert.ok(
    plain[0] > plain[1] && plain[1] > plain[2],
    `the direct Principled plane does not draw red-brown: ${plain}`,
  );
  results.push({ baked: { left, right, painted, plain } });

  // Extended Principled inputs (real Blender 5.2.3 export): with @margoengine/blender/pbr-ext the glass plane
  // (transmission 1) shows the green backdrop behind it; plain loadMargo draws the same plane as white plastic.
  await page.route("**/pbr-ext.margo", async (route) =>
    route.fulfill({
      body: await readFile("packages/blender/tests/fixtures/pbr-ext.margo"),
      contentType: "application/octet-stream",
    }),
  );
  const glassShots = await page.evaluate(async () => {
    const { Engine } = await import("/packages/core/dist/index.js");
    const { loadMargo } = await import("/packages/blender/dist/index.js");
    const { loadMargoPBR } = await import("/packages/blender/dist/pbr-ext.js");
    const { waitForPipelines } = await import("/scripts/support/gpu-ready.js");
    const shots = {};
    for (const [name, load] of [["plain", loadMargo], ["physical", loadMargoPBR]]) {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "width:256px;height:256px";
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: "webgpu",
        capacity: 16,
        camera: { position: [-2, 2, 0.001], target: [-2, 0, 0] },
      });
      engine.camera.up = [0, 0, -1];
      engine.gpu.pushErrorScope("validation");
      const model = await load(engine, "/pbr-ext.margo");
      await waitForPipelines(async () => {
        engine.render({ culling: false });
        await engine.gpu.queue.onSubmittedWorkDone();
      });
      shots[name] = {
        image: canvas.toDataURL(),
        validation: (await engine.gpu.popErrorScope())?.message ?? null,
      };
      model.destroy();
      engine.dispose();
      canvas.remove();
    }
    return shots;
  });
  const glass = {};
  for (const name of ["plain", "physical"]) {
    assert.equal(glassShots[name].validation, null, name);
    const bytes = Buffer.from(glassShots[name].image.split(",")[1], "base64");
    await writeFile(`test-results/blender/pbr-ext-${name}.png`, bytes);
    const image = await decodePNG(bytes),
      sum = [0, 0, 0];
    let count = 0;
    for (let y = Math.round(0.45 * image.height); y < Math.round(0.55 * image.height); y++)
      for (let x = Math.round(0.45 * image.width); x < Math.round(0.55 * image.width); x++, count++)
        for (let c = 0; c < 3; c++) sum[c] += image.data[(y * image.width + x) * 4 + c];
    glass[name] = sum.map((s) => s / count);
  }
  assert.ok(
    glass.physical[1] > glass.physical[0] + 30 && glass.physical[1] > glass.physical[2] + 30,
    `the glass does not show the green backdrop through it: ${glass.physical}`,
  );
  assert.ok(
    Math.abs(glass.plain[0] - glass.plain[1]) < 30,
    `plain loadMargo should draw the glass as white plastic: ${glass.plain}`,
  );
  results.push({ glass });

  // KTX2 textures (real Blender 5.2.3 export compressed in Node by @margoengine/blender/ktx2). Three proofs that the
  // KTX2 sections, not PNGs, reach the GPU: every image goes through the transcoder, the model's 32 x 32 textures are
  // block-compressed formats on an engine that requests the texture-compression features (RGBA8 on one that does not:
  // the "rgba8" run), and a file whose two base colour KTX2 images trade places (the PNG file unchanged) draws the
  // Painted plane with the Procedural plane's gradient. The Painted plane's colour is uniform, which Basis Universal
  // keeps exactly, so the codec's loss is measured on the Procedural plane's gradient.
  const { compressMargo } = await import("../packages/blender/dist/ktx2.js");
  const fixture = await readFile("packages/blender/tests/fixtures/bake.margo");
  const ktx2Files = {
    uastc: await compressMargo(fixture, { mode: "uastc" }),
    etc1s: await compressMargo(fixture, { mode: "etc1s" }),
  };
  {
    // Images 0 and 2 (Procedural and Painted base colour, sections 3 and 5) trade sections in the manifest.
    const swapped = new Uint8Array(ktx2Files.uastc),
      view = new DataView(swapped.buffer),
      at = view.getUint32(68, true),
      text = new TextDecoder().decode(swapped.subarray(at, at + view.getUint32(72, true))),
      a = '{"section":3,"mimeType":"image/ktx2"}',
      b = '{"section":5,"mimeType":"image/ktx2"}';
    assert.ok(text.includes(a) && text.includes(b), "the KTX2 manifest names sections 3 and 5");
    const next = text.replace(a, "\0").replace(b, a).replace("\0", b);
    assert.equal(next.length, text.length);
    swapped.set(new TextEncoder().encode(next), at);
    ktx2Files.swapped = swapped;
  }
  for (const [name, file] of Object.entries(ktx2Files))
    await page.route(`**/bake-${name}.margo`, (route) =>
      route.fulfill({ body: Buffer.from(file), contentType: "application/octet-stream" }),
    );
  const ktx2Shots = await page.evaluate(async () => {
    const { Engine } = await import("/packages/core/dist/index.js");
    const { loadMargo } = await import("/packages/blender/dist/index.js");
    const { loadMargoKTX2 } = await import("/packages/blender/dist/ktx2.js");
    const { KTX2Decoder } = await import("/packages/decoders/dist/index.js");
    const { waitForPipelines } = await import("/scripts/support/gpu-ready.js");
    const shots = {};
    for (const name of ["png", "uastc", "etc1s", "swapped", "rgba8"]) {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "width:256px;height:256px";
      document.body.append(canvas);
      const features = ["texture-compression-bc", "texture-compression-astc", "texture-compression-etc2"];
      const engine = await Engine.create(canvas, { backend: "webgpu", capacity: 16, features: name === "rgba8" ? [] : features });
      engine.gpu.pushErrorScope("validation");
      const decoder = new KTX2Decoder({ device: engine.gpu }),
        transcoded = [];
      const ktx2 = {
        async transcode(data, options) {
          const result = await decoder.transcode(data, options);
          transcoded.push({ format: result.format, width: result.width, levels: result.mipmaps.length });
          return result;
        },
      };
      const model =
        name === "png"
          ? await loadMargo(engine, "/bake.margo")
          : await loadMargoKTX2(engine, `/bake-${name === "rgba8" ? "uastc" : name}.margo`, { ktx2 });
      const shot = { transcoded, frames: {} };
      // The model's own GPU textures: the four 32 x 32 images (1 x 1 textures are empty slots' defaults).
      shot.textures = model.textures
        .filter((t) => t.width === 32)
        .map((t) => ({ format: t.format, levels: t.mipLevelCount }));
      shot.features = ["bc", "astc", "etc2"].filter((f) => engine.gpu.features.has(`texture-compression-${f}`));
      for (const [plane, x] of [["Procedural", -3], ["Painted", 0]]) {
        engine.camera.position = [x, 2.5, 0];
        engine.camera.target = [x, 0, 0];
        engine.camera.up = [0, 0, -1];
        await waitForPipelines(async () => {
          engine.render({ culling: false });
          await engine.gpu.queue.onSubmittedWorkDone();
        });
        shot.frames[plane] = canvas.toDataURL();
      }
      shot.validation = (await engine.gpu.popErrorScope())?.message ?? null;
      model.destroy();
      decoder.dispose();
      engine.dispose();
      canvas.remove();
      shots[name] = shot;
    }
    return shots;
  });
  const ktx2Frames = {};
  for (const [name, shot] of Object.entries(ktx2Shots)) {
    assert.equal(shot.validation, null, `KTX2 check, ${name}`);
    assert.equal(shot.textures.length, 4, `KTX2 check, ${name}: the four baked images reach the GPU`);
    if (name === "png") {
      assert.deepEqual(shot.transcoded, [], "the PNG file transcodes nothing");
      assert.ok(shot.textures.every((t) => t.format.startsWith("rgba8unorm")), JSON.stringify(shot.textures));
    } else {
      assert.equal(shot.transcoded.length, 4, `KTX2 check, ${name}: every image goes through the KTX2 transcoder`);
      if (name === "rgba8")
        assert.ok(
          shot.features.length === 0 && shot.textures.every((t) => t.format.startsWith("rgba8unorm") && t.levels === 6),
          `KTX2 check, rgba8: an engine with no compression features holds RGBA8 with 6 mips: ${JSON.stringify(shot.textures)}`,
        );
      else if (shot.features.length)
        assert.ok(
          shot.textures.every((t) => /^(bc7|astc|etc2)/.test(t.format) && t.levels === 6),
          `KTX2 check, ${name}: the GPU textures are block-compressed with 6 mips: ${JSON.stringify(shot.textures)}`,
        );
    }
    ktx2Frames[name] = {};
    for (const [plane, url] of Object.entries(shot.frames)) {
      const bytes = Buffer.from(url.split(",")[1], "base64");
      await writeFile(`test-results/blender/ktx2-${name}-${plane}.png`, bytes);
      ktx2Frames[name][plane] = await decodePNG(bytes);
    }
  }
  /** Mean absolute RGB difference of two frames, in 255ths. */
  const frameDifference = (a, b) => {
    let total = 0;
    for (let i = 0; i < a.data.length; i += 4)
      for (let c = 0; c < 3; c++) total += Math.abs(a.data[i + c] - b.data[i + c]);
    return total / ((a.data.length / 4) * 3);
  };
  const ktx2Result = { features: ktx2Shots.uastc.features, textures: ktx2Shots.uastc.textures, png: { bytes: fixture.length } };
  for (const name of ["uastc", "etc1s", "swapped", "rgba8"])
    ktx2Result[name] = {
      bytes: (ktx2Files[name] ?? ktx2Files.uastc).length,
      formats: [...new Set(ktx2Shots[name].textures.map((t) => t.format))],
      Procedural: frameDifference(ktx2Frames.png.Procedural, ktx2Frames[name].Procedural),
      Painted: frameDifference(ktx2Frames.png.Painted, ktx2Frames[name].Painted),
    };
  console.log("KTX2 frames:", JSON.stringify(ktx2Result));
  const gradient = (image) => [mean(image, 0.33, 0.37, 0.45, 0.55)[0], mean(image, 0.63, 0.67, 0.45, 0.55)[0]];
  for (const name of ["png", "uastc", "etc1s"]) {
    const [left, right] = gradient(ktx2Frames[name].Procedural);
    assert.ok(right > left + 20, `KTX2 check, ${name}: the Procedural red does not rise with u: ${left}, ${right}`);
  }
  // The swap: the Painted plane now draws the Procedural gradient, so KTX2 bytes (not the PNGs) give its pixels.
  const [swapLeft, swapRight] = gradient(ktx2Frames.swapped.Painted);
  assert.ok(swapRight > swapLeft + 20, `the swapped KTX2 images do not draw: Painted red ${swapLeft}, ${swapRight}`);
  assert.ok(ktx2Result.swapped.Painted > 10, "the swapped KTX2 Painted plane matches the PNG frame");
  assert.ok(ktx2Result.rgba8.Procedural < 1, `UASTC as RGBA8 differs from the PNG frame by ${ktx2Result.rgba8.Procedural}`);
  assert.ok(ktx2Result.uastc.Procedural < 1, `UASTC frame differs from the PNG frame by ${ktx2Result.uastc.Procedural}`);
  assert.ok(ktx2Result.etc1s.Procedural < 4, `ETC1S frame differs from the PNG frame by ${ktx2Result.etc1s.Procedural}`);
  results.push({ ktx2: ktx2Result });

  // Live link (real Blender 5.2.3 session): the add-on serves a red plane, the page draws it, Blender turns it blue
  // and the same margoLive loop draws the blue one.
  if (process.env.MARGO_BLENDER) {
    const blender = spawn(
      process.env.MARGO_BLENDER,
      [
        "--background",
        "--factory-startup",
        "--python-exit-code",
        "1",
        "--python",
        "tools/blender-addon/tests/blender_live.py",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = new Promise((resolve) => blender.on("exit", resolve));
    let output = "";
    const url = await new Promise((resolve, reject) => {
      // A hard bound for Blender to start and listen, which a working run never nears.
      const timer = setTimeout(() => reject(new Error(`Blender's live link did not start: ${output}`)), 120_000);
      blender.stdout.on("data", (chunk) => {
        output += chunk;
        const found = /MARGO_LIVE (\S+)/.exec(output);
        if (found) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
      blender.on("exit", (code) => reject(new Error(`Blender exited ${code} before its live link started: ${output}`)));
    });
    let liveShots;
    try {
      liveShots = await page.evaluate(async (url) => {
        const { Engine } = await import("/packages/core/dist/index.js");
        const { margoLive } = await import("/packages/blender/dist/live.js");
        const { waitForPipelines } = await import("/scripts/support/gpu-ready.js");
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "width:256px;height:256px";
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
          backend: "webgpu",
          capacity: 16,
          camera: { position: [0, 3, 0.001], target: [0, 0, 0] },
        });
        engine.camera.up = [0, 0, -1];
        engine.gpu.pushErrorScope("validation");
        const shots = [];
        for await (const model of margoLive(engine, url, { signal: AbortSignal.timeout(120_000) })) {
          await waitForPipelines(async () => {
            engine.render({ culling: false });
            await engine.gpu.queue.onSubmittedWorkDone();
          });
          shots.push({ image: canvas.toDataURL(), meshes: engine.meshes.size });
          if (shots.length === 2) break;
        }
        const validation = (await engine.gpu.popErrorScope())?.message ?? null;
        const left = engine.meshes.size;
        engine.dispose();
        canvas.remove();
        return { shots, validation, left };
      }, url);
    } catch (error) {
      // Blender waits for the page; a failed page check must not leave it running.
      blender.kill();
      throw error;
    }
    assert.equal(await exited, 0, `Blender's live link script failed: ${output}`);
    assert.equal(liveShots.validation, null);
    assert.equal(liveShots.shots.length, 2, "the page did not get both versions");
    assert.equal(liveShots.left, 0, "the last live model was not disposed when the loop ended");
    const colours = [];
    for (const [i, shot] of liveShots.shots.entries()) {
      const bytes = Buffer.from(shot.image.split(",")[1], "base64");
      await writeFile(`test-results/blender/live-${i + 1}.png`, bytes);
      const image = await decodePNG(bytes),
        p = (Math.round(image.height / 2) * image.width + Math.round(image.width / 2)) * 4;
      colours.push([...image.data.subarray(p, p + 3)]);
    }
    assert.ok(colours[0][0] > colours[0][2] + 40, `version 1 is not red: ${colours[0]}`);
    assert.ok(colours[1][2] > colours[1][0] + 40, `the edited version is not blue: ${colours[1]}`);
    assert.equal(liveShots.shots[1].meshes, liveShots.shots[0].meshes, "the old version was not disposed");
    results.push({ live: { colours } });
  }


  // Lights and cameras (real Blender 5.2.3 export): the scene opens through Blender's scene camera, its sun lights
  // the engine at Blender's strength (exposure 1/683 undoes the lumens-per-watt conversion) from Blender's direction,
  // and the red cube Blender frames fills the middle of the picture.
  const sceneTruth = JSON.parse(
    await readFile("packages/blender/tests/fixtures/scene-truth.json", "utf8"),
  );
  await page.route("**/scene.margo", async (route) =>
    route.fulfill({
      body: await readFile("packages/blender/tests/fixtures/scene.margo"),
      contentType: "application/octet-stream",
    }),
  );
  const framed = await page.evaluate(async () => {
    const { Engine } = await import("/packages/core/dist/index.js");
    const { loadMargoComponents } =
      await import("/packages/blender/dist/components.js");
    const { waitForPipelines } = await import("/scripts/support/gpu-ready.js");
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:320px;height:240px";
    document.body.append(canvas);
    const engine = await Engine.create(canvas, { backend: "webgpu", capacity: 64 });
    engine.gpu.pushErrorScope("validation");
    const scene = await loadMargoComponents(engine, "/scene.margo", { exposure: 1 / 683 });
    await waitForPipelines(async () => {
      engine.render({ culling: false });
      await engine.gpu.queue.onSubmittedWorkDone();
    });
    const result = {
      image: canvas.toDataURL(),
      position: [...engine.camera.position],
      target: [...engine.camera.target],
      fov: engine.camera.fov,
      sun: [...engine.lighting.direction],
      cameras: scene.model.cameras.length,
    };
    scene.dispose();
    result.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    engine.dispose();
    canvas.remove();
    return result;
  });
  assert.equal(framed.validation, null);
  assert.equal(framed.cameras, 2);
  const view = sceneTruth.cameras.View,
    sunTruth = sceneTruth.lights.Sun.direction;
  framed.position.forEach((v, i) =>
    assert.ok(Math.abs(v - view.position[i]) < 1e-4, `camera at ${framed.position}, Blender's at ${view.position}`),
  );
  const look = framed.target.map((v, i) => v - framed.position[i]),
    length = Math.hypot(...look);
  look.forEach((v, i) =>
    assert.ok(Math.abs(v / length - view.forward[i]) < 1e-4, `camera looks along ${look}, Blender's ${view.forward}`),
  );
  assert.ok(
    Math.abs(framed.fov - (2 * Math.atan(1 / view.projection[1][1]) * 180) / Math.PI) < 1e-3,
    `camera fov ${framed.fov}`,
  );
  // engine.lighting.direction points toward the light: the opposite of where the sun shines.
  sunTruth.forEach((v, i) =>
    assert.ok(Math.abs(framed.sun[i] + v) < 1e-4, `sun toward ${framed.sun}, Blender's sun shines along ${sunTruth}`),
  );
  assert.ok(Math.abs(framed.sun[3] - 3) < 1e-4, `the 3 W/m2 sun lights the engine at ${framed.sun[3]}`);
  {
    const bytes = Buffer.from(framed.image.split(",")[1], "base64");
    await writeFile("test-results/blender/scene-framed.png", bytes);
    const image = await decodePNG(bytes),
      p = (Math.round(image.height / 2) * image.width + Math.round(image.width / 2)) * 4,
      [r, g, b] = image.data.subarray(p, p + 3);
    assert.ok(r > g + 40 && r > b + 40, `the middle of Blender's framing is not the red cube: ${[r, g, b]}`);
    framed.middle = [r, g, b];
    delete framed.image;
  }
  results.push({ framed });

  for (let i = 0; i < results.length; i++) {
    if (results[i].animated || results[i].components || results[i].baked || results[i].glass || results[i].live || results[i].framed || results[i].ktx2) continue;
    const screenshot = Buffer.from(
        results[i].screenshot.split(",")[1],
        "base64",
      ),
      image = await decodePNG(screenshot);
    let colorful = 0;
    for (let p = 0; p < image.data.length; p += 4)
      if (
        Math.max(...image.data.subarray(p, p + 3)) -
          Math.min(...image.data.subarray(p, p + 3)) >
        30
      )
        colorful++;
    assert.ok(colorful > 100, "Textured .margo produced no colored pixels");
    await writeFile("test-results/blender/render-" + i + ".png", screenshot);
    delete results[i].screenshot;
    results[i].colorfulPixels = colorful;
  }
  await page.goto("http://127.0.0.1:5193/examples/blender-loader/index.html");
  await page.waitForFunction(
    () =>
      !document.querySelector("#file").disabled &&
      document.querySelector("canvas").width > 1,
  );
  await page
    .locator("#file")
    .setInputFiles({
      name: "fixture.margo",
      mimeType: "application/octet-stream",
      buffer: fixtures[0],
    });
  await page.waitForFunction(
    () =>
      document.querySelector("#status").textContent !==
      "Choose a .margo file exported from Blender.",
  );
  assert.match(await page.locator("#status").innerText(), /2 objects/);
  await page
    .locator("#viewport")
    .screenshot({ path: "test-results/blender/viewer.png" });
  await page
    .locator("#file")
    .setInputFiles({
      name: "invalid.margo",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("invalid"),
    });
  await page.waitForFunction(() =>
    document
      .querySelector("#status")
      .textContent.includes("Invalid .margo size"),
  );
  assert.deepEqual(errors, []);
  await writeFile(
    "test-results/modern-blender.json",
    JSON.stringify({ hardware, results }, null, 2),
  );
  console.log(JSON.stringify({ hardware, results }, null, 2));
} finally {
  await browser.close();
}
