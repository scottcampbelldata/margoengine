# Core parity hooks implementation plan

> **For agentic workers:** Use the native implementation workflow task by task, with independent review of the final changes. Steps use checkbox syntax for tracking.

**Goal:** Implement the three approved core hooks while preserving ordinary rendering and the strict gzip ceiling.

**Architecture:** Camera selection belongs in Engine update/render and restores its primary view without replaying simulation. Colored ambient extends the canonical frame's tail and its consumers. Viewport/scissor belong to individual core draw calls.

**Tech stack:** TypeScript, Rust/Wasm transform kernel, WGSL, WebGPU/WebGL2, Node tests and browser pixel tests.

**Spec:** [Three core parity hooks](../specs/2026-10-16-core-parity-hooks-design.md).

## Global constraints

- Combined core + stage gzip must be strictly below 25,000 bytes; measure after each hook.
- The user's freeze exception covers only these three hooks. Do not change the stage facade implementation or add a second renderer stack.
- New camera/ambient/rectangle options must preserve default rendering and optional-package composition.
- Use the shared main-checkout GPU lock for every GPU run; preserve the main checkout's unrelated parity edits.

## Review focus

- Opposing camera frusta with shared geometry: restore visibility and pending instance uploads immediately.
- Failures and recursive renders: restore primary state without a second simulation callback.
- Canonical frame users with private buffers: keep offsets and buffer sizes compatible.
- SSAO/IBL/Sky ambient replacements: preserve the intended ambient contribution and baseline pixels.
- Successive rectangle passes and frames: reset backend state and preserve whole-target clear semantics.

## Task 1: Camera option

**Files:** `packages/core/src/engine.ts`, `packages/core/src/api.ts`, new `tests/core-parity-hooks.test.js`.

**Interface:** `render({camera?: Camera, culling?: boolean, delta?: number} = {})`.

- [x] Establish clean built baseline and baseline core + stage gzip.
- [x] Add failing tests for selected-camera culling, primary restoration, repeated frames, errors, callback counts, invalid cameras and orthographic/culling-disabled paths.
- [x] Implement selected-camera update plus restoration without duplicate simulation. Reject reentrant rendering.
- [x] Run focused tests and measure gzip; stop before hook 2 if the exclusive limit cannot be met.

## Task 2: Ambient RGB

**Files:** core `engine.ts`, `renderer.ts`, `shaders.ts`; canonical shared frame in `packages/shared/gpu.js`; canonical-frame buffer owners in selection, culling, XR, scatter and environment; SSAO/Sky ambient replays; relevant behavioral and shader-contract tests.

**Interface:** optional `Lighting.ambient` RGB multipliers; white fallback; unchanged `radiance[3]` intensity.

- [x] Add failing default-white, colored upload, scalar compatibility, validation and canonical-frame consumer tests.
- [x] Append RGB to canonical frame and update all producers/consumers that use that frame, preserving the 112-byte prefix and optional shader hook anchors.
- [x] Verify SSAO/IBL/Sky/Toon/shadow composition; keep unrelated optional material models unchanged.
- [x] Run focused tests and measure gzip; stop before hook 3 if the exclusive limit cannot be met.

## Task 3: Draw rectangles

**Files:** core `plugin.ts`, `renderer.ts`; WebGL `src/index.ts`; new rectangle regressions and WebGL test coverage.

**Interface:** independent optional `[x,y,width,height]` tuples on `DrawOptions.viewport` and `.scissor`.

- [x] Add failing tests for command placement, independent rectangles, invalid input, resets, clear/load/MSAA behavior, and WebGL coordinate conversion.
- [x] Implement validation and per-pass state on both backends, leaving absent rectangles implicit where required.
- [x] Run focused tests and measure gzip.

## Task 4: Integration and evidence

**Files:** core README/API reports, a focused real-GPU hook regression script and fixture, final verification record.

- [x] Document camera sequencing, ambient scope and rectangle/clear/aspect/picking limitations.
- [x] Build packages, run strict types, update and verify API reports, run the full Node suite.
- [x] Under the shared GPU lock, validate alternate-view pixels/restoration, ambient channel response/default parity, and two successive rectangle draws. Rerun the existing helmet regression.
- [x] Request an independent code review, resolve actionable findings, and record final gzip and test evidence.

## Progress

- Approved by user: all three core hooks are a freeze exception under the strict size limit.
- Work isolated on `codex/core-parity-hooks`; main checkout's parity documents are untouched.
- Baseline: package build and 56 core tests pass; 20,282 bytes gzip.
- Task 1: nine new cases observed failing before implementation; focused 16 and core 56 pass. Compacted core + stage: 20,407 bytes gzip (+125).
- Task 2: new RGB/default/validation/replay regressions observed failing; focused compatibility 137 and combined camera/ambient 15 pass. Compacted core + stage: 20,486 bytes gzip (+79).
- Task 3: 15 of 17 rectangle regressions observed failing before implementation; rectangle 17, combined focused 46 and core 56 pass. Final core + stage: 20,641 bytes gzip (+155).
- Integration: complete build, 74 strict typechecks, matching API reports, 2,266 full-suite tests with zero failures/skips, and five physical GPU groups pass. Independent review has no actionable findings. See `docs/core-parity-hooks-verification.md` for scope and evidence.
