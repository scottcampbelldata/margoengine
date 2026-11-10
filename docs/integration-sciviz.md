# J6 scientific dashboard integration

The `sciviz` test page combines Figure scatter, a direct PointsPlugin cloud, a
two-segment Lines path, LabelRenderer annotations, an HTML depth anchor, XYZ
loading, Compute reductions and a VideoFrame overlay. A core box shares their
depth and canvas. All calls use public package entries. The XYZ rows and static
canvas frame are authored stand-ins, not a scanner or movie-codec claim.

Run `npm run build:packages`, then
`npm run test:integration:browser -- --scene=sciviz`.
Run `npm run check:examples-types -- --projects=integration-sciviz` for types.
The shared GPU runner takes one slot, with 150 seconds per backend scene.
There are no timing assertions. Results are in
`docs/whitepaper/results/integration-j6-sciviz.json`.

Four probes match exactly before and after device destruction/replacement on
native WebGPU and WebGL2 compatibility. They also match between backends. The
XYZ parser supplies three scatter points; a fourth point and both line segments
are checked through their draw counters. Compute uses the current engine device,
reads the exact sum 20, and disposes its context before rendering; it is repeated
on the replacement device. This does not claim ComputeContext transparently
restores old GPU arrays. Label/HTML elements are removed and the shared ledger
finishes with zero live allocations, meshes and plugins. See
[shared accounting limits](integration-everything.md).

The shared readiness helper now declares its boolean predicate parameter with
JSDoc. Without that annotation TypeScript inferred `() => true` and rejected a
predicate whose result changes while resources restore. The planted TypeScript
regression in `tests/check-example-types.test.js` fails on the old inference;
runtime waiting and hard limits are unchanged. The game scene is rerun because
the helper is shared.

Clean-room basis: the WebGPU, WebGL and context-loss specifications listed in
[everything scenes](integration-everything.md), plus Microsoft, *TypeScript
Handbook: JSDoc Reference* (2026),
https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html.
The annotation expresses the existing runtime contract. No external source or
companion implementation was read or copied. Backend/GPU coverage is this PC's
RTX A6000, not a device-diversity or speed claim.
