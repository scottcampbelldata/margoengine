# Batch 234 caustics

The optional `@margoengine/water/caustics` entry provides refracted surface
flux, world-space receiver projection, RGB absorption and entry/receiver shadows.
The final full rebuild with main version guard measures 9004 B min+gzip,
with a 9230 B ceiling. Core plus stage measures 24209 B. No underwater renderer is included.

The fast gate passes: lint, hygiene, banned terms, package builds, API check,
quality, 520 water/Biomes/wrapper units and 41 export/corpus checks. All 46
rendering commands pass. These cover water, its previews, Biomes and the umbrella
on both requested backends; Biomes' hardware compute proofs explicitly select
native WebGPU. The independent caustic assertions run on both actual backends.
After the final rebase, all four caustics compatibility leaves pass again on
main's updated WebGL2 backend. Core, stage, water, post, math, shared rendering,
glTF-pro and Biomes runtime sources are unchanged by that rebase.

Main's browser-host repair 919fdc09e closes the prior flow teardown blocker.
The original flow gate now completes on both backends at its unchanged close
bound. This feature changes no browser lifecycle file. The GPU command guard
required an explicit rendering reason for one leaf before startup. The outer
runner also killed the first compatibility flythrough at six minutes, below
its existing fifteen-minute limit; the corrected invocation uses that existing
limit. No test or assertion changed, and both failed invocations are retained.
[Landing receipt](whitepaper/results/batch234-caustics-landing.json).

README examples are deferred in `docs/work-lists/readme-owed.md`; local CI owns
the full repository verify. No speed result is claimed. Local logs are retained
under `test-results/caustics-land/`.

The following development record preserves earlier failures and intermediate
acceptance status. Its pending statements describe those checkpoints.

Black-box output review executed Evan Wallace, **WebGL Water** (2011),
<https://www.madebyevan.com/webgl-water/>, in its remote browser page. Only the
rendered pool output was inspected: animated caustics on the bottom and sphere,
with shadows. No scripts, shaders or repository files were read or copied.
Margo's enabled/disabled and time-3/time-5 captures show source-coupled patterns
on the seabed and raised opaque boxes. These are a qualitative capability
comparison, not equal-input pixel parity. Independent physical oracles provide
the quantitative evidence. The final NOAA preview includes all three 128/32/8 m
bands, a 40 m / 256-cell submitted surface and a 32 m camera-centred projection
map; its explicit finite map boundary is visible behind the receivers. The
first preview saturated most of the bed at direct-light intensity 4; display
settings now use 1 and effect intensity 0.8. No test or physical-flux threshold
was changed for the preview. Wider coverage is an explicit `size` setting.

## Independent job-4 continuation

The job-4 feature at `6e16c0d72` has been separated onto current main in
`f47a2f863`. The preserved `batch-234-checkpoint-6e16c0d72` branch retains all
job-3 work. Caustics imports the internal surface-capture helper, not the
underwater renderer. No underwater export, renderer, test or open visual defect
is included in this job's branch. Current main's unit-light changes are retained.

Research was checked again before the range repair: Wyman and Davis (2006),
section 3.2.1, requires distributing conserved beam energy over finite polygons;
Barczak and Olano (2007), sections 3.2 and 3.4, motivates scaled vector fields
and separate surface/receiver occlusion. The latter full text is now available
at <https://redirect.cs.umbc.edu/~olano/papers/causticvolume.pdf> and was read.
W3C, **WebGPU**, editors Kai Ninomiya, Brandon Jones and Jim Blandy (2026),
section 25.15, <https://www.w3.org/TR/webgpu/#float32-blendable>, establishes
that 32-bit floating-point blending is optional, so it cannot be assumed on
both required backends. No external implementation or companion source was read.

Raw additive half-float maps have a second failure mode beyond collapsed
coverage: concentrated irradiance can exceed their finite range. A GPU reduction
now bounds the sum of absolute incoming flux-vector components divided by the
minimum footprint area. Beams are accumulated after division by a shared scale;
the projector multiplies by that scale. This changes representation, not light
energy or the footprint. A factor-of-two headroom keeps the conservative bound
under 65504 without clipping radiance. Invalid beams do not inflate the bound.
The first reduction uses one invocation per source triangle, then one 64-lane
workgroup sums those partials. Its storage is `4 * ceil(2 * segments ** 2 / 64)`
bytes. Half-float quantization and finite-footprint broadening still apply.

The independent native ideal-focus oracle retains its 0.005 energy-error bar:
64-square maps measure relative error 0.000004759; 1024-square maps measure
0.000149427. Full compatibility, projector, extinction/shadow, lifecycle,
visual/rival and complete-gate acceptance remain pending at this checkpoint.

The follow-up review identified a boundary interpolation defect: rejecting a
slice whenever it lies above one of a beam's source vertices makes valid shallow
receivers fade toward an artificial zero slice. A flat interface at -1 m and
a sampled slice at 0 m isolates it without wave curvature or shadows. The
ray bundle is now mathematically extended through those virtual slices, with
non-negative physical absorption distance; the projector still rejects every
receiver at or above its actual drawn interface. This is an inference from the
straight refracted beam volume described by Barczak and Olano, not a claim
that the paper specifies this interpolation implementation. The unchanged
Fresnel-energy oracle includes that virtual flat slice, and the independent
projector retains explicit dry and above-interface zero-light assertions.
The new boundary case passes on both backends: expected flux 3.918507249,
measured 3.91796875, relative error 0.000137425 under the unchanged 0.005 bar.

The seven independent projector cases pass on native WebGPU: flat, tilted,
raised, dry, above-interface, receiver shadow and outside-height. Each checks
3600 pixel-centre positions against analytic planes and known flux vectors;
worst absolute channel error is 0.000004932 under the 0.001 bar. This separates
projector correctness from MSAA depth reconstruction and source emission.

The full scene now passes on both backends: oblique RGB extinction worst error
0.000231993, entry-shadow flux worst 0.000134625, filtered shadow projection
worst 0.000468642, 21504 receiver-shadow probes, resize to 160 x 96, identical
map restoration and coded borrowed-source disposal. The shadow oracle originally
assumed an unfiltered step, failing by 0.006225586 at its filter footprint. It
now evaluates the independent linear reconstruction at each pixel, with the
same 0.003 bar and more edge pixels checked. No production threshold changed.

The one full verify invocation stopped at API quality, with two help links to
the absent `attached` fragment. Both attachment errors now retain code `attached`
while linking to the existing `state` page, and tell callers to create another
instance for another stack. Unit regressions check both the remedy and URL.
The quality gate and the interrupted unit/API steps are resumed individually;
the full verify command is not repeated. This repair applies W3C, **WCAG 2.2**
(2023), criterion 3.3.3,
<https://www.w3.org/TR/WCAG22/#error-suggestion>, and Tim Neusesser / Evan Sunwall,
**Error-Message Guidelines** (2023),
<https://www.nngroup.com/articles/error-message-guidelines/>, to API recovery
instructions. This is a design analogy, not a WCAG conformance claim.

## Research and real-state checkpoint

After job 3's unsuccessful visual repair, fetched and rebased onto current main
as instructed. Water's README, exports and source have no caustics entry. The
underwater work remains checkpointed and unaccepted, not a full-match skip.

Compared these primary publications before implementation:

- Chris Wyman and Scott Davis, **Interactive Image-Space Techniques for
  Approximating Caustics** (2006), I3D,
  <https://cwyman.org/papers/i3d06_imgSpaceCaustics.pdf>. Read sections 3.1-3.2.2:
  connecting adjacent light samples into beams spreads flux over a finite area;
  projected area ratios determine irradiance. Multiple overlapping beams add,
  which handles focusing and folds rather than drawing a decorative noise mask.
- Juan Guardado and Daniel Sanchez-Crespo, **Rendering Water Caustics** (2004),
  GPU Gems chapter 2,
  <https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-2-rendering-water-caustics>.
  Read the physical description and equations, not its sample implementation.
  Its overhead-light approximation motivates a much cheaper projection, but
  explicit Snell refraction is preferable for oblique sun and varying depth.
- Josh Barczak and Marc Olano, **Interactive Shadowed Caustics Using Hierarchical
  Light Volumes** (2007), <https://userpages.cs.umbc.edu/olano/papers/causticvolume.pdf>.
  The previously reviewed abstract motivates testing submerged receiver and
  surface-entry occlusion separately; no full-paper reading is claimed here.

Attempted the EGSR 2006 screen-space photon-tracing paper (publisher fetch 403)
and Wyman's 2008 hierarchical paper (web reader's size limit). Neither is claimed
as read. No companion files, rival code or external engine source was read.
Black-box rival output and all acceptance remain pending.

## Architecture decision still to prove

Keep the effect in an optional water/caustics entry, outside root/core/stage.
Use refracted beam area and additive flux, with world-space depth so elevated
submerged meshes receive a different focus pattern from the seabed. Filter
finite footprints rather than clipping bright caustics. Prove flat-interface
uniformity, energy, oblique light, varying receiver height/normal, animation,
dry pixels, shadows, lifecycle and both backends with independent oracles.
The real NOAA NDBC wind observation already retained by water drives the demo.

Ordering needs explicit proof: Water/FFTOcean publish their submitted wave
resources during their order-4 draw. Underwater snapshots opaque HDR at order 3.
A caustic composite after water must not brighten opaque top-surface water with
a bed-space pattern; a pre-water pass must not sample a stale wave frame or
silently omit the first frame. Resolve this in the optional package before
claiming source-coupled parity. No new core/stage API is needed or requested.

## Implementation checkpoint, not accepted

The internal water bridge now registers optional source-ready passes. Water and
FFT invoke them after this frame's wave uploads/simulation and before their
surface draw. Caustics has priority 0; Underwater's opaque snapshot has priority
1, replacing its earlier order-3 graph pass. Registration code is reachable only
through optional entries. The water root and FFT gain only internal dispatch;
core and stage are unchanged. Source-ready illumination refreshes Water's
single-sample refraction copy as well as the live multisample resolve.

The draft emits refracted triangles into horizontal depth slices, adding three
per-channel flux-vector maps with per-beam RGB extinction. The depth projector
uses the receiver's world height and reconstructed normal, a drawn-surface dry
mask and optional surface/receiver shadows. This lights elevated geometry without
painting an opaque top water surface with a seabed-space overlay. The final HDR
stage only presents its input; scene illumination already happened before water.

The first draft's area floor lost all flux for an exact point focus: an
independent ideal 2 x 2 m refracting patch expected 3.914081 units and measured
zero, without any shader errors. The production emitter now replaces unresolved
triangles with a pixel-aligned bounding footprint, normalizing by its full area.
Resolved triangles retain their original geometry. The same test measures
3.9140625 units, relative error 0.000004759 against the unchanged 0.005 bar,
on native and full compatibility. This is a finite-resolution box reconstruction;
it broadens unresolved elongated beams, and is not a wave-optics diffraction model.

Both backends pass all current caustic assertions: four flat-interface depth
slices (worst 0.000135), 22736 independently selected seabed pixels (worst
0.000221), exact disabled passthrough, animated source changes, same-frame source
time, reverse stack registration order, first-frame FFT illumination and disposal
of the borrowed source. The latter now throws a coded state error rather than
presenting an old capture. Float32-collapsed height ranges reject before GPU work.
All 41 water units passed. Updated underwater and 75-case trace suites pass on
both backends with the source-ready scheduling. No test threshold changed.

The initial test's 16-segment, 80 m water mesh correctly filtered out its 12 m
waves. The animated fixture now uses 64 segments so it actually draws those
waves. Its original perspective depth fixture mixed nearest MSAA sample depths
with pixel-centre world positions. A top-down orthographic receiver provides
constant analytic plane depth across all samples, retaining 4x MSAA and every
assertion/bar. Broader perspective/receiver orientation bars are still required.

The real NOAA-driven preview rendered with Shadows on native GPU; retained
`test-results/batch234/caustics-{below,window,split}.png` shows the seabed lighting.
The job-3 underside bands remain and these images are NOT accepted parity.
Further shadow/attenuation/receiver-orientation/dry/resize/restoration numerical
oracles, float16 extreme-focus range, visual/rival review, remaining package GPU
leaves, README runners and full gates remain pending. Neither job is ready to push.

Sizes at this checkpoint: caustics 8122 B min+gzip, new ceiling 8378 B; water root
20013 -> 20060 B, FFT 7438 -> 7458 B, underwater 8138 -> 8215 B, each within its
existing ceiling. Query stays 4463 B and core plus stage stay 23924 B. Splitting
map emission/projection would duplicate capture and lifecycle state for optional
size alone. Lint, hygiene, all 41 water units and 231-document link checks pass.
API/umbrella, supply-chain and LLM outputs were regenerated after the rebase.
No full verify has been invoked for job 3 or job 4; none is claimed or repeated.
