# Batch 169: deterministic work-count phase

No wall-clock benchmarks or budget changes. Timing pending the quiet rerun.

| Job | Package | State | Evidence |
| --- | --- | --- | --- |
| 1 | ui | DONE in `perf(ui): memoize intrinsic layout per call` | 24 to 2 leaf measurements; identical layout bytes; five Yoga oracle fixtures |
| 2 | text | DONE in `perf(text): reuse logical kerning and shaped prefix advances` | 1198 to 599 pair calls; 35 to 18 prefix calls; 35 byte-identical layouts; Canvas/Troika value oracle |
| 3 | mesh-edit | Pending | Subdivision oracle and work count |
| 4 | splines | Pending | Curve values and work count |
| 5 | terrain | Pending | Source-height and clipmap error |
| 6 | wfc | Pending | Constraint satisfaction and work count |
| 7 | procedural | Pending | Published noise values, Poisson spacing and work count |

## Job 1: UI intrinsic measurements

Cause: intrinsic sizing, flex basis, wrapped-line height and placement recursively asked
for the same node's content at the same available width. An eight-parent row chain
called its leaf 24 times, although only widths 200 and 20 were requested.
`contentOf` now memoizes by node identity and inner width for one `arrange` call.
Every placement, scroll extent, hidden rectangle and offset still runs. The cache
is local to the call, discarded after success or exception and separate for reentrant
layouts. Direct edits between calls remain visible. No core/stage bytes or imports
change. No new public export or optional dependency is added.

`packages/ui/tests/layout-workcount.test.js` requires exactly two measurements,
and hashes 64 deterministic mixed trees (rows, columns, grids, stacks, hidden nodes,
scrolling, wrapping, percentages, margins and offsets). All 40 nodes' rectangles,
content extents and scroll offsets per tree retain the original Float64 bytes:
SHA-256 `b0dffbf009a22ce56f39ccaf646440f7b52f30c0a86a27dcf2c0e96a8871c9e8`.
The hash and the 24-call baseline were captured before changing production code.
Fresh-content, failed-measurer and reentrant-call tests protect cache lifetime.

The black-box Yoga 3.2.1 harness compares the identical trees, without reading its
source: nesting depths 1/4/8 and clamped grow/shrink, 22 rectangles equal exactly.
Margo performs two leaf measurements; Yoga performs one. This is an accepted work
difference on these fixtures: Margo's arbitrary width-only measurer is asked at both
intrinsic and assigned widths; it cannot infer that a callback returns the same
height at a smaller width. Yoga's width/height constraint modes allow compatible
measurement reuse. Like for like with fully explicit leaf dimensions, both make
zero measure calls and give identical grow/shrink rectangles. This does not claim
full Yoga conformance or a speed win. Cross-call dirty-subtree reuse remains future
quality work; Margo's plain mutable LayoutNode has no dirty notification contract.

## Job 2: text layout measurements

Cause: logical layout measured each eligible adjacent pair, then visual placement
measured the same pair again. Shaped-run growth also remeasured the previous prefix
for its caret, after measuring it to create the run. The change reuses the logical
kerning only for the same contiguous source neighbors, in logical direction;
new visual neighbors still call the measurer. It retains the previous raw prefix
advance and applies font scaling and spacing in exactly the original order.
No persistent cache, new export, GPU work reduction or optional import is added.

The 600-character pair fixture falls from 1198 kerning callbacks to 599; the
18-character shaping fixture falls from 35 advance callbacks to 18. The 35-layout
corpus covers fractional spacing/size, wrapping, justification, RTL/numbers,
Arabic, Indic, CJK, combining marks, emoji ZWJ and CRLF. Every glyph, line, bound,
UTF-16 range and caret retains its bytes. The 387896-byte canonical JSON stream
(preserving negative zero with a sentinel) has SHA-256
`b671ae6317ed56c5fc4a7dfc9681af9327008300d9e28b2844bd90e8f9c99dcf`, captured
before the source change. A separate test edits a measurer between calls.

The external Troika 0.52.4 comparison uses the same pinned Source Sans 3 Regular
3.052R TTF as Canvas and Margo, with Latin ligatures enabled. Four unwrapped advance
widths match Canvas exactly: AVATAR 3.128999710083008 em; office affine waffle
7.606998443603516 em; Hello world 4.813998222351074 em; AVATAR repeated 20 times
62.50399271647135 em. Margo minus Troika selection widths are respectively
-2.384185791015625e-7, -1.430511474609375e-6, -1.9073486328125e-6 and
-8.900960288826809e-6 em. These small numeric differences are retained, not treated
as exact equality. Canvas uses browser font metrics and Troika returns Float32
selection rectangles; the per-font numerical causes have not been isolated further.
The oracle covers advance widths only, not glyph pixels, line-break equivalence,
all scripts or competitive speed. No timing was run.

## Reproduce

Build with `npm run build:packages`, then:

```sh
node --test --test-timeout=120000 packages/ui/tests/layout-workcount.test.js
```

Install `yoga-layout@3.2.1` in a separate external test directory, outside the Margo
repository, with `npm install --prefix <external-dir> --ignore-scripts --no-audit --no-fund yoga-layout@3.2.1`.
Then run the value-only harness once:

```sh
node scripts/bp-169-ui-oracle.mjs --yoga=<absolute-external-dir>/node_modules/yoga-layout
```

The runner verifies the external package name/version and prints all five results,
measurement counts and exact rectangle comparisons. It measures no time. Tonight's
quiet campaign must time the same full layout work on each side, including applying
rectangles, and separate initial layouts from unchanged or edited trees.

## Research and clean-room boundary

Compared the sizing/placement phases in Tab Atkins Jr., Elika J. Etemad and Rossen
Atanassov (editors), *CSS Flexible Box Layout Module Level 1* (W3C, 2025), sections
9.2, 9.4 and 9.7, https://www.w3.org/TR/css-flexbox-1/#layout-algorithm, with Meta's
*Incremental layout* (Yoga documentation, accessed 2026-11-10),
https://www.yogalayout.dev/docs/advanced/incremental-layout, and Thibaud Hottelier
and Ras Bodik, *Synthesis of Layout Engines from Relational Constraints* (2014),
UCB/EECS-2014-181, https://www2.eecs.berkeley.edu/Pubs/TechRpts/2014/EECS-2014-181.html.
The specification defines the repeated constraint contexts; the research motivates
functional value propagation. Yoga's persistent dirty flags need an API Margo does
not expose, so this change uses call-scoped memoization instead. Only papers,
specification and documentation were consulted; no external implementation or
companion code was read, copied or adapted.

## Job 2 reproduction and research

After `npm run build:packages`, run
`node --test --test-timeout=120000 packages/text/tests/layout-workcount.test.js`.
Install `troika-three-text@0.52.4` only in an external test directory with
`npm install --prefix <external-dir> --ignore-scripts --no-audit --no-fund troika-three-text@0.52.4`.
The rival and its dependencies stay outside this repository and are used only as
black boxes. In PowerShell, set `$env:MARGO_GPU_SLOTS='3'`, then run
`node scripts/bp-169-text-oracle.mjs --rival=<absolute-external-dir>`.
The harness holds the shared GPU lock, bounds each sync at 60 seconds and its hold
at five minutes, and prints every width and difference. Its worker is disabled
and CPU SDF is selected; it is not a rendering-speed comparison. No font is newly
copied: existing fixture provenance is in packages/text/tests/fixtures/fonts/NOTICE.md.

Compared Robin Leroy (editor), *Unicode Line Breaking Algorithm*, UAX 14 revision
57 (2026), https://www.unicode.org/reports/tr14/, and Josh Hadley (editor),
*Unicode Text Segmentation*, UAX 29 revision 49 (2026),
https://www.unicode.org/reports/tr29/, with Donald E. Knuth and Michael F. Plass,
*Breaking Paragraphs into Lines* (1981), https://doi.org/10.1002/spe.4380111102,
and WHATWG, *HTML Living Standard*, Canvas text preparation/measureText (2026),
https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-measuretext.
The text standards distinguish source segmentation, measured runs and final
placement; reuse is confined to unchanged measurement inputs, retaining Margo's
current line-breaking algorithm. Knuth/Plass paragraph optimization was compared
but not substituted for that algorithm. The rival's documented sync and selection
APIs, https://protectwise.github.io/troika/troika-three-text/, are used only for the
external value oracle. No rival implementation or companion code was read or copied.
