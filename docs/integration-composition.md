# Render-pass composition (integration J2)

`scripts/generate-composition.mjs` builds sparse binary strength-2 arrays. A greedy
positive-pair construction is followed by a separate repair of 00, 01 and 10 states.
The independent tuple checker covers all four states, rather than only counting
co-occurrence. Maximum row width is five. Input order breaks ties deterministically.
This trades a few more rows for bounded resources and easier failure diagnosis.

The target is 24 members and 276 positive pairs. Creative uses its particle pass,
with toon represented by the separate toon package. Sciviz is outside this target.
All target members have executable adapters in 34 generated rows. Presence states
refer to these adapters: core, post/stack, post/depth and the selected device
backend are common infrastructure, including when the post/FXAA adapter is absent.

Generated `.html` and `.ts` files live in `tests/composition/`. Regenerate with
`node scripts/generate-composition.mjs`; the CPU test fails on stale output.
`npm run test:composition:browser` holds one shared GPU slot and runs one native browser and compatibility browsers grouped
by ANGLE backend, with every row at 1x and 4x MSAA. On Windows, compatibility rows that
hold a member listed in `COMPAT_VULKAN_MEMBERS` (`scripts/support/composition-run.mjs`)
run in a second compatibility browser on ANGLE Vulkan, as that member's own
compatibility checks do; the other rows keep ANGLE's default Direct3D 11 backend.
The one member listed is voxel-pathtracer, whose `trace` program never finishes
compiling on Direct3D 11 (docs/known-bugs.md, "The path tracer never compiles on
ANGLE Direct3D 11"). Each scene run has a 150 s limit, under the GPU lease's 3 minute
idle window: a scene that does not return fails with `ERR_COMPOSITION_STALL`
naming the row, backend, sample count and the page's pending pipelines, instead of
holding the slot until the lease reclaims the whole run. Use `-- --packages=taa,dof` to select
rows containing those packages. `check:gpu-packages` registers it as a ROOT suite;
affected-GPU footprints include every generated page and the packages it imports.

Every row creates four distinct core material batches, with red, green, blue and
yellow front faces. Six pixels are read from the rendered canvas, including two
background probes. Half-intensity ambient lighting keeps colours below the
neutral curve's desaturation knee. Interior probes assert sRGB [188 or 0] within
one quantization level and opaque alpha; both background probes assert exact
opaque black. Scene drawCalls must equal four plus one per OIT, VFX, creative
particle or splat adapter present. Validation scopes,
uncaptured errors, page errors and unhandled rejections must be empty. Pipelines
and queue completion determine readiness. There are no timing assertions; the
suite has the existing ten-minute process-tree deadline in check:gpu-packages.
Post effects join one ordered PostStack; TAA samples its depth. This is the
supported composition API, rather than competing standalone scene captures.

The runner writes `test-results/composition.json`, including backend, row id,
members, sample count, probes and drawCalls. Pair coverage is computed only from
selected rows after all backend/sample runs pass. J1 owns fixture shape and plugin
lifetime; this suite does not define or import its integration fixtures.

## Clean-room sources

- D. Richard Kuhn, Raghu N. Kacker and Yu Lei, *Practical Combinatorial Testing*,
  NIST SP 800-142, 2010, https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-142.pdf.
  Defines t-way coverage and explains why independent coverage measurement matters.
- D. Richard Kuhn, Raghu N. Kacker and Yu Lei, *Combinatorial Testing*, 2012,
  https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=910001.
  Compares interaction coverage with exhaustive and random testing. Pairwise is a
  deliberate bound, not proof that higher-order failures cannot occur.
- GPU for the Web Working Group, edited by Kai Ninomiya, Brandon Jones and Jim
  Blandy, *WebGPU*, 2026, https://www.w3.org/TR/webgpu/.
  Error scopes and queue completion supply correctness evidence. Canvas readback
  is taken in the render task so the compatibility drawing buffer stays valid.
- Immersive Web Working Group, *WebXR Device API*, 2026,
  https://www.w3.org/TR/webxr/, and *WebXR Layers API Level 1*, 2026,
  https://www.w3.org/TR/webxrlayers-1/. View projection, per-eye subimages and
  session lifetime define the simulated delivery boundary; actual eye textures
  are drawn and read back on both backends. No external implementation read.

Compared full binary rows, exhaustive pairs and sparse greedy rows; chose sparse
rows with independent four-state repair. No external implementation was read.

## Second executable set

The executable set now includes shadows, clustered, toon, transitions, lines,
points, labels and text alongside the first four members. Thirteen sparse rows
cover all 66 positive pairs among these 12 members on both backends at 1x and 4x.
Shadows draw a 32-texel cascade atlas. Clustered bins a real finite-range light.
Toon draws its outline hull. Lines, points and text draw real geometry in the gap
between the four probes. Labels assert an on-screen centre projection; points
assert one point drawn; text asserts one allocated glyph. A wipe freezes the
previous completed image and advances by an explicit simulation delta of 0.5,
asserting progress 0.5, then the common six-pixel oracle still holds.

Package changes pass the affected package closure through check:merge and the GPU
runner to select only rows containing those members. Composition source changes
keep every row. The selection and downstream closure have CPU regressions. The
scene project also type-checks with `node node_modules/typescript/bin/tsc -p tests/composition/tsconfig.json`.

## Full 24-member expansion

The full expansion exercises 24 adapters in 34 rows. The previous c2-003
compatibility stall is the existing voxel-pathtracer ANGLE Direct3D 11 shader
link defect, isolated and handled by main commit 04f611773. Tracer rows now use
ANGLE Vulkan on Windows and each scene has a 150 s hard limit. The full run passes all 136 cases: 34 rows on both backends at 1x and 4x,
with 276/276 positive pairs and all four binary adapter states on each setting.
The recorded local Windows run used NVIDIA RTX A6000 driver 617.42. Results,
including every colour/depth/eye probe and the compatibility browser arguments,
are in `docs/whitepaper/results/integration-j2-composition.json`. No known-driver
assertion exception was used. The 63 affected CPU tests and scene TypeScript
check also pass.

The generator produces 34 rows covering all 276 positive pairs and
adds numeric reversed-depth readback, target/MSAA/viewport/scissor restoration
checks and simulated XR sessions drawing real GPU eye textures. Creative uses
its particle pass and scenery its Moon pass, so the separate toon and sky
members exercise different renderers in the same graph. Water receives the
supported explicit depth provider when another effect owns capture.

The reversed-depth oracle is `(near * far / 4.9 - near) / (far - near)` for
near 0.1 and far 50. Four interior probes must be within 1e-6; background depth
must be within 1e-6 of zero. An offscreen lighting2d target must contain RGB 128
within one code and opaque alpha. XR uses the real engine route and two real
96x96 GPU texture layers; only headset/session delivery is simulated. Each eye's
six RGBA probes must match the desktop probes within one code. This is simulated
session evidence, not physical headset certification. The scene's 1x/4x setting
is checked independently of the single-sample simulated XR layer.

`c2-007` exposed Water copying TAA capture depth using the source format rather
than its own surface depth format at 4x. Main commit `6b78f2f9a` fixes that owner
bug with `packages/water/test/water.test.js`; the unchanged composition
depth assertion remains the cross-package regression. No package API, core or
stage code is changed by this expansion.

Reproduce from this checkout with `npm run build:packages`, then
`node --test --test-timeout=120000 tests/composition-generator.test.js tests/check-merge-affected.test.js`,
`node node_modules/typescript/bin/tsc -p tests/composition/tsconfig.json`, and
`node scripts/gpu-lock.mjs run --owner=j2-reproduce --max=10 --wait-max=5 -- node scripts/composition-browser-tests.mjs`.
The GPU command runs 34 rows on each backend at both sample counts, 136 cases.
Coverage describes these fixed settings and probes; it does not prove every
option, every pixel, higher-order interactions, C1 or C3-C10. No speed claim.
