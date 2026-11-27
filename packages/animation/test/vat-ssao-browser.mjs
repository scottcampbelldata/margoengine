// Real-GPU proof that SSAO darkens a VATCrowd, a SkinnedCrowd and a MorphedCrowd (gap row 138): `ssao.add(crowd)`
// makes the crowd an SSAO source, so
// it writes its normal, depth and ambient light into SSAO's G-buffer pass. The crowd here is a floor (a hand-built
// one-frame VAT quad facing up) with a core box standing on it: next to the box's foot the crowd's floor is darker
// with the source added than without it, and far from the box it keeps its ambient light (nothing is taken out where
// nothing occludes). Without the source the crowd's pixels are left as drawn. The skinned floor's bind pose sits 0.5
// below y = 0 and its one bone lifts it; the morphed floor sits 1 below, its bone lifts 0.5 and its live target the
// other 0.5, so the occlusion pass matches the core floor only if it skins and morphs as the beauty pass does.
// Run from the repository root after building packages, with a hard limit:
//   node scripts/run-with-timeout.mjs run --max=5 -- node packages/animation/test/vat-ssao-browser.mjs
// (MARGO_COMPAT=1 for the WebGL2 compatibility layer).
import assert from "node:assert/strict";
import { openBrowser } from "../../../scripts/browser.js";
import { compatRun } from "../../../scripts/support/compat-shim.js";
import { closeAll } from "../../../scripts/support/shutdown.mjs";

const compat = compatRun();
const browser = await openBrowser({ startPath: "/tests/modern-game.html" }),
  { page } = browser,
  pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});

try {
  for (const kind of ["vat", "skinned", "morphed"]) {
  const report = await page.evaluate(async (kind) => {
    const { EngineKernel, Camera, box, PbrMaterial } =
      await import("/packages/core/dist/index.js");
    const { SSAO } = await import("/packages/post/dist/ssao.js");
    const { Clustered } = await import("/packages/clustered/dist/index.js");
    const { VATCrowd } = await import("/packages/animation/dist/vat.js");
    const { SkinnedCrowd } = await import(
      "/packages/animation/dist/instanced-skin.js"
    );
    const { MorphedCrowd } = await import(
      "/packages/animation/dist/instanced-morph.js"
    );
    const { waitForPipelines } = await import("/scripts/support/gpu-ready.js");
    // A 12 x 12 floor at y = 0 facing +y (counter-clockwise seen from above), both rows the same pose.
    const corners = [
      [-6, 6],
      [6, 6],
      [6, -6],
      [-6, -6],
    ];
    const vat = {
      vertexCount: 4,
      rows: 2,
      width: 16,
      texels: new Float32Array(64),
      uvs: new Float32Array(8),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      clips: [{ name: "still", start: 0, frames: 1, duration: 1, loop: true }],
    };
    for (let row = 0; row < 2; row++)
      for (let v = 0; v < 4; v++) {
        vat.texels.set(
          [corners[v][0], 0, corners[v][1], 1],
          (row * 8 + v * 2) * 4,
        );
        vat.texels.set([0, 1, 0, 0], (row * 8 + v * 2 + 1) * 4);
      }
    // The same floor as a one-bone bake (two identical rows, texels 0 to 5, the bone lifting by 0.5) and as a bake
    // with one live target "lift" (entry texel 6 pointing at the offsets from texel 8, two texels per vertex).
    const bindY = kind === "morphed" ? -1 : -0.5;
    const bones = {
      bones: 1,
      rows: 2,
      width: 16,
      texels: new Float32Array(64),
      vertexCount: 4,
      vertices: new Float32Array(24),
      joints: new Uint32Array(32),
      weights: new Float32Array(32),
      indices: vat.indices,
      uvs: vat.uvs,
      clips: vat.clips,
    };
    for (let row = 0; row < 2; row++)
      for (let k = 0; k < 3; k++) {
        const t = [0, 0, 0, 0];
        t[k] = 1;
        if (k === 1) t[3] = 0.5;
        bones.texels.set(t, (row * 3 + k) * 4);
      }
    for (let v = 0; v < 4; v++) {
      bones.vertices.set([corners[v][0], bindY, corners[v][1], 0, 1, 0], v * 6);
      bones.weights[v * 8] = 1;
    }
    const morphBake = {
      ...bones,
      morphs: {
        names: ["lift"],
        weights: new Float32Array([1]),
        vertices: new Uint32Array(16),
        blocks: 1,
      },
    };
    morphBake.texels.set([8, 0, 0, 0], 6 * 4);
    for (let v = 0; v < 4; v++) {
      morphBake.texels.set([0, 0.5, 0, 0], (8 + v * 2) * 4);
      morphBake.morphs.vertices.set([6, 1, v, 0], v * 4);
    }
    const make = (engine) =>
      kind === "vat"
        ? VATCrowd.attach(engine, vat, { roughness: 0.9 })
        : kind === "skinned"
          ? SkinnedCrowd.attach(engine, bones, { roughness: 0.9 })
          : MorphedCrowd.attach(engine, morphBake, { roughness: 0.9 });
    const problems = [];
    const shoot = async (mode) => {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "width:128px;height:96px";
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: "webgpu",
        exactSize: [128, 96],
        capacity: 16,
        camera: { position: [0, 3, 4], target: [0, 0.4, 0] },
      });
      engine.stop?.();
      engine.gpu.addEventListener("uncapturederror", (e) =>
        problems.push(e.error.message),
      );
      // The key light from below the floor: the floor's light is the hemisphere fill SSAO takes out.
      engine.lighting.direction.set([0, 1, 0, 1]);
      const crowd = make(engine);
      if (!mode.startsWith("core")) crowd.add();
      else
        engine
          .createMesh()
          .setGeometry(box(12, 0.01, 12))
          .setPosition([0, -0.005, 0])
          .setMaterial(new PbrMaterial({ color: "#ffffff", roughness: 0.9 }));
      engine
        .createMesh()
        .setGeometry(box(1, 1, 1))
        .setPosition([0, 0.52, 0])
        .setMaterial(new PbrMaterial({ color: "#c0c0c0", roughness: 0.6 }));
      if (mode !== "none" && mode !== "core") {
        const ssao = SSAO.attach(engine, { radius: 1.5 });
        if (mode === "source" || mode === "lit") ssao.add(crowd);
        // With a lighting effect the occlusion shader binds the effect's group too.
        if (mode === "lit") Clustered.attach(engine).add(crowd);
      }
      await waitForPipelines(async () => {
        engine.render({ delta: 1 / 60 });
        await engine.gpu.queue.onSubmittedWorkDone();
      });
      engine.render({ delta: 1 / 60 });
      const bitmap = await createImageBitmap(canvas);
      const read = new OffscreenCanvas(128, 96).getContext("2d");
      read.drawImage(bitmap, 0, 0);
      const px = read.getImageData(0, 0, 128, 96).data;
      // The mean brightness of the floor in a small window, the window's top left at x, y.
      const mean = (x, y) => {
        let sum = 0;
        for (let j = 0; j < 4; j++)
          for (let i = 0; i < 4; i++) {
            const k = ((y + j) * 128 + x + i) * 4;
            sum += px[k] + px[k + 1] + px[k + 2];
          }
        return sum / 48;
      };
      // Find the box's bottom edge in the centre column: the first row from the bottom that is not floor.
      const out = {
        foot: 0,
        far: mean(4, 88),
        centre: [...px.slice((48 * 128 + 64) * 4, (48 * 128 + 64) * 4 + 3)],
      };
      crowd.dispose();
      engine.dispose();
      canvas.remove();
      return { ...out, px: Array.from(px) };
    };
    // Two views in one frame, the scene seen from opposite sides: each view's SSAO must use its own view matrix, so the
    // crowd's frame matches the same two views of a core floor.
    const twoViews = async (core = false) => {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "width:256px;height:96px";
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: "webgpu",
        exactSize: [256, 96],
        capacity: 16,
      });
      engine.stop?.();
      engine.gpu.addEventListener("uncapturederror", (e) =>
        problems.push(e.error.message),
      );
      engine.lighting.direction.set([0, 1, 0, 1]);
      const crowd = make(engine);
      if (core)
        engine
          .createMesh()
          .setGeometry(box(12, 0.01, 12))
          .setPosition([0, -0.005, 0])
          .setMaterial(new PbrMaterial({ color: "#ffffff", roughness: 0.9 }));
      else crowd.add();
      engine
        .createMesh()
        .setGeometry(box(1, 1, 1))
        .setPosition([0, 0.52, 0])
        .setMaterial(new PbrMaterial({ color: "#c0c0c0", roughness: 0.6 }));
      SSAO.attach(engine, { radius: 1.5 }).add(crowd);
      const views = [
        {
          camera: new Camera({ position: [0, 3, 4], target: [0, 0.4, 0] }),
          viewport: [0, 0, 0.5, 1],
        },
        {
          camera: new Camera({ position: [0, 3, -4], target: [0, 0.4, 0] }),
          viewport: [0.5, 0, 0.5, 1],
        },
      ];
      await waitForPipelines(async () => {
        engine.render({ views, delta: 1 / 60 });
        await engine.gpu.queue.onSubmittedWorkDone();
      });
      engine.render({ views, delta: 1 / 60 });
      const bitmap = await createImageBitmap(canvas);
      const read = new OffscreenCanvas(256, 96).getContext("2d");
      read.drawImage(bitmap, 0, 0);
      const px = read.getImageData(0, 0, 256, 96).data;
      crowd.dispose();
      engine.dispose();
      canvas.remove();
      return { px: Array.from(px) };
    };
    return {
      views: await twoViews(),
      coreViews: await twoViews(true),
      core: await shoot("core"),
      coreSSAO: await shoot("coreSSAO"),
      none: await shoot("none"),
      ssao: await shoot("ssao"),
      source: await shoot("source"),
      lit: await shoot("lit"),
      problems,
    };
  }, kind);
  assert.deepEqual(report.problems, [], "no GPU validation errors");
  assert.deepEqual(pageErrors, [], "no page errors");
  // The floor right in front of the box's foot: scan the centre column up from the bottom edge for the box.
  const lum = (shot, x, y) => {
    const k = (y * 128 + x) * 4;
    return shot.px[k] + shot.px[k + 1] + shot.px[k + 2];
  };
  const floor = lum(report.none, 64, 92);
  let edge = 92;
  while (edge > 10 && Math.abs(lum(report.none, 64, edge) - floor) < 30) edge--;
  const near = (shot) => {
    let sum = 0;
    for (let y = edge + 2; y < edge + 6; y++)
      for (let x = 60; x < 68; x++) sum += lum(shot, x, y);
    return sum / 32 / 3;
  };
  const rows = {
    edge,
    none: near(report.none),
    ssao: near(report.ssao),
    source: near(report.source),
    core: near(report.core),
    coreSSAO: near(report.coreSSAO),
    lit: near(report.lit),
  };
  let viewsWorst = 0;
  for (let k = 0; k < report.views.px.length; k++)
    if (k % 4 !== 3)
      viewsWorst = Math.max(
        viewsWorst,
        Math.abs(report.views.px[k] - report.coreViews.px[k]),
      );
  // The crowd and a core floor differ only along the box's silhouette (multisampled edge pixels), as much in one view
  // as in two; a view drawn with another view's matrix differs across the whole floor.
  let singleWorst = 0;
  for (let k = 0; k < report.source.px.length; k++)
    if (k % 4 !== 3)
      singleWorst = Math.max(
        singleWorst,
        Math.abs(report.source.px[k] - report.coreSSAO.px[k]),
      );
  console.log(
    JSON.stringify({
      kind,
      ...rows,
      views: viewsWorst,
      single: singleWorst,
      far: [report.none.far, report.ssao.far, report.source.far],
    }),
  );
  assert.ok(floor > 30, `the crowd floor draws: ${floor}`);
  assert.ok(edge > 20 && edge < 88, `the box's foot is in view: row ${edge}`);
  assert.ok(
    Math.abs(rows.ssao - rows.none) <= 1,
    "SSAO without the source leaves the crowd as drawn",
  );
  assert.ok(
    rows.none - rows.source > 3,
    `SSAO darkens the crowd at the box's foot: ${rows.none} -> ${rows.source}`,
  );
  // A core floor in the same place is darkened by the same SSAO: the crowd's ambient and normal match core's.
  assert.equal(
    rows.core,
    rows.none,
    "the core floor draws as the crowd floor does",
  );
  assert.ok(
    Math.abs(rows.coreSSAO - rows.source) <= 1,
    `the crowd darkens as a core floor does: core ${rows.coreSSAO}, crowd ${rows.source}`,
  );
  assert.ok(
    Math.abs(report.source.far - report.none.far) <= 2,
    `far from the box the crowd keeps its ambient light: ${report.none.far} -> ${report.source.far}`,
  );
  assert.ok(
    viewsWorst <= singleWorst + 2,
    `two views in one frame each keep their own SSAO view, as a core floor does: ${viewsWorst}`,
  );
  assert.equal(
    rows.lit,
    rows.source,
    "a clustered effect with no lights in range changes nothing",
  );
  console.log(`vat-ssao ${kind}: PASS on ${compat ? "WebGL2 layer" : "WebGPU"}`);
  }
} finally {
  await closeAll({ browser });
}
