# Material wireframe verification

Verified 2026-10-17. Implementation stays in optional materials, gltf-pro, shadows, clustered and staging packages.
Wireframe changes no core or stage source. After rebasing upstream Euler lane-view maintenance (`5e92092`), the
combined core + stage measurement is 21,094 bytes gzip (50,155 raw), below the strict 25,000-byte ceiling.

`Material({wireframe: true})` fixes the flag at construction. Native `PBRMaterial.wireframe` is live. Each source
triangle contributes `[a,b,b,c,c,a]` indices, including shared edges; deduplicating those edges changes transparent
alpha accumulation. Native lines have one-pixel width and ignore triangle side culling and polygon bias.

The cached edge buffer belongs to its device's draw resource. Beauty, G-buffer, ambient, occlusion, transparent,
transmission, capture and forward-device draws select it without changing the source geometry. Directional,
external local, integrated clustered local and contact shadow consumers select matching line pipelines. Automatic
shadow caches follow topology/index/count changes, including a toggle back to a previously used index buffer.
Explicit directional `{static: true}` registration retains its documented `Shadows.invalidate()` policy.

Picking, CPU snapshots and glTF export retain filled triangles. Groups, mirrored static batches, instancing and
deformation preserve their existing vertex buffers. Edge buffers allocate lazily and survive warm toggles, then
release on device restoration, progressive resource replacement or disposal.

## Focused verification

- Before implementation, native and public API tests failed against the previous distribution for missing line
  topology, edge counts, boolean validation and flags. Six new shadow tests also failed for the expected missing
  topology and cache refresh behavior. The GPU fixture captured filled interiors against independent line references.
- The combined focused command passes 73 tests: native/public wireframe and all directional, local and contact
  shadow suites. Independent shadow-only verification passes 62 tests.
- Progressive/native verification passes 36 tests. Three new regressions first failed against the old distribution:
  placeholder replacement must release cached edges, texture swaps must retain the live flag, and a disposal
  exception must still release edges and newly allocated replacement uniforms. Main/worker and range/plain
  progressive loading tests remain green.
- Strict TypeScript checks pass for all 74 packages; the API report contains 173 entries and 1,782 exports.
- Touched-package hygiene has no new violations compared with the preceding material render-state commit.

## Physical GPU verification

`node scripts/material-wireframe-gpu-check.js` passes 249 checks with 60 beauty captures and 24 shadow cases on
physical NVIDIA Ampere hardware (`fallback=false`), at actual 1x and 4x MSAA. Page, engine and WebGPU validation
error lists are empty. Results are written to ignored `test-results/material-wireframe/gpu.json`.

The fixture uses separately authored explicit line geometry and literal per-triangle edge indices as references.
Whole attachment hashes match for native/public materials, nonindexed meshes, mirrored nodes/instances, groups,
color maps, alpha masks, deformed buffers, ordinary transparency and physical tint. A deduplicated control visibly
changes shared-edge alpha, proving the reference retains duplicates. Warm native toggles allocate no new buffers,
textures, samplers, bind groups or pipelines after both states have been exercised.

Actual directional, external local, integrated local and contact shadow attachments match independently supplied
line-caster indices for native, grouped and instanced/deformed cases at both sample counts. Disabling the native
flag produces filled shadow pixels; enabling it restores the exact edge-shadow hash.

GPU pixel comparisons cover beauty and the four shadow consumers. Auxiliary/forward-device draws have unit
coverage; OIT, transmission-hook and capture integration were checked in source through their shared draw path.
Shadow references reuse the existing alpha metadata and establish edge connectivity rather than independently
validating that metadata. Independent reviews found the progressive issues above; review is clear after their fixes.

## Main integration gates

The final `npm run check:merge` exits 0: all 2,487 Node tests, all 15 current proofs, the site build and all 55
hardware-matched visual comparisons pass. Original visual references are unchanged. The seven additional
`verify:full` package/interop checks also exit 0, including 163 Node tests and strict consumers of all 74 packaged
modules. Logs remain under ignored `test-results/wireframe-*.log`. Core and stage source files are unchanged.
The physical-GPU fixture and all seven packaged-consumer checks were rerun successfully after the upstream rebase.
