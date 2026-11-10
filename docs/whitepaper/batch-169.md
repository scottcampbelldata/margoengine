# Batch 169: deterministic work-count phase

No wall-clock benchmarks or budget changes. Timing pending the quiet rerun.

| Job | Package | State | Evidence |
| --- | --- | --- | --- |
| 1 | ui | DONE in `perf(ui): memoize intrinsic layout per call` | 24 to 2 leaf measurements; identical layout bytes; five Yoga oracle fixtures |
| 2 | text | Pending | Canvas measurement and text layout |
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
