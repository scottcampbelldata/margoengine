# Skip-audit research record

Research reviewed on 2026-11-09 before this continuation's changes. Public papers,
abstracts and standards only; no companion implementation or foreign engine
source was read. Existing Margo implementations and tests were inspected separately.

## Camera follow-up and item 5: examples and ownership

- Paul Haeberli and Kurt Akeley, *The Accumulation Buffer: Hardware Support for
  High-Quality Rendering*, SIGGRAPH 1990,
  https://graphics.stanford.edu/courses/cs248-06/haeberli-akeley-accumulation-buffer-sig90.pdf.
- Craig Kolb, Don Mitchell and Pat Hanrahan, *A Realistic Camera Model for Computer
  Graphics*, SIGGRAPH 1995, https://graphics.stanford.edu/papers/camera/.
- W3C GPU for the Web Working Group, *WebGPU*, 2026 working draft,
  https://www.w3.org/TR/webgpu/.

The first paper motivates subpixel image sampling; the second separates exposure
and optical camera parameters. Neither specifies Margo's plugin ownership. The
WebGPU attachment and resource rules, together with Margo's own PostStack contract,
support one scene capture shared by the documented effects. Item 5 exposes the
existing smooth option and physical-camera/terrain APIs; it adds no sampling or
optics algorithm and makes no lens-simulation claim.

## Item 5 follow-up: self-contained Cube input

- Adobe Systems, *Cube LUT Specification*, version 1.0, 2013,
  https://kono.phpage.fr/images/a/a1/Adobe-cube-lut-specification-1.0.pdf.
- Jeremy Selan, *Using Lookup Tables to Accelerate Color Transformations*,
  GPU Gems 2 chapter 24, 2005,
  https://developer.nvidia.com/gpugems/gpugems2/part-iii-high-quality-rendering/chapter-24-using-lookup-tables-accelerate-color.
- Academy of Motion Picture Arts and Sciences, *Common LUT Format Specification*,
  version 3.0, online September 2025 status note, https://docs.acescentral.com/clf/specification/.

The Adobe publication defines Cube's red-fastest sample order; CLF uses the
third component fastest, so its serialization cannot be substituted. Selan's
lattice description supports a complete identity transform as a minimal example.
The existing parser accepts a 2x2x2 Cube. Supplying all eight corners fixes the
missing input without changing parsing or grading. The actual first README block
is executed with fetch forbidden and the real parseCube function; it fails on
the old external input and verifies every RGBA corner, clearing and disposal on
the replacement. No implementation or companion code was read.

## Item 3: batched picking

- Timo Aila and Samuli Laine, *Understanding the Efficiency of Ray Traversal on
  GPUs*, HPG 2009,
  https://research.nvidia.com/publication/2009-08_understanding-efficiency-ray-traversal-gpus.
- Sven Woop, Carsten Benthin and Ingo Wald, *Watertight Ray/Triangle Intersection*,
  JCGT 2(1), 2013, https://jcgt.org/published/0002/01/05/.
- W3C, *WebGPU*, above, command encoding, queue order and texture-to-buffer copies.
- Todd Mytkowicz, Amer Diwan, Matthias Hauswirth and Peter F. Sweeney,
  *Producing Wrong Data Without Doing Anything Obviously Wrong!*, ASPLOS 2009,
  https://research.ibm.com/publications/producing-wrong-data-without-doing-anything-obviously-wrong.

Traversal work distribution and robust intersection are distinct concerns. The
repair retains the intersection arithmetic and complete 3x3 query workload. It
reduces repeated invariant validation, command submissions and matrix-row reads.
These sources do not establish a speed ratio: deterministic parent regressions
prove work counts and identical answers, while the historical timing loss stays
open. The measurement-bias study reinforces keeping counts separate from elapsed
speed claims. GPU equivalence must pass independently.

## Item 4: terrain grass and interaction

- Kevin Boulanger, *Real-time Realistic Rendering of Nature Scenes with Dynamic
  Lighting*, doctoral dissertation, University of Central Florida, 2008,
  https://stars.library.ucf.edu/etd/3508/.
- Haeberli and Akeley 1990, above, spatial filtering motivation.
- W3C GPU for the Web Working Group, *WebGPU Shading Language*, 2026 working draft,
  https://www.w3.org/TR/WGSL/.

Boulanger's research surveys grass geometry, lighting and levels of detail; that
does not prove Margo's chunk scale or speed. Margo reuses its own clumps and LOD.
For interaction, independently derived Euclidean sphere distance is evaluated at
the bilinearly sampled placement surface. Four explicit loads preserve the existing
heightmap convention without requiring float texture filtering. Scaled norms avoid
overflow. The same CPU oracle and unchanged 1e-5 GPU bar check the result. No
physical blast simulation or huge-area performance claim follows.

The CPU checkpoint's packaging follow-up moves WGSL comments to TypeScript
comments, following the same W3C WGSL language/comment rules. It changes no
algorithm or instruction token: the update token SHA-256 stays
593e1aa2c641ac2f4614ca86365da5300db58a82cb12987c563c6eaf0ae27733.
The interaction entry drops from 3,664 to 3,345 B gzip below its existing
3,574 B ceiling; no ceiling rises and the same 73 scatter unit tests pass.

## Item 1: ordered Rust/Wasm erosion

- Xing Mei, Philippe Decaudin and Bao-Gang Hu, *Fast Hydraulic Erosion Simulation
  and Visualization on GPU*, Pacific Graphics 2007,
  https://doi.org/10.1109/PG.2007.15.
- Balazs Jako and Balazs Toth, *Fast Hydraulic and Thermal Erosion on GPU*,
  Eurographics 2011, https://doi.org/10.2312/EG2011/short/057-060.
- Ondrej Stava, Bedrich Benes, Matthew Brisbin and Jaroslav Krivanek,
  *Interactive Terrain Modeling Using Hydraulic Erosion*, SCA 2008,
  https://dcgi.fel.cvut.cz/publications/2008/stava-sca-erosion/.
- Richard Barnes, Clarence Lehman and David Mulla, *Priority-Flood: An Optimal
  Depression-Filling and Watershed-Labeling Algorithm for Digital Elevation Models*,
  Computers & Geosciences 62, 2014, https://arxiv.org/abs/1511.04463.

The GPU papers use parallel flow updates; replacing Margo's ordered in-place
thermal and upstream hydraulic passes with those schemes would change its output.
Priority-Flood supports retaining Margo's drainage semantics. A feature-local
Rust/Wasm route is the candidate for exact parity, subject to deterministic work
evidence, larger-grid integer bounds, memory accounting and real DEM validation.
The integrated optional route keeps that ordering exactly. It packs direction,
seen and lake into one byte and reuses filled/order for wear/deposit. SIMD computes
four final differences at once. CPU parity covers 258 cases and a real 2048x2048
DEM at 32 rounds; the latter matches the independent JS reference's hashes and
outflow. Array work improves by 10n bytes; copies add 21n bytes, so no total-memory
or elapsed-speed win follows. Production WebGPU/WebGL2 browser proof now passes. This
continuation rechecked Barnes' primary abstract and Stava's primary publication
page before integration; no companion code was read.

### Item 1 production asset proof

- Andreas Haas et al., *Bringing the Web up to Speed with WebAssembly*, PLDI 2017, https://doi.org/10.1145/3062341.3062363.
- W3C WebAssembly Working Group, *WebAssembly Core Specification 2.0*, 2024 candidate recommendation, https://www.w3.org/TR/2024/CR-wasm-core-2-20241217/.
- Vite contributors, *Static Asset Handling*, documentation reviewed 2026-11-09, https://vite.dev/guide/assets.html.

The paper motivates a portable compiled CPU route; the specification defines
SIMD and linear memory. Neither proves Margo performance. Vite documents hashed
asset URLs and no-inline handling. The production test builds a real package
consumer and checks its emitted bytes; the browser checks lazy fetches and all
real-DEM crop outputs on both WebGPU and WebGL2 pages. This caught a missing
package export/build-copy registration in the saved chain before publication.
No companion code or foreign implementation was read.

## Item 2: cutout ray-shadow coverage

- Aila and Laine 2009 and Woop, Benthin and Wald 2013, above.
- Eric Enderton, Erik Sintorn, Peter Shirley and David Luebke, *Stochastic
  Transparency*, IEEE TVCG 17(8), 2011,
  https://research.nvidia.com/publication/2011-08_stochastic-transparency.
- Khronos Group, *glTF 2.0 Specification*, 2021, alpha coverage and texture
  coordinates, https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html.
- Khronos Group / Steven Vergenz, *KHR_texture_transform*, ratified 2018,
  https://registry.khronos.org/glTF/extensions/2.0/Khronos/KHR_texture_transform/.
- Ed Mackey and Khronos contributors, *KHR_texture_transform has the wrong
  rotation matrix*, issue 1563, 2019-2026,
  https://github.com/KhronosGroup/glTF/issues/1563; and *Clarify descriptions of
  rotation direction in KHR_texture_transform*, PR 1624, 2019-2026,
  https://github.com/KhronosGroup/glTF/pull/1624.
- W3C GPU for the Web Working Group, *WebGPU* and *WebGPU Shading Language*,
  2026 working drafts, https://www.w3.org/TR/webgpu/ and https://www.w3.org/TR/WGSL/.

These primary publications and standards were searched/rechecked before this
continuation. No companion code or foreign renderer implementation was read.
Traversal and robust intersection are separate from deterministic MASK coverage;
Enderton's stochastic transmission does not replace glTF's inclusive cutoff.
A transparent candidate continues the same traversal before closest/any acceptance.
Epsilon recasts would lose coplanar candidates. Original face UV/material
provenance must survive leaf permutation. Margo's existing bilinear CPU oracle
motivates four explicit alpha reads with independent repeat/mirror/clamp wrapping.
One optional storage image keeps coverage resources owned/restorable with RT.
The WGSL finite-arithmetic requirement motivates fourfold float32 affine headroom;
individually finite UVs and rows alone do not prevent overflow. Direct and forged
packed-data regressions reject that case before GPU upload.

The extension overview's historical GLSL matrix is not an independent reason to
flip Margo's signs. Khronos issue 1563 and PR 1624 explain the U-right/V-down
rotation discrepancy and call for the authored sample model as conformity evidence.
The production standard-model GPU gate passes both baked-UV comparisons
(max error 0.0059999654 under the unchanged 0.01 bound) and rendered-pixel bars;
the synthetic quarter-turn coverage proof alone establishes CPU/GPU agreement.

The complete AlphaBlendModeTest model has 61 faces, including an opaque backboard.
The traversal proof keeps the complete model and checks nearest accepted distance,
including clear front texels with farther opaque hits. The attached-scene proof
also keeps every face; its 7.1-unit RT reach isolates the foreground cutout shadow
from the backboard. Its map fallback uses a full-distance CPU oracle, since maps
have no RT distance cutoff. Four corners and centre must agree before a receiver
pixel is compared, excluding mixed MSAA boundaries independently of the rendering.
Opaque controls, default/quarter-turn masks, coverage resource restoration and
map fallback all pass with unchanged 0.05/0.95 shadow/light visibility bars.
No elapsed-speed or hardware ray-query claim follows.
