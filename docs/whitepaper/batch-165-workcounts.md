# Batch 165: loaders, decoders and exporters

## Job 1: Cube LUT parsing, row 10.21

Fix commit: `perf(tonemap): stream Cube lines and validate samples once`.
The historical 2.61x loss remains historical; timing pending the quiet rerun.
No benchmark was run for this change.

The pre-change parser first split the complete text into an array of lines,
allocated a comment-split array per line, and scanned all RGBA samples again
after checking every RGB conversion. The parser now locates each newline and
comment with indexOf, retains one token array per nonempty row, checks RGB
at conversion, writes alpha 1, and validates the domain separately. The public
validator still scans all samples of externally supplied LUT objects.

For an N-sample file with a size header, a comment on each sample and a final
newline, split-array counts fall from 2N + 4 to N + 1. Finite checks fall from
7N + 9 to 3N + 9. At size 33 (N = 35,937), these are 71,878 to 35,938 arrays
and 251,568 to 107,820 checks, removing 143,748 output-element reads. These
count calls to String.prototype.split and Number.isFinite, not hidden runtime
allocations or allocated bytes. The returned RGBA array remains 574,992 bytes;
there are no worker messages or new optional imports. The same JavaScript
number conversion, Float32 rounding and input limits remain in effect.

The optional tonemap root measures 12,490 to 12,598 B minified gzip (+108 B).
Its prior ceiling of 12,561 B is raised to 12,976 B using the normal 3% headroom,
under Scott's 2026-11-10 optional-entry rule. The bytes remove a text-sized
line array and the redundant sample reads. A separate entry could not remove
the existing synchronous root parseCube API without an API change; an async
load would change its contract. Core and stage are untouched.

`packages/tonemap/tests/cube-workcount.test.js` fails against the pre-change
parser (size 2: 65 finite checks rather than 33). It proves these counts for
sizes 2, 17, 33 and 65 and compares all output bytes with independent Float32
expectations. SHA-256 records captured from the parser at
`fb8ac941da7a6aaee731e85a02b0ef46d4f5df58` additionally preserve varied
signed-zero, subnormal, exponent, near-maximum and high-precision inputs with
BOM, CRLF, quoted hashes, inline comments and a missing final newline. Existing
cube-sizes tests retain malformed syntax, hostile counts, range and manual-LUT
validation coverage. No speedup over a rival is claimed.

Reproduce correctness and counts after building packages:

```sh
node --test --test-timeout=120000 packages/tonemap/tests/cube-workcount.test.js packages/tonemap/tests/cube-sizes.test.js
npm run check:readme-run -- --packages=tonemap
```

For tonight's permitted quiet run, retain the existing p-cube-lut workload and
both rival backends; run the row command in perf-vs-threejs.md. It is not part
of the current correctness gate.

## Job 2: STL export skips unused world normals, row 11.2

Fix commit: `perf(exporters): skip unused world vertex normals in STL export`.
The 2026-11-10 `p-export-mesh` diagnosis named scene normalization and
`toWorld` among the costs. STL writes one facet normal per triangle, computed
from the transformed positions, so the per-vertex world normals `toWorld`
built for it were never read. `toWorld` now takes an `includeNormals` flag;
STL passes `false`, OBJ, PLY and the other writers keep the default.

For a drawable with V vertices, STL export no longer allocates the 3V-element
Float64 world-normal array, no longer builds the normal matrix (3 basis-length
calls) and no longer normalizes V vertex normals. Input normals are still
validated, so non-finite normals still reject. On the test mesh (4 vertices,
2 triangles) three-component `Math.hypot` calls fall from 13 to 9 and
12-element Float64 arrays from 2 to 1. Binary and ASCII STL bytes for both
up axes, and OBJ and binary PLY bytes, keep their pre-change SHA-256 values.

`packages/exporters/tests/stl-workcount.test.js` fails against the parent
(13 length calls, not 9) and passes with the change. No benchmark was run;
the historical row 11.2 loss stays recorded until the quiet rerun.

```sh
node --test --test-timeout=120000 packages/exporters/tests/stl-workcount.test.js
```

## Clean-room sources

### Blocking compatibility correction

The required custom-curve compatibility GPU test found that WGSL `log2(x)--12.0`
was rejected as decrement, although it is subtraction followed by unary negation
in expression context. The fix belongs to webgl2-compat's parser: it consumes
one minus at a time in expressions without shifting the remaining token array,
and retains decrement tokens for statements and for-update clauses. Tonemap's
shader text and arithmetic remain unchanged. The parent-failing
`packages/webgl2-compat/test/wgsl-minus.test.js` checks constant values, source
spans, unary chains, multiplicative operands, valid decrements and malformed
inputs. No public API or core/stage change is involved.

Sources compared before the parser correction:

- Alan Baker, Mehmet Oguz Derin and David Neto (editors), *WebGPU Shading
  Language* (W3C, 2026), section 3.1:
  https://www.w3.org/TR/2026/CRD-WGSL-20261106/#parsing.
  Token selection depends on valid lookahead in the current parser state;
  the longest lexical token alone is insufficient.
- Robert J. Simpson (editor), *The OpenGL ES Shading Language 3.00*, revision 6
  (Khronos, 2016), sections 3.7 and 5.1:
  https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf.
  GLSL's token and increment-expression rules cannot be substituted for the
  WGSL source grammar when translating to GLSL. No external implementation
  source was consulted.

### Cube parser research

- Adobe Systems Incorporated, *Cube LUT Specification 1.0* (2013), sections
  5 and 7: https://kono.phpage.fr/images/a/a1/Adobe-cube-lut-specification-1.0.pdf.
  Line-local headers, decimal syntax, red-fastest RGB data and domains define
  what may be streamed. Margo retains its documented 2-65 and Float32 limits.
- Daniel Lemire, *Number Parsing at a Gigabyte per Second* (2021):
  https://arxiv.org/abs/2101.11408. Numeric conversion requires correct rounding;
  this change retains JavaScript Number rather than introducing a decimal
  accumulator that could change the output bits.
- Noble Mushtak and Daniel Lemire, *Fast Number Parsing Without Fallback*
  (2023): https://arxiv.org/abs/2212.06644. Removing redundant numeric work
  requires a correctness argument. Here every sample is already checked after
  Float32 rounding, and alpha is a finite constant; external mutable objects
  still require a complete scan. No parsing algorithm or code was copied.

Only the papers' descriptions and the format requirements were consulted.
No companion implementation or external engine source was read.
