# Compatibility continuation research

2026-11-10 continuation. No external engine or companion source was read. Research
compared language rules, raster conversion guarantees and image/tile separation
before the following repairs. These are correctness changes, with no speed claim.

- W3C GPU for the Web Working Group, *WebGPU Shading Language* (2026),
  [variable declarations](https://www.w3.org/TR/WGSL/#var-declarations) and
  [concretization](https://www.w3.org/TR/WGSL/#concretization).
  Module private variables can infer concrete store types from initializers.
  Requiring an explicit type rejected clustered lighting's valid boolean. The
  checker now uses the same concretization and conversion rules as local variables,
  retaining constant-expression and address-space validation. Regression:
  `packages/webgl2-compat/test/private-inference.test.js` fails on the old checker.
- Jon Leech and Benj Lipchak (editors), *OpenGL ES 3.0.6* (2019),
  [section 4.1.9](https://registry.khronos.org/OpenGL/specs/es/3.0/es_spec_3.0.pdf).
  Dithering starts enabled and can select adjacent representable colours based on
  input components and pixel coordinates. Kai Ninomiya, Brandon Jones and Jim
  Blandy (editors), *WebGPU* (2026),
  [colour target state](https://www.w3.org/TR/2026/CRD-webgpu-20260915/#color-target-state),
  has no corresponding dithering control. GLSL ES 3.00, Khronos Group (2016),
  [invariance rules](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf),
  does not promise identical intermediate arithmetic across different shaders.
  Initial sequential toggles appeared to remove a seven-pixel discrepancy, but
  they also advanced the scene. Disabling dithering from device creation still
  failed the original comparison by seven pixels. The hypothesis is not proven
  and no production dithering change is retained. The exact culling assertion
  remains unchanged while shadow/frame readiness is investigated.
- Jorge Jimenez, *Next Generation Post Processing in Call of Duty: Advanced
  Warfare* (SIGGRAPH 2014), [author presentation](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/),
  compared with Brian Karis, *High Quality Temporal Supersampling* (SIGGRAPH 2014),
  [course record](https://www.realtimerendering.com/advances/s2014/index.html).
  Both motivate treating spatial filtering and changing temporal samples as
  distinct operations. Margo already implements its own half gather, rotating
  taps and sharp/blur join. The full layer's refusal was an implementation gap,
  not a WebGL impossibility. Its route now writes half colour/CoC independently,
  then reuses the existing tile-maximum kernel over the half CoC before gathering.
  This preserves the existing mean, nearest-depth choice and max values without
  shared workgroup memory. `temporal-compat.test.js` rejects the old refusal and
  checks the half-image tile binding. Native and compatibility lens pixel checks
  retain their original bounds; the compatibility check now requires drawing.

Validation and remaining failures are recorded in the operational playbook and
known-bug list. No teardown fix or core/stage source change belongs to this work.

The LOD gate's later separation of correctness and optional measurement follows
David L. Parnas, *On the Criteria To Be Used in Decomposing Systems into Modules*
(1972), [author record](https://doi.org/10.1184/r1/6607958), compared with the
economy-of-mechanism principle in Jerome H. Saltzer and Michael D. Schroeder,
*The Protection of Information in Computer Systems* (1975),
[author publication](https://web.mit.edu/Saltzer/www/publications/protection/Basic.html).
One common rendering loop preserves the same scene, frame count and image
assertions; the default gate cannot read the measurement clock. This is test
responsibility separation, with no rendering algorithm or speed improvement.

## Installer diagnostic size gate

The integrated entry exceeded its unchanged gzip ceilings (root 102,906 versus
102,814 B; device 103,008 versus 102,935 B). The installer now uses shorter
messages with the same API names, missing-capability list, error codes, help
anchors and installation decisions. The actual rebuilt entries measure 102,799
and 102,914 B. These are deterministic byte counts, not timing measurements.
The core plus stage remains 23,924 B. No budget or numerical assertion changed.

The review compared small-mechanism guidance from Jerome H. Saltzer and Michael
D. Schroeder, *The Protection of Information in Computer Systems* (1975),
[author publication](https://web.mit.edu/Saltzer/www/publications/protection/Basic.html),
with the semantics-preserving transformation approach of David Monniaux and
Cyril Six, *Simple, Light, Yet Formally Verified, Global Common Subexpression
Elimination and Loop-Invariant Code Motion* (2021),
[paper](https://arxiv.org/abs/2105.01344). The final change only compacts diagnostic
wording; it does not alter installer control flow or graphics algorithms.
Ecma International, *ECMA-262, 16th edition* (2025),
[Error objects](https://262.ecma-international.org/16.0/index.html#sec-error-objects),
provides the message/object distinction: the existing code/name/help contract
and every missing capability remain tested in device.test.js. No companion
repository or external implementation source was read.
