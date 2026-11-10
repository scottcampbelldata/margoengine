# Staging parity, batch 272

## Textured stills

`@margoengine/staging/pathtrace-materials` exports `TexturedStill` and
`texturedSceneFromGLTF`. Convert a loaded gltf-pro model to an owned
`PBRMeshTraceScene`, then pass it as `scene` to `TexturedStill.attach`.
The model can be disposed after conversion. The adapter preserves current
geometry, interpolated normals, UV sets, tangents, vertex colours, transforms,
instances, glTF factors, texture addressing and transforms, base colour,
normal, metallic/roughness, emission and binary alpha coverage. Transport is
the existing optional `voxel-pathtracer/mesh-pbr` feature in a composed tracer;
no second material evaluator or shader is introduced.

The ordinary still controller owns camera motion detection, raster fallback,
the idle interval (0.25 seconds), order 19/20/21 camera handoff, history reset,
scene replacement, device restoration and disposal. Capture retains the
integrator's linear image/AOV and PNG, tiled rendering and AbortSignal APIs.
Options keep the ordinary still defaults. Changes to the raster model do not
change an owned snapshot; convert and setScene again after edits.

The requested rival row is compared against public three-gpu-pathtracer
material behaviour: interpolated normals, base colour/normal/roughness maps,
alpha cutouts and glTF conversion. `pathtrace-materials-browser` checks base
texture versus independently decoded linear factors, metal/roughness versus
independent scalar factors, a normal map versus independently normalized
vertex normals and cutouts versus absent geometry. It also converts the
licensed FlightHelmet mobile fixture with real maps, disposes the source,
compares textured and untextured pixels and checks identical image capture
after actual device replacement on WebGPU and WebGL2 compatibility. These
are standards-based image oracles, not a numerical rival-renderer comparison
or a claim about every feature of that renderer. No benchmark or speed claim.

Limits follow mesh-pbr: OPAQUE/MASK only, no alpha BLEND; static snapshots,
no automatic animation tracking; spatial nearest/linear texture sampling,
no ray-differential mip selection. Compressed/streamed images need the
adapter's imagePixels decoder. Native WebGL2 preview refuses with linked
unsupported; install the full compatibility layer instead. A single view
is required. Neither core nor stage is modified.

Entry measurements for job 1: ordinary pathtrace 1398 B gzip (previous budget 1469 B), new pathtrace-materials 1560 B, new ceiling 1816 B. Core plus stage remains 24209 B. No existing ceiling is raised. Keeping the PBR factory and adapter together adds 162 B over the ordinary controller and avoids a duplicate integrator.

## Multiple lights and ambient visibility

`@margoengine/staging/accumulate-ambient` exports `AmbientShadows`. It has the
ordinary accumulator's receiver, frames, invalidation, fit, disposal and
compatibility APIs. `lights` is a copied array of up to 64 disks with required
world `position`, `radius` (default 2) and relative `intensity` (default 1).
Each disk must lie above the complete caster slab. Omitted lights uses the
ordinary accumulator's lightPosition/lightRadius. `ambient` defaults to 0.5
and is the normalized sky share; 1 permits an empty disk list. Disk weights
are normalized inside the remaining share. A zero-weight light contributes
nothing. Live light, weight or ambient edits restart accumulation.

One deterministic mixture sample is projected each frame; base-2 selects the
light component and bases 3/5 sample the disk or cosine hemisphere. The existing
binary visibility sum and converged receiver stay unchanged. Parallel sky rays
use a homogeneous projection without a finite dome or horizon truncation.
This implements the requested multi-light/ambient row of RandomizedLight and
adds unequal relative disk weights. It is a normalized monochrome visibility
catcher, with no coloured per-light radiometry, inverse-square falloff or
shadows on the product itself. The caster slab and receiver footprint still
bound coverage; motion resets history instead of converging.

CPU tests check the cosine distribution, exact 1:3 component counts, copied
positions, rejected distributions and live resets. GPU tests use the original
128x128, 4-unit contact-reference scene: radius-0.5 sphere at Y=0.5, 96x48
triangles, identical exposed-ground silhouette guard. The analytic projected
solid angle is R squared times height divided by distance cubed. Also check
weighted separated hard shadows, cached history, live edits, removal and exact
device replacement on both backends. No speed claim.

Entry sizes: accumulate 9767 B gzip (ceiling stays 9945 B), new
accumulate-ambient 10410 B (new ceiling 10723 B). Core plus stage stays
24209 B. The optional entry retains one accumulator and one lifecycle; no
quality reduction or new split is needed.

Job 2 contact-reference result: both GPU backends give analytic exposed-ground MAE 0.0012992441388291445 over 15472 pixels at 1024 samples (maximum 0.008304237419899413). The recorded contact-only 4096-ray reference loss is 0.048174. Same sphere/ground/guard; the new measurement reads normalized accumulated coverage against the closed-form integral rather than fitting a shadow opacity. Weighted history and actual device replacement are exact. No speed claim.
