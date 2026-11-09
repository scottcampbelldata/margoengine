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
