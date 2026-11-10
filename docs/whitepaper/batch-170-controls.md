# Batch 170 controls work counts (2026-11-10)

The historical `p-drag-controls` and `p-arcball` rows remain slower. This change proves less work with the same
recorded output, not a measured time improvement or rival win. Timing is pending the quiet rerun.

`packages/controls/tests/workcount.test.js` fails on the parent for both counts: a 200-move drag replaces its private
carried list 200 times, and 10,000 idle arcball updates build the screen basis 10,000 times. The new counts are zero
and zero. Drag list compaction preserves order and removes disposed members; arcball still evaluates changed live
distance limits on every update. No events are coalesced, no ray casts are removed, and all moving-step arithmetic
is unchanged. No optional dependency or core/stage code changes.

The replay hashes raw Float64 camera position, target, up, moved return and change-event counts at every step, plus
Float32 engine transform matrices after every grouped translation/rotation step. It includes six arcball rigs,
pole and oblique views, immediate and damped movement, idle updates, pan, dolly, live limits, and group disposal.
The parent recorded SHA-256 is `bab1b21b918c4d8f593bd9b63e2934e782211e421b3b37a00023756bf56904fd`;
the changed implementation matches. This fixture does not certify all possible inputs; the existing controls tests
cover the other supported modes and edge cases.

Reproduce from the repository root:

```sh
npm run build:packages
node --test --test-timeout=120000 packages/controls/tests/workcount.test.js
npm run check:readme-run -- --packages=controls
```

For tonight's timing rerun use the existing scene definitions and unchanged workloads:
`npm run bench -- parity --cases=p-drag-controls,p-arcball --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5`.
Reference engines run only in their external checkout. No timing run was performed for this change.

Research compared Ken Shoemake, *ARCBALL: A User Interface for Specifying Three-Dimensional Orientation Using a Mouse*
(1992), https://graphicsinterface.org/wp-content/uploads/gi1992-18.pdf, with Patrick H. Lauke and Robert Flack (editors),
W3C, *Pointer Events Level 4* (2026 working draft), https://www.w3.org/TR/2026/WD-pointerevents4-20261008/.
Shoemake motivates preserving rotation composition; the event specification requires respecting each delivered
pointer's position and lifecycle. The implementation retains both, removing only consumed-motion calculation and
private list replacement. These are descriptions/specifications, not borrowed implementations. No other engine
source or paper companion code was read.
