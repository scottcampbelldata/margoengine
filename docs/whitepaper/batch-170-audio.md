# Batch 170 audio work counts (2026-11-10)

The historical `p-audio` result remains slower. `AudioListener.writePose` destructured three stored Float64Array
vectors; `PositionalAudio.writePose` destructured two on each of setPosition and setDirection. ECMAScript's iterable
destructuring starts an iterator per vector even though the required components are always indices 0, 1 and 2.
Indexed reads remove this semantic work. This is not a heap-allocation or time measurement; a JIT may optimize
iterator objects. No scheduling calls, smoothing, validation, clock reads or optional boundaries change.

`packages/audio/tests/workcount-replay.js` exercises 128 sources for 100 steps in each of three modes: running with
and without smoothing, and suspended. Its controlled clock advances on every currentTime read, preventing a clock
hoist or scheduling reorder from accidentally passing. The parent starts 154,500 stored-vector iterators; the new
code starts zero. Both produce 931,662 recorded automation events with the same SHA-256 of event kinds, raw Float64
arguments, observable parameter state and world vectors:
`3468f19ee9de8dea6679e6814e1b6163b2fd3441c34607da58f59b183e95d836`.
The work-count regression fails on the parent. This proves command/value identity for the replay, not PCM identity
across audio devices or a win against another engine. Existing browser tests exercise real Web Audio rendering.

Reproduce from the repository root:

```sh
npm run build:packages
node --test --test-timeout=120000 packages/audio/tests/workcount.test.js
npm run check:readme-run -- --packages=audio
```

Timing pending the quiet rerun using the unchanged scene:
`npm run bench -- parity --cases=p-audio --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5`.
No benchmark or timed comparison was run for this change.

The upstream batch 159 diagnosis also records 128,000 immediate full panner-pose writes for 64 sources over
1,000 steps, versus one scene-graph update per step in the rival adapter. This change retains that scheduling
contract. The immediate-versus-deferred workload difference remains open; removing iterators does not close it.

Research compared Paul Adenot and Hongchan Choi (editors), W3C, *Web Audio API 1.1* (2026 working draft),
https://www.w3.org/TR/2026/WD-webaudio-1.1-20260922/, including AudioParam timelines and panner/listener attributes,
with Ecma International TC39, *ECMAScript Language Specification*, living draft (accessed 2026-11-10),
https://tc39.es/ecma262/multipage/indexed-collections.html#sec-%typedarray%.prototype.values.
Boris Smus, *Web Audio API: Advanced Sound for Games and Interactive Apps* (2013),
https://smus.com/papers/2013%20-%20Web%20Audio%20API%20-%20Advanced%20Sound%20for%20Games%20and%20Interactive%20Apps.pdf,
explains the audio clock model. Preserve that clock and automation sequence; remove only iteration over fixed
storage. No external implementation or companion code was read or copied.
