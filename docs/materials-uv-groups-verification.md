# Materials UV1 and geometry groups: verification

Date: 2026-10-16. Implemented on `codex/materials-uv1-groups`, based on `6a57389`, in the existing isolated worktree.
The user approved the additive API before implementation. These results describe the modified source tree; the
[portable record](../benchmarks/materials-uv-groups-2026-10-16.json) includes its source hashes.

## Delivered behavior

- `MeshGeometry.uvs1` supplies independent UV1 coordinates in the existing 80-byte vertex layout. Omitted UV1 copies
  UV0. `Material.setUVTransform({texCoord: 1}, slot)` selects it per map and stays live.
- `createMesh` and `createInstancedMesh` accept material arrays. Nonempty, nonoverlapping triangle `groups` select
  material indices and ranges. Each range becomes a primitive under one model/root; vertices, GPU vertex buffers and
  instance state are shared. Scalar material calls still draw the whole geometry.
- Local material shading composes before model-wide effects, keeping group shaders, textures and live factors
  separate. Mixed opaque/blended models join the materials queue's respective phases, including opaque-color
  capture deferral. Material-array snapshots are readonly; their materials remain live.
- glTF/GLB export retains UV1, UV selection/transforms, group materials, textures and instancing. Referenced all-zero
  UV sets survive export. Roundtrips pass Khronos validation.

Normal maps exposed an existing derivative-frame error: WebGPU's screen orientation inverted the frame, and a fixed
normalization floor weakened it at higher pixel densities. Both compact and extended glTF-pro shaders now correct
the orientation and normalize without that floor; authored tangent handling is unchanged. The exact shader
fingerprints in existing regression tests were updated deliberately, retaining their frame, binding and allocation
assertions. Missing normal maps use an exactly neutral half-float texel. Matcap bindings remain present in auxiliary
passes, including SSAO.

## Validation

| Check | Result |
| --- | --- |
| Complete package build and Node suite (`npm run test:all`) | **2,291 passed; zero failures, skips or TODOs** |
| Strict TypeScript | All 74 packages passed |
| API reports | 173 entries / 1,777 exports match |
| Physical GPU feature checks | **14 checks / 17 captures passed**, zero page/GPU validation errors |
| Device restoration | Different GPU device; zero changed image channels |
| Helmet regression | All five cases passed; direct/streamed pixels identical with SSAO off/on |
| Independent review | No remaining actionable findings |
| Core + stage | **20,641 bytes gzip**, unchanged; strictly below 25,000 |
| Source integrity | Core and stage source unchanged; `git diff --check` passed |

GPU checks used physical NVIDIA RTX A6000 / Ampere, Edge `155.0.4283.60`, with no software fallback. UV0 sampled
red `[255,0,0]`; independent UV1 sampled blue `[0,0,255]`. A tilted normal gave `[128,218,218]` with authored UV0
tangents and `[128,37,218]` with mirrored UV1, verifying the tangent orientation. Normal scale zero gave
`[127,127,255]`. The checks also cover AO UV selection, distinct group shaders/textures, picking both ranges,
root transforms, transparency order, matcap with SSAO, shared instancing/count changes and disposal. Every GPU run
used the primary checkout's shared lock and released it normally.

## Remaining limits

Arbitrary named vertex attributes remain absent, so the matrix's combined custom-attributes row stays PARTIAL and
its counts remain **95 COVERED / 39 PARTIAL / 25 MISSING**. Groups have conservative whole-geometry bounds and
transparent sorting uses node distance. Picking returns the shared mesh node; existing texture-alpha picking/shadow
limits remain. Cross-device local material shading requires rebuilding its GPU resources; same-engine device
restoration is supported. Geometry attributes are cached at first packing; change geometry identity to repack them.

See the [materials README](../packages/materials/README.md#meshes-with-two-uv-sets-and-material-groups) for the API.

## Reproduce

```sh
npm run test:all
npm run typecheck
npm run api:check
npm run measure:size
```

For a linked worktree on this Windows host, use the shared primary-checkout GPU lock:

```powershell
$env:MARGO_GPU_LOCK = 'C:/Development/Projects/margoengine/test-results/gpu.lock'
node scripts/materials-uv-groups-gpu-check.js
node scripts/gpu-lock.mjs run --owner=materials-uv-groups -- node scripts/test-helmet-streaming.js
```

Detailed local output is under `test-results/materials-uv-groups/`. The complete passing Node log is
`test-results/materials-uv-groups-full-suite-final.log`; strict typecheck output is
`test-results/materials-uv-groups-typecheck-final.log`.
