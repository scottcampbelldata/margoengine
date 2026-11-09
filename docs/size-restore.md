# Optional package quality restoration

Scott's 2026-11-10 optional-package rule permits sensible ceiling growth instead
of reducing quality or complicating an API. Core and stage root are out of scope.
Measurements use `scripts/measure-size.js` bundleBytes, default gzip, bare imports
external, and `measureCoreStage` for the unchanged combined root.

## Labels duplicate attachment (audit finding 1)

Verified on c0e7053ee: the state failure was a TypeError saying `reuse/rename`.
Restore `shared/errors.js` fault, check the name before constructing the renderer,
and give the user both reuse and a complete alternate-name call. Root 5450 to
5550 B gzip; ceiling 5546 to 5806 B. Keeping this synchronous diagnostic in its
owner avoids a needless diagnostic entry or asynchronous attach contract.
Core plus stage remains 23924 B. No speed claim.

Research: Ecma International / TC39, *ECMAScript 2026 Language Specification*,
2026, [Error Objects](https://tc39.es/ecma262/2026/multipage/fundamental-objects.html#sec-error-objects),
permits user-defined Error classes. The existing Margo convention uses TypeError
for arguments and coded MargoError for state failures. W3C / WHATWG, *Web IDL*,
living standard, [Exceptions](https://webidl.spec.whatwg.org/#idl-exceptions),
also separates failure identity from its human-readable message. Use the existing
Margo error identity and retain actionable message detail; no foreign source read
or copied and no new error framework.

Regression: `packages/labels/tests/testpage-attach.test.js` fails on the shortened
TypeError, checks MargoError identity, code, link, name and full repair guidance,
and preserves the renderer and DOM for default and custom-name collisions.

## Shared codec diagnostics (audit findings 2 and 5)

Verified on 17e876ee3: inflate still collapsed distinct failures into three
messages, called caller size limits damage, and did not link errors. GLB did not
identify its failed header field or chunk constraint. Restore diagnostics in the
shared owners, including byte counts and policy-specific repair hints. Keep GLB
argument errors as TypeErrors and stream failures as coded MargoErrors. A valid
preset-dictionary zlib stream is unsupported, with recompression guidance.

The fixed Huffman distance alphabet now includes all 32 specified codewords so
reserved symbols 30 and 31 reach their explicit rejection, rather than appearing
undefined. No valid-stream work or output is reduced. Limits report at least the
bytes needed for the next write, not an uncomputed total decompressed size.
NIfTI/DICOM policy failures name maxSamples; paired image and Zarr metadata
failures name their actual metadata instead. No catch/rethrow masks a cause.

Research compared the container and compression specifications:

- Peter Deutsch and Jean-Loup Gailly, *ZLIB Compressed Data Format Specification
  version 3.3*, 1996, [RFC 1950](https://datatracker.ietf.org/doc/html/rfc1950),
  sections 2.2 and 2.3: method/window/header checks, dictionary support and Adler-32.
- Peter Deutsch, *DEFLATE Compressed Data Format Specification version 1.3*, 1996,
  [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951.html), sections 3.2.2 to 3.2.7:
  canonical codes, stored-block checks, reserved symbols and code-length repeats.
- Peter Deutsch, *GZIP file format specification version 4.3*, 1996,
  [RFC 1952](https://datatracker.ietf.org/doc/html/rfc1952), section 2.2: separate
  members, each with its own compressed stream. Later member limits are remaining
  byte allowances, which the sciviz README now explains.
- Khronos 3D Formats Working Group, *glTF 2.0 Specification*, 2017 (2.0.1 edition
  2021), [Binary glTF layout](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout):
  three header fields, chunk lengths, four-byte alignment, JSON/BIN order and
  unknown-chunk preservation.

These standards determine the existing checks and their diagnostic subjects; no
companion or other engine source was read or copied. No codec redesign, timing
claim or shader-text transformation. Detailed before/after sizes and ceilings are
in `docs/limits.md`. The additional strings remain in their synchronous owning
entries; a lazy diagnostic module would complicate every failure path.

Regression evidence: `tests/shared-inflate-diagnostics.test.js` exercises each
restored failure family; `tests/shared-inflate.test.js` retains 300 node:zlib
parity cases; `tests/shared-glb.test.js` covers fields, counts, ordering, bounds,
alignment and zero-copy unknown chunks. `packages/sciviz/tests/formats.test.js`
proves valid 600000-sample NIfTI/DICOM files fail with a policy error at a small
maxSamples and decode unchanged after it is raised; Zarr names metadata.

Consumer validation on the restoration build: lint and hygiene pass. Verify
completed all API, quality, size, proof, documentation and build steps; its one
unit failure was an old worker diagnostic expectation, corrected and rechecked
with all 17 worker/llms tests passing. Forty shared codec tests, fourteen sciviz
format tests and all six sciviz GPU suites pass. The eleven-package README run
has 155 passes and fourteen existing known failures; Blender's live example was
the sole fresh failure and now passes after its owner harness repair
(`docs/readme-live.md`). Only failed steps were rerun. All nine remaining real
GPU consumer suites pass: decoders, environment, gltf, gltf-pro extensions,
exporters, tiles, rigging, USDZ and Blender. USDZ required an explicit GPU-leaf
reason because its command name is unclassified; its pixel/shader checks ran
under one shared slot, not outside the lock. Remaining consumer requests use wait-max 60 and
no timing work. Detailed logs remain in this worktree's test-results/size-restore.

Rebase onto ba9248a85 preserved concurrent preview, teardown, decoder and scatter
work. The package build, entry/lazy measurements and API surface were regenerated
from the combined source. The limits table now compares current main's record
with this combined build and keeps standard headroom in all 38 raised ceilings;
historical figures above describe the original restoration build. Core plus
stage is still 23924 B. No codec implementation conflict or output change was
introduced by the rebase.

## Lighting2d diagnostics (audit finding 3)

Verified on b5822d106: emissive fields lost their range guidance; root, soft,
cookie and shared validation conflated unrelated fields. Restore the existing
checks with field names, finite/positive/non-negative ranges and accepted enum
values. Shared scalar validation keeps these constraints readable. Global bloom
threshold errors now name bloomThreshold rather than bloomIntensity. Numeric
acceptance and lighting calculations are unchanged. All six entries include
shared validation; their measured changes and raised ceilings are in limits.md.
Synchronous validation remains in its owner: a diagnostic entry would complicate
constructors and mutable-light validation without improving the API.

Research compared Ecma International / TC39, *ECMAScript 2026 Language
Specification*, 2026, [Native Error Types](https://tc39.es/ecma262/2026/multipage/fundamental-objects.html#sec-native-error-types-used-in-this-standard),
which defines RangeError for values outside an allowable set or range, with W3C
Accessibility Guidelines Working Group (editors Alastair Campbell, Chuck Adams,
Rachael Bradley Montgomery, Michael Cooper and Andrew Kirkpatrick), *Web Content
Accessibility Guidelines 2.2*, 2024, [Error identification and suggestion](https://www.w3.org/TR/WCAG22/#input-assistance).
The latter motivates identifying the input and giving its correction. Applying
that communication guidance to API diagnostics is a design inference, not a WCAG
conformance claim. Preserve RangeError and the existing help link while making
the correction available directly in the message. No foreign code read or copied.

Regression: packages/lighting2d/tests/diagnostics.test.js fails on the old
diagnostics and covers each restored field, mask constraints, soft/cookie enums,
CPU checks, pass options and ambient validation, including accepted boundaries.
Existing rendering and lifecycle tests remain in place. No timing or speed claim.

Validation: 119 package tests pass; the added ambient regression also passes.
All 236 real-GPU pixel checks have zero wrong pixels and no validation errors;
11 distinct shader modules compile. All nine README examples run (one Node,
eight browser). Lint and hygiene pass. One shared slot per worktree, wait-max
60, only the real browser commands inside the GPU lock. No successful step
rerun to obtain this evidence. Full verify has 13744 passing unit tests and two
stale-record failures: the API size table and the network record paired with
entry sizes. Regenerated both from the measured build; only those two failed
test files were rerun, both pass (9 tests total). All other verify steps pass
and are retained. The network fixture makes five requests with no unused build
files. API summary and paired size/network records are committed together.

## Pixel palette source and diagnostics (audit finding 4)

Verified on 2e8ebc506: the WGSL still uses S/s/n/lab/lin/near/noise/vs/fs and
unindented blocks, and eight argument checks still share one generic message.
Restore Settings/settings/count/oklab/linear/candidates/pattern/vertexMain/
fragmentMain and readable layout. Keep the dither lookup table and unknown-mode
RangeError. Restore field/range and accepted-value guidance, including the
unreadable palette colour's index. No matching or dither algorithm changes.
The audit also exposed spread accepting positive infinity: reject non-finite
spread before shader creation or GPU writes, with its own regression.

Research compared these primary descriptions and specifications:

- W3C GPU for the Web Working Group (editors Alan Baker, Mehmet Oguz Derin and
  David Neto), *WebGPU Shading Language*, 2026,
  [tokenization](https://www.w3.org/TR/WGSL/#tokenization) and
  [comments](https://www.w3.org/TR/WGSL/#comment). Whitespace and comments can
  separate tokens; block comments nest. A general minifier must preserve lexical
  boundaries, not just remove text.
- Bjorn Ottosson, *A perceptual color space for image processing*, 2020,
  [Oklab description](https://bottosson.github.io/posts/oklab/). Retain the existing
  conversion constants and operation order rather than replace the colour model.
- W3C CSS Working Group (editors Tab Atkins Jr., Chris Lilley and Lea Verou),
  *CSS Color Module Level 4*, 2026,
  [Oklab](https://www.w3.org/TR/css-color-4/#ok-lab). This independently specifies
  the named lightness/opponent coordinates; no new colour-space claim is made.

The existing WCAG error-identification/suggestion and ECMAScript RangeError
research above applies to the palette diagnostics too. No foreign engine or
companion code was read or copied. One-time normalization against the pre-change
Margo shader proves every operation, literal and binding position unchanged
after mapping the restored identifiers and ignoring whitespace; GPU pixel parity
remains the runtime acceptance bar.

Minifier evaluation (LF-normalized shader text, default gzip): shortened 802 B,
readable 903 B; a whitespace-only collapse saves 35 B (868 B). That experiment
does not prove a repository-wide transform sound for nested comments, operator
boundaries or composed shaders. Keep readable WGSL verbatim and raise the optional
ceiling; the evidence does not meet the brief's sound, identical-output condition
for adding a generic build transform. No shader parser/minifier is added.

Regression: packages/pixel/tests/palette-diagnostics.test.js covers every restored
argument error and rejects infinite/NaN/negative mutable spread before GPU work.
The old diagnostics fail it. Existing palette GPU tests compare every pixel
exactly with the CPU form across both distances, all patterns, alpha, swaps and
device replacement. Measured entry and ceiling changes are in limits.md.

Validation: 45 existing package tests pass, as do all three diagnostics tests
after supplying the engine's sceneOf method in their fixture. Only the failed
file was rerun; the infinite-spread regression has its own case. All five real
GPU suites pass. Palette has 20 exact checks with no wrong pixels or validation
errors and two shader modules compile; the compositor has 48 exact-pixel checks
and six shader modules compile. The lock initially refused the unclassified
palette-check filename before launching it; its explicit real-GPU reason was
supplied, and only that failed/remaining sequence ran. No successful GPU suite
rerun. Lint and hygiene pass. All seven README examples run in the browser with
zero failures. Fresh entry and basic-scene network records measure the same
2e8ebc506 dirty build; the basic scene has five requests and no unused build
files. api:update produced no public export changes.

Before rebase, full verify passes all 13756 unit tests, API, quality, sizes,
documentation, proofs and sandbox builds/tests. No failed step remains. The
successful package, GPU and README results are retained across the rebase.
Rebase onto 2ab71bef2 preserves the independent biomes erosion feature and
decoder documentation. Pixel source and its proof inputs have no conflict or
change. The combined packages are rebuilt; entry and network records genuinely
measure 2ab71bef2 with package changes, followed by api:update and size measurement.
Palette remains 4945 B and core plus stage 23924 B. No source or metadata relabeling.
The merged sizes gate, size-page/llms/API-short-path tests and documentation links
all pass. No successful pixel GPU, README or full verify run was repeated.
Current-main fetch then included 8ca1632cb's independent deferred spectral fix.
Preserved it and its documentation; rebuilt the changed spectral package and
remeasured the combined entries/network pair from 8ca1632cb with package changes,
then regenerated the API. Pixel source and its passing proof inputs stay unchanged.

## Named matrix decomposition (audit finding 6)

Verified on 2f31a061e: math/quat still returned a tuple or a bare reason string.
Restore TRSSplit as a discriminated union with ok and named position, rotation,
scale or reason. Migrate every caller in exporters, gltf, gltf-pro, loaders,
rigging and scene, including scene's world rotation/scale readers. This is a
pre-release API correction with no deprecation adapter; the math README gives a
runnable migration example and api:update records the signature.

Research compared three primary sources:

- Khronos 3D Formats Working Group, *glTF 2.0 Specification*, 2017 (2.0.1,
  2021), [Transformations](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#transformations):
  column-major affine TRS and XYZW quaternion layout; shear is outside glTF TRS.
- Ken Shoemake and Tom Duff, *Matrix Animation and Polar Decomposition*, 1992,
  [Graphics Interface](https://graphicsinterface.org/proceedings/gi1992/gi1992-30/):
  distinguishes a general affine decomposition, including stretch, from simple
  translation/rotation/scale. This restoration retains the existing TRS check;
  it does not introduce polar decomposition or change accepted finite arithmetic.
- Microsoft TypeScript team, *TypeScript Handbook: Narrowing*, living handbook,
  accessed 2026-11-09, [Discriminated unions](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions):
  a common literal field narrows named result members. Use ok rather than
  overloading a tuple/string distinction. This API choice is a design inference.

No companion code or foreign engine source was read or copied. Finite successful
inputs retain exactly the existing expressions, negative-x reflection convention
and shear tolerances (1e-5 default; callers retain 1e-6, 1e-3 or Infinity).
The documented singular result previously missed infinite column lengths and
infinite determinants, allowing NaN rotations. The owning helper now checks
these explicitly before normalization. Its regression covers non-finite inputs
and finite determinant overflow, even with Infinity shear tolerance.

Regression: packages/math/test/split-trs.test.js requires named success/failure
fields, recomposition for rotated and reflected matrices, unmodified input,
singular/dependent columns, shear thresholds and the non-finite failure above.
Existing consumer tests exercise their unchanged matrix handling.
Synchronous named results belong in math/quat; splitting them into a lazy entry
would change the helper contract and complicate all six consumers. Byte changes
and raised optional ceilings are recorded in limits.md. No speed claim.

The first partial build also exposed a scheduler defect: when rigging and
math/gltf-pro are selected but the intervening animator/animation packages are
prebuilt, only direct selected edges were honored. Rigging could read gltf-pro
while its declarations were being replaced and infer unknown/any model nodes.
The scheduler now respects transitive paths through unselected packages without
rebuilding those intermediates. Regression: tests/package-order.test.js, narrowed
build case, at one and three jobs, with a consumer listed before its provider.
This is a build-tool fix; runtime bytes are unchanged. The initial passing math
and scene builds were retained; only failed rigging and not-yet-started gltf,
gltf-pro, exporters and loaders were built afterward.

Research: Arthur B. Kahn, *Topological sorting of large networks*, 1962,
[Communications of the ACM](https://doi.org/10.1145/368996.369025), requires ordering
by dependency paths; Microsoft TypeScript team, *Project References*, living
handbook, accessed 2026-11-09,
[Build mode](https://www.typescriptlang.org/docs/handbook/project-references#build-mode-for-typescript),
explains why declarations must be built in dependency order. Retain that ordering
when filtering the build graph. No foreign implementation was read or copied.

A deterministic comparison against Margo's pre-restoration helper checks 4000
finite rotated/reflected/sheared cases across all four caller tolerances with
exactly equal parts/reasons after adapting the old result shape. The prior
helper demonstrably succeeds with a NaN quaternion for an infinite first column
under Infinity tolerance; the new helper returns singular. The prior narrowed
scheduler fails the new ordering condition. Local evidence: math-parity.json
and math-parity-corrected.log in test-results/size-restore. No timing measurement.

Validation: lint and hygiene pass; the changed scheduler and regression files
also pass targeted lint. Full verify passes 13763 unit tests and every other
step, with one stale generated llms-full.txt failure after the math README
migration. Regenerate it and rerun only that failed case, retaining all passed
results. The three new math regressions and seven build-order cases pass; the
full unit run includes every changed consumer package. No tolerance or test is
relaxed. Paired entry/network records measure 2f31a061e with dirty packages;
the basic scene makes five requests, with zero unused built files. api:update
records the named TRSSplit union and the changed size summary.

All consumer GPU suites pass: gltf, gltf-pro extensions, exporters, rigging,
loaders and loaders/render. The first gltf-pro run passed six cases before
Windows logged nvlddmkm event 153 at 16:02:42 and requestDevice failed with
D3D12 E_OUTOFMEMORY. Retain those six passes; only the failed lights group and
remaining scatter/uv/bump/splats groups run afterward, all passing. No source
or bar changed for that confirmed system reset. Each real GPU leaf holds one
shared slot, wait-max 60; no build/unit/verify command holds a GPU lock. The
premature README request was stopped while still waiting, before any example
ran, so the consumer sequence and subsequent README run never overlap.

README execution: 112 of 121 pass, nine already listed known failures, no new
exemptions. The new named-result math example passes. Existing known failures
are retained rather than reported as passing examples. The standalone full
verify is not rerun; only failed steps and new merge-record checks are needed.

The sole failed llms currentness case passes after regeneration, completing the
13764-test result without repeating successful unit tests. Rebase onto 68a03f32c
preserves sciviz moving-flow and the new BVH/shadow alpha entries, their docs,
ceilings and histories. The math implementation, six callers, scheduler and
regressions are byte-identical to the tested 5bf38b4a9 source. Rebuild inherited
bvh/shadows/sciviz/umbrella packages, then genuinely remeasure paired entry/network
records from 559e2dba1 (dirty=false), followed by api:update. Core plus stage
remains 23924 B and math/quat 1346 B. The merged size gate, nine paired-record/API
tests, llms currentness case and documentation links pass. No successful
consumer GPU/README suite or full verify is rerun, and no metadata is relabeled.

## Readable Unity support delivery (audit finding 7)

Verified on fc20cdca6: the generator still compacted C# before embedding it and
rejected interpolated strings. Remove the compactor and embed every canonical
UTF-8/LF source byte verbatim. The public delivery API and manifest hashing are
unchanged; the installed support source now includes its comments and layout.
All canonical C# files remain untouched. A full source/embedded/delivered byte
comparison and SHA-256/length checks cover every file. A generator fixture with
documentation, directives, UTF-8, interpolated/verbatim/raw strings and block
comments proves the build imposes no C# parser subset.

Research compared the official package workflow and language grammar:

- Unity Technologies, *Unity 6.0 Manual: Create custom packages*, 2026,
  [package workflow](https://docs.unity.com/en-us/engine/6000.0/manual/packages-list/cus-pkg-development/custom-packages):
  an embedded package can contain reviewable C# source and assembly definitions.
- Microsoft C# language team / Ecma TC49-TG2, *C# Language Specification,
  section 6: Lexical structure*, living specification, accessed 2026-11-09,
  [lexical structure](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/lexical-structure):
  comments, whitespace, tokens and directives have separate rules. Do not
  implement a partial lexer just to compress delivered source text.
- Microsoft C# language team, *String interpolation*, living language reference,
  accessed 2026-11-09,
  [interpolated strings](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/tokens/interpolated):
  interpolation is standard source syntax, not a packaging limitation.

No third-party engine or companion implementation was read or copied. Canonical
native sources are Margo's existing files. Keeping them embedded avoids a new
runtime file-fetch path, asynchronous module plumbing and extra deployment
assets solely to save optional-entry bytes. The Unity entry is already separate
from the exporters root. Raise its ceiling rather than add that complexity.
Regression: packages/exporters/tests/unity-support.test.js. Existing Unity
bundle tests retain deterministic archives, unchanged GLB/atlas bytes, exact
manifest identities and isolation across calls. This proves source delivery,
not a new native Unity execution or performance result.

Validation: lint and hygiene pass, as do all 13 targeted Unity cases. The
exporters real-GPU suite passes. README execution has 33 of 35 passes, with the
two prior known failures unchanged and no new exemption; the new source-reading
example passes. Paired entry/network records measure fc20cdca6 with dirty
packages; the basic scene has five requests and no unused built files.
api:update records the changed Unity size, without an API shape change.

The original verify invocation passed hygiene, then check-gpu-policy could not
read the intentionally deleted compactor because that deletion was not yet in
Git's index. Stage the authorized deletion, rerun the failed policy step and
run all still-unrun SERIAL/PARALLEL commands exported by verify.mjs. Every step
passes, including all 13778 unit tests with zero failures, skips or cancellations.
The retained hygiene/GPU/README results are not replayed. Logs and the exact
command/result manifest are test-results/size-restore/unity-verify-remaining*;
no checker, test, tolerance or known-failure list is weakened.

Rebase onto 4e5dbdf04 preserves concurrent WebGL2 tier/post integration, its
source, docs, generated APIs, ceilings and histories. Exporter source and tests
are byte-identical to the tested restoration. The complete combined package
build passes, then paired entry/network records genuinely measure 8b5c04aab
(dirty=false), followed by api:update and llms generation. This implementation
commit remains in history; the measurement refresh is its own following commit.
Unity remains 50038 B, exporters root unchanged, core plus stage 23924 B. The
merged size gate, nine paired-record/API tests, llms currentness and documentation
links pass. Retain the successful full unit, GPU and README evidence without
replaying those suites. No record is relabeled and no timing work is introduced.
