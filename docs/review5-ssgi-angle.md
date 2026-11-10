# SSGI ANGLE D3D11 investigation (2026-11-10)

The RTX A6000 reproduction is `node packages/post/test/ssgi-bounce-browser.mjs --compat`
after `npm run build:packages`. The unchanged fixture's final exact comparison fails
with back.most=1 and mean 0.00005642361111111111 (13 one-level channels). It fails
identically on plain origin/main f38642c02, without the restoration change.
Native WebGPU and diagnostic ANGLE Vulkan pass. The restoration callbacks are not
called by this scene. The assertion and tolerance were not edited.

## Boundary evidence

An earlier full-payload recorder found identical normalized 435-call GL streams
for unchanged one-bounce frames on both backends. Sync ids alone were renamed and
sync polling removed; uniforms, texture bindings and draw commands were retained.
After removing one polling call and normalizing sync ids to WebGLSync#sync,
the 434-call JSON array SHA-256 is
`554ac7a2d65e8cb0abf7a2cea71a2a21b558f166a7c23fd18faf3ec60b9ab30c`.
D3D11 screenshots differ in 97 one-level channels; Vulkan differs in zero.
The committed recorder is `scripts/diagnose-ssgi-stream.mjs`; run it with the
same environment/flags as the target probe below to regenerate
`test-results/review5-ssgi-streams-{d3d11,vulkan}.json`. Records 6 and 7 are
consecutive unchanged one-bounce frames. Compare `calls` after removing
clientWaitSync calls and renaming WebGLSync object ids, and compare the decoded
base64 `pixels` channel bytes. The recorded hash excludes polling and uses the
normalized JSON call array; a changed Chromium or Margo version can change it.
Run `node scripts/diagnose-ssgi-summary.mjs` after generating both backend dumps
to reproduce stream hashes, screenshot counts, first repeat target and finite/GL
error counts.
Eighteen direct final-target read pairs and eighteen HDR PBO/direct pairs per
backend agree, as do twelve early-resolve/later-read comparisons per backend.
This signature is distinct from the existing geo-lod/dispersion reread defect.
To regenerate the negative read probes, set PROBE_READS=1 when running the
stream recorder; add PROBE_HDR=1 for the HDR/PBO pairs. The recorder retains
those observations in the -pbo-reads and -hdr-reads JSON variants. Remove both
environment variables before recording the uninstrumented command stream.

The committed diagnostic `scripts/diagnose-ssgi-angle.mjs` executes the original
fixture with added readback and separate diagnostic shaders. It saves every
captured target as base64 raw bytes, format/type/dimensions, compiled shader text,
and diagnostic f32 values for five affected texels. No image encoding or palette
conversion is involved. GL coordinates use the lower-left origin. The diagnostic
is coupled to the current generated shader variable names and fails explicitly
if a requested expression cannot be located. It is not an engine fallback.

Run these PowerShell commands independently from the repository root, after the
package build (each harness has a 120-second test limit after GPU admission):

```powershell
$env:MARGO_COMPAT='1'
$env:PROBE_ANGLE='d3d11'
node scripts/diagnose-ssgi-angle.mjs --compat
$env:PROBE_ANGLE='vulkan'
node scripts/diagnose-ssgi-angle.mjs --compat
Remove-Item Env:MARGO_COMPAT,Env:PROBE_ANGLE
```

The D3D11 command retains the original assertion and can exit 1; the raw JSON is
written in the finally block. Output files are
`test-results/review5-targets-{d3d11,vulkan}.json`.
For records with type 5126, decode `raw` as little-endian Float32 RGBA. Other
records carry their GL read type (5121 unsigned bytes or 33640 packed 10:10:10:2).
Compare draw/attachment/mip tuples in frames 2 and 47, or frame 2 across backends.
Additional capture can perturb driver scheduling; a passing diagnostic rerun does
not erase the uninstrumented failure or establish that the defect was fixed.

## First differing values and operation

The captured scene resolve, three material replay outputs, six Hi-Z levels and
five prefilter levels match across backends in the recorded run. They also match
before/after the mode round trip on D3D11. The first differing target is draw 26,
the rgba16float SSGI ray trace. D3D11 frame 2 to 47 has eleven changed components:
red at (110,74) is 0.06024169921875 versus 0.060272216796875; alpha at (300,76)
is 0.5 versus 0.75. Bilateral filtering propagates the differences. Across
backends the first trace changes are green/blue at (122,150): D3D11
0.447509765625/0.448486328125, Vulkan 0.447265625/0.4482421875.

Separate diagnostic RGBA32F shaders return the original expression values before
half-target conversion. At (300,76), normal/depth, world position, ray start,
sample direction and basis-combined ray agree exactly. The first sampled
cross-backend arithmetic difference is normalize(t1*k.x+t2*k.y+n*k.z):

| Value | D3D11 | Vulkan |
| --- | --- | --- |
| input x | -0.9959985613822937 | -0.9959985613822937 |
| input y | -0.001060005626641214 | -0.001060005626641214 |
| input z | -0.08936194330453873 | -0.08936194330453873 |
| normalized x | -0.9959985613822937 | -0.9959986805915833 |
| normalized y | -0.001060005626641214 | -0.0010600057430565357 |
| normalized z | -0.08936194330453873 | -0.08936195075511932 |

The vector is finite, nonzero and approximately unit length. Ordinary permitted
cross-backend arithmetic precision is not a Margo reliance on zero normalization,
NaN/inf, out-of-range loads, derivatives or integer overflow. All captured float
targets are finite and the final probe records no GL errors. The emitted texture
load helper clamps coordinates/levels. The fixture uses explicit LOD, bounded
ray indices, initialized accumulators and nonzero ray counts. Normal/albedo
coverage rejects cleared pixels. Half-target values are representable finite
numbers. No owning-package undefined-input repair was established within the
one-hour investigation limit.

The modified diagnostic shaders produce stable same-backend values at those
sites, so the normalization observation does not establish the physical cause
of the original repeat-render discrepancy. Root cause below the GL boundary
remains unresolved. Scott's coordinator accepts the independent identical-stream
proof plus backend isolation for this one recorded case. Tests still fail visibly
on affected D3D11; no assertion, tolerance or runner exemption was changed.

## Standards consulted clean room

Compared Alan Baker, Mehmet Oguz Derin and David Neto (editors), *WebGPU Shading
Language* (W3C, 6 November 2026), floating-point accuracy and normalize,
https://www.w3.org/TR/WGSL/#floating-point-accuracy ; Robert J. Simpson and
John Kessenich (editors), *The OpenGL ES Shading Language*, version 3.00 revision 6
(Khronos, 2016), precision/invariance and geometric functions,
https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf ; and
Mark Callow and the Khronos WebGL Working Group, *EXT_color_buffer_float* (2017),
https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/ .
The first two distinguish arithmetic precision from invalid inputs; the third
supports raw float attachment inspection. No foreign implementation or companion
source was read. This report makes no performance or universal portability claim.
