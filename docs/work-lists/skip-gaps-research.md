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
