# Materials compatibility hunt, 2026-11-10

## Wireframe index replacement

Owner: `@margoengine/webgl2-compat`, indexed command replay. The unchanged complete
material wireframe grid failed at 1x: the mirrored edge draw lost 159 pixels.
An alternating reference/wireframe probe also reproduced a plain missing edge.
The requested edge indices were `[0,1,1,2,2,0,2,3,3,0]`; the correctly bound
replacement GL buffer sometimes read back the retired reference's
`[0,1,1,2,2,0,0,2,2,3,3,0]`. The 10-index draw therefore lost its last edge.
Uploads contained the requested bytes, and shaders and uniform blocks matched.

Replaying the captured commands in a fresh OffscreenCanvas, without importing
an engine, reproduced three stale reads in eight indexed draws on NVIDIA RTX
A6000 / ANGLE D3D11. Every GL error was zero. Detaching the old element binding
on the draw VAO before binding its replacement eliminated all three. Changing
the upload target to COPY_WRITE_BUFFER, usage to STATIC_DRAW, zero initialization,
or replacing subdata with a full data upload did not repair this replay. A finish
after upload also avoided it, but would introduce an unnecessary GPU stall.
This establishes a GL backend state defect; the exact ANGLE/driver internal
cache responsible is not claimed from these observations.

The repair detaches only when the pipeline's cached element buffer changes.
Unchanged indexed draws retain their existing cache hit. Index counts, edge
deduplication, shaders, resources and pixel comparisons are unchanged.
`packages/webgl2-compat/test/device.test.js` fails without the repair and checks
replacement, return to a previous buffer, unchanged draws and index offsets.
The canonical wireframe suite adds six repeated transparent replacement pairs
at each sample count. Its 285 checks / 84 captures pass native and compat.

The raw diagnostic is `/tests/material-index-rebind-raw.html` under a repository
dev server. `window.indexRebindRaw(false)` replays the original bindings and
`window.indexRebindRaw(true)` detaches before replacement. It reports each draw's
indices, exact byte equality and GL error. The original is diagnostic, not a
required failure on drivers that do not have this defect. The gzip capture is
entirely Margo-generated; it retains every recorded upload, including readback
payloads. Replacing large payloads with zeros stopped reproducing the defect.
Decompressed SHA-256:
`8a833975b9c33b6f45913a7c015f35af88391397f5d8ebc4c710a1259bdeb40a`.

## Dispersion investigation

The historical exact 4x live-reset defect remains open. Two complete compat
grids passed 278 checks / 254 captures each in this investigation. An additional
48 reset cycles, across clean, mapped, advanced-lit and inert prior states,
were exact, as were four live-versus-constructor comparisons. The third complete
compat run reproduced the historical 4x live-reset maximum error 0.000244140625,
after the index replacement repair was active. The wireframe repair does not
close dispersion. No dispersion assertion, tolerance or shader was changed.
One subsequent 4x full-prefix trace read both resolved HDR attachments during
the live sequence. Its opaque snapshots were exact, and reset matched baseline
at both resolves; all 139 4x checks passed. The extra readbacks may perturb the
failing state, so this does not isolate its cause. Next use nonblocking capture
or command replay of the failing full sequence, retaining all uploaded bytes.

## Clean-room research

- Kelsey Gilbert (editor), Khronos Group, *WebGL 2.0 Specification* (2026),
  https://registry.khronos.org/webgl/specs/latest/2.0/ . Buffer binding, data
  upload and readback semantics distinguish an upload error from a stale draw.
- Jon Leech and Benj Lipchak (editors), *OpenGL ES 3.0.6* (2019),
  https://registry.khronos.org/OpenGL/specs/es/3.0/es_spec_3.0.pdf . Compared
  vertex-array element bindings, buffer deletion, line rasterization and resolve
  rules before changing replay. Endpoint rasterization alone cannot explain
  different bytes in a correctly bound buffer.
- Kai Ninomiya, Brandon Jones and Jim Blandy (editors), W3C, *WebGPU* (2026),
  https://www.w3.org/TR/2026/CRD-webgpu-20260915/ . Indexed draws must consume the
  selected buffer and offset; replacement must preserve uploaded contents.
- ANGLE project authors, *Uniform Block to StructuredBuffer Translation*
  (living documentation, consulted 2026),
  https://chromium.googlesource.com/angle/angle/+/refs/heads/main/src/libANGLE/renderer/d3d/d3d11/UniformBlockToStructuredBufferTranslation.md .
  Compared the documented D3D11 uniform translation with the observed buffer
  state; no uniform translation defect was established.
- Microsoft, *Floating-point rules (Direct3D 11)* (living documentation,
  consulted 2026), https://learn.microsoft.com/en-us/windows/win32/direct3d11/floating-point-rules .
  Half precision can explain an error's magnitude, but cannot establish the
  cause of a state-sensitive exact reset mismatch.

Only specifications and public documentation were consulted. No rival engine
or ANGLE implementation source was read. No timing claim or core/stage change.

The owning package CPU gate also exposed a missing lightmap shader in its WGSL
corpus. A scoped real-GPU capture of the existing lightmap suite added the one
validated lightmap-owned module through the corpus generator. Corpus coverage,
parsing, entry points and recorded layouts pass with all prior records retained.
Main commit 8ea7f79c9 independently landed the same index-detach repair and
caller-injected sciviz compatibility module. The isolation assertions stay unchanged.
This job adds deterministic replay coverage, the raw captured reproduction and
the expanded wireframe grid on top of that repair. Main also contains the lightmap
corpus module, so the larger current corpus is retained without regeneration.
