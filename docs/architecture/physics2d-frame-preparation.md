# Exact frame-preparation checks in the 2D kernel

Two changes avoid evaluating predicates whose result is already known. They preserve public input
validation, derived-overflow refusal, the contact graph, every physical operation and its evaluation
order. They change no setting, scene, accuracy predicate or production hash.

## Bounds after current-step preflight

`World::step` validates every body pose. Its complete `shape_marks` ownership witness validates every
shape exactly once and proves that each shape names its in-range owning body. `validate_shape` includes
the same core validation used by public `bounds_of`. The sole private `broad_phase` call follows this
preflight with only dt, count and step bookkeeping in between. Exclusive access to the World and plain
value inputs expose no callback that could mutate the validated core or pose.

The private `bounds_from_validated` helper therefore receives the same current core and transform that
preflight checked. It retains the original transformed-vertex, min/max and radius expressions verbatim,
including the final finite check on the derived AABB. Finite inputs can overflow when transformed or
expanded; those cases still return `ArithmeticOverflow` before the broad tree receives that bound.

Public `bounds_of` still validates core first and pose second before delegating. Creation and append
paths still use that checked public function. Mutating a public body or shape between steps gains no
certificate: every positive step performs current-data preflight again. No validity flag survives a
mutation, frame or API call. An arbitrary malformed private-helper argument is outside this caller
contract; the public function and step remain the checked entry points.

## Lazy eligibility of rejected support components

The support planner visits connected components of its active dynamic-contact graph. For one component,
`valid` starts true and can only become false. Its degree, joint and fixed-domain predicates are pure
conjuncts. `fixed_domain` reads validated contacts/shapes and immutable step-start bounce data, returns
a boolean, and neither mutates state nor emits a Result.

Changing the three eager `valid &= predicate` updates to `valid = valid && predicate` preserves their
final conjunction. When valid stays true, the same predicates run in the same order. Once false, later
pure conjuncts cannot change the rejected outcome and need not be evaluated.

Every DFS body/edge visit, visited mark, member and terminal collection remains unconditional, even
after rejection. Seeds, component ownership, accepted path/range ordering and all path arithmetic stay
unchanged. This traversal is essential: stopping at the first bad vertex could split a rejected
component and falsely accept a later seed. A rejected component sharing a static ground with a separate
valid column also cannot reject that column. Neither a global branch test nor world island labels
replace the planner's component ownership.

Only actual validated solver inputs are in this proof. Invalid private indices/counts that could panic
are not newly accepted public inputs: current preflight and solver construction certify those accesses.
All public malformed-input regressions remain required. These are our own dataflow/boolean proofs;
the external formulation literature is cited in the solver/support design studies rather than credited
with these implementation-specific implications.

## Complete-step profile used to select the work

The profile freezes the finite-certificate baseline, matching pushed `fc88da420` physics. It compares
matched uninstrumented/instrumented modules at 17 phase boundaries, with no per-row clocks. Both pass all
three explicit unsigned hashes and shipped checks. Node's first 100 steps and every corresponding
measured browser step match their body/contact/cache state and public work fingerprints. The unchanged
pyramid retains 14,950 constraints, 119,600 block visits, eight colours and 5,050 awake bodies.

Eight alternating rounds per browser retain 40 complete measured steps after the original 60 settling
steps. Phase shares divide each phase's sum by the outer elapsed sum for the same 320 instrumented
steps. No sum of independently selected phase minima or medians is presented as a complete step.

| Aggregate phase share | Edge 157 | Firefox 157 |
|---|---:|---:|
| Solver setup | 22.132% | 24.056% |
| Support planner | 10.938% | 15.318% |
| Narrow phase | 14.278% | 10.422% |
| Biased solve | 13.978% | 11.159% |
| Relax solve | 13.623% | 9.910% |

The support-planner boundary also includes adjacent snapshot/observer allocation setup; its share is not a graph-only cost. The planner is called once per step but accepts no component and attempts no correction in this scene.
The profile identifies preparation work worth auditing; it does not establish a speedup from either
change. Host aggregate CPU busy was 99.2917%. Absolute profile times must not replace the separate
browser/rival benchmark rows.

The instrumented step makes 39 verified imported clock calls. Approximate clock-minus-empty-loop median
costs are 153.2 ns per call in Edge and 76.1 ns in Firefox; the empty loop also has observable checksum
and conversion work, so this is not an exact isolation of import cost. No estimate is silently
subtracted. Outer-minus-phase-sum median residuals are 0.010 and 0.020 ms. Whole-step paired
instrumented/control ratios have medians 1.0284 and 0.9667, with broad overlapping quartiles. Imports,
bookkeeping, static layout, optimizer changes and post-timer state reads all limit attribution.

The first diagnostic attempt failed before collecting timed samples because its harness formatted Wasm
i64 pins as signed integers. Directed u64-normalization assertions fixed that harness representation;
the original failed record remains. No module, expected pin or physical predicate changed.

## Acceptance and measured work

The combined frozen candidate passes all 78 native unit/shadow cases, native integration/input/domain and
retained-reference manifold suites, shipped Wasm checks and all 29 physical bars. All three current pins
remain unchanged. Public malformed-input errors and the mandatory 1:1000 support bar remain required;
owned-2D CCD stays separate T-11 / 127.y.

The immutable eager planner control and lazy candidate compare exact DFS/edge traces, active workspace
arrays and Plan paths/ranges/weights/gaps bits, including retained-state transitions and disconnected
valid columns beside rejected components sharing static ground. On unchanged frames 60 through 99,
actual test-only fixed-domain call counts fall from **382,554 to zero** while **1,192,000 adjacency-edge
traversals** remain identical. These are predicate evaluations, not dynamic machine instructions.

Separate uninstrumented release LLVM proves the eager control's aggregate false value does not guard
the domain loop. The candidate branches around its pure degree/joint/domain reads and rejoins the
unchanged traversal. No test counter or eager reference is emitted in release code; instrumentation
counts alone are not used to infer that the optimized production binary avoids work.

The native emitted broad-phase refit calls the derived-only helper rather than public checked bounds.
Branch-inclusive static callee inventories are fabs calls **37 to 1**, floating comparisons **38 to 1**,
and branches **42 to 12**. These are not per-quad dynamic instructions. In shipped Wasm the two observed
bounds callees retain the same static physical add/multiply/subtract totals **26/32/10**; the derived
finite refusal remains. Native vectorization and code layout also change, so no whole-native-callee
instruction-only or layout-independent timing claim follows.

The [frame-preparation diagnostic record](../whitepaper/results/physics2d-frame-preparation-20261108.json)
retains constituent source/log identities, emitted code evidence, combined acceptance and every timing
round. The separate [portable profile bundle](../whitepaper/results/physics2d-step-profile-20261108/README.md)
contains the exact instrumentation patch, own diagnostic/harness sources, original failures, raw vectors
and a source-only archive reproducer pinned to fc88da420. It requires no existing ignored lane files.

## Paired and browser measurements

One process alternates 24 fresh unchanged 100-row scenes per artifact, preserving 60 settling and 40
sampled steps, all three explicit pins and 5,050 awake bodies on every visit. At 73.01% aggregate host
CPU busy, old/new minima are 4.8228/4.6899 ms. The paired candidate/control ratio median is
0.870453 (IQR 0.77345 to 0.92358), with 20/24 faster; paired difference median
-0.8156 ms. This favors the combination in this session, without assigning a timing gain
to either constituent or establishing quiet release speed. Source paths, compiler and layout can affect timings.

Twelve-round browser minima, in milliseconds, follow. Before and after are separate changing-load sessions;
their difference is not a controlled speed claim. Rivals remain external black boxes and scenes are unchanged.

| Browser/backend | Before Margo / Box2D v3 / Rapier | After Margo / Box2D v3 / Rapier |
| --- | --- | --- |
| Edge 157 WebGPU | 4.065 / 1.500 / 8.855 | 4.730 / 1.635 / 12.700 |
| Firefox 157 WebGL2 | 4.420 / 1.420 / 10.460 | 4.140 / 1.440 / 8.280 |

Available Edge WebGPU/WebGL2 and Firefox WebGL2 retain the current pins; Firefox WebGPU has no adapter.
The Box2D browser goal remains unmet. Quiet release reruns remain required; no accuracy bar is reduced.
