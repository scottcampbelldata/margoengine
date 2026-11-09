# Batch 234: wave queries

Job 2: optional `@margoengine/water/query`. Core and stage are unchanged.

Research preceded implementation. Compared Mark Finch, *Effective Water
Simulation from Physical Models*, GPU Gems chapter 1 (2004), sections 1.2.1
and 1.2.3, <https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models>,
with Jerry Tessendorf, *Simulating Ocean Water* (1999-2004), displacement
equations 42-45, cited and reviewed for job 1 in [water-fft.md](water-fft.md).
Finch supplies parameter-space displacement and its derivatives; a height
lookup at displaced world XZ is not an intersection with drawn triangles.

Compared Tomas Moller and Ben Trumbore, *Fast, Minimum Storage Ray/Triangle
Intersection* (1997), <https://my.eng.utah.edu/~cs6965/papers/MT97.pdf>, with
Sven Woop, Carsten Benthin and Ingo Wald, *Watertight Ray/Triangle Intersection*
(2013), sections 2-3, <https://jcgt.org/published/0002/01/05/paper.pdf>.
The latter's ray-relative, consistently evaluated three projected edge
functions avoid the shared-edge mismatch of a two-weight barycentric test.
For vertical wave queries no shear is required. Use binary64 edge arithmetic,
all three edge signs, and the highest hit when choppy triangles overlap.

Synthesis: an explicit GPU snapshot evaluates the renderer's own surface
functions at its draw vertices, with analytic bent-Gerstner derivatives or
the existing FFT velocity field. A GPU-built bounding hierarchy avoids a CPU
geometry build and full-triangle scans. CPU queries traverse its projected
bounds, intersect actual triangles, and interpolate their data. FFT macro
normals use the shader's periodic bilinear field at the interpolated base XZ.
Coastal signed-fill/dry masking uses an explicit immutable texture copy.
There is no automatic readback, second FFT or CPU geometry-generation loop.

Coastal velocity combines conservative face-flux motion, height divergence,
surface advection and the solver's sea relaxation. This is the current
finite-volume model's particle velocity, not the displacement of its fixed
grid. Still water has zero flow; offshore blending retains its wave velocity.
The continuous velocity does not claim to predict an arbitrary future discrete
step across wet/dry transitions or the solver's capped time step.

Before fixing unrendered-edit leakage, compared W3C GPU for the Web Working
Group, *WebGPU* (2026), queue timelines, writeBuffer and command submission,
<https://www.w3.org/TR/webgpu/#programming-model-timelines>, with its WGSL
uniform resource rules, <https://www.w3.org/TR/WGSL/#var-decls>.
CPU authored amplitudes can change before the next upload. The optional
capture therefore reads the submitted GPU uniform directly, in queue order.
The browser regression sets wave height to zero without rendering, and
requires the snapshot to equal the previous rendered frame exactly.

Public rival descriptions reviewed: Babylon.js, *Lite Ocean* (2026),
<https://www.babylonjs.com/lite-demos/demo-ocean.html>, advertises its
merge/buoy probe; the Babylon.js forum discussion *Float on Water Material*
(2019), <https://forum.babylonjs.com/t/float-on-water-material/1800>, describes
coordinate height queries and private animation time. The Margo contract
must supply height, normal and velocity at actual rendered time, including
horizontal chop. No rival or companion implementation was read.

The scoped full-match contract is height, normal and velocity at arbitrary
world XZ for floating props, using the drawn wave field, including choppiness.
The public Babylon Lite Ocean advertises a buoy probe, while older water
examples expose coordinate height. Margo supplies all three requested fields,
the actual triangle normal, finite-grid/dry rejection and topmost folded hits.
This compares behaviour with the documented rival row; it is not a pixel
identity or a boat-physics claim. The NOAA public-domain wind fixture retained
for job 1 also drives this demonstration. No external model assets are used.

## Evidence and reproduction

Unit tests cover barycentric interpolation, all 1,025 samples of a shared edge,
corners, degeneracy, folded overlap, signed still-fill masking, invalid input,
pre-render capture and pre-abort. Physical raster tests use the renderer's
actual vertex/index buffers, shader vertex function and submitted uniforms,
with world-position/normal render targets independent of CPU intersection.
The six cases are Water, horizon, moving coast, still water, FFT and folded FFT,
on a deliberately odd 19-cell grid to exercise hierarchy edges. Open-water
velocity is checked against GPU position differences at fixed material points;
moving coastal velocity has an independent CPU face-flux oracle in the shallow
interior. The still-water interior must be stationary. Concurrent captures,
in-flight abort, source disposal, device restoration and unrendered wave edits
are exercised without sleeps, timing assertions or lowered numeric bounds.

Run unit tests with `npm test --workspace @margoengine/water`. Run
`node packages/water/test/query.browser.mjs`, then the same with `--compat`,
each under `node scripts/gpu-lock.mjs run --owner=codex-batch234 --wait-max=60 --max=3 -- ...`.
Numerical/native/compatibility records are in
`docs/whitepaper/results/batch234-water-query-{webgpu,compat}.json`.
The initial six-case results have height error below 0.000002 m and macro-normal
error below 0.000004; finite-difference wave-velocity error is below 0.002 m/s.
The independent coastal flux oracle has a stricter 0.000001 m/s bound.

## Limits and sizes

Captures are explicit and retain time, not a prediction for the next frame.
They cover the finite draw grid; spectral periodicity does not extend geometry
outside it. Normal orientation is the shader input before view-dependent
underside flipping, excluding Water's micro-ripple shading. Particle velocity
is interpolated on the displaced mesh; it is not Eulerian height rate.
Each snapshot owns CPU arrays only; capture temporarily owns GPU mesh/bounds
and staging buffers, plus FFT/coast copies. Forty-eight bytes per vertex and
sixteen bytes per hierarchy node, plus source field copies, are intentional.
No speed result or release performance claim is made.

Measured bare-peer min+gzip: new `/query` 4,463 B (ceiling 4,719 B), root
19,846 -> 20,013 B and `/fft` 7,334 -> 7,438 B, within their existing ceilings.
The root additions are an internal resource bridge; neither imports query
implementation. Core + stage remains 23,924 B. All capture/query code stays
optional and no optional ceiling increase is needed.

## Landing acceptance

The round invoked full `npm run verify` exactly once, without a GPU lease.
Its water-SSR preservation failure identified the unnecessary flux texture
COPY_SRC addition made for the test oracle. That addition was removed entirely;
the independent oracle now extracts the existing sampleable flux by compute.
The unchanged preservation proof then passes. Successful verify steps were
retained; interrupted API, quality, voxel-sandbox and full-unit steps resumed
separately. The new entry's budget total was corrected to the exact item sum,
with no other ceiling or numeric test changed.

The resumed full suite ran 13,945 cases: 13,944 passed and one pre-existing
fixed-wait classification/compute-fixture check failed. Current main already
contains the owning checker and fixture repairs. After rebasing and rebuilding
the affected stats/sciviz/umbrella outputs, all 175 affected checks and 51
generated-doc/umbrella/supply-chain/size-record integration checks pass. An
initial concurrent post-rebase test attempt read stale stats output; acceptance
uses the subsequent run after the rebuild completed. No second full verify or
full post-rebase suite is claimed.

All 38 water unit cases pass. Sixteen package GPU runs (all eight water drivers,
native and full compatibility) pass; the query driver passes again on both
backends after removing the unnecessary usage flag. All nine water/umbrella
README examples execute with zero known failures. Lint, hygiene, API, docs links
and the size gate pass; research, evidence, API report and generated docs are
in the same landing. No GPU job remains held or queued by this lane.

Later landing rebases incorporated unrelated materials fixtures, sciviz LIC
and save ownership changes. Their affected outputs and combined API/docs
were rebuilt and checked; Water source and its retained GPU proof did not
change. These were targeted rebase checks, never another full verify run.

