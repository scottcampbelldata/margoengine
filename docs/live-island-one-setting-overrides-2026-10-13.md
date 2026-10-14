# Private single-setting live-island overrides

Root's completed full-profile ABBA at matched 1x/DPR 1/selected 1M reports
desktop 22.62/23.38 Hz and phone 27.20/27.89 Hz on the same laptop. The authored
density profile helps about 20% in that run but does not reproduce the physical
iPhone's reported 60 FPS. Those are complete-profile results; they do not assign
a saving to any individual setting below.

Five private overrides are prepared for later use **after** actual pooled GPU
pass timings identify the relevant component. No GPU, browser, build or CPU
benchmark ran during preparation; production source was not edited.

The helper `test-results/live-island-setting-overrides.mjs` requires original
live entry SHA-256
`1d096ef1af9fc7b0d505d46e70d6e5bd1ee0de906590151f3e0b156977ce9fa1`.
It composes with the existing reviewed 1x/DPR 1 helper, whose control output SHA
is `2c2e8079130c15f8363c90d5dfd02a59b9c825a57cf37ed3c48d23fe2339c598`.
Each candidate changes precisely one numeric literal in the **desktop arm** of
one reviewed callsite's ternary. It does not change the UA, mobile arm, other
authored settings, VFX source or selected-tier route. It never replaces generic
`256` occurrences. The harness must retain desktop UA, select 1M and assert actual
capacity/occupancy/pipeline metadata; preparation does not itself launch or
configure a browser.

| Helper setting | Single changed desktop value | Original literal range, end exclusive | Exact reviewed callsite |
| --- | --- | --- | --- |
| `terrain-resolution` | 192 → 96 | 289841–289844 | `o=Br(Ki,{size:[160,160],resolution:a?96:192})` |
| `heightmap-resolution` | 256 → 128 | 290502–290505 | `d=Hr.attach(e,Ki,{size:[160,160],resolution:a?128:256})` |
| `grass-count` | 110000 → 25000 | 290579–290583 | `bi.attach(e,[W(gr(3)),W(gr(2)),W(gr(1))],{count:a?25e3:11e4,` |
| `shadow-resolution` | 1024 → 512 | 295386–295390 | `d=fe.attach(e,{resolution:n?512:1024,distance:115,` |
| `water-segments` | 256 → 64 | 296026–296029 | `l=Re.attach(e,{size:[400,400],segments:n?64:256,horizon:!0,` |

These are verified callsite/token ranges in the original pinned entry, line
956, not inferred AST node identities. UTF-16 and UTF-8 offsets happen to agree
at these sites; the JSON stores both independently, plus the shifted ranges
after the shared sample/DPR rewrite. All original/common/served source hashes,
helper hashes, exact callsite fragments, intended values and override counts are
in `test-results/live-island-setting-overrides-preparation.json`. Each candidate
has one setting rewrite plus the two shared quality-control rewrites; control
has zero setting rewrites. Prepared JavaScript is emitted as
`test-results/live-island-<setting>-private.js`, alongside the control.

Call the Node helper with the original pinned source:

```js
const result = liveIslandSettingOverride(source, 'heightmap-resolution');
// result.code is the reviewed response override; result.metadata records its scope.
```

The existing GPU harness route can use this instead of its shared quality-only
override for one B condition. Do not apply it to source already rewritten: the
original-source hash guard intentionally rejects that. Preserve complete served
source/hash and metadata in the executed harness. Keep feature negotiation,
camera/time, viewport/pixels, VFX 1M, playback, focus and all other settings matched
across A/B/B/A; use separate labels for every setting. These intentional quality
changes are attribution controls, not proposed production reductions or pixel
parity claims.

## Heightmap is explicitly a coupled workload

Reducing the single authored `TerrainHeightmap` resolution also supplies Water
with a smaller terrain texture. CoastalFlow allocates its states, fluxes and
connectivity map at that texture size, so its 256x256 grid becomes 128x128.
Each of six steady flow/integration dispatches changes from 32x32 to 16x16
workgroups of 8x8 threads; three substeps and all simulation equations remain.
Grass/fieldstones and terrain wetness also sample the coarser map. Therefore a
result for this variant measures the combined heightmap/coastal/sampling change,
not an isolated texture-upload saving. In contrast, `water-segments` leaves the
256x256 map and coastal simulation grid unchanged and changes only the authored
water mesh tessellation/footprint.

## Preparation proof

Seven lightweight tests pass with zero failures. They parse the complete
original-control/candidate JavaScript without executing it, pin exact control
identity, verify original token ranges in UTF-16 and UTF-8, and compare every byte
outside the sole setting literal against the common control. They retain the UA
branch count, VFX body, direct selected-capacity/initialCount/rate route and
desktop selector default. Modified source and unknown/multiple-profile choices
are rejected. Exact reconstruction guards prevent another scene change from
being hidden in a numeric rewrite.

Tests stay private in `test-results/live-island-setting-overrides.test.mjs` so
the general package test suite does not depend on an ignored live archive.
Full results are
`test-results/live-island-setting-overrides-preparation-tests-20261013.log`.
The emitter is `scripts/prepare-live-island-setting-overrides.js`; its final
executed output is
`test-results/live-island-setting-overrides-preparation-20261013.log`.
There are no individual-setting millisecond or FPS gains to report yet.
