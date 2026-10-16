# VFX unchanged-field writes — private candidate

The retained one-state simulation ends each live invocation with a full 64-byte
particle assignment. Color is unchanged except when a particle respawns. This
candidate stores only position/life, velocity/size and rotation at the end,
stores color inside the existing birth branch, and stores only position/life
when an expired particle cannot obtain an emission ticket. It preserves every
arithmetic expression, the 256-thread workgroup, global atomic algorithm,
64-byte ABI, bindings, fragment shader, capacity and public API.

At 1M live particles without births, the source no longer requires loading and
rewriting 16 MB of unchanged color in each direction per dispatch. This is a
nominal traffic calculation, not generated-code inspection or measured speed;
the compiler may already remove or combine some traffic.

Preparation command `node test-results/prepare-vfx-field-writes.mjs` completed
with exact reversible source-mutation checks and a byte-identical billboard.
Both full optional-package virtual builds used `write:false`; source and public
distributions remain untouched. Original 13,841 raw / 4,659 gzip bytes becomes
14,003 / 4,681: **+162 raw / +22 gzip**, so the current candidate fails a strict
no-growth acceptance requirement. Core/stage are untouched.

| Variant | Simulation SHA256 | Raw WGSL | Gzip WGSL |
|---|---|---:|---:|
| Original256 | `72f1d762fab9e6e5c03794a0395597c8142e71a1d023ae3faf0dfffab60de8df` | 2,722 | 1,130 |
| FieldWrites256 | `efd0b15127f85bc19cfab98b151eb80f7a608def08c04e7cb1ea60726f058328` | 2,884 | 1,154 |

Exact preparation evidence is `test-results/vfx-field-write-preparation.json`,
variant config is `test-results/vfx-field-write-config.json`, and private
bundles/source are retained alongside them. No GPU timing has run. Reuse the
existing correctness-only native headless fixture for full/sparse/empty state
word, live-ID set, indirect and respawn comparisons, with original A/A birth
variability recorded. Never replace actual alive ordering with a canonical
order to claim unchanged blended output.

Native output/state correctness does not prove sustained foreground FPS. The
Windows input desktop was Screen-saver at 19:21 UTC; an awake Default desktop,
owned browser foreground proof and controlled load are required before timing.
Exact native HDR/depth output, paired GPU/whole-scene performance and consumer
bytes remain open. No production adoption is supported yet.

## Subsequent correctness result

The native headless run completed with 36/36 no-birth A/B comparisons and
18/18 original A/A comparisons matching every state word, live-ID set and
indirect/respawn count. Single-particle accepted births also matched exactly.
Larger respawn cases changed accepted IDs and seeded state; original A/A also
varied in the larger cases, while the recorded capacity-63 A/A controls matched.
Actual alive ordering varied. These are separate results, not a blanket image
or respawn parity pass. Zero rendering, RAF and timestamp-query calls occurred;
one device and all owned resources/processes retired. No timing or adoption ran.
Full frozen evidence and limitations are in
[the correctness record](vfx-field-write-correctness-2026-10-13.md).
