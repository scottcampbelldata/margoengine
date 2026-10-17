# The FlightHelmet goggle compare

Date: 2026-10-16. The pixel compare in `scripts/test-helmet-streaming.js` now passes on Edge 155 with a physical NVIDIA RTX A6000, at commit `05d9cf1`. Streamed and direct desktop loads are identical with SSAO off and on. The original Arc 140V configuration has not been rechecked.

## What the open note recorded

On 2026-10-15 the public helmet changed from DamagedHelmet to FlightHelmet. DamagedHelmet has no `KHR_materials_transmission`, so this step had never run on glass. The streaming cases in `scripts/test-helmet-streaming.js` passed. The full-detail parity step failed.

That step takes two captures of the same desktop file, `examples/assets/flight-helmet.glb`, from `examples/flight-helmet.html?quality=high`, with SSAO off and on:

- **Streamed.** The page loads `flight-helmet-mobile.glb`, then loads the desktop file, registers it with SSAO, and disposes the preview (`examples/extension-demo.ts`). The lenses showed the stand through the glass.
- **Direct.** The test serves the desktop file at the mobile URL and aborts the real desktop request. The first model is already the full helmet, and nothing transmissive is disposed. About 320 pixels differed, with a max channel difference of 165–171. The lenses were black.

The test requires the two PNG buffers to be identical. `test-results/helmet-streamed-full-ao-*.png` and `test-results/helmet-direct-full-ao-*.png` are the captures.

## What was fixed beside it

HANDOFF 5w.f fixed a gallery bug with the same symptom and a different shape. On Edge, an Arc 140V, D3D12, and 4x MSAA, a blend constant read as 0, so every transmissive surface drew its own color over black. `@margoengine/gltf-pro` now draws transmission twice, without that constant: `margoTint` multiplies the background, then the lit surface adds. The comment is on the draw in `packages/gltf-pro/src/index.ts`.

That bug blacked out both loads whenever it applied. The streaming failure had one correct image and one black image, so it is a separate report. After 5w.f, `examples/assets/khronos/README.md` says the source FlightHelmet in the gallery matches, and the background shows through the tint. That row is the source glTF in `examples/khronos-gallery.html`. It does not run the demo's two load orders, and it does not compare pixels between them.

## Verification on 2026-10-16

After waiting for the other GPU job to release its lock, this command exited 0:

```sh
node scripts/gpu-lock.mjs run --owner=codex-helmet-streaming -- node scripts/test-helmet-streaming.js
```

The run used Edge `155.0.4283.60` on Windows, with WebGPU reporting NVIDIA Ampere and `fallback: false`. The report in `test-results/helmet-streaming.json` records `changedChannels: 0` for the full-detail comparison with SSAO both off and on. The successful upgrade, failed-detail fallback, Android layout and pagehide cleanup checks also passed. No renderer, core or stage code changed for this verification.

This establishes parity on the tested adapter. It does not establish which change resolved the original failure or prove the original Arc 140V/D3D12 configuration passes. HANDOFF's load/dispose sorting explanation remains a hypothesis. The paths also differ in when the full model first renders relative to SSAO attachment: the direct model renders before attachment, while the upgraded model first renders afterward.

The separate `node scripts/csp-check.mjs` check was not re-run as part of this verification.

## Re-run

On AC power, with the GPU lock:

```
node scripts/gpu-lock.mjs run --owner=helmet-streaming -- node scripts/test-helmet-streaming.js
```

The script opens `/examples/flight-helmet.html` itself. A pass writes `test-results/helmet-streaming.json` and the parity result `changedChannels: 0`. A failure writes `test-results/helmet-streaming-failure.json` and leaves the two pairs of PNGs. Compare the goggle pixels in `helmet-direct-full-ao-false.png` with `helmet-streamed-full-ao-false.png` before changing the renderer.

## What to say

The demo's cold desktop load and its preview-then-upgrade path produce identical pixels with SSAO off and on in the 2026-10-16 Edge/NVIDIA run. The gallery's separate visual claim remains documented in the Khronos README. The original Arc 140V configuration still needs a rerun before claiming parity there.
