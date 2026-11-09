# Test-page bug research and clean-room decisions

The live brief added the research-first ruling during this local run. This audit
records the source comparison before landing the local repairs. Searches covered
programming-language semantics, ECMAScript/Node standards, polygon triangulation,
half-edge topology and WebGL context loss. No companion code or other engine
implementation was used.

## Retained refs: entries 36 and 32

- Arjun Guha, Claudiu Saftoiu and Shriram Krishnamurthi, *The Essence of JavaScript*,
  ECOOP 2010, [corrected 2015 paper](https://arxiv.org/pdf/1510.00925).
  Object-field replacement and mutation of a referenced object are different state
  changes. The known-error 2009 technical report is not a basis for this repair.
- Ecma International / TC39, *ECMAScript 2022 Language Specification*, 2022,
  [ordinary object property operations](https://tc39.es/ecma262/2022/#sec-ordinarysetwithowndescriptor).
  Runtime accessor setters govern assignment; TypeScript readonly declarations do
  not establish those runtime descriptors. A throwing setter gives the requested
  diagnostic in both module assignment and Reflect.set. Non-configurable core
  accessors retain the live ref while supported mutation methods update its store.

The implementation follows the language standard, rather than introducing a new
vector-copy operation. Label keeps its getter-only declaration. Its existing math
dependency is shared instead of embedded; neither its projection algorithm nor
the core transform kernel changes.

## Export contracts: entries 42 and 43

- Khronos glTF Working Group, *glTF 2.0 Specification*, 2017 with current 2.0.x
  clarifications, [mesh topology](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#meshes).
  Triangle-list indices are grouped in threes. Margo already checks that invariant
  before normalization/winding, as the new public-writer regressions confirm.
- Node.js contributors, *Modules: Packages*, documentation accessed 2026,
  [subpath exports](https://nodejs.org/api/packages.html#subpath-exports).
  The root and a named subpath are distinct entries. Margo's README explicitly
  chooses the USDZ subpath; tests verify that actual package import and archive.

## Bevel validity: entry 44

- David Eberly, *Triangulation by Ear Clipping*, 2002, revised 2024,
  [paper](https://www.geometrictools.com/Documentation/TriangulationByEarClipping.pdf).
  Ordered polygon corners and ears give triangles using the existing corners.
- Stefan Hertel and Kurt Mehlhorn, *Fast Triangulation of Simple Polygons*,
  1983 conference / 1985 journal version,
  [author-hosted paper, section 6.2](https://people.mpi-inf.mpg.de/~mehlhorn/ftp/FastTriangulation.pdf).
  Removing suitable triangulation diagonals can yield fewer convex pieces.
- Lutz Kettner, *Using Generic Programming for Designing a Data Structure for
  Polyhedral Surfaces*, 1999,
  [publisher record](https://doi.org/10.1016/S0925-7721(99)00007-3).
  Half-edge connectivity separates topology from geometric normal estimates.

Comparison: a blind fan need not respect a projected concave outline; retaining
warped quads violates the editable face contract. The existing ear clipper handles
generated invalid loops, preserving corner indices and UVs. Valid convex planar
loops stay polygons. Convex merging adds code and work without improving this
validity repair, so it is omitted here. Cap cycles and strip winding follow source
half edges, avoiding the failed global-centroid orientation guess. Regression
evidence, not the papers alone, establishes the twelve tested output guarantees.

## Disposal investigation: entry 45

- Khronos WebGL Working Group, *WEBGL_lose_context*, revision 15, 2020,
  [specification](https://registry.khronos.org/webgl/extensions/WEBGL_lose_context/).
  Context loss is the specified resource shutdown mechanism.
- Khronos WebGL Working Group, Jie Chen and Geoff Lang, *KHR_parallel_shader_compile*,
  revision 6, 2020,
  [specification](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/).
  Completion polling avoids compilation-status stalls; lost contexts must report
  completion. A long driver compile and a blocked context-loss call require
  different evidence. The bounded D3D11 probe logs both call boundaries; no float
  texture or shader-state cause is inferred before the repro actually runs.
- Lukas Bernhard, Nico Schiller, Moritz Schloegel, Nils Bars and Thorsten Holz,
  *DarthShader: Fuzzing WebGPU Shader Translators & Compilers*, 2024,
  [paper](https://arxiv.org/abs/2409.01824).
  Translation and driver compilation are separate fault surfaces; successful
  JavaScript attachment alone cannot establish shader or disposal correctness.
- Khronos WebGL Working Group, *WebGL Working Group Updates*, March 2021,
  [parallel shader compilation discussion](https://www.khronos.org/assets/uploads/developers/library/2021-webgl-meetup/Khronos-Group-WebGL-WG-Updates.pdf).
  Deferring use until linking completes avoids forcing compilation into a frame.
  This informs the separate immediate-disposal and ready/render probe cases;
  it does not establish a cause or justify removing any tracing work.

Comparison for the pending investigation: the context-loss specification defines
resource shutdown, the parallel-compilation specification defines nonblocking
completion queries, and the paper motivates checking the full shader pipeline.
Record page errors, readiness, render, tracer disposal and context-loss entry/exit
separately. Browser-process teardown is a different owned investigation, not proof
that the engine's synchronous dispose call hung. No companion code was read.

### Active-compilation disposal isolation

- Khronos WebGL Working Group, Kelsey Gilbert (editor), *WebGL Specification*,
  editor's draft, 2026,
  [program and shader objects](https://registry.khronos.org/webgl/specs/latest/1.0/).
  Explicit object deletion and context loss are distinct operations. The draft
  informs the deletion experiment; it is not evidence that a driver cancels an
  active compiler job when an object is deleted.
- Samuli Laine, Tero Karras and Timo Aila, *Megakernels Considered Harmful:
  Wavefront Path Tracing on GPUs*, HPG 2013,
  [paper](https://research.nvidia.com/sites/default/files/pubs/2013-07_Megakernels-Considered-Harmful/laine2013hpg_paper.pdf).
  Specialized kernels exchange path state through queues instead of enclosing
  all transport in one kernel. This is a candidate decomposition for the existing
  D3D11 compilation defect, not proof of compile success or speed in Margo.

Comparison: the context-loss and parallel-compile specifications distinguish
resource shutdown from pending link work; DarthShader distinguishes translation
and driver compilation; Laine et al. describe splitting transport work while
preserving its state. None permits removing materials, traversal or precise
maths. A future staged route must keep the same work, random sequence and output
and prove correctness before any performance claim. No companion code was read.

### Bug 45 continuation: compilation inputs and ownership

The current-main check still reaches `loseContext` after 61 raster frames and
does not return before the unchanged 180 s GPU command deadline. Raw WebGL
isolation establishes a browser/compiler interaction, but Margo still owns the
program it submits. The following sources were compared before testing a new
input representation; no Chromium, ANGLE or companion source was opened.

- ANGLE project contributors, *Dynamic Shader Compilation*, living design
  document, accessed 2026-11-09,
  [document](https://chromium.googlesource.com/angle/angle/+/HEAD/doc/DynamicShaderCompilation.md).
  HLSL compilation can occur at link and draw boundaries, and target changes
  can cause further compilation. A returned `compileShader` call is not proof
  that native compilation has completed.
- Khronos WebGL Working Group, Jie Chen and Geoff Lang, *WebGL
  KHR_parallel_shader_compile Extension Specification*, revision 6, 2020,
  [specification](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/).
  Completion polling is nonblocking; the extension supplies no cancellation or
  compiler-thread control. A JavaScript promise timeout cannot cancel native
  compilation or interrupt a synchronous context-loss call.
- Khronos WebGL Working Group, *WEBGL_lose_context Extension Specification*,
  revision 15, 2020,
  [specification](https://registry.khronos.org/webgl/extensions/WEBGL_lose_context/).
  Context loss should destroy the graphics context and resources. Omitting it
  indefinitely would preserve the resource problem instead of repairing it.
- Chromium GPU/ANGLE contributors, *Shader compilation in WebGL blocks the
  thread even when KHR_parallel_shader_compile is used*, issue 40890686, 2023,
  [report](https://issues.chromium.org/issues/40890686).
  Reports describe stalls despite parallel compilation, across platforms. This
  is supporting evidence for the boundary, not proof of the same internal lock.
- ANGLE project and Microsoft HLSL team contributors, *Slow fxc compile
  performance with dynamic uniform indexing*, issue 40096608 (formerly 3682),
  2019,
  [report](https://issues.angleproject.org/issues/40096608).
  The reported shader inputs make native compilation pathological; changing
  uniform data representation improves those cases. Margo's captured shader
  has dynamically indexed blocks of 2,048 and 2,312 uvec4 rows. The existing
  compatibility data-texture path is therefore a hypothesis worth isolating;
  the report does not establish that it repairs Margo's shader.
- Lewis Crawford and Michael O'Boyle, *A Cross-platform Evaluation of Graphics
  Shader Compiler Optimization*, ISPASS 2018,
  [author manuscript](https://www.pure.ed.ac.uk/ws/files/56917122/A_Cross_platform_Evaluation_of_Graphics_Shader_Compiler_Optimization.pdf),
  [publication](https://doi.org/10.1109/ISPASS.2018.00035).
  Optimization effects vary by shader and platform. In contrast to a presumed
  loop-unrolling cure, the test must exercise the actual D3D11 input and retain
  all arithmetic and material work. The prior native-trig and loop-attribute
  experiments did not resolve compilation and are not repeated.

Decision boundary: the browser owns native compilation and context shutdown;
the tracer/compatibility packages own the submitted representation. Test the
existing data-texture representation before attempting a larger wavefront
split. Neither a renderer-name rejection nor a timeout followed by endless
deferred destruction supplies the required working route. No runtime fix or
speed result is claimed at this checkpoint.

- Tom Wiltzius, Vangelis Kokkevis and the Chrome Graphics team, *GPU Accelerated
  Compositing in Chrome*, updated 2014,
  [design document](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/).
  The client/server command-buffer explanation distinguishes submitting a GL
  command from executing its native work. This historical architecture document
  supplies context, not evidence of the current hang's internal locking cause.

Observed comparison on the same RTX A6000/D3D11 host, correctness diagnostics
only, each actual GPU command holding one shared slot:

| Input representation | Observed boundary |
| --- | --- |
| Current trace pipeline, dispose one second after submission | Tracer disposal returns; context loss reaches the unchanged 180 s kill limit. |
| Large uniform blocks as existing data textures, 134,927-byte fragment | Completion false after one second; context loss reaches the same limit. |
| All uniform blocks as data textures, 135,096-byte fragment | Still pending after 120 s of polling; context loss reaches the same limit. |
| All textures and a uniform-dependent five-light loop bound, zero added to its authored count | Still pending after the same poll; context loss reaches the same limit. |
| Isolated camera, closest-hit and surface trees, 18,742 / 30,216 / 14,195 bytes | Each links. The combined lighting tree in that context remains pending; its loss reaches the limit. |
| Isolated shadow, glass candidates and one-light evaluation, 27,612 / 20,184 / 60,201 bytes | All link; context loss returns. All five light-kind branches remain in the one-light shader and every Walk field is exposed. |

The one-light fixture is not a feature-reduced tracer: it is a compile probe of
one possible stage boundary, with no drawing or complete path loop. Separately,
the compatibility CPU f32 executor compares the original direct loop against
five ordered light steps that retain the partial lighting sum and Walk state.
All 144 non-geometry fixtures match radiance, all 22 Walk words and RNG exactly.
Of those, 99 have nonzero radiance and 3 have populated reservoirs. Sun, area,
environment, ground-shadow and fog controls are covered; emitter geometry,
glass traversal, GPU numerical parity and texture serialization are not.

This changes the decision from an untested split proposal to evidence that
smaller constituent programs can link. It does not prove a full repair or
impossibility of engine prevention. The owning optional route must preserve
sample order, RNG, material/transport work and precision while replacing the
monolithic submission. No native compiler flag or timeout is changed. A
conservative typed-IR inventory counts 98 scalar words of persistent locals
and private globals before liveness/bool packing, plus phase scratch; allocate
from an actual liveness/serialization design, not the earlier 18-vec4 estimate.

Local reproducibility files are `test-results/testpage-45-uniform-context.mjs`
and its supervisor (`large`, `all --ready`, `dynamic --ready`),
`testpage-45-stages.mjs`, `testpage-45-split-light.mjs` and their supervisors,
plus `testpage-45-light-equivalence.mjs` and `testpage-45-state-budget.mjs`.
Sources, logs and result JSON files retain the inputs and observed boundaries.
These diagnostics do not replace the failing real-engine disposal regression.

The one-light active-compilation control subsequently waits one second after
submission, observes completion false and calls context loss. It returns before
the unchanged 180 s limit (92.2 s for the supervised command, including launch
and shutdown). This is evidence that the input workload affects the lifecycle
boundary, not proof of responsive cleanup or a native deadlock. The source
initializes Walk to zero; a further compile check loads every Walk field and
the partial lighting sum from runtime uniforms, keeping the final reservoir
evaluation live for a carried-state stage. Compilation of that representation
must be observed separately, and no result is assumed from source size alone.

Carried-state result: the 60,463-byte shader, SHA-256
a290ea09511921309aa138c65b9f43508efe73e5de91a372b33f1d1f3678d5b7,
is still incomplete at the 120 s poll deadline. Context loss subsequently
returns before the 180 s kill limit. The supervisor records failure at 176.1 s
because the completion check failed; it did not time out. This strengthens the
scope limit: loading the real staged inputs changes compiler work, and a
zero-initialized reservoir is insufficient compile evidence for all transport.
The next decomposition should isolate the final reservoir/BSDF evaluation as
well as shadow/candidate work, preserving all operations and their order.
Command: `node test-results/testpage-45-split-light-supervisor.mjs light --carried`.
All own GPU commands have ended and released their shared slot.

### Bug 45 hunt (2026-11-09): where the compile time goes

Method, CPU only after one GPU-locked capture: Chromium with
`--use-angle=d3d11 --enable-privileged-webgl-extensions` returns ANGLE's
translated HLSL through `WEBGL_debug_shaders.getTranslatedShaderSource` after
`compileShader`, with no link. Filling the three link-time `@@` placeholders
(pixel output struct, `SV_Position` parameter, `gl_FragCoord` prologue) gives a
file that `fxc /T ps_5_0 /E main` (Windows SDK 10.0.26100) compiles. The full
trace program does not finish in 240 s there either, with default flags, `/Od`
or `[loop]`, so the D3D11 hang reproduces without a browser or a GPU.

Results (one RTX A6000 PC with other jobs running, several compiles at once;
diagnostic compile times, not speed claims):

| Program compiled | fxc result |
| --- | --- |
| `main` calls `cameraRay` 1, 2, 4, 8 times | 3.2 s, 17.1 s, 89.7 s, over 300 s |
| `main` calls `closest` 1, 2, 4 times | 36.6 s, 130.8 s, over 300 s |
| `closest` once, `[loop]` (with or without `[fastopt]`) on every loop | 25 s |
| `closest` once, `march` stubbed | 1.2 s |
| `closest` once, `shapeCut` and `cutThrough` stubbed | 11.5 s |
| `closest` once, `octWalk` stubbed | 31.2 s |
| `cameraRay` kept, the other heavy callees stubbed, default / `/Od` | 61.7 s / 55.6 s |
| Same, `qpmTwoOverPi` switch as a table | 29.7 s (39.9 s base in that batch) |
| Same, precise trig stubbed | 13.2 s |
| `cameraRay` and `direct` stubbed (folds to 14 instruction slots) | 119.5 s |
| Full program, `[loop]` on all 27 loops | over 300 s |

Reading: doubling the inlined code multiplies the compile time by 3.6 to 5.3,
and a program that folds to 14 instructions still takes two minutes, so the
time goes into the compiler's handling of the inlined source before dead code
is removed, not into optimizing the final code. Loop attributes and the switch
table change the constant, not the growth. Inside traversal, `march`'s shape
cut and cut-through code carries most of the cost.

Sources: the ANGLE project list thread "Solving slow compilation (and eventual
fail) in complex shaders" (2011) reports FXC loop unrolling and optimization
cost on ANGLE output, with `[loop]` and `[fastopt]` helping that case; the
Khronos public_webgl threads (2013, 2017) on long Windows compiles and the GPU
watchdog; the Khronos public_webgl threads (2019) on `KHR_parallel_shader_compile`,
which offers completion polling and no cancellation. No browser, ANGLE or
other engine source was read.
