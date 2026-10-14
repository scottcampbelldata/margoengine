# Private VFX field-write correctness

The field-write candidate has exact no-birth state/count/set proof and deterministic single-particle accepted-birth proof on native headless Intel hardware. Generic respawn and actual alpha-blended image parity remain unresolved. No performance result or production adoption is claimed.

Root prepared three reversible storage-only changes in `test-results/prepare-vfx-field-writes.mjs`: rejected expired particles store only positionLife; accepted births store their newly assigned color immediately; final live updates store positionLife/velocitySize/rotation separately. The source simulation expressions, workgroup width 256, global respawn/live atomic algorithm, public64B particle ABI and billboard shader remain unchanged. Nominal avoided unchanged-color traffic is not inspected native GPU code or measured bandwidth/performance.

Original WGSL SHA is `72f1d762fab9e6e5c03794a0395597c8142e71a1d023ae3faf0dfffab60de8df`; candidate `efd0b15127f85bc19cfab98b151eb80f7a608def08c04e7cb1ea60726f058328`. Input config SHA `8516194512c6ba4d7671769843e772ac24c38527ed39ea7343628b1ac25a5e83`. Source file SHA `d42742af00b8d7f4d37a91b4c9b65e8071cd3c6e00f16f8a4fd6f6b6c70c1cd0`; unchanged compiled public VFX SHA `e6d1f080f91f4a623aeb38ce675b892319005d22de26ba1766f1bad588ea1a55`. Root's private write:false bundle measured 13,841/4,659 raw/gzip original versus 14,003/4,681 candidate: **+162 raw/+22 gzip**, so no package-byte-neutral proof exists.

## Authorized headless quality and respawn run

The existing minimal correctness launcher was reused with a bounded alternate-config option and exact candidate digest, without creating a new render framework. Preflight used the actual compiled public VFX constructor with a mock device to verify original shader, 64MB native state, 224B header and bindings0/1/3/4/5. Eight offline guard tests passed. The executed command was:

```text
node test-results/vfx-compaction-headless-quality.mjs --run --config=test-results/vfx-field-write-config.json --expected-candidate=efd0b15127f85bc19cfab98b151eb80f7a608def08c04e7cb1ea60726f058328 --phase=both --quality-repeats=2 --respawn-capacities=1,63,257,4097,1000000 --label=field-writes-v1
```

Verified adapter: Intel `xe-2lpg`, fallback false, Chrome155.0.8059.40, headless with no custom GPU/shader-debug flags. The current Core optional feature list was requested; guard counters prove **zero RAF, render, timestamp-query creation and query-resolve calls**. Both phases measure correctness only. Screensaver/desktop state was untouched; no idle-awake foreground/presentation/speed interpretation applies.

No-birth coverage is72 observations (six capacities1/63/64/65/257/1M, full/sparse/empty, two repeats, two variants), with three dispatches per case. All36 A/B and18 original A/A comparisons match every particle state word, complete alive-ID set, all five indirect words and both respawn words. Every1M full-live result is `[6,1000000,0,0,0]` with zero state-word differences. Actual alive order differs in8 A/B and4 original A/A comparisons. The fixture never canonicalizes IDs or treats set equality as actual draw-order equality.

Separate respawn coverage is30 observations (five capacities, three repeats, two variants), with reset input/sequence123 and a bounded birth budget. Capacity1 accepted birth matches all three A/B and both A/A comparisons exactly, including new color/state, live ID/order and indirect/respawn data. Larger cases:

| Capacity | A/B differing state words, repeats0/1/2 | Original A/A differing state words, repeats1/2 |
|---:|---|---|
|63|546 / 0 / 546|0 / 0|
|257|1,666 / 2,210 / 1,666|1,844 / 832|
|4,097|20,989 / 22,077 / 20,770|19,869 / 17,592|
|1,000,000|3,002,016 / 3,009,500 / 3,003,992|2,998,620 / 3,004,185|

Differences include accepted ID selection/seed assignment, while counts and sequence words remain equal. Baseline A/A variability shows the existing atomics are scheduling-sensitive; it does **not** convert candidate differences into an exact-parity pass. At63, two candidate comparisons differ while the two recorded baseline repeats match, so that case deserves particular care. No per-ticket seed trace or actual HDR/depth image comparison was performed. A separate all-field finite scan was not part of this fixture; every state word was compared.

All compilation/validation/page errors were absent. Native cleanup passed: one device destroyed once, zero live buffers, hooks restored, browser/server closed and all seven exact CDP-owned PIDs absent in query-only CIM proof. No other process was killed or desktop changed. Source/public distributions are unchanged.

Raw/frozen evidence: `test-results/vfx-compaction-headless-field-writes-v1/report.json`, its harness and fixture hash inventory, full stdout `test-results/vfx-field-write-headless-quality-v1-20261013.log`, and compact immutable `summary.json`, appended to `docs/afterlight-trace-runs-2026-10-13.jsonl`. The performance variant remains queued until a native awake/unlocked foreground guard is satisfied. The higher-byte grouped compaction HDR branch was deferred as root steered; no image fixture or further GPU launch was made for it.

## Distinct comment-recovery variant — gzip gate passes, quality remains partial

This later private variant removes only the 70-byte WGSL comment
`// Analytic curl of a smooth vector potential; its divergence is zero.`
from the field-write candidate. Its newline and all surrounding whitespace
remain. Three static tests prove exact reverse reconstruction of the original
source, identical noncomment simulation tokens relative to field writes,
unchanged billboard, 64-byte ABI, 256-thread workgroup and atomic algorithm.
No direct color-expression rewrite or shader minifier was added.

Candidate WGSL SHA is
`b67ea3fb564804a4b5e8e76df67a293e5f93992bce5c6ca58b5868f78083ea63`;
config SHA is
`d28c86a6c351f7d646de626d6793bfaa2d45680154b04c652805f48037cd6a27`.
The preparation records normalized-LF source hashes; the actual build report
also inventories the physical source bytes before/after.

Matched actual Vite `write:false` builds measure the optional VFX package
**13,841/4,659 → 13,933/4,632 raw/gzip (+92 raw/−27 gzip)**.
The whole current gameplay consumer includes both emitted JavaScript chunks,
summing their individually gzipped bytes:
**306,041/102,365 → 306,133/102,347 (+92 raw/−18 gzip)**.
The original field-write +22-gzip result above remains a separate immutable
variant. Gzip no-growth now passes; it proves no hardware gain. Source,
public VFX/Core distributions and all current app source hashes were unchanged
across these builds. No public output was written.

The existing headless correctness launcher then ran the exact new config on
Intel `xe-2lpg`, fallback false, Chrome155.0.8059.40, with original optional
features and no custom GPU/shader-debug flags. All72 no-birth observations
completed: **36/36 A/B and18/18 original A/A state/set/indirect/respawn
comparisons match**, including every1M full-live state word and indirect
`[6,1000000,0,0,0]`. Actual alive order differs in8 A/B and5 A/A comparisons;
IDs were retained in their actual atomic order, not canonicalized for a draw.
Capacity1 accepted births separately match3/3 A/B and2/2 original A/A.

| Birth capacity | A/B differing state words, repeats0/1/2 | Original A/A differing state words, repeats1/2 |
|---:|---|---|
|63|546 /546 /546|0 /0|
|257|2,210 /782 /1,666|2,184 /1,844|
|4,097|18,712 /19,357 /19,869|19,357 /18,712|
|1,000,000|3,002,971 /3,003,222 /3,003,323|3,009,888 /3,003,362|

Counts and respawn sequence words match in these cases; selected IDs, order
and particle state differ. Original scheduling variability at257+ is not a
blanket equivalence pass. At63 all three candidate comparisons differ while
both baseline repeats match. Generic multi-birth correctness and actual
alpha-blended HDR/depth parity therefore remain unaccepted. No image test,
native generated traffic inspection or speed measurement ran.

The run exited0 with no validation/page/cleanup errors. Guards recorded zero
RAF, render, query creation and query resolve calls. One device was destroyed
once, zero buffers remained, hooks restored and all seven exact owned PIDs
were absent. Screensaver/desktop state was untouched; physical presentation,
foreground FPS and performance acceptance were explicitly false.

Immutable evidence: `test-results/vfx-field-write-comment-size-v1/report.json`,
`test-results/vfx-compaction-headless-field-comment-v1/report.json` and its
`summary.json`, full stdout `vfx-field-write-comment-size-v1-20261013.log`
and `vfx-field-write-comment-headless-quality-v1-20261013.log`, preparation,
config and frozen executed-helper/public-distribution hashes. The summary is
appended to `docs/afterlight-trace-runs-2026-10-13.jsonl`.
**No production adoption.** Hardware performance remains queued until an
awake native foreground guard, and only after the remaining quality issues
are addressed.

## Separate live-only field-store follow-up — rejected by consumer gzip gate

One smaller follow-up preserves the original whole-record rejected-dead store
and accepted-birth final store. A local `born=false` flag is set on entry to
the original expired-life branch. Final storage is the original whole record
when born, otherwise only positionLife/velocitySize/rotation. The original
local color assignment remains in place; no early color store occurs. The same
single 70-byte analytic-curl comment is removed, preserving its newline.
Three static checks passed strict full-source reversal, original birth paths,
billboard, 64-byte ABI, 256-thread workgroups and existing atomic order. This
does not prove native scheduling or image equivalence.

WGSL SHA is
`56f2b6df66e7b089e2096c6d4795bc43bc03ac6263cd7329e1839ce2e702f542`.
Actual matched `write:false` builds measure optional VFX
**13,841/4,659 → 13,936/4,657 raw/gzip (+95/−2)** and all whole-current-consumer
JavaScript chunks **306,041/102,365 → 306,136/102,367 (+95/+2)**.
The consumer gzip gate therefore fails. The dynamic chunk gzip changes by−1
and the main chunk by+3; all chunks are included rather than choosing only
the favorable package result. All protected production source/public
distribution hashes remain identical before/after; build errors are empty.

Work stopped before native quality/respawn, GPU render, traffic inspection or
timing. No claim of improved multi-birth scheduling is made. Earlier variants
and their raw quality reports remain unchanged. No production/Core change,
variant iteration or adoption. CPU slot was released and no GPU acquired.

Evidence: `test-results/vfx-live-field-write-size-v1/report.json` and immutable
`summary.json`, complete stdout `vfx-live-field-write-size-v1-20261013.log`,
`vfx-live-field-write-static-tests-20261013.log`, guarded candidate/config,
source-reconstruction preparation, and the append-only cross-run JSONL.

## Final immutable-predicate follow-up — gzip passes, quality partial

The final private variant computes `let born=p.positionLife.w<=0;` immediately
after the original life decrement and uses `if(born)` for the original birth
block. It reuses that existing comparison once, eliminating the previous
mutable flag and assignment. Rejected-dead and accepted-birth paths keep their
original whole-record stores and local color assignment; only an already-live
particle uses the three partial stores. The same single analytic-curl comment
body is removed, with newline/other bytes preserved. Three static tests pass
full reverse source reconstruction, unchanged math, predicate count, atomic
order, 256-thread workgroup, 64-byte ABI and billboard; no early color store.

WGSL SHA: `c4c59850b6dffffa227d205a06f449992c3035a386e656b95c743168045ac692`.
Config SHA: `2a875f1a4bfaf408ee4c063dce59af0b440eac2927600d377cecb4724bbddfb0`.
Actual matched `write:false` builds: VFX **13,841/4,659→13,925/4,651 raw/gzip
(+84/−8)**; whole current consumer all JS chunks **306,041/102,365→306,125/102,358
(+84/−7)**. Both gzip gates pass; all protected source/public distribution
hashes remain identical. The previous mutable-flag consumer+2 rejection stays
immutable. A size win proves no hardware speed or native generated traffic.

The bounded correctness-only headless run completed on verified Intel
`xe-2lpg`, fallback false, Chrome155.0.8059.40, no custom GPU/shader-debug
flags. All72 no-birth observations completed:36/36 A/B and18/18 original A/A
match every state word, complete alive set, indirect and respawn words. Actual
alive-order mismatches: **8 A/B and4 A/A**.
Every1M full-live result retains `[6,1000000,0,0,0]` with zero state differences.

Separate accepted-birth comparisons at capacities1 **and63** now match exact
state/set/order/indirect/respawn in3/3 A/B and2/2 A/A each. That resolves the
previous capacity63 discrepancy for these recorded repeats; it is not a
generic scheduling guarantee. Larger births:

| Capacity | A/B differing state words, repeats0/1/2 | Original A/A differing words, repeats1/2 |
|---:|---|---|
|1|0 /0 /0|0 /0|
|63|0 /0 /0|0 /0|
|257|1,300 /0 /2,184|1,844 /1,640|
|4,097|17,385 /17,538 /12,952|18,720 /19,017|
|1,000,000|3,000,994 /3,003,802 /3,005,089|3,001,916 /2,999,648|

All birth counts and sequence words match. At257 repeat1 the candidate state
and set match but its alive order differs; other larger comparisons include
different accepted IDs/state/order. Baseline variability documents scheduling
sensitivity and does not automatically pass quality. No undocumented generic
deterministic contract is asserted. Actual alpha-blended HDR/depth comparison,
native generated traffic and hardware speed remain unmeasured.

Zero RAF/render/query creation/query-resolve calls, errors/cleanup empty, one
device destroyed once, zero live buffers and hooks restored. All **eight** exact
owned PIDs were absent in final query-only cleanup. Screensaver/desktop state
was unchanged; no physical-presentation, foreground-FPS or performance
acceptance. Source/public distributions unchanged; no adoption.

Raw/frozen proof: `test-results/vfx-compaction-headless-live-predicate-v1/report.json`
and immutable `summary.json`; actual size proof:
`test-results/vfx-live-predicate-size-v1/report.json`. Preparation/config,
three static tests, preflight and complete size/headless stdout are saved with
the `vfx-live-predicate-*` prefix. Summary appended to the cross-run JSONL.
This branch is closed after this final variant; no further hardware work
without a native awake foreground guard and separate authorization.
