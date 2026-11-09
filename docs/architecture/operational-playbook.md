# Engine architecture and quality reference

## Purpose and authority

This document preserves the engine-specific technical design, validation model, measured limits, and known gaps that
were previously mixed with repository coordination instructions. It does not define task assignment, branches,
integration, publishing, or source-control operations. Those are external workspace responsibilities.

The implementation and focused tests are authoritative when this document disagrees with current code. Most detailed
measurements below were audited at commit `67ca53a5` on 2026-10-29. Later committed records supersede those snapshot
values. Status words mean:

- **Enforced**: executable code or a test rejects a violation.
- **Verified**: the cited implementation or test was inspected.
- **Measured**: a committed result records the value and conditions.
- **Documented**: the contract exists, but this document does not claim a live run.
- **Unverified**: a known evidence gap.

## 1. Deterministic transform kernel

### 1.1 Components and build

| Path | Responsibility |
| --- | --- |
| `packages/kernel/Cargo.toml`, `Cargo.lock` | Rust crate `margoengine-kernel`, built as `cdylib` and `rlib`; release uses `opt-level = 3`, fat LTO, one codegen unit, aborting panics, no overflow checks, stripped symbols. |
| `rust-toolchain.toml` | Pinned minimal Rust toolchain and `wasm32-unknown-unknown` target. |
| `packages/kernel/src/lib.rs` | Layout, transform evaluation, constraints, bounds, culling, exports, and native unit tests. |
| `scripts/build-modern.js` | Cargo build, Binaryen optimization, validation, compression, and generated embedding. |
| `packages/core/src/wasm.ts` | Generated raw-deflate payload encoded as base64. Consumers need no Rust toolchain. |
| `packages/core/src/kernel.ts` | `TransformStore`: instantiate, bind typed-array views, grow, tick, and report errors. |
| `packages/core/src/engine.ts` | Slot allocation, public transform setters, per-frame tick, and instance updates. |
| `scripts/kernel-opt-experiment.js` | Historical optimization experiment. It is currently stale; see known gaps. |

The source build runs Cargo for `wasm32-unknown-unknown` with SIMD enabled, then `wasm-opt` with `-Oz`,
`-ocimfs 300`, SIMD, bulk memory, non-trapping float-to-int support, stripped metadata, and convergence. The normal
package build can instead decode the checked-in payload. Both paths validate the module, enforce raw Wasm under
30 KiB, compress with raw deflate at level 9, and verify a lossless round trip. At the audit snapshot the payload was
9,011 bytes raw and 3,435 bytes before base64 after deflate.

`npm run modern:build` rebuilds from Rust. `npm run build:packages` uses the checked-in payload. `npm run test:kernel`
runs `cargo test --locked`. The `rlib` target lets native tests execute the same algorithms with owned vector storage.

### 1.2 Linear-memory contract

One Wasm instance owns one fixed-capacity kernel. The kernel allocates a float region followed by a byte region at an
aligned `__heap_base`; tick performs no allocation. Capacity is limited to `2^23` so the layout remains below the
wasm32 4 GiB address space.

Constants at the audited layout:

- `TAIL = 24`, `DATA_LANES = 86`, `FLAG_LANES = 7`.
- Float lanes: translation 0-2, quaternion 3-6, scale 7-9, parent 10, world matrix 11-26, local sphere 27-30,
  world-sphere structure-of-arrays 31-34, planes and Euler storage 35-37, limits 38-49, scratch matrix 50-65,
  scratch sphere 66-69, and snapshot 70-85.
- Flag lanes: active 0, visible 1, constrained 2, hidden 3, hierarchy depth and inherited-hidden bit 4, tick state 5,
  changed 6.
- The constraint mask uses bits 0-2 for translation and bits 3-5 for Euler rotation (`ROTATION = 56`).

| Region | Indexing and shape | Producer |
| --- | --- | --- |
| Translation, quaternion, scale | `lane * capacity + id`, one structure-of-arrays lane each | JS setters; rotation sync may rewrite quaternion |
| Parents | `10 * capacity + id`, parent id stored as f32, `-1` for none | JS hierarchy setter |
| World matrices | `11 * capacity + id * 16 + element`, column-major | Kernel publish pass |
| Local spheres | `27 * capacity + id * 4 + component` | Geometry-bound setup |
| World spheres | Four structure-of-arrays lanes at 31-34 | Kernel publish pass; suited to four-wide SIMD culling |
| Frustum planes | First 24 values of the lane-35 region | Camera update |
| Euler XYZ | After the 24 plane values, `id * 3 + axis` | JS rotation setter; constraints |
| Limits | After the same tail, 12 values per entity: min/max for translation and Euler axes | JS constraints |
| Scratch matrix and sphere | Per-entity blocks | Kernel staging only |
| Snapshots | 16 values per entity | Kernel bitwise change detection |

The layout costs 351 bytes per slot: 86 f32 lanes plus 7 flag bytes. A committed measurement recorded 352.1 bytes
per slot at 1,048,576 slots. Core adds approximately 5 bytes per slot for the host-side seen and slot arrays. The
mixed layout is deliberate: streamed values and culling spheres are structure-of-arrays, while records copied whole
are per-entity blocks.

`kernel_new` is the only allocator. On wasm32 it owns one static kernel per instance, grows linear memory by pages,
zeros storage, initializes parents to `-1`, and returns null on invalid capacity or allocation failure. `kernel_data`
and `kernel_flags` expose byte offsets; JS constructs all typed views from those offsets. Bounds checks are omitted
only where the layout proves safety. Value, hierarchy, capacity, and finiteness checks remain.

The numeric layout constants are duplicated in Rust and TypeScript. There is no direct generated or compile-time
comparison between those lists; behavioral tests are the current drift detector.

### 1.3 Slot allocation and growth

Removed ids enter a LIFO free list and are reused before the monotonic `next` id advances. A new slot resets
translation to zero, quaternion and scale to identity, parent to `-1`, constraints and hidden state to zero, and Euler
values to zero. Geometry later supplies bounds.

When an id reaches capacity, the store doubles up to `2^23`:

1. Copy every current view out of Wasm memory.
2. Drop the static kernel instance.
3. Bind a larger kernel at the same base address, growing linear memory if required.
4. Recreate every typed view and restore each old view as a prefix.
5. Rebind every live mesh matrix subarray.
6. If the larger bind fails, rebind the old capacity, restore all copies, and rethrow.
7. Mark the new kernel for one full recomputation.

Old views must never be retained across growth. A memory grow detaches their buffer; without a memory grow they still
alias a layout whose column offsets changed. Growth copies about 351 bytes per existing slot and has no isolated
committed timing.

### 1.4 Change detection, hierarchy, and atomic publication

There are no descendant dirty lists. Each entity has a 16-lane bit snapshot containing translation, quaternion,
scale, parent, local sphere, and hidden state. Comparing bits means signed zero and NaN payload changes are visible.
All four four-lane groups are visited even if an earlier group changed.

A tick proceeds as follows:

1. With culling enabled, validate all 24 frustum-plane floats.
2. Validate every constrained value and min/max pair; all must be finite and `min <= max`.
3. Clamp constrained axes. If an Euler axis changed, synchronize its quaternion through the kernel's one XYZ
   expansion.
4. Clear per-tick state.
5. Visit active ids in order. Resolve a parent recursively before its child, memoize completed work, reject cycles,
   reject invalid or inactive parents, and enforce depth at most 64.
6. Recompute when the snapshot changed, the full flag is set, or the parent was recomputed. Write only to scratch.
7. If every active hierarchy succeeds, copy changed scratch matrices and spheres to published regions and set sticky
   changed bytes. A failure publishes nothing and sets the next tick to full.
8. Set initial visibility from local and inherited hidden state, then optionally cull.

Parent composition uses the parent's scratch matrix, which always contains its last computed value. Local TRS is
validated for finite values, nonzero scale, and nonzero quaternion. Quaternion normalization and affine composition
accumulate in f64 and publish f32. The final matrix and transformed sphere must be finite.

World-sphere centers are transformed normally. Radius uses `r * sqrt(norm1 * normInfinity)` of the world matrix's
3x3 part, a conservative spectral-norm bound under non-uniform scale and shear. Culling tests six planes and keeps a
sphere that touches a plane. SIMD handles groups of four, with a scalar remainder. The implementation remains linear
in active entity count; no spatial index is present.

Euler XYZ radians share the tail region after the planes. The kernel owns the single `qX * qY * qZ` expansion and a
deterministic sine approximation: range reduction by tau plus an 11-term f64 Taylor series. A direct Euler write and
a constraint clamp therefore produce the same quaternion bits. One unverified edge remains: native `f64::round`
and Wasm `nearest` differ at exact half-way turn reductions.

`kernel_tick` returns 0 on success, `id + 1` for an invalid entity, and `capacity + 1` for an invalid frustum. The
host converts these to coded range errors. Scratch-first publication and the full-after-failure flag make updates
atomic.

### 1.5 Host bridge and frame loop

Public transform setters validate before writing directly into Wasm-backed arrays. Translation, scale, quaternion,
parent, and visibility setters make no per-entity tick calls. Euler writes call `kernel_sync_rotation`; a multi-axis
`.set` synchronizes once. Quaternion writes normalize without array iteration or `map`, then update Euler lanes in JS.
`Engine.writePoses(ids, poses, count)` (extension surface) is the bulk form of `setPosition` plus `setQuaternion`: it
checks every row (a live slot by the `active` column, values finite as float32, a nonzero quaternion) before writing any,
then writes the same bits, as both go through one `storeQuaternion`. It looks no mesh up, so its callers drop ids of
disposed meshes. `@margoengine/physics/next` writes its awake root bodies through it, one call a sync.

Each rendered frame:

1. Runs plugin pre-update, resize, and camera update.
2. Copies 24 camera-plane floats into the store.
3. Calls `kernel_tick` once per drawn view, plus the main camera after a multi-view frame where required.
4. Performs a full instance collection after structural, scene, layer, or material changes (every row then counts as
   changed).
5. Otherwise scans one visibility byte per slot against the last frame's: a mesh shown takes its batch's next row, a mesh
   hidden gives its row to the batch's last row (24 floats moved, the moved mesh's slot updated from row float 23); then
   finds sticky changed bytes, clears them and copies only those matrices into their rows. Each changed row sets its bit
   in the batch's `rows` bitset and counts in `dirty`. The batch's `mask` counts its drawn rows that need back faces
   (double-sided or mirrored, read from the row itself), so hiding or unmirroring the last such row puts the batch back on
   the back-culled pipeline (`tests/core-material-setters.test.js`).
6. Uploads each batch's changed rows once (`uploadRows`: one `writeBuffer` for each run of neighbouring set bits, clamped
   to `count`, no sort and no allocation).

There is no per-entity Wasm call during a normal tick and no kernel allocation in tick. Host work still scans one
visibility byte per slot and copies each changed row. A culling flip costs 2 map lookups, 24 floats and 96 uploaded bytes;
at 50,000 boxes with 500 flips a frame that is 1,000 lookups and 48 KB instead of a full collection's 100,000 lookups and
4.8 MB (counted in `tests/core-instance-cache.test.js`, which also proves on 200 random frames of flips and moves that the
uploaded rows equal the instance rows and the drawn set is exact). Row order inside a batch therefore depends on the order
of flips, which changes draw order among one geometry's instances: identical opaque pixels except an exact depth tie. Several
cameras on one scene flip most rows and then cost what a full collection costs. The WebGL2 renderer still uploads
`[0, count * 24)` every frame. The cost of `kernel_sync_rotation` has not been isolated.

`@margoengine/stats/phases` times these steps from outside core: step 3 is its `tick`, steps 4 and 5 are its `cull`,
and it reads the frustum test as part of `tick`, because the test runs inside `kernel_tick`. It wraps `store.tick`,
`createCommandEncoder` and `queue.submit` and adds two frame graph passes, so a change to this frame order must keep
`packages/stats/test/phases.test.js` and `scripts/test-stats-browser.mjs` in step.

`@margoengine/scene` adds no kernel entry and no core bytes. `TransformWriter` (`/bulk`) writes the columns the setters write, from
typed arrays, with validation and column lookups once per call; Euler rows still go through the mesh's own `syncRotation`, so
`kernel_sync_rotation` runs once per row. A bad value or a disposed mesh changes nothing. The scene helpers read the store and
its parents, so a world value is right before any frame. A change to these columns or to the setters must keep the package in
step. Evidence: `packages/scene/tests/bulk.test.js` (bit for bit what the setters give, world matrices included) and
`packages/scene/tests/scene.test.js` (against the Wasm kernel's matrix, mirrors and uneven parents included). Measured,
diagnostic, Node, 10,000 meshes: positions 0.12 ms against 0.59 with setters (perf-history entry 70). Missing: a quiet run, and
the whole frame with thousands of moving meshes.

### 1.6 Kernel evidence and limits

The native and host suites cover:

- TRS, atomic failed updates, culling at plane contact, inactive slots, hierarchy composition, cycle rejection,
  depth, constraints, inherited hiding, exact changed sets, rotation synchronization, layout edges, signed zero, NaN
  payloads, all snapshot groups, and failed-tick recovery.
- An oracle in `tests/core-dirty-transforms.test.js`: incremental results match a fresh full recomputation bit for
  bit, including growth, 1% moving entities, 63-deep chains, removal, reuse, and one million entities.
- Growth preserves every value and replaces views; invalid capacities and failed growth leave state unchanged.
- `setQuaternion` creates no arrays across 1,000 calls.
- Build-time Wasm validation, compression round-trip, 30 KiB raw limit, and the combined core-stage size gate.

Recorded snapshot values: unchanged tick about 3.3 ms at 100,006 entities, 20.2 ms at 499,992, and 41.5 ms at
1,000,012, roughly 41 ns per entity per frame at the largest point. Above 1,048,576 slots was not measured. Initial
capacity is 1,024 and the enforced cap is 8,388,608.

Bit-for-bit claims are scoped. Incremental versus full recomputation is verified on the same Wasm. Cross-machine
kernel equality is expected by design but unverified. JavaScript's approximated `sin`, `cos`, `pow`, `hypot`, and
related functions are not promised to have the same final bits across JS engines.

Known kernel gaps:

- No gate proves that checked-in `wasm.ts` was rebuilt from current Rust source.
- Native Cargo tests do not execute the Wasm SIMD paths; JS tests execute the checked-in Wasm.
- No direct cross-machine kernel-bit test and no focused kernel fuzz target.
- `scripts/kernel-opt-experiment.js` expects the old compression and 70-float/5-flag layout; it must not be treated as
  runnable evidence until updated.
- The native/Wasm half-way turn-reduction rounding difference is untested.
- Growth and one rotation-sync bridge call lack isolated cost measurements.

### 1.7 Physics kernel

A second Rust kernel, the own rigid-body solver, is being built behind `@margoengine/physics/next`. Rapier stays the default until the switch. It shares the transform kernel's pattern, not its code. Its narrow phase runs once a step, before islands, over pairs with an awake body: manifolds of up to four points live in rows of the world, so a snapshot carries them, and hulls are rows too, held for the world's life. Boxes and hulls go by the separating axis test; anything with a ball or capsule goes by GJK distance and an expanding polytope. Two bodies count as touching, for islands and sleep, when their pair holds points, no longer when their fat boxes overlap. Evidence: both paths against brute force in doubles on random poses, native; Wasm through the replay. Each point keeps a normal impulse, a tangent impulse as a world vector and a friction drift from step to step, by feature id and then by place, in rows of the world, so a snapshot carries them. A clipped face of more than four points reduces to the four of largest area with the deepest always kept; last step's ids and feature win ties, so a resting pile does not swap points on noise. The solver is soft step: per substep, velocities, warm start, 2 biased passes, poses, the friction drift tallied from the speeds the poses moved with, as many relax passes as biased ones, restitution. Within a pair the normal rows of the manifold sweep to convergence each pass and friction takes one sweep; the relax pass solves the normal before friction, so friction's cone is the normal the relaxed contact holds (2026-11-07: a drift tallied inside the relax pass saw speeds the points before it had changed and left a resting block's anchors twisted, creeping 2.1e-6 m in 5 s; one relax pass left the anchors' push in a 14-row pyramid, which rocked; one normal sweep let the first point take a whole strike, so a cube dropped flat spun and slid; evidence `a_block_slides_at_its_rate_from_release`, `a_cube_dropped_flat_lands_flat`, the pyramid and dominance tests, native, Wasm through the replay). A four-point manifold ends each sweep with the exact step along the one impulse pattern that moves no body (its points' shares of one load), which Gauss-Seidel settled only by the leak, about 3 percent a sweep, so soft passes used to run out at 16 sweeps; they now settle in about 4 (2026-11-08, perf-history 80, counted with `--features counts`). A ball's or capsule's gap within a step is read from its core plus its radius along the normal, so a rolling ball's point stays on the floor (2026-11-08: fixed to the ball it rose r (1 - cos a) and the ball ran 0.33 percent fast; evidence `a_ball_rolls_from_rest_at_five_sevenths_of_g_sin_t_on_thirty_degrees`, native, Wasm through the replay), and a strike seen across an open gap notes gravity's gain over the gap (`a_ball_bounces_to_e_squared_at_four_substeps_of_one_pass`). Inside the slop a biased pass closes a point rigidly to the slop's depth, a speculative row of (gap + slop) / h as in Catto's Solver2D soft step, so a loaded point no longer sinks faster than a light one and a cube on a slope below tan t = mu holds from release (2026-11-08, `a_cube_released_on_a_slope_below_tan_t_equal_to_mu_holds_from_its_first_second`, native, Wasm through the replay). One pass a substep does not settle a deep pile at a quarter of the substep rate, so at one pass a contact between two dynamic bodies that neither dominates takes an eighth of the rate (Catto's Solver2D advice to keep the stiffness well below the step rate) while it carries under 50 times the lighter body's weight (`CHAIN_LOAD` in `solver.rs`); the ground, kinematic and dominant bodies and heavier loads keep the quarter, so a 1:1000 stack sags as before. The 20-row pyramid at 4 substeps of one pass sleeps at 2.28 s, 30 rows at 2.03 s; at two passes or more the code path is the old one, bit for bit (2026-11-08, `a_pyramid_settles_at_one_pass_a_substep`, native, and the harness in Node). Before that change: 8 substeps by default, one pass more than the plan and twice its substeps, because 4 substeps and 1 pass let a 20-row pyramid creep 20 cm and throw a 1:100 stack (build record, batch 124). Evidence: every proof native with sleeping on and off; Wasm through the replay. Missing: speed against Rapier, which batch 129 measures.

Joints are one six-axis row class: each axis along or about frame A is locked, limited, driven or free. A substep runs rows, warm start, settling passes, one pushing pass, poses, rows again, a relaxing pass. Locks along a path of joints are solved exactly by a Cholesky factor in doubles, from Householder QR of M^-1/2 J^T joint by joint; a path nothing leans on closes its whole error and relaxes on rows from the new pose, the two stages of RATTLE. Where a branch or a ring ends a path, paths meet by block Gauss-Seidel at a share of 0.2. Only the pushing pass carries a position bias, and the warm start does not remember it: remembering it makes every mode the passes have not settled a triple integrator with the error as its only feedback, which grew an 8 by 8 grid to 1.5 m of gap and 100 m/s (`docs/clean-room.md`, PK24). This is a rule of the step: a row with a rigid position bias keeps its bias out of its memory, or it has a gamma term of its own, as motors and contacts do. Evidence: closed forms for a swung bob and a parallelogram, energy of a double pendulum, a 50-link 1000:1 chain, grids to 30 by 30, native; Wasm through the replay, whose scene now holds joints of every locked kind. Missing: a lock's turning arm is read at the start of a substep, so a light link under a large pull is an explicit spring and a 50-link chain laid level under a 1000:1 end mass stretches 2 times its length by step 60 (`docs/known-bugs.md`; the fix needs the turning read implicitly), exact loops and branches (a 1000:1 load on a grid opens 7 cm), exact limits (one row at a time: twelve hinges on their stops droop 0.91 m), and speed against Rapier.

Rows that depend on each other are the solve's singular case, and four rules cover it (`docs/limits.md`, Own physics joints, gives what each costs). K = J M^-1 J^T is never formed: Householder QR with column pivoting of A = F^T J^T (F F^T = M^-1 per body) gives its Cholesky factor with complete pivoting (Higham 1990, section 5.2), one front of at most 12 rows a joint along the path, with a stop at n u of a row's size, n the path's rows and u f32's epsilon (his test 4.3). Eliminating K joint by joint carried W^T E W into each Schur complement (his Lemma 2.1) with no bound on W, and a 13-row path on 12 freedoms read 4e-7 where rationals give 0 (2026-11-08, `a_path_with_more_locks_than_freedoms_drops_the_row_that_depends`); a reflection rounds each row only by its own length, and that row reads 1e-32. A lock's bias is capped at `joint_max_push` plus what the turning carries its anchors. A pushing pass is cut when a body's turn would rise by more than 0.2 rad times N / M in a substep (Buss and Kim 2005, section 4), on the rise only, as a push that takes back a limit's kick slows its body. Only its position bias is cut: the pass first solves the speeds along a path's locks whole, then the bias on the same factors, capped from the speeds those leave (2026-11-08; one cut solve of both left a limit's kick of 7,500 rad/s in a joint web and handed a neighbour 457,390 rad/s, `a_cut_push_still_takes_back_the_speed_along_the_locks`). Cost: one more forward and back sweep of each path in the pushing pass. A warm start worth more than one push's energy is taken only to the minimum of the dual along it, our own rule. A body past 1e15 stops the world: `world_lost` names it and `KernelWorld.step` throws, as the state may hold no NaN. Before this the replay's own scene reached NaN on 27 of 40 seeds, and that was also the one mismatch between native and Wasm: every differing word of 652,560 bytes at step 174 was a NaN against a NaN of the other sign. Evidence: `kernel/tests/stability.rs`, each rule with a test seen failing without it; the rule counts on `kernel/tests/joints.rs` show the cut and the cap leave every figure there as it was. Missing: the rules are tuned on Windows x86-64 native and Wasm in Node only, and the search has no paper. Evidence for the factor: kernel pivots against exact rational elimination agree to 1e-13 on every path of two web seeds at their fastest steps, native only (a one-off check, not a test); Wasm through the replay. Open: near a toggle a path's row that does not yet depend is answered in full, so web seed 49 reaches 10,991 m/s and a joint 165.8 m open and the 60 webs have no gap bar (`docs/known-bugs.md`); the joint gap of a chain laid out level is not yet held by any test (1:1 opens 7.0 mm).

A limit is rigid up to its edge and soft past it. Up to the edge its row closes any gap within the substep and no more, and it reads and moves through the Schur complement of the joint's own locks. Past the edge it pushes with the contact's soft constraint, so a limit and a floor that cannot both hold rest instead of trading rigid pushes, and being soft it remembers all it gives. A cone joint is two such rows: the twist about frame X, read as 2 atan2(q.x, q.w) of the swing and twist split (Dobrowolski 2015) with its rate along the bisector of the two X axes, and the first-order distance past an ellipse of the swing's rotation vector, along that ellipse's gradient. Evidence: a thrown rod stops at a cone of 0.5 rad and stays at 0.5000, ellipses of 0.3 and 0.8 hold each limit, a tilted twist stops at 0.3993 of 0.4, a limb a floor holds past its cones sleeps, a link of a hundredth of the mass carries a full one 0.008 rad past its cone, all native, and Wasm through the replay. Missing: the push past an edge scales with the mass the row sees, so a hand of a hundredth of the density rests 0.49 rad past its cone under its arm.

What a pair may do is settled in the narrow phase, the only place that looks at it each step: a pair of a disabled body or collider, groups that do not meet, a joint or a refusing filter has no contact; a sensor pair or one whose solver groups do not meet only finds out whether it overlaps, and takes no part in islands; every other pair gets its manifold. A step's last act compares what each active pair found with what it remembers and lists the changes, two words an event, for the entry to read and clear; a pair of sleepers, which no step looks at, keeps what it had. Dominance is a bit on the pair for the step, read where a pair's two bodies are fetched, and only between dynamic bodies, so it costs a solve nothing when unused. The contact filter is the kernel's one import, called only when set. Evidence: `packages/physics/kernel/tests/events.rs`, `packages/physics/tests/next-events.test.js`, each behaviour in `packages/physics/README.md`, native and through the entry; Wasm through the replay, whose scene holds sensors, groups, a filter, dominance and a disabled body. Missing: a sensor reads the pose a step starts from, so it reports up to a step late.

A pair tallies the normal impulse of a whole step: what each point holds after the relaxing pass is all it gave in that substep, its warm start included, and a bounce adds its own. `contactforce` reads the tally from the solve list, so it costs a listener only. Evidence: a resting stack reads its weights to 1e-5, the impulses of a landing add up to m g t to 1e-5, native; Wasm through the replay.

A rope and a spring are joints with no lock: their first axis is the line between the anchors, and what it reads is their distance. A rope is a limit on that row and a spring a motor in the force model, so both use the rows above and neither joins a path. Evidence: a slack rope lets a weight fall as free fall, a taut one swings with the elliptic period to 0.01 percent at 60 degrees and stretches 0.00007 m at the jolt; a spring keeps its period to 0.003 percent and the decay of implicit Euler to 0.2 percent, and settles at its static stretch to 1e-5 m, native; Wasm through the replay, whose scene holds both. Missing: a rope is one row at a time, so two ropes under a 1000:1 end mass rest 35 mm long; `Rope` on the own solver (batch 128) is spherical joints on a path, which do not have this limit.

A convex hull from points is built in the entry's TypeScript, on the add path, by Quickhull with fat planes, then merged into the large faces the clipper needs; the kernel only checks and stores it. A face holds up to 256 edges, so the clipper's buffers are left unwritten until used, rather than cleared on every face contact. The kernel refuses two neighbouring faces as one plane split in two only when they meet under 0.8 degrees and every corner of each lies within half of FLAT of the other's plane, as an angle alone refused real creases of random clouds. Evidence: 85 point sets hold every point within 2.0e-5 of their size and the kernel takes each, and a 256-sided cylinder stands on its cap, in Node; the replay holds four hull bodies bit-equal across Node, Chromium and Firefox. Missing: build cost against Rapier (batch 129).

A body's kind can change between steps. Two fixed bodies have no pair, so a body that stops being fixed walks the sorted ends once for the fixed colliders its boxes overlap, and one that becomes fixed drops its pairs with fixed bodies, which ends their touches; the body wakes and is listed again. A body's own solid (mass at a point, principal moments along a frame of its own) joins its colliders by the parallel axis theorem, and with no collider mass it is the body's figures exactly. An island may ask for extra solver passes: a substep runs `iterations` plus the most any awake island asks for, and a pair or joint path joins a pass only when its island's extra reaches it, so each island runs the last `iterations + e` passes and the pushing pass stays the last for all; `tests/next-bodies.test.js` holds such an island bit-equal to a world of that many passes and the others bit-equal to the plain world (LIM-433). With no island asking, the passes take no lookup.

A spherical motor is three motor rows, one a frame axis, on the rotation vector left between the joint's frame on body A and body B. Its target is that frame, moved onto the rotation asked for, so what is measured stays small and tells rotations apart near half a turn. The rows read the free body and not the Schur complement a limit uses: a motor is soft, the passes converge on its own fixed point, and a ball rod lands within 0.0006 rad of the implicit Euler closed form at every step measured. Tan, Liu and Turk 2011 is the same stable step in generalized coordinates; here it comes from the implicit form of the row (`docs/clean-room.md`, PK24). Evidence: critically damped closed form to 0.0006 rad, a slanted target to 1e-6 rad in a second, a target near half a turn, a spinning target, a cap of 12 N m holds 9.81 N m and 7 N m does not, all native or through the entry; Wasm through the replay.

| File | Role |
| --- | --- |
| `packages/physics/kernel/Cargo.toml`, `Cargo.lock` | Rust crate `margoengine-physics-kernel`, no dependencies, `cdylib` and `rlib`, the same release profile as section 1.1. |
| `packages/physics/kernel/src/layout.rs` | The column table. `packages/physics/scripts/build-kernel.mjs` parses it, so JS and Rust read one list. |
| `packages/physics/kernel/src/world.rs` | The world: header and columns in one block, addressed by offset. |
| `packages/physics/kernel/src/integrate.rs` | The step: impulses once, then per substep the velocity update and the pose update. |
| `packages/physics/kernel/src/math.rs` | Scalar, vector and quaternion maths, correctly rounded on both targets. |
| `packages/physics/kernel/src/mass.rs` | Mass, centre and inertia of a body from its colliders; principal axes by Jacobi rotations. |
| `packages/physics/kernel/src/broad.rs` | Sweep and prune over fat boxes, the pair rows and their table. |
| `packages/physics/kernel/src/island.rs` | The awake and active-pair lists, union-find islands, sleep timers and sleeping rings. |
| `packages/physics/kernel/src/joints.rs` | Joint rows, paths of joints solved exactly, motors and limits. |
| `packages/physics/src/wasm.ts` | Generated: raw-deflate blueprint, source hash, column table. |
| `packages/physics/src/kernel.ts` | `KernelWorld`: instantiate, bind views, grow, snapshot, restore. |
| `packages/physics/src/next/` | `Physics`, `PhysicsBody` and `PhysicsCollider` on the kernel, with the root entry's names; what is still to come throws `unsupported`. |
| `packages/physics/src/mesh-fit.ts` | Reading a mesh for physics, shared by both entries. |

`npm run build:physics-kernel` rebuilds it (cargo, wasm-opt -O3, deflate); `npm run modern:build` does too. `npm run build:packages` uses the committed blueprint. `npm run test:physics-kernel` runs the native tests.

The 2D kernel (batch 127) is its own crate, `packages/physics2d/kernel`, under the same determinism rule (rotation as a cos and sin pair, no trigonometry on the step path). It holds so far shapes (`shape.rs`: circle, capsule, segment, polygon of up to 8 corners by gift wrapping, each a core and a radius), exact mass of rounded shapes (`mass.rs`) and contact manifolds of up to two points (`manifold.rs`: separating axis and reference face clipping when cores overlap, the exact core distance when apart). It also holds the world (`world.rs`: static, kinematic and dynamic bodies, positions moved in doubles and contacts worked out relative to a pair's first body, so a pile 10 km out steps as one at the origin; islands that wake and sleep as one) and the contact solver (`solver.rs`, over its own compact 32-byte bodies, each half loaded whole and transposed into lanes: the soft step at 4 substeps of one biased and one relaxing pass, the two-point block solve with a row-by-row fall-back, the 3D kernel's chain rule for unloaded dynamic pairs at one pass). Sweep and prune, a dynamic box tree with pairs kept from step to step (`tree.rs`, the 2D default: on the 100-row pyramid 15,133 box tests a step where the sweep made 497,402, the bodies bit for bit the same), islands and sleep timers live in `packages/physics/kernel-common`, a crate generic over the dimension that the 2D kernel uses first; the 3D kernel moves onto it in its own job with a replay bit-equality proof. `check:rust-kernels` runs a kernel when a package its crate reaches by a path dependency changes, so a kernel-common change runs the 2D suite. `npm run test:physics2d-kernel` runs its native tests. Its Wasm build (wasm32 with simd128, no_std, the size-class heap of `kernel-common/src/heap.rs` as its allocator) is built by `check:rust-kernels`, and `kernel/wasm-check` steps the pinned-bits scenes of `tests/bits.rs` (the 100-row pyramid, the joint grid, the mixed scene, 120 steps) inside that build in Node: the four-lane simd128 solve gives the native hashes bit for bit (2026-11-08). `node scripts/physics2d-kernel-browsers.mjs` loads the same module into a page drawing with WebGPU and one drawing with the WebGL2 fallback (Edge 157 both ways, Firefox 157 on WebGL2; Playwright's Firefox has no WebGPU) and gets the native hashes in each, then times the 100-row pyramid against Rapier 2D's Wasm in the page (perf history entry 88), and against Box2D v3's Wasm when `BOX2D_WASM` names a build of it made outside the repository (entry 89); `npm run test:physics2d-kernel-browsers`, a GPU suite check:merge runs, is its bits part in the default browser. Before that the crate built natively only (an f64 square root no_std lacks, no allocator) and no check built it for Wasm. There are no Wasm exports or browser run yet; the other evidence is native: the 20-row pyramid's top drops 28.26 mm and the pile sleeps at 0.73 s, against Box2D v3's 29.11 mm and 1.02 s and Rapier 2D's 29.56 mm and 0.92 s on the same scene (LIM-527). Polylines are chains of segment shapes with ghost vertices (`smooth.rs`, `World::create_chain`): a box and a ball slide across 50 joins at 5 m/s keeping vx within 1e-4, as Box2D v3's chain does and Rapier 2D's polyline does not (LIM-529). Joints (`joint.rs`: revolute, prismatic, fixed, rope, spring, with limits and motors) solve their locks exactly along paths (Baraff 1996, block elimination of the block tridiagonal K) and one joint at a time at branches and rings, and stiffen each body's turning by its taut joints' pull (geometric stiffness, Andrews, Teichmann and Kry 2017): a 50-link chain under a 1000:1 end mass stretches 0.55 percent where Box2D v3 and Rapier 2D fly to 30 and 22 times its length, and the 30 by 30 grid holds within 3.96 mm (LIM-534). The solver visits the contacts colour by colour (`kernel-common/src/colour.rs`, greedy first fit in 16 colours, no two contacts of a colour writing one body), coloured from the top of the scene down along gravity, so a pile rests the same whatever order it was built in (the 20-row pyramid built top down drops 28.35 mm, where it dropped 29.41 mm before). The colours are solved four contacts at a time in SIMD lanes (`kernel-common/src/lanes.rs`, Wasm simd128 and SSE2 with only exact IEEE operations; `solver/wide.rs`), every bit as one at a time (`Settings::contact_lanes` off, native only); two blocks of a colour are visited together so their chains overlap (perf history entry 90), and a step that covers every live lane writes without the selects that keep the others, each point's gap is worked out once after the poses move, and the contacts are read through the colouring's order instead of copied into it (entry 91). Two four-cornered polygons collide down a lane path (`manifold.rs`: placing, both best faces, `closest`'s 32 distances and the incident face four lanes at a time, with `pmin` and `pmax`, defined as the compare and select they replace), every bit as the scalar code kept in `tests/support/manifold_ref.rs` over 11.4 million compared manifolds (`tests/manifold_exact.rs`). In the browser the 100-row pyramid steps in 2.9 to 3.2 ms in Margo's Wasm against Box2D v3's Wasm 1.4 and Rapier 2D's 7.6 to 8.1 (entry 91); in Wasm the solver takes 1.9 ms of it (setup 0.58, passes 1.17) and the narrow phase 0.80 (open in known-bugs). Natively, like for like at four lanes, Box2D v3 steps it in 1.24 ms (its default eight AVX2 lanes 0.98) and Margo in 2.87 (entry 91; physics-refs `native/scripts/native-build-sse2.bat`). Evidence missing: a quiet-machine run of those numbers. Its top drops 684 mm by 10 s against the references' 726 to 735: a pair keeps last step's reference face while the two faces' separations lie within one slop, and a clipped point keeps its end's id, so resting points keep their warm start (before, 1,100 to 1,800 points a step restarted from zero and the top fell 906 mm; `Counts::cold_points` counts them, at most 8 a step after 1 s now). Missing: queries, events and filters, the Wasm layout.

Memory contract: one Wasm instance per world, from `__heap_base`. Every column holds 4-byte rows and starts on 16 bytes; a row keeps its index for life. Growth moves each column up to its larger place, last column first, in the same block, so offsets stay relative, no second copy is needed, and a copy of the block is a whole world. A step can grow the world, as new pairs need rows; `world_layout` counts layouts and JS binds its views again when it moves. Growth changes no later result, since nothing iterates a column by capacity.

Row classes: body, collider, endpoint (two a collider), pair, table, and body list. A body list column is indexed by place in a list, not by body, so freeing a body row leaves it alone; putting a list in the body class zeroed a list slot on every reused row, and the churn test in `tests/sleep.rs` caught it.

Determinism contract: same inputs, same call order and same kernel build give bit-equal state on every machine, browser and Node. Wasm floats round to nearest, ties to even, and only NaN payloads may differ, so the state may hold no NaN. The kernel uses `+ - * /`, `sqrt`, compares and integers; no trigonometry, no fused or relaxed operations.

Step contract: `world_step(dt)` lands impulses once, before the first substep; forces stay in their columns and reach every substep, until the caller clears them. Each substep is semi-implicit Euler (velocity, then pose with the new velocity), so a body's reported velocity is the one that moved it. The gyroscopic term is one implicit-midpoint step in the principal frame, two Newton steps, and may not raise the energy. Rotation uses the exact exponential from a series, with no trigonometry. The contact and joint passes will go between the two halves of a substep.

Broad phase contract: after impulses land and before the first substep, sweep and prune updates the pairs. A pair is two fat boxes that overlap. A fat box holds the shape, what the step can reach from its velocity, acceleration and spin, and a 0.04 m margin. Detection runs once a step and serves every substep. A removed collider stays in the lists until the next step and goes in one pass; new colliders join in one sort, merge and sweep. Nothing that decides an order reads the pair table, so results do not depend on capacity.

Island contract: a step walks the awake list and the active-pair list only, so a sleeper costs nothing. After the broad phase, an awake dynamic body or a moving kinematic one wakes whatever it touches, union-find groups the awake dynamic bodies, and an island whose bodies are all ready becomes a ring. Islands are numbered by their first body on the awake list, a pure function of the calls made; islands are independent, so that order cannot change a result. Fixed and kinematic bodies are insulators. Until P2 touching means fat boxes overlap. A pair that loses its contacts, because the narrow phase found none, the pair became one nothing solves or it left the broad phase, starts both bodies' sleep timers again: a body that cannot sleep keeps its island awake, so what rests on it can be long past its window, and with its support gone it would sleep in mid air at the next look (`kernel/tests/sleep.rs`).

Evidence so far: native tests of layout, growth and hash; Node tests of the views. `packages/physics/kernel/tests/integrate.rs` holds free fall and a projectile against the closed form with the method's own term, a free top against the closed precession rate, a heavy top against the Lagrange rate, energy on a tumbling box and at extreme spin, damping, locks, kinematic targets and an off-origin centre of mass, each bound derived from the method's error term plus f32 rounding. `packages/physics/tests/kernel-step.test.js` repeats the closed forms and the force and impulse contract through the shipped Wasm. `packages/physics/kernel/tests/bodies.rs` checks each solid's mass and moments against a numeric integral of its shape, a dumbbell against the parallel axis theorem, a tilted collider's principal frame, and that freed rows come back last in, first out. `packages/physics/kernel/tests/broad.rs` compares the pairs with brute force on every step of random scenes in which bodies move, teleport, join in batches and leave, and asserts the sorted lists, ranks, pair table and pair lists each time; two runs at different capacities must match, and overlapping balls must always be a pair. `packages/physics/kernel/tests/sleep.rs` compares islands with a plain graph search on random scenes, checks every list and ring through a churn of adds, removals, wakes and sleep requests at two capacities, and proves each rule of the sleep policy. Every row access in the native test build is bounds-checked. `packages/physics/tests/kernel-blueprint.test.js` fails when the committed blueprint's source hash is not the hash of the sources, which closes for this kernel the gap section 1.6 lists for the transform kernel. The gate also rebuilds the blueprint and requires identical bytes.

Replay: `packages/physics/tests/replay-scene.js` runs two 10,000-step scenes, one on `KernelWorld` and one through `Physics`, and hashes the world every 100 steps. `tests/fixtures/replay-hash.json` holds the hashes and the hash of the kernel sources, so a stale file fails. Node (`tests/replay.test.js`), native code (`kernel/tests/replay.rs`, a twin of the kernel scene) and Chromium and Firefox (`npm run test:replay`, in `.github/workflows/browser.yml`) must all give them; `npm run test:browser`, which the full check runs, holds them in that machine's default browser. The scene must reach 8 sleepers, 8 pairs, 8 islands and a growth, and moving one position by 2^-20 must change the hash, so the proof can fail. `tests/step-path.test.js` holds the entry's step path free of `Math`, clocks and `**`, which are the ways TypeScript could part from the kernel.

Missing: everything beyond free motion. Bit equality is proved on one Windows x86-64 PC, in Node, native code, Chromium 156 and Firefox 157 (LIM-366); Safari, ARM and a second machine are not (section 5). Nothing is timed yet: the kernel's speed against Rapier waits for the quiet pass.

## 2. Precise GPU mathematics

WGSL permits large builtin errors and floating-point reassociation. `packages/shared/precise-math.js` provides 19 f32
functions for code that compares CPU and GPU results or results across vendors:

`preciseDiv`, `preciseSqrt`, `preciseSin`, `preciseCos`, `preciseTan`, `preciseAtan`, `preciseAtan2`, `preciseAsin`,
`preciseAcos`, `preciseExp`, `preciseExp2`, `preciseExpm1`, `preciseSinh`, `preciseCosh`, `preciseTanh`, `preciseLog`,
`preciseLog2`, `preciseLog1p`, and `precisePow`.

The implementation uses public numerical methods: integer Payne-Hanek reduction with a 2/pi table, Cody-Waite
reduction for ln 2, Dekker products from 12-bit halves, and minimax coefficients derived by
`scripts/precise-math-coefficients.mjs` at high precision. WGSL is emitted only for requested functions, with shared
helpers emitted once. The derivation solves each Lawson step by Householder QR on unit-scaled columns and stops
reweighting at 2^-44 relative error (f64 noise): the normal equations it used before amplified a 1 ulp difference in the
host's `Math.atan` or `Math.cos` past an f32 rounding midpoint, so macOS arm64 derived other atan constants than Windows,
and tanh's stored set had come from that noise. `tests/precise-math.test.js` re-fits atan and tanh with the host maths
nudged by 1 ulp and needs the same f32 values. The regenerated tanh holds 1.45 ulp (bound 2) on the M6 Mac mini (Metal)
(`npm run test:browser --workspace packages/compute`, 2026-11-07); other GPUs still need a run with it.

Important primitives:

- `pmSplit` extracts a stable high part by masking mantissa bits.
- `pmProductError` returns the exact product residual for the rounded product.
- `pmFastTwoSum` implements the magnitude-ordered Dekker two-sum. A general Knuth two-sum and FMA emulation are not
  present.
- `preciseDiv` and `preciseSqrt` correct one rounded builtin result using an exact residual.
- `pmHide` reconstructs a float from integer sign, exponent, and mantissa bits through `ldexp`. It preserves the value
  but prevents a compiler from proving and cancelling the expression that produced it.

`pmHide` was required because real compilers legally rewrote error-free transforms: AMD D3D12 folded
`(1 + x) - 1`, and Mesa also regrouped and factored sums. Before the fix a Radeon 680M produced a `preciseLog1p`
result 8,383,741 ulp outside the bound; Mesa had 14 of 17 functions outside bounds. Apple's compiler (M6, Chrome and
Playwright WebKit) lost the last product of `pmProductError` while it was unhidden, so the result was the sum without
it: `precisePow` went 97 ulp out, and `preciseTan` over its bound through `preciseDiv`. Every product there is hidden now.
The same compiler spread an unhidden tail over the large part of `preciseLog2`, regrouped `(0.5 t) t` as `0.5 (t t)` in sinh
and cosh, and lost `f - sd` in pow's log pair. Hides there are named in `tests/precise-math.test.js`. The fixes are guarded by:

- A browser shader rewriter that simulates cancellation and factoring on any GPU.
- A spec-error rewriter that perturbs builtin results by WGSL's allowed error.
- Host text tests that reject self-cancelling and factorable forms.
- Dense host reference tests under fused, unfused, and worst-allowed division/sqrt behavior.
- Browser checks against a step-for-step host mirror and a broad exponent sweep.

The documented bounds are function-specific: most are within 1-2 ulp, tan about 2.5 ulp, and pow 2 ulp while
`|y log2(x)| < 16` and 5 ulp beyond. GPU checks require the bound and no more than 2 ulp from the host mirror; exact
mirror share is reported, not generally required.

At the audited fixes, dense checks and the sweep passed on NVIDIA RTX A6000/D3D12, AMD Radeon 680M/D3D12, and Intel
UHD/Mesa Vulkan. The Intel Arc 140V had not been rerun after the fix. The committed sweep reported 573,720 trig inputs
and 298,646 pow inputs with zero over bound on A6000 and Intel UHD. Bit equality across vendors is not claimed; the
per-function ulp bound is.

`pmLog2Pair` carries `s R` as a pair since 2026-11-05. In one float it left `precisePow` over its bound near the top of the
range on every GPU tried (5.66 ulp on the A6000), and the sweep never drew those inputs. The sweep now has that class,
which fails on the old maths: 318,575 pow inputs, 0 over bound on the A6000 and on an Apple M6 in Chrome 157 and
Playwright WebKit. Worst in a 262,144 input scan of that class: 1.23 ulp on the A6000, 1.03 on the M6. The AMD, Intel UHD
and Arc results above predate this change.

Node 22 and Node 26 once produced different pinned proof digests because V8 implementations of `pow` differed. The
proof inputs now use exact operations, approximated host math is replaced by deterministic stand-ins during the
proof, and the suite runs under both pow modes. NaN payloads are canonicalized only where a proof explicitly defines
that comparison; signed zero otherwise remains significant.

Measured on the RTX A6000 only (`docs/whitepaper/perf-history.md` entry 48): one precise call per element costs 1.0 to
1.8 times the builtin, `tan` 2.3, `pow` 3.0, and the path tracer's panorama and fisheye rays 1% to 7% of a traced sample.
The `pow` figure predates the pair for `s R`, which adds work, and has not been measured again.
`npm run bench` repeats the pairs (`compute-elementwise`, the `tracer` suite; entry 71), diagnostic so far.
Unmeasured: that cost on other GPUs, one kernel rotation-sync call, and cross-machine kernel bit equality.

`@margoengine/compute/subgroups` is opt-in for the same reason: its float sums follow the GPU's subgroup size, so they
do not repeat across GPUs, while integers, orders and sorts equal the default kernels. WGSL promises no subgroup size or
layout, so kernels order work by seats taken with one workgroup atomic, never by `local_invocation_index`. Checked at
sizes 32 (RTX A6000) and 4 (SwiftShader, `BROWSER_ARGS` with `--enable-unsafe-swiftshader` and
`--use-webgpu-adapter=swiftshader`).

Skinning has one optional second path: `@margoengine/animation/dqs` blends dual quaternions in the batched deformation
shader, a pipeline of its own beside the linear one, reading the same 64-byte bone slots (rotation, dual part, symmetric
stretch). The CPU splits each bone matrix by polar decomposition in double precision (Jacobi on the Gram matrix, so a
rank-deficient bone still gives a rotation). Quaternion signs follow the heaviest influence, because glTF fills spare
influences with joint 0 and an idle joint must not choose them. Checked on the RTX A6000 only: 28,512 values against the
double-precision twin, worst 8.8e-7 in position and 2.1e-7 in normal; the narrowest ring of a 170 degree twist stays at
radius 1.000 where the linear path gives 0.087 (`npm run test:gpu:dqs -w @margoengine/animation`). Unmeasured: its frame cost.

`SkinnedCrowd` (`@margoengine/animation/instanced-skin`) skins in the vertex stage from a baked rgba32float bone texture,
drawing through `VATCrowd`'s pipeline code. Its proof runs the stage's own `skinned` function from a compute shader, since a
vertex stage cannot write out. Checked on the RTX A6000 only. Unmeasured: its frame cost.

### Particle shadow depth and node vectors

`@margoengine/vfx/shadows` draws each live particle as a sphere impostor. WebGPU clips a primitive whose clip z is outside [0, w] (WebGPU specification, primitive clipping) before the fragment stage. The quad's clip z stays inside that interval when the sphere's depth interval meets [0, 1], so a centre past the cascade far plane still draws a front that is in range. The fragment writes the geometric depth, `centerZ - sqrt(max(0, 1 - x^2 - y^2)) * depthRadius`, clamped to [0, 1]. A sphere whose whole depth interval is past the far plane still clips.

`@margoengine/vfx/nodes` normalizes with one scaled length on the CPU and in WGSL, function `nodeNorm`: divide by the largest absolute component, then by the length of that vector (Blue, James L., "A Portable Fortran Program to Find the Euclidean Norm of a Vector", ACM TOMS 4(1), 1978). A zero vector stays zero. WebGL2 translates that same function. Finite values 1e-21 and 1e20 both become a unit vector on the CPU, on WebGPU and on WebGL2. A finite double that is not a finite f32 is rejected for a node literal and for shadow range and intensity (`vfx-float`) before it is stored in a uniform.

### PixelScale, CRT and PaletteQuantize

`@margoengine/pixel/scale` fits a whole-pixel rectangle into each view (contain rounds down the unconstrained side and
centres the result). Nearest selects `floor((2 o + 1) n / (2 w))` by integer arithmetic, so an exact source boundary
selects the texel to its right or below. Sharp-bilinear integrates the last two texels on each axis: at the right edge
`r = (o + 1) n / w`, it mixes texels `floor(r)-1` and `floor(r)` with weight
`clamp(fract(r) w / n, 0, 1)`, then the two rows the same way. Edge first applies the public Scale2x corner rule
(matching adjacent neighbours and differing opposite neighbours), only when at least 2x fits. Below 1x this two-texel
filter is not full box integration; colours mix in their stored encoding, not linear light.

`@margoengine/pixel/crt` maps the output centre to `c = 2 (o + 0.5) / w - 1`, bends it with
`b = c (1 + curvature * c.yx^2)`, rejects points outside the glass and maps back to source coordinates. Flat glass
avoids that normalized round trip: it uses the same integer nearest quotient as PixelScale. Scanlines multiply by
`1 - scanlines * (1 - sin(pi * fract(t.y))^2)`. The three-column grille passes one RGB channel and multiplies the other
two by `1-mask`. Glow adds a clamped-edge 3x3 binomial `[1,2,1] x [1,2,1] / 16` blur. The beam is multiplied by
brightness, glow alpha is added and clamped, and RGB is capped at alpha before premultiplied compositing. This is a
designed look, not a measured physical tube. All-off must equal rational nearest exactly; it has no excluded samples.

Both screen passes intersect the fitted rectangle with canvas bounds and RenderView.scissor, preserving the original
mapping. Explicit output textures cover their own rectangle, independent of the canvas view. Per-view uniforms
prevent queue writes for a later view overwriting an earlier one. Bind groups retain both source texture and selected
pipeline identity because WebGPU auto layouts belong to their creating pipeline, even when shapes match. Disposal
queries `engine.sceneOf(this)` before unregistering, so equal names in other scenes are untouched; buffers are destroyed
and pipeline/bind-group references released. The same ownership rule holds for PaletteQuantize and LayerCompositor.

`@margoengine/pixel/palette` unpremultiplies nonzero-alpha source texels (unless straight input is requested), adds
`spread * (threshold - 0.5)` in encoded sRGB, clamps to [0,1], then minimizes squared distance in sRGB or Oklab. Oklab
decodes sRGB with its standard piecewise transfer function, applies Ottosson's LMS matrix, cube roots and Lab matrix.
Ties keep the first palette entry. The chosen swap colour is premultiplied by the original alpha. Bayer ranks use
`(rank + 0.5) / side^2`; blue noise is Margo's deterministic 64x64 tile. CPU cycling reduces the finite `rate * seconds`
modulo the run length before subtracting small indices, floors the reduced shift, and optionally interpolates its
fraction in Oklab. Product overflow is rejected with coded `state` and a help link. GPU palette disposal destroys its
palette/dither textures and uniform buffer as well as removing the owning scene's pass.

Evidence: `packages/pixel/tests/screen-pass.test.js` checks auto-layout identity on repeated format changes, scissor
intersection and exactly-once resource destruction; `palette-cycle.test.js` checks huge signed shifts and overflow in
both blend modes. These run in verify, hence check:merge. Both scale/crt GPU harnesses import `screen-regressions.js`
for real-device format round trips, clipped and empty scissors, and same-name plugins in different scenes. The CRT
harness additionally compares 154 source/output size pairs against both rational nearest and PixelScale with exact
bytes and zero exclusions. Existing scale/palette/CRT GPU checks retain CPU maths comparisons and device restore.
Backend evidence and its remaining scope are recorded in section 5.

## 3. Rendering backends and hardware tiers

`@margoengine/vfx/shadows` and `@margoengine/vfx/nodes` run on WebGPU and on the WebGL2 compatibility layer from the same shaders. WebGL2 has no compute stage; the particle simulation uses the existing GPU point-draw route in `vfx/src/compat.ts`, and the shadow depth pass is a fragment shader. Disposal removes the point lights that effect published into its clustered list, and a dispose or device restore during the light read-back settles the cancelled map.

**Area light integrals (2026-11-05).** `@margoengine/clustered/area` returns early from a quad with nothing to clip; the clip's own result, by the same operations. Evidence: `packages/clustered/test/ltc-edge.test.js` (bit for bit in float32) and `examples/package-benchmarks/area-lights-gpu.mjs` as the package's `test:gpu:area` (11 frames byte-equal, RTX A6000 only).

gltf-pro trims each pipeline to the vertex inputs its finished shader reads (`packages/gltf-pro/src/vertex-inputs.ts`), after
every shader patch. Evidence: `packages/materials/test/vertex-inputs-browser.mjs` (no pixel differs, RTX A6000 only).

A frame is one colour render pass when only a package draws. The main pass with nothing to draw leaves its clear to a next
pass that declares `joins`; that pass opens its render passes through `context.attach`, and the last one resolves. A clear
nobody took runs before the following pass. Core resolves in a pass of its own only when the graph's last pass did not.
Evidence: `packages/culling/test/gpu/last-pass-check.mjs` (pass counts, frames unchanged) and `tests/modern-msaa.test.js`, RTX
A6000 only; the gain on tile-based GPUs is unmeasured.

**Rendering in a worker (2026-11-05).** Core runs on a transferred `OffscreenCanvas` with no change: it reads no DOM it does not
guard. `@margoengine/worker` gives the canvas `clientWidth` and `clientHeight` and copies `devicePixelRatio` and `margoLow`, so
`resize`, `sceneSamples` and `pick` take the same paths as on the page. Evidence: `packages/worker/tests/browser-check.mjs`
(WebGPU and the WebGL2 fallback in a real worker), RTX A6000 on Chromium only.

**Per-device sharing (2026-11-05).** Three caches hold GPU objects by count and free them with their last holder: `Environment`'s BRDF LUT
per device, size and sample count (a failed create drops its count, and nothing joins that LUT again); gltf-pro's textures per
device, image and format (100 `cloneModel` copies of `p-morph` hold 7 textures, not 700); `@margoengine/shader/raw` buffers per
set of equal bytes, with copy on write. Evidence: `packages/environment/tests/brdf-share.test.js`,
`packages/gltf-pro/tests/model-runs.test.js`, `packages/shader/test/raw.test.js`, and the two browser checks they pair with, RTX
A6000 only.

**Textured meshes on the light path (2026-11-06).** `@margoengine/gltf/textured` keeps a mesh a core mesh, claims its batch and draws it
with core's shader plus a UV input and a texture read, in one extra render pass per frame for all textured meshes of a scene.
WebGPU only. A cut-out picks and casts shadows as solid, and `engine.stats.drawCalls` leaves these draws out. Evidence:
`packages/gltf/test/textured.test.js` and `scripts/test-gltf-browser.mjs`.

**Lighting in a node graph (2026-11-06).** `Material` gains one internal step, `relight`, that runs after the effects composed; it returns
the code unchanged for every other material. `@margoengine/shader/lighting` reads the sun, its shadow visibility, the clustered
lights, the ambient light and the environment as the attached effects worked them out. Rectangle and disc area lights are not
covered. Evidence: `packages/shader/test/lighting.test.js` and `packages/shader/test/lighting-check.mjs` on a real GPU, a graph
Lambert equal to the Lambert shading.

**Motion vectors without the resolve (2026-11-05).** TAA's `velocityOnly` leaves out jitter, capture, history and resolve, so `MotionBlur`
no longer pays for them, and the blur runs inside the `PostStack`. It reads the depth and scene target another plugin made, so a
4x MSAA frame with no `PostStack` throws `state`. Evidence: `packages/taa/test/velocity-only-browser.mjs`, RTX A6000 only.
Plain TAA is unchanged.

**Dithered level changes (2026-11-05).** `LODFade` draws both levels for the fade, each pixel from one by a fixed noise threshold, so
depth stays right with no sorting. Core meshes read the value from a buffer by mesh id, one storage read per core-mesh pixel while
attached; models read a lighting effect's uniform. WebGPU only, instant on WebGL2. Evidence: `packages/lod/test/fade-check.mjs`.
Missing: a measured cost.

### 3.1 Fallback ladder

| Tier | Behavior | Loading and cost |
| --- | --- | --- |
| Native WebGPU | Core `GPURenderer` and all packages | Always attempted first for `backend: 'auto'` or `'webgpu'`. |
| `@margoengine/webgl2-compat/preview` preview | Core meshes, constant-color PBR, one directional plus ambient light; no textures or effects. `/pick` (which also exports `webglRenderer`, so one `loadFallback` import serves a React Canvas) adds a read-pixels `engine.pick`, the route of `Picking` and React pointer handlers on the preview: evidence `packages/webgl2-compat/test/preview-browser-check.mjs`, `packages/react/scripts/test-scene-browser.js`. The pick uses an R32UI 1x1 target and core's projection narrowing; core's refusal stands without it. `/restore` rebuilds programs and buffers after a lost context and makes `rebootDevice` work, with `onDeviceRestored` in each scene; core's refusal stands without it. Evidence: real-browser `packages/webgl2-compat/test/preview-browser-check.mjs` on Chromium, including a real `WEBGL_lose_context` loss; Firefox and Safari not run. `/auto` chooses between WebGPU, the preview and the layer, moving to the layer when a package refuses the preview during `setup`. | App-provided fallback, normally dynamically imported. Separate chunk; 3,407 bytes gzip in the audited size record. |
| `@margoengine/webgl2-compat` | WebGPU-shaped API over WebGL2 so core and feature packages run unchanged | App installs only when native WebGPU is unavailable. Device, translator, and compute entries are lazy. |
| Unsupported message | Page explains that WebGPU is required and does not download demo code | Used below the supported fallback floor. |

Core requests an adapter without a power preference on Windows and with `high-performance` elsewhere. Requested
features are filtered against adapter support. Desktop scenes default to 4x MSAA; phones, the light tier, and exact
size use 1x. `Engine.create` records the native failure before invoking an app-supplied fallback. `exactSize` fixes the
canvas dimensions, disables resizing, and forces one sample.

**Device destroy (2026-11-06).** A frame on the page is an ImageBitmap of the device's own WebGL2 context, so `destroy()` copies it
into a 2D context of the page before it loses the context. Chrome 157 on macOS crashed the tab otherwise. Evidence:
`packages/webgl2-compat/test/destroy-frame-browser.mjs` in `test:gpu`, run on the Apple M6 in Chrome and WebKit and on the RTX A6000 in Edge.

**Native compatibility level (2026-11-05).** `allowCompatibilityAdapters` in `@margoengine/webgl2-compat/adapter` adds a
rung between native WebGPU and the layers: `navigator.gpu.requestAdapter` retries with `featureLevel: 'compatibility'`
when the full level finds nothing. Core changes by 0 bytes: it calls `requestAdapter` at creation and in `rebootDevice`,
so answering there covers both. Compatibility devices take the adapter's limits and rewrite `@interpolate(flat)` to
`either`, which core's pick needs. Evidence: `packages/webgl2-compat/test/adapter-browser.mjs` on a forced device on the
RTX A6000 (D3D12, Chromium): same pixels as the full level, pick hits and misses, restore keeps the level. Missing: a run
on a real OpenGL ES or Direct3D 11 class device, so forced runs prove the validation, not the older GPU's limits.
Packages on the level (2026-11-06): the adapter's `createShaderModule` turns a depth texture that is only loaded into its
float type with `.x` on each load, and default layouts then bind it `unfilterable-float`, so culling's pyramid and
Shadows' nearest depth run unchanged. `compatibilityLevel` in `packages/shared/compat.js` names the rest: Shadows binds
its map a second time as float for the blocker search (a depth texture takes no plain sampler there), `SceneTarget`
copies 4x depth with one masked draw per sample (no `sample_index`), points' eye-dome lighting does the same and draws its depth in a second pass, as bytes in rgba8unorm (r32float does not multisample at the level, and it has no blend to match the colour target's), the frame equal to the full level's on the forced device, Bloom keeps each level in its own texture (no two
views of one texture in a dispatch) and `PostStack` captures 4x in `rg11b10ufloat`. Evidence in the same check: Shadows
0 bytes apart from the full level with a real shadow on the floor, four depth samples read back as written, the post
frame within 2 of 255. Missing: fog, volumetrics, points, water spray and soft `VirtualShadows` (known-bugs.md).

`@margoengine/headless` is outside this ladder: it takes a WebGPU implementation through `installGPU` and a stand-in canvas, so a stage
runs with no page. Stages alive at once share one `gpu`, because `installGPU` changes globals, and `engine.start()` needs
`requestAnimationFrame`, so time moves with `step(delta)`. Evidence: `packages/headless/tests/browser-check.mjs`, on a browser's
WebGPU through the stand-in canvas, and `packages/headless/tests/node-check.mjs`, which runs the README examples in Node on the `webgpu` binding (Dawn), a dev dependency. The stage scene drawn in Node matches the page at changed 0 on the RTX A6000 (D3D12), and the examples run on WARP. Missing: a textured glTF in Node (docs/known-bugs.md); Linux and macOS runs of the binding.

App-side detection must test both presence of `navigator.gpu` and a non-null adapter. The compatibility layer does not
silently install itself and changes no globals at import time.

### 3.2 WebGL2 compatibility architecture

**XR route (2026-11-06).** `installXR()` in `@margoengine/webgl2-compat/xr` replaces `XRGPUBinding` with a binding on an
`XRWebGLLayer`, so `@margoengine/xr` keeps one renderer: each eye resolves into its own texture and `present` draws it
into the opaque framebuffer after the submit, and the view's projection is remapped to z in [0, 1]. Evidence:
`packages/webgl2-compat/test/xr-browser.mjs` in `test:gpu`, 0 differing pixels in both eyes on the RTX A6000 with stand-in
XR objects. Missing: a real headset.

**XR through the engine (2026-11-07).** An engine made by `createXREngine` (`@margoengine/xr`) asks for its adapter with
`xrCompatible: true`, so `XR.create` shares its device and draws each eye as one view of `engine.render({views})`: every
package pass and post effect runs per eye as it runs per view on the desktop. Each eye renders into a texture, a blit copies
it into the layer's sub-image, and a second blit writes the layer's forward depth24plus depth as 1 minus the scene's reversed
depth (the nearest sample). In AR the alpha is the share of samples that wrote depth, or the brightest channel where none
did. Evidence: `tests/modern-xr-passes.ts` in `modern:test:xr:browser`, both eyes byte-equal to a desktop render of the same
camera with a line, a point cloud, terrain and bloom, on the RTX A6000 with a stand-in session. On the WebGL2 layer
(`installXR()`), `packages/webgl2-compat/test/xr-browser.mjs` (in the layer's `test:gpu`) runs the same route with a line
into a stand-in XRWebGLLayer over a real WebGL framebuffer: `xr.route` is 'engine' and both eyes match the native route
with no pixel over 2 (2026-11-07, RTX A6000, Chromium). Missing: a real headset.

**Terrain on the layer (2026-11-08).** The clipmap terrain (`@margoengine/terrain`) and its runtime virtual texture run
on the layer with no route of their own: their passes are draws, which the layer translates unchanged. Evidence:
`packages/terrain/test/compat.browser.mjs` in terrain's `test:gpu` draws rules only, painted weights with a hole, and the
virtual texture natively and on the layer in exact-pixel mode; no pixel differs by more than 1 of 255, and a frame of six
clipmap levels is 6 GL draws and 48 GL calls (Radeon 680M, ANGLE on Direct3D 11, Edge 157). Missing: frame time on the
layer, other GPUs and back ends, and the terrain entries with compute passes (`sculpt`, `deform`, `displace`).

`install()` returns without changes when real WebGPU has an adapter, unless forced. Otherwise it probes WebGL2,
requires highp fragment floats/ints and `EXT_color_buffer_float`, defines a `CompatGPU` at `navigator.gpu`, patches
only `getContext('webgpu')`, and installs missing WebGPU flag constants. `uninstall()` reverses those changes. Lower
half-float and LDR capability tiers are detected but not accepted because the engine depends on HDR and float-data
targets.

Each compatibility device owns a separate WebGL2 context with antialias, depth, and stencil disabled. WebGPU-style
attachments are explicit. Four-sample pipelines use multisample renderbuffers and resolve by blit; exact-pixel mode
stays unsmoothed. The canvas texture is offscreen and is y-flipped only at presentation, which occurs at the end of
each submit so same-task canvas reads see the current frame.

Translation pipeline:

1. Tokenize complete WGSL, including nested comments, Unicode identifiers, numeric forms, and template discovery.
2. Parse the full grammar and its operator restrictions.
3. Resolve and type-check declarations, pointers, abstract numbers, overloads, constants, layouts, stages, and entry
   interfaces; detect declaration cycles.
4. Produce typed IR carrying folded values, spans, and entry-point reachability.
5. Report coded syntax, type, or limit errors with Unicode-aware line/column and help links. Limits include 4 MiB
   source, 255 nesting levels, and 65,536 values in one constant.
6. Emit GLSL ES 3.00 with WebGPU layout semantics, integer operations, conversions, clamped indexes, combined
   samplers, storage reads through data textures, and helpers for missing GLSL builtins.
7. Build resources, render pipelines, a state cache, canvas presentation, and command replay.
8. Analyze compute IR and choose a GPU or CPU execution tier.

Uniformity analysis is intentionally omitted because the recorded corpus already passes the browsers' compilers.

Mapping details:

- `EXT_clip_control` supplies WebGPU depth range. Rendering flips y so textures keep a top-left origin; presentation
  flips back.
- Bind-group entries map to uniform blocks and texture units per pipeline.
- Storage-buffer render reads use RGBA32UI data textures with 16-byte texels and clamped accesses. Bindings in one
  group share a texture, reducing texture-unit pressure.
- Base vertex and base instance use uniforms because measured WebGL2 targets lacked the extension.
- Without indexed draw-buffer state, outputs with matching blend state are grouped; depth/stencil-writing cases that
  cannot be preserved are refused.
- Render shaders that write storage resources are refused.

### 3.3 Compute tiers

| Tier | Selection | Execution | Important limit |
| --- | --- | --- | --- |
| Fragment | Stores map each invocation to its own renderable texture texel and no buffer is written | Full-target draw, scissored per target/slice | Target must be renderable. |
| Scatter | Bounded stores with no same-invocation read-after-write hazard | Instanced point draw per target; buffer words use R32UI textures | At most 1,024 stores per invocation per target. |
| CPU | Atomics, workgroup memory, barriers, unbounded store loops, hazards, unsupported formats, or f16 uniform cases | Typed IR emitted as JavaScript; one invocation at a time, generators across barriers, f32 rounded with `Math.fround` | Under a CSP without `unsafe-eval` the same JavaScript runs on an interpreter (`compute/interpret.ts`), 13 to 41 times slower; cannot read cube, multisampled, or external textures; GPU-written inputs can cause synchronous stalls. |
| Package alternate path | Planned for large atomic, sorting, or GPU-driven workloads | Feature-specific implementation | No recorded shader required it at the snapshot. |

Package routes now cover VFX, scatter (not `ScatterTiles`) and the sky's light projection as well as DOF, splats,
culling and shadows. A CPU-tier kernel that reads a GPU-written resource waits for all GPU work before it, so one small
kernel can cost a whole frame: the sky projection cost 57 ms that way. Evidence: `routes.test.js` and the frame budget of
`visual:compat:budget`; the integrated-GPU budget run is still missing.

A route that reads a resolved multisampled depth must allow for the layer reading it as one sample (WebGL2 cannot
read one sample of a multisampled texture). DOF's route takes the nearest depth of each pixel and its four neighbours
when the capture is multisampled; without it silhouette pixels kept the background's depth under the object's colour
and every far gather drew a faint ring (2026-11-08). Evidence: `packages/dof/tests/gpu/compat-check.mjs`.

Texture read-back left the layer's base on 2026-11-06 (`device/readback.ts`, 70,274 B base): the queue holds a submit
with a `copyTextureToBuffer` until the chunk has loaded, as it does for compute, and the sizes gate measures the chunk in
the split's lazy number. Evidence: `tests/lazy-boundary.test.js` and `readbackOrder` in `compute-browser.mjs`.

The voxel path tracer has a route too (`packages/voxel-pathtracer/src/compat.ts`): `trace` runs as a fragment shader
cut from the WebGPU kernel's own text, writing four `rgba32float` targets, and a scatter kernel adds them to the image
buffers. Evidence: `packages/voxel-pathtracer/tests/browser-check.mjs --compat` on ANGLE Vulkan. Still missing: a run on
ANGLE Metal and on an integrated GPU. ANGLE on Direct3D 11, the default on Windows, does not finish `trace`: Microsoft's shader compiler was still running at the 50 minute limit, three times (its smaller kernels take 27 to 86 s each), while the page kept drawing at full rate. So that route shows the raster image and never a traced frame (`docs/known-bugs.md`).

The CPU tier's `new Function` applies only to this opt-in compatibility path, and a strict policy sends it to the
interpreter instead of refusing it. General claims that nothing builds code at run time must stay scoped to the native
engine. Evidence: `packages/webgl2-compat/test/interpret.test.js` compares the two paths over the corpus, and
`compute-browser.mjs` reruns every case under a real policy; there is no quiet speed record of the interpreter yet.
The two paths compare bytes, so a NaN must have one encoding: JavaScript lets an engine write any NaN bits, and V8
wrote different signs on the two paths (2026-11-08). The CPU tier writes every stored, bitcast or packed NaN as
0x7fc00000 (f16 0x7e00), which WGSL 15.7.2 allows; `test/nan-encoding.test.js` holds it on both paths.
Recorded A6000/Edge measurements for CPU clustered binning
over 3,456 clusters were 1.5 ms with 16 lights, 2.8 ms with 64, and 9.4 ms with 256; a 64-wide reduction with seven
barriers reached 4.4 million invocations per second.

`@margoengine/geometry/gpu` has no route through these tiers: `GeometryGenerator` writes core's vertex buffers from a
frame pass at order -1000 and refuses the WebGL2 backend with `unsupported`. Evidence: `npm run test:gpu` in
`packages/geometry` on the RTX A6000, reading vertices back and rebuilding after `rebootDevice`.

`@margoengine/bvh/gpu` has no route through these tiers either: `GPUMeshBVH` takes a `GPUDevice` and refuses anything
else with `unsupported`; WebGL2 keeps the CPU tree. Its ray test is float32 and watertight, with a four-step slack on
each node's exit distance, so rounding never loses a hit. Evidence: `npm run test:browser` in `packages/bvh` on the
RTX A6000 compares 100,000 rays with the float64 CPU tree and fires 123,200 rays at vertices and shared edges from
inside a closed mesh.

`@margoengine/bvh/gpu-build` follows a vertex buffer the GPU writes, on the same WebGPU-only terms. A build is Morton codes, a
bitonic sort and the Karras hierarchy, then bounds climb one level a dispatch: a node's stamp names the dispatch that
finished it, and a parent reads only children stamped by an earlier dispatch, because threads of one dispatch have no
order. Evidence: trees read back and walked node by node, and rays through a pose only the GPU wrote, against a float64
CPU tree, in `packages/bvh/tests/gpu-build-browser.js`.

`CulledMeshes` with `occlusion` runs before core's main pass, so it cannot read core's depth, which has no texture binding
anyway: it redraws last frame's large kept instances depth-only with this frame's camera, at the scene's sample count,
and shares the Hi-Z pyramid of `packages/culling/src/pyramid.ts` with `CulledInstances`. An instance is hidden only
strictly behind the farthest occluder depth in its footprint, so the image is core's. On the WebGL2 layer it stays
frustum and screen size. Evidence: `packages/culling/test/gpu/meshes-occlusion-check.mjs`, 0 differing pixels against
core through camera and occluder changes, 9 of 1,509 instances drawn behind a wall, RTX A6000.

`CulledModels` (`@margoengine/culling/models`) runs the same cull on `PBRInstances` rows, world = node matrix x row. gltf-pro
reads `primitive.redirect` as core reads `Batch.redirect`, so its colour and depth replays draw the kept rows; casters and
picking keep every row. Evidence: `packages/culling/test/gpu/models-cull-check.mjs`, 0 differing pixels with and without
shadows, RTX A6000. A primitive without instances gets one 20-byte indirect record from one dispatch and gltf-pro draws it
through `primitive.culled`, so a culled one still costs its draw call on the CPU (WebGPU has no multi-draw). With
`occlusion` both tests also read the shared pyramid, built each frame from `addOccluder` surfaces drawn with this frame's
camera, as for `CulledInstances`. Evidence: `packages/culling/test/gpu/models-plain-check.mjs`, 0 differing pixels on the
real NodePerformanceTest.glb (2,066 of 10,000 primitives drawn close up) and through a wall that moves in, 1 of 146 drawn
behind it, RTX A6000. Still missing: a timed run, skinned and morphed primitives, and members of an instanced batch.

`addOccluder` puts core meshes, models and Terrain into the occluder pass of `CulledInstances`, each with the maths of its
own draw (core's `camera*(model*p)`; Terrain's rings on its own uniforms). An occluder must be a surface the frame shows,
so only front faces draw, by the sign of the matrix, and cut-out, blended, displaced and clipped primitives are left out.
Evidence: `packages/culling/test/gpu/occluders-check.mjs`, 0 differing pixels against core, 0 of 576 parts drawn behind a
core wall, a materials wall and a terrain ridge, RTX A6000.

`bounds: 'box'` on `CulledInstances` adds each geometry's local box after the sphere tests: the box under the part's matrix
is an oriented box, its radius along a plane normal is exact, and its nearest depth is at a corner. It can only drop more than
the sphere, so a part it keeps is unchanged. Hi-Z still compares one nearest depth with the farthest occluder depth in a
screen rectangle, so a long part behind a slanted surface stays in. Evidence: `packages/culling/test/gpu/bounds-check.mjs`,
0 differing pixels against core, 0 of 900 rods drawn by box and 900 by sphere under a plate from above, RTX A6000.

`@margoengine/culling/shadows` culls casters per cascade: `prepareShadow` runs one thread per row, tests its sphere against the
six planes of each light matrix (Gribb and Hartmann rows, padded for float32) and appends the row to that cascade's list by
atomic add. List order is free, because a depth-only pass keeps the nearest depth in any order. A caster outside a light box
clips away in that pass, so the map is unchanged. The draw reads rows through an instance-rate u32 vertex buffer, so a batch's
list is a plain vertex buffer offset. Evidence: `packages/culling/test/gpu/shadows-cull-check.mjs`, 0 differing pixels against
every caster drawn in every cascade, RTX A6000. Still missing: a timed run.

Imposters (`@margoengine/lod`) draw 96 bytes an instance: world matrix, colour, emissive. As a shadow source a `LODSystem`
draws, per cascade, a card facing the light per object, reprojecting the ray along the light onto the nearest atlas view with
one parallax step, and stands the depth back by `r*(2/(frames-1)+4/frameSize)` so an imposter does not shadow itself. Evidence:
`packages/lod/test/imposter-full-check.mjs` on the RTX A6000. Missing: other GPUs, and a measure of the cost per cascade.
`@margoengine/selection` asks each engine plugin with `drawSelectionMask` to mark its own pixels; a `LODSystem` redraws the
selected imposters with the same fragment shader at the same depth. A pixel of alpha 0 is discarded whatever `fwidth` says:
it holds no depth, and once landed on the eye, in front of any wall. Evidence: `packages/lod/test/imposter-outline-check.mjs`
on the RTX A6000. Missing: other GPUs.

Shadow outlines have an outside reference: `packages/shadows/test/outside` compares a real glTF model's shadow on a white
ground with Blender Cycles, each side giving the ground's light with the model over its light without it, so no Margo
code decides the answer. Evidence: overlap 0.98 on DiffuseTransmissionPlant and 0.91 on AlphaBlendModeTest's masks, 0.31 with
the masks off. Missing: other GPUs.

`VirtualShadows` takes `drawShadow` sources: a source keeps one uniform per cascade slot and writes it with
`queue.writeBuffer`, which runs before the submit that follows it, so pages go four at a time, each batch in its own
encoder and submit, and the sources need no change. Feedback runs after the pages, because a custom receiver draws there
with slot 0 and the camera's matrix. Voxels read `shadowReach()` where the shadow pass defines it, as `VirtualShadows` does,
since `splits` is a field of the cascades' uniform alone; terrain reads its lighting group's layout from the WGSL the effects declared, since a table of
binding numbers fitted only `Shadows`. Evidence: `packages/shadows/test/virtual-custom-browser.mjs`, overlap 0.97, 0.95 and
0.95 with `Shadows` for culled parts, scatter and voxels; real Mount Rainier elevation against Blender Cycles, overlap 0.86
(`Shadows`) and 0.81 (`VirtualShadows`), 0 with the terrain not casting, RTX A6000. Missing: other GPUs.

Terrain layer materials (`@margoengine/terrain/layers-pbr`, 2026-11-07) are a lighting effect in the same group, at
bindings 90 to 92: they patch the layer loop (a height-blend factor on each weight, then the layer's normal and surface
samples) and wrap the fragment so the per-pixel roughness is written into the input before any later lighting code reads
it; the tilted normal is a surface gradient from the three projections' volume gradients (Mikkelsen 2020), so no tangents
exist and shadows and clustered lights see the same `n`. SSR's capture keeps the geometric normal and terrain roughness.
Evidence: `packages/terrain/test/layers-pbr.browser.mjs`, flat maps 0 of 255 from the terrain's own shading with rules,
painted weights and bump; tilts lit from the right side on both axes; real CC0 rock maps 1.6 times the luminance spread of
colour alone; Radeon 680M. Missing: other GPUs, cost timed.

Terrain near displacement (`@margoengine/terrain/displace`, 2026-11-08) sits after the layer materials at bindings 97 and
98: it wraps the materials' fragment so the view ray's hit (parallax occlusion) replaces the shading position, keeps the
surface's own derivatives for every texture read, and multiplies the sun's direct term by the relief's self-shadow. The
shadow ray walks a maximum mipmap (Tevs, Ihrke and Seidel 2008) built from the surface maps' alpha by a compute pass at
attachment, so it cannot step over a ridge; a fixed-count march did (0.08% of the rock shadowed where a CPU trace gives
2.85%). Evidence: `packages/terrain/test/displace.browser.mjs`, shadowed share 2.71% and 30.7% against a CPU trace's
2.76% and 30.85% at 10 and 30 cm of relief; parallax 3.07 of 255 from real geometry, flat 24.5; Radeon 680M. Missing:
other GPUs, cost timed.

Terrain deformation (`@margoengine/terrain/deform`, 2026-11-08) sits at bindings 99 and 100 and wraps the terrain's lit
fragment (whatever effects came before): each near fragment's view ray is marched through a camera-centred relief map
(parallax occlusion, offset limited), the hit's XZ on the undeformed tangent plane replaces the shading position (so
shadow lookups still see the surface the shadow map holds) and the relief's slope bends the normal. The map is written
by compute passes: an atomic maximum over float bits keeps the deepest print a texel, a fixed refill a second fades
them, and a moving window clears the texels it exposes. Evidence: `packages/terrain/test/deform.browser.mjs`, map to
0.06 mm of the CPU profile, picture 6.6 of 255 from real geometry (flat 33.3); Radeon 680M. Missing: other GPUs, cost
timed.

Mesh to terrain blending (`@margoengine/terrain/blend`, 2026-11-08) patches core's standard fragment through the same
mesh-ID varying and per-pixel block as `TerrainColors` (shared in `terrain/src/mesh-patch.ts`, so either runs first
and the shader holds one copy). At the top of the block, where control flow is uniform, it takes the pixel's footprint
from the position's screen derivatives; per blended mesh (a storage row by mesh id) it reads the ground height from the
heightmap, fades the colour toward the virtual texture's, roughness toward the terrain's and the normal toward the
heightmap's over `height`, so core's lighting shades the mesh's foot as the ground. Evidence:
`packages/terrain/test/blend.browser.mjs`, seam 126.6 to 6.8 of 255, nothing off the foot changes; Radeon 680M.
Missing: other GPUs, cost timed, sloped ground in a picture check.

World-space UI panels (`@margoengine/ui/world`, 2026-11-08) share the screen UI's drawing core (`ui/src/painter.ts`,
used by `UiRenderer` too, so one copy of the instanced rectangle and SDF glyph pipeline): each panel's draw list is
painted into an `rgba8unorm-srgb` texture in its own submission only when the list or the glyph atlases changed, then
mipmapped, and a quad pass at order 25 (inside the scene, before post-processing) samples it with depth test against the
scene, one camera uniform per view index so XR eyes never share a buffer written in the same frame. Evidence:
`packages/ui/tests/world-browser.mjs` on a Radeon 680M (colours, occlusion, back face, repaint counts, a real click by
camera ray). Missing: other GPUs, an XR headset, cost timed.

Screen UI on the WebGL2 preview backend (`@margoengine/ui`, 2026-11-08): `ui/src/painter.ts` builds one `UiBatch` of
rectangle and glyph instances (16 floats each) for either backend; `ui/src/gl.ts` draws it with instanced attributes and
two GLSL ES 3.00 programs that compute the same rounded box distance and SDF coverage as `ui/src/shader.ts`. WebGL2 has
no base instance, so each run moves its attribute offsets to its first instance; clip regions are scissors in GL's
bottom-up rows; the atlases are `TEXTURE_2D_ARRAY` (R8 for SDF, RGBA8 for colour glyphs) grown by reallocation and
re-upload. The code is a separate chunk loaded on the first WebGL2 frame. Evidence: `packages/ui/tests/webgl2.test.js`
(a recording WebGL2 context: draws, offsets, scissors, texture units, lost and restored contexts) and the WebGL2 check
in `packages/ui/tests/ui-browser.js` on a Radeon 680M (colours, rounded corner, text ink, clipped list, unchanged
frame). Missing: other GPUs, WebKit and Firefox, world panels on WebGL2.

Planet terrain (`@margoengine/terrain/planet`, 2026-11-08) draws a cube sphere quadtree with its own pass and shader.
Precision: each patch stores float32 vertices relative to its float64 centre; each frame the CPU subtracts the camera
position from each drawn centre in float64 (one instance attribute a patch) and builds a view-projection with no
translation from the camera's position, target, up and projection, so no float32 value holds a world coordinate; depth is
core's reversed z. Evidence: `packages/terrain/test/planet.browser.mjs`, the disc from orbit within 0.2% of a sphere's
projection, the horizon dip within a pixel, no sky through the ground and the same picture with a `FloatingOrigin` at
6,371 km from the world origin; Radeon 680M. Missing: frame cost, other GPUs, shadows and lighting effects on it.

Both shadow classes take `effects`: objects that declare WGSL at bindings 40 and up (four each), give a factor that
`shadowLit` multiplies the sun by, and update once a frame after the depth passes. With none the shader text is what it was,
which the golden GPU proofs pin. `cloudShadows` runs the sky's cloud remap and erosion along the ray to the sun, with the
sky's noise text, clock and height read from `sky.cloudLayer`, so there is one cloud field, not a copy. `check.mjs` in
`packages/shadows/test/outside` now reads partial light back through Khronos PBR Neutral's toe on a white ground below the
curve's shoulder: until then only full shadow was measured, and partial values on a dim blue ground read too dark. Evidence:
`packages/shadows/test/outside/check.mjs`, a real image as `lightPattern` against a real sheet of it across the sun in Cycles,
overlap 0.996, mean difference 0.0074, 0.71 and 0.26 for the same mask shifted; `packages/shadows/test/light-function-browser.mjs`,
ground and the sky's own render along the sun ray agree on all 256 points, before and after 2,400 m of drift, against 0.64 for
the old ground and the new sky, and core meshes, materials, gltf-pro, terrain and voxels go dark under a black pattern in both
classes. Missing: other GPUs; a real cloud photograph over real ground is not the claim, the claim is agreement with the sky.

`VolumetricClouds` (`@margoengine/sky/volumetric-clouds`) ray marches a layer between two shells around the planet in one
full-screen fragment pass at order 3, between the sky and its fog. f32 cannot form |o|^2 - (R + h)^2 at planet scale, so the
shell roots use the constant |e|^2 + 2R(e_y - h) - h^2 from the camera's own position and the stable quadratic form, and a
point's height is (|p|^2 + 2R p_y) / (|o| + R). Two tiling noise volumes are generated once by compute on the first frame and
after a device loss; the sky light is reduced from the sky's reflection map by one 64-thread workgroup each frame. Without a
depth texture the pass depth-tests against the cleared sky; with one it reads the first sample of multisampled depth.
Evidence: `packages/sky/test/features-check.mjs` (coverage 0 exact, coverage, depth occlusion in front of and inside the
layer, motion) at 4x and 1x on a Radeon 680M. Missing: other GPUs, a quiet timing, a comparison with a reference renderer.

`volumetricCloudShadows` (`@margoengine/sky/cloud-shadows`) is a shadow effect that renames the clouds' WGSL field with its
binding (`shadowFxCloud...N`) and marches it from each receiver to the light. It keeps its own noise volumes, filled by the
same deterministic generator on its first update, and writes the layer fields with the clouds' own `writeLayer`, so it
shares no GPU object with `VolumetricClouds` and survives either side's device loss alone. Evidence: `features-check.mjs`,
48 ground points against the clouds seen from each point toward the sun, mean 0.0018 before and 0.0021 after 1,500 m of
drift, 0.29 for stale shadows; Radeon 680M. Missing: other GPUs, any timing, a soft edge from the sun's size.

`AerialPerspective` (`@margoengine/sky/aerial`) is the first user of `atmosphere-luts.ts`, the sky's Hillaire 2020 model in
kilometres: a 256 x 64 transmittance table (Bruneton 2017 mapping) and a 32 x 32 multiple scattering table, recomputed only
when the medium changes, and a 32^3 camera volume each frame, one thread per column marching its slices in turn. Ray
and sphere constants use (|o| - r)(|o| + r), so a camera a metre up keeps its horizon in f32. The composite is two blended
draws in one pass (dst x T, then + L), exact per channel without dual-source blending, which core does not request.
Evidence: `features-check.mjs` aerial, transmittance within 0.006 of a CPU Beer-Lambert integral at 1, 10 and 40 km on a
Radeon 680M. Missing: other GPUs, any timing, an in-scattering reference.

`HillaireSky` (`@margoengine/sky/hillaire`) is the second user of `atmosphere-luts.ts`: the same transmittance and multiple
scattering tables, plus a 192 x 108 sky-view table each frame (azimuth from the sun over a half turn, zenith angle
squeezed toward the horizon) that every sky pixel reads. With the camera above the top radius the table is not made and
each pixel marches its own chord through the air, entry and exit from the top sphere's two roots. The draw is the root
Sky's: a fullscreen triangle at reversed-Z 0 with `greater-equal`, so only clear depth takes it. The disc's radiance is
held at 65,504 so an rgba16float capture never takes an infinity. Evidence: `features-check.mjs` hillaire on a Radeon 680M
at 4x and 1x: blue noon, orange sunset, ozone's bluer twilight zenith, the ground, limb and black space from 1,000 km, and
the table and the march within 0.05% on one ray across the top; the CPU sun transmittance against the closed-form vertical
optical depth to 1e-4. Missing: other GPUs, a reference image or radiance from another renderer, timing (4 to 6 ms per
frame at 128 x 96 with Bloom, diagnostic).

The Bruneton `Sky`'s `groundAlbedo` (`@margoengine/sky/bruneton`) adds the ground as a boundary to the four-order
precomputation, built the first time an albedo above 0 is set: per order a 64-texel irradiance pass (the direct sun,
then the order before over the upper hemisphere) and a density pass that adds albedo / pi times that light, through
the air between, for directions that end on the ground. At 0 the sky runs the passes and shaders it had before, so
the recorded traces stand; a change of albedo rebuilds the scattering once, not the transmittance. Evidence:
`features-check.mjs` albedo on a Radeon 680M at 4x and 1x (snow +113% at the horizon, sand +49%, albedo 0 bit for
bit). Missing: other GPUs, a reference sky, timing.

`@margoengine/sky/presets` holds other worlds for the Hillaire model (`EARTH`, `MARS`, `marsAtmosphere`). To colour
Martian dust the medium now reads Mie scattering and absorption per channel: two vec4s at the end of the `Atmosphere`
uniform (now 224 bytes), which the extinction, the in-scattering and the multiple scattering table read, and the CPU
sun transmittance per channel too; a number still means grey. The tables are keyed on them, so a new preset rebuilds
both once. Evidence: `features-check.mjs` presets on a Radeon 680M at 4x and 1x (Earth blue and bit-identical to the
default, Mars red over blue 1.17, a storm 1.82), and the hillaire, aerial and shafts checks unchanged. Missing: other
GPUs, a photograph or reference renderer of Mars, timing.

`LightShafts` (`@margoengine/sky/shafts`) is a screen-space pass after the aerial perspective (order 4.5): a half-size
r16float mask of open sky (2 x 2 depth taps) times the clouds' transmittance along each view ray, from its own copy of
the cloud noise volumes, then a fullscreen draw that walks the mask toward the sun's projected position and adds light
with one-one blending. The sun's screen place is the projection of its direction (w = 0); its clip w is the cosine to
the view axis and fades the effect, so a sun behind the camera adds nothing. Normalizing by the summed weights makes
the blur a share of lit air, so the added light is linear in `intensity` and exactly 0 where every sample is occluded.
Evidence: `features-check.mjs` shafts on a Radeon 680M at 4x and 1x. Missing: other GPUs, a reference renderer,
timing (about 12 ms per frame at 256 x 192 with Bloom, diagnostic), off-screen occluders.

`WeatherFX` (`@margoengine/sky/weather-fx`) draws its occluders each frame (order 5.9) into a depth32float map from above,
an orthographic view over the weather's box snapped to its texel grid; each occluder's world matrix sits in one storage
buffer read by `firstInstance`, so the draws share one bind group. `Weather` reads the map through a hook
(`weather.occlusion`, its `shader(code)` adding the cover read), so the weather entry carries no cover code; its
`ParticleOverlay` (packages/shared) now takes extra bind group entries and rebuilds its pipeline when the shader
changes. A one-thread compute step keeps the lens wetness on the GPU. Evidence: `features-check.mjs` weather-fx on a
Radeon 680M at 4x and 1x. Missing: other GPUs, timing, cover finer than a texel.

Sleet (`precipitation: 'sleet'`, 2026-11-07) is two `ParticleOverlay` draws in the weather's pass, rain then snow,
each with its own uniform buffer (one uploaded buffer holds one draw's values within a submit) and the snow on its own
hash seed, so the two never share spots. Evidence: `features-check.mjs` sleet on a Radeon 680M at 4x and 1x against
each kind drawn alone. Missing: other GPUs, timing.

Puddles (`@margoengine/weather/puddles`, 2026-11-07) is a hook into core's mesh shader at frame graph order -1, like
`ShaderEffect`: it renames the fragment input and works on a copy named `i`, setting its colour, roughness, metalness
and normal before core lights it, so every later hook (sky ambient, environment lighting, fog) reads the wet surface.
The shared `patchFragment` (packages/weather/src/scene-patch.ts) lets a second surface hook chain on the same copy. One
32-byte uniform at group 0 binding 160 a frame. Evidence: `browser-check.mjs` puddles on a Radeon 680M at 4x and 1x
(WGSL against JavaScript, dry untouched, water on ground not walls, rings only on water). Missing: other GPUs, timing.

Snow (`@margoengine/weather/snow`, 2026-11-07) is the second surface hook: besides the fragment change it rewrites
core's vertex line `let p=model*vec4f(i.position,1);` to lift the world position by the snow's thickness, from the
world normal it computes the same way core does, before the clip position. A vertex stage that another package
replaced has no such line, and the snow there is colour and grain only. One 48-byte uniform at group 0 binding 161.
Evidence: `browser-check.mjs` snow on a Radeon 680M at 4x and 1x (the plate's edge rises where the camera projects
it, snow with puddles on one shader). Missing: other GPUs, timing, the slit on split-normal meshes.

Hail lighting and splashes (2026-11-07): `Hail` reads `engine.lighting` each frame into its uniform (now 240 bytes) and
shades each stone in its fragment stage as a ball, its normal built from the place across the streak; splash chips are
extra instances of the same `ParticleOverlay` draw (stones times one plus `splashes`), each a closed-form ballistic path
from its stone's first landing. Evidence: `browser-check.mjs` hail on a Radeon 680M (lit 9.5 times brighter toward the
sun than away, flat unchanged by it, chips near the ground). Missing: other GPUs, timing, scene shadows on stones.

AstroSky (`@margoengine/sky/astro`, 2026-11-07) is a `ParticleOverlay` draw at frame graph order 2.5, after the sky's
pass and before fog: one storage buffer of three vec4 a point (the J2000 vector and magnitude, colour, proper motion a
Julian year; the seven planets the last points, rewritten each frame), the sky matrix (precession, nutation, sidereal
time, latitude) in its uniform, refraction and air-mass extinction in the vertex shader, and each point at the far plane
so only open sky shows it. It reads the sky's `nightFactor` in its pass, after the sky's own pass has set it, so day
and night switch on the same frame. Straight alpha subtracts the sky times the alpha, so on a float target the alpha is
the brightest channel over 64 and the star's light is added within 0.1%. The night shader's moon takes its lit limb
toward the sun when `moonLitBySun` puts 2 in the night's enabled slot. Evidence: Meeus' worked examples in
`astro.test.js`; `features-check.mjs` astro on a Radeon 680M at 4x and 1x for star places and light, the horizon, day
and the moon's limb. Missing: other GPUs, timing.

A `ShadowFilterEffect` replaces the named filters' last step in `shadowVisibility`, after the cascade pick and the receiver
plane. `varianceFilter` turns the depth map into two moments, blurs them by two separable passes when the map changes, and
bounds the lit share with Chebyshev's inequality. A filter's shader must keep `shadowSampler` read, in a branch never taken,
since 'auto' layouts drop what no code reads; `shadowSampling` adds that branch. Evidence:
`packages/shadows/test/vsm-browser.mjs`, on a straight edge 2.7 pixels wide at blur 2 and 11.1 at blur 16, and row-to-row
grain 0.00023 against 0.0033 for PCSS; `check.mjs`, the real plant under a soft Cycles sun, overlap 0.76 and mean difference
0.0088, PCSS 0.97 and 0.0010. RTX A6000. Missing: other GPUs, and any timing.

A surface lit from behind has to look up its shadow on the side facing the light: `shadowVisibility` offsets along the normal,
which on a leaf's far side lands behind the leaf. A shader that declares `margoLightSide` (gltf-pro with diffuse transmission)
gets that normal through the `direct` hook's second argument, and every other shader's text is unchanged. `transmission`
moves what `transmits` to the tint map, and its effect's `tint` expression scales the light by the disc form factor over the
gap to the caster, read from the tint depth. Evidence: `packages/shadows/test/transmission-browser.mjs`, from under the real
plant leaves keep 0.34 of the light through them, 0.06 without the fix; `check.mjs`, deep in the shadow 0.0001 and Cycles'
translucent BSDF 0.0023 on the plant, 0.05 for light going straight on, 0.04 and 0.004 on the Teacup. RTX A6000. Missing: other
GPUs, transmission textures, more than one scatter.

Past `shadowReach()` the depth maps end, and `distanceShadows` takes over from a height field. A compute pass marches each cell towards the sun and keeps the highest plane `height - d * tan(elevation)` and its distance `d`, so one `vec2f` per cell answers for that sun: a receiver below the plane is behind the ridge. The light is the segment of the sun's disc above that horizon, with `d * sunSize` as the disc's height. The storage buffer costs no sampled texture, and gltf-pro already uses all 16 per stage. The march reruns only after the sun moves `sunStep` degrees. Each step spans the shorter cell side, so the step count scales with the cell's aspect. Evidence: `check.mjs`, real Rainier elevation with `distance` 30, overlap 0.85 and mean difference 0.016 against Cycles on both shadow classes, overlap 0 without it; `packages/shadows/test/distance-browser.mjs`, the disc share within 0.003 of the formula at three distances. RTX A6000. Missing: other GPUs, and any timing.

An effect with `style` wraps the light's whole shadow in `shadowLit`: `direct*style(vec3f(1)*visibility*tint*calls)`, so it sees the map, tinted casters and the other effects as one. With no style the text of `shadowLit` is unchanged. `shadowStyle` is `mix(floor,1,shade)` with `floor` from `intensity` and `color` on the CPU. Evidence: `check.mjs`, the real plant against two Cycles suns, one casting and one not, whose colours sum to white: 0.283 against 0.287 in red, 0.684 against 0.684 in blue, 0.292 under `VirtualShadows`, 0.003 with no style. RTX A6000. Missing: other GPUs, and any timing.

`rayTracedFilter` is a filter effect whose body walks `bvhWGSL` in the fragment shader, with the tree's names prefixed `shadowFx` so `moveEffects` carries them. It takes six bindings, so each effect now has eight from `EFFECT_BINDING`. Rays leave `position` along the normal and spread over the sun's disc on a Vogel spiral turned per pixel, as the soft filter's taps are. `GPUMeshBVH.forShader` uploads without a pipeline, so `setup` can rebuild the tree synchronously after a device loss. WebGPU exposes no ray queries, so there is no hardware path yet; this is the place for one. Evidence: `check.mjs`, the real plant against Cycles, overlap 0.97 and mean difference 0.0016 with one ray, 0.97 and 0.0010 under a soft sun with 64 rays, 0 with an empty tree. RTX A6000. Missing: other GPUs, any timing, alpha masks in the tree.

`LodInstances` (`@margoengine/culling/lod`) tests each instance against the frustum and picks its level in one compute pass:
the level is the first whose limit the world sphere's radius in pixels reaches. Instances append to their level's list by
atomic add, and the counts are copied to each level's indirect arguments, so core draws each list through `Batch.redirect`. On
the WebGL2 layer every shown instance draws the first level. Evidence: `packages/culling/test/gpu/lod-check.mjs`, 0 differing
pixels against core meshes with levels worked out on the CPU, RTX A6000. Still missing: a timed run.

`MeshletMesh` (`@margoengine/culling/meshlets`) splits one mesh into clusters of up to 64 vertices and 124 triangles, grown
breadth first over shared vertices. One workgroup per cluster tests its sphere against the frustum and, on a single-sided
batch under a perspective camera with a positive determinant, its normal cone against the camera, then appends its indices
to the part's region of a kept index buffer that the main pass draws, one indirect draw per part. `'occlusion'` culling adds the
Hi-Z test between the two, and each shadow cascade runs the same kernel against its light box into lists of its own in
`prepareShadow`. Core's shader takes vertices as attributes, so no vertex pulling: a region per part is what keeps it one
draw each. The cone test is in the mesh's own space: which side of a plane a point is on
survives any affine map of positive determinant, so uneven scale needs no wider cone. It drops only triangles the back-face
discard would drop. Evidence: `packages/culling/test/gpu/meshlets-check.mjs`, 0 differing pixels against a core mesh, RTX
A6000, for one part, three parts, Hi-Z and a shadow cascade. Still missing: a timed run, and occluders from last frame's clusters
instead of whole parts.

`DynamicInstances` builds kept records from the rows in its scatter; a `fill` kernel writes `world` once per cull, only for what reads it,
`prepareShadow` and `pick`. A scene with shadows pays what it paid before and the compatibility route is unchanged. Evidence:
`packages/culling/test/gpu/dynamic-check.mjs`, frames equal to core meshes with shadows on and off, and picks that agree, RTX A6000.
The removed traffic was not the main cost (perf-history entry 54; known-bugs.md).

`@margoengine/shader` compute passes (`ComputePass` grids, `workgroup`, barriers, `indirect`, every atomic, `storageTexture`, `pingPong`) are
checked on WebGPU only: `packages/shader/test/compute-model-check.mjs` and `compute-texture-check.mjs`. The package emits no GLSL,
and no check runs them through these tiers; by the table above, atomics, workgroup memory and barriers select the CPU tier.
Invocation inputs reach the entry point only when a graph reads them, so 1D passes compile to the same text as before. Statement
nodes (`If`, `Loop`, `While`, `Switch`) leave graphs without statements byte for byte unchanged.

`@margoengine/compute` has two backends of its own, WebGPU and CPU. `/graph` runs rounds over all edges with an atomic minimum so one
code path serves both, and `/nn` gathers through an inverse table so it needs no atomics and its gradients repeat exactly. `/autotune`
times candidate workgroup sizes in interleaved rounds, keeps the median-fastest and caches per adapter, name, signature, source and
candidates; `createCompute` now asks for the adapter's workgroup limits so sizes above 256 can be tried. Evidence: `npm test` and
`compute-browser.mjs` in `packages/compute`, LIM-079, LIM-080 and LIM-082. `tuneCompute` runs the same timing on the context's own
reduce, scan and radix sort, whose kernels now take their thread count as a parameter (`createCompute({ tuned })`); a sort block is one
workgroup, so the block count follows the table, and another route's kernels keep 256. Speed is not measured for `/nn` or `/graph`.
Tuned sizes have diagnostic numbers on one Apple M6 and one RTX A6000 only (perf-history entry 77); no AMD or Intel GPU is measured.

Accepted compatibility differences include CPU transcendental last bits, exact CPU filtering versus typical GPU
fixed-point filtering, one signed-normal tie, canonical rgb9e5/snorm readback, unavailable per-sample shading and
timestamp queries, copied video frames, clamped allowed out-of-bounds reads, refused compressed attachment/readback
operations, and refused integer MSAA formats unsupported by the context.

### 3.4 Corpus, size, and compatibility evidence

The recorded corpus snapshot contains 786 modules with entry points, 3,405,543 WGSL bytes from 41 packages plus site
pages. It is stored as a Brotli corpus with a SHA-256 manifest. Tests require packages with WGSL source to contribute
a recorded module. At the snapshot all modules parsed and checked; 1,049 vertex/fragment entries compiled, 459 stage
pairs linked, 624 render pipelines drew, and 397 of 417 browser compute pipelines dispatched. Twenty path-tracer
kernels remained out of scope because ANGLE compilation could take tens of seconds to minutes.

Audited gzip sizes: root compatibility entry 92,467 bytes, device 92,286, GLSL 42,394, compute 41,489, WGSL 26,528.
The root exceeded its original 60 KiB target; that was recorded rather than hidden. Isolation tests assert no other
package reaches the layer, import changes no globals, and native core/stage bytes remain unchanged.

Evidence includes capability probing, parser/checker fuzzing and nesting bombs, complete corpus compile/link/draw,
forced native-versus-compat rendering, format/readback/query/bundle cases, compute-tier parity, package tests in
forced compatibility, no-WebGPU page behavior, exact-pixel rendering, multi-view, and device restore. Pixel parity
uses per-pixel maximum RGB difference with no more than 0.1% over 2 and mean no more than 0.25.

### 3.5 Runtime quality tiers and resolution

`@margoengine/quality` starts desktops in a light tier rather than guessing from a GPU name. Phones always use the
phone tier. URL overrides can force high or low on desktop; per-page storage records later choices.

| Tier | Main defaults |
| --- | --- |
| Phone | 1x MSAA, DPR 1, two cascades, SSAO and volumetrics off, light-tier base settings. |
| Light | 1x MSAA; shadows 1024 with PCF, SSAO 16 samples, SSR off, reduced volumetric grid/local shadows/VFX capacity. |
| High | Package defaults and desktop 4x MSAA. |

Explicit feature options override presets. Feature packages read one global preset at construction and do not import
the quality package.

Promotion and demotion rules:

- Phone or URL-forced tiers are not auto-changed.
- A light-tier page with timestamp-query support samples GPU passes after startup for 120 frames, reading the time a
  frame's passes cover, so passes that run side by side count once (2026-11-05: an Apple M6 ran 31.9 ms of passes in 8.5 ms
  of GPU time; an RTX A6000 reads the same either way, 4.33 ms, so limits set on such GPUs keep their meaning). A sufficiently low
  p90 stores high for the next page load; it never reloads immediately into a heavier tier.
- A high-tier page stores a held state and reloads once only after five consecutive one-second windows under 55 FPS;
  frame gaps above 250 ms restart a window.
- The measurement restores wrapped queue/encoder methods and destroys temporary GPU resources.
- The light tier's pace (`capFrameRate`) gives each frame the most whole refreshes that still reach 60 FPS, from a median of
  the last 16 callback gaps, so a 100 Hz display renders 100 FPS rather than 50. Evidence: unit tests from 50 to 240 Hz with
  jitter, and a real page on a simulated 100 Hz clock on an Apple M6. Missing: a run on a physical 100 Hz panel, Safari
  itself, and whether an M6 stays on the full tier at 100 Hz (it costs 13.4 ms a frame there, over the 10 ms refresh).

The source comments contain both an old 5 ms threshold and a later documented 8 ms threshold. Current code is the
authority; the discrepancy should be removed when that area changes.

`ResolutionScaler` defaults to a 12 ms budget, scale 0.5-1.0, a 30-sample window, 0.05 granularity, and eight ignored
samples after a change. Over-budget scale falls approximately with the square root of target/current cost, never by
more than 30% at once. A rise needs sustained cost below 70% of budget; an immediately reversed rise doubles holdoff
up to 32 decisions. Core sizes to the lower of device pixel ratio, quality cap, sample-count cap, and 4096 pixels per
side. Exact-size mode bypasses resizing.

`supersample` (`@margoengine/quality/ssaa`) makes stills: it renders whole frames into a view target with the camera's
clip-space x and y moved along a Halton (2, 3) sequence, keeps running sums in linear light in `rgba32float`, and encodes
once. The offset exists only inside each `engine.render` call and the frustum planes stay unmoved. Evidence:
`packages/quality/test/ssaa-browser.mjs` on a real GPU, single-sampled and at 4x MSAA. Missing: Safari, and stills at
the texture limit.

`FeatureScaler` (`@margoengine/quality/features`) lowers features rather than pixels. Each step is a trial: the frame
cost over one window after it, against the window before, is the step's measured saving. A saving under 3% of the frame
gives the step back and rests it for 120 decisions. Known savings choose later steps, least visible first among those
that cover the shortfall; a feature returns under 70% of budget if its saving leaves the frame under 90%. Evidence:
`packages/quality/test/features.test.js` on a modelled scene, and `features-browser.mjs` driving real `SSAO`,
`Shadows` (filter, distance, resolution, cascades) and `VolumetricFog` (grid, on and off) through every level. Missing: how good the savings are in a real scene under load, for the quiet pass.

`watchPower` (`@margoengine/quality/power`) adds a third input to tiers. Level 1 (on battery) and level 2 (hot, CPU
pressure or low battery) cap the frame rate and cut the `FeatureScaler` budget; on the full tier they set this tab's next
load to light through `sessionStorage`, and that load measures nothing. `FrameDrift` tells heat from a heavier scene by
shape: a gradual rise that stays, against a step. Evidence: `packages/quality/test/power.test.js` on modelled costs, and
`power-browser.mjs` on the real battery manager. Missing: a run on a laptop really throttling, on battery, which should
set `rise` and `readings`.

### 3.6 Warm-up and device loss

`warmUp(engine)` renders offscreen delta-zero frames until two complete frames run with all asynchronously compiled
pipelines available. It retries bounded rounds and can reboot the device before falling back to synchronous pipeline
creation. `redrawAfterRestore` schedules two animation-frame renders for on-demand apps.

`PBRModel.compile()` (2026-11-05) warms one model rather than a frame: it runs the draw's own derivation and compiles with
`createRenderPipelineAsync`, so the draw finds the same pipeline under the same key. Its key needs the target formats and sample
count, which live in the renderer's private descriptor, so core gained one read-only getter, `Engine.renderTarget` (44 B gzip, Scott's
exception of 2026-11-05, `docs/conventions.md`). It is opt-in: at every load it would compile twice in a scene that adds lights
or effects afterwards. The wait moves rather than disappears: first frame 100 to 17 ms, build 54 to 108-126 ms, 11 to 29 ms saved in
all, busy machine, diagnostic. Evidence: `packages/gltf-pro/tests/model-runs.test.js` and `tests/core-timestamp-feature.test.js`
(after a device restore too).

`PipelineCompiles` (`@margoengine/stats/compile`) records every shader and pipeline create call on a device, follows restored devices,
and links a slow frame to the compiles in it or the frame before, blocking calls first. Evidence:
`packages/stats/test/compile.test.js` and a real-device check in `scripts/test-stats-browser.mjs`.

Core treats `device.lost` and relevant frame-time DOM exceptions as loss. Recovery is deduplicated by one shared
promise, creates a new adapter/device/renderer with the same features and samples, re-adds every geometry batch from
CPU copies, configures the canvas for the new device, swaps renderers, rearms the watcher, and calls every plugin's restore hook in its scene. CPU-side Wasm
transforms and instance arrays survive. Frames skip rendering during recovery, and accessing geometry buffers reports
a restore-specific coded error. The WebGL2 compatibility device feeds its context loss through the same path.

Tests destroy devices and GPU processes during lifecycle checks, compare every visual demo before and after loss,
exercise scenes and multi-view water, restore compatibility devices, and include restore events in proof stories.

A step that can throw runs before any state changes (2026-11-07). `Engine.retain` makes the instance array and calls `Renderer.add`
first, then swaps the array, counts the reference and registers the batch; `Renderer.add` frees a held geometry's old buffers only after
the new ones exist. It always allocates on the renderer in use, so during a restore that is the lost one, whose buffers go with it (a
restore that fails leaves it in place with every geometry held), and inside `onDeviceRestored` the new one. Restore hooks and scene
disposal run to the end and rethrow the first error. A full instance collection clears `collected` first, so one that throws repeats.
Evidence: `tests/deep-core-allocation-failure.test.js` on a fake device; on a real one, the lifecycle scenario that sets geometry on a
destroyed device and in the hook. Missing: `createBuffer` does not throw on a real out-of-memory, it reports later through
`uncapturederror`, so no check exercises a true GPU out-of-memory and core does not roll one back. It surfaces as a `gpu-lost` error.

Configuring the canvas is the one step of a restore with no way back, so it is the last step that can fail (2026-11-07):
`GPURenderer.create` skips it for a restore, and `rebootDevice` calls `GPURenderer.configure` after every batch is rebuilt. A failed restore
leaves the canvas on the old device, and one that ends after `engine.dispose()` never touches the canvas. Evidence: the lifecycle scenario
"a restore that fails on a healthy device" compares the picture before and after and watches the old device for errors, on a real device
whose successor reports a lowered buffer limit; `tests/deep-core-allocation-failure.test.js` runs the real `GPURenderer.create` on a fake
device, including a `configure` that throws. Missing: a restore that fails on hardware that really has a smaller limit than the old device.

Known rendering gaps:

- WebGL preview size is stated inconsistently in older public files; current generated size records are authoritative.
- Intel Arc 140V precise-math evidence needs a post-fix rerun.
- Compatibility CPU compute compiled with `new Function` and was refused without `unsafe-eval`; it now falls to an interpreter, and older broad CSP wording still needs the CPU tier qualifier.
- Visual profiles do not cover every GPU/browser/OS combination.
- Compatibility path-tracer kernels remain outside the supported compilation budget.


**Dispersed rays (2026-11-05).** In the `Transmission` pass each of the red, green and blue rays reads the blur level of its own IOR. Evidence: `node scripts/material-dispersion-gpu-check.js` (278 checks at a 0.002 tolerance), whose references use f32 IORs and, on the caller path, a fixed Fresnel, since dispersion moves refraction only.

**Native glass tint (2026-11-05).** A loaded transmissive material's multiply draw reads the full surface (`surfaceTintPBR`): base colour, transmission, metal, specular, sheen, clearcoat and thin film, maps included; the tint lanes hold the volume attenuation alone. Evidence: `packages/materials/tests/transmission-layers.test.js` and `node scripts/material-dispersion-gpu-check.js` on the native path. Missing: a measured cost of the second textured pass.

**Transmission on display-encoded targets (2026-11-05).** `materialTransmissionAdd` decodes the lit colour and the light behind, adds them in linear light and encodes the sum (encoded 0.5 + 0.5 reads 0.69, no longer 1.0); with an HDR scene target both are linear and add directly. gltf-pro's native two-draw path still adds encoded (`docs/known-bugs.md`). Evidence: `packages/materials/tests/transmission-shader.test.js`.

**Native coat and sheen lobes in shadow (2026-11-05).** `layers()` multiplies its sun light by `margoDirectVisible`, so a `direct` hook reaches the clearcoat and sheen lobes of physical shaders. The hook is asked about `margoLit(s,l,direct)`, zero where neither the base nor a lobe has light, so `shadowLit` skips the same fragments on uncoated surfaces and adds lookups only where a coat or sheen faces the light and the base does not. Evidence: `scripts/materials-clearcoat-tests.js` on the GPU (full shadow reads exactly 0, half shadow half) and `packages/gltf-pro/tests/extensions.test.js`. Missing: a measured frame cost on a coated scene.

**Clearcoat over opaque materials through `install` (2026-11-05).** `MaterialExtension.coat` scales direct, local, ambient and emitted light by `1 - clearcoat * F(n.v)` and adds the coat's own light on top, so `install(model)` follows KHR_materials_clearcoat as gltf-pro's native `layers()` does. `lightPBR` then evaluates a `direct` hook once on `vec3f(1)` (`margoDirectVisible`), so such hooks must scale the light they wrap. Evidence: `scripts/materials-clearcoat-tests.js` on the GPU (clearcoat 1 keeps 0.96 of emission at normal incidence and 0.73 at n.v 0.25; ambient 0.0782 where the unfixed shader read 0.0674; SSAO's replay equals the beauty) and `packages/materials/tests/clearcoat.test.js`.

**Stochastic tiling (2026-11-06).** `stochasticTiling` (`@margoengine/materials/stochastic`) rewrites a material's `textureSample` reads into three `textureSampleGrad` reads at random per-corner offsets of a triangle grid, keeping the unshifted UV's derivatives so an edge never picks another mip, and scales the blend about the 1 x 1 mip by 1 / sqrt(sum w^2) (Heitz and Neyret 2018), held inside the three reads. It binds nothing, so steady batches keep their fast path. Evidence: real-texture correlation, contrast, register and solid-mip checks in `packages/materials/test/features-browser.mjs` on an RTX A6000; WebGL2 layer, tile-based GPUs and the cost are unmeasured.

**Hair, eye and skin models (2026-11-06).** `hair`, `eye` and `skin` (`@margoengine/materials/hair`, `/eye`, `/skin`) are `MaterialFeature`s built on one helper, `character-light.ts`: each is a WGSL function `light(n, v, l, base)`, the response to one light with its cosine included, put in place of the body of `direct_light` for the sun and of the `clusterBrdf` term in the clustered loops through the `lit` hook, so a mesh answers a directional or point light as it answers the sun; the `character` GPU job fails if the hook is removed. Area lights, ambient and environment reflections keep the plain model, and a material with `fn margoDirect(` (anisotropy, thin film) throws. Hair is Kajiya and Kay's fibre with Marschner's two shifted lobes as tangent-shifted lobes (Scheuermann 2004). Skin is d'Eon and Luebke's six Gaussians integrated around a circle into a 64 by 64 half-float table (Penner and Borshukov 2011), row the square root of curvature in 1 / mm, read with |dN| / |dP| from screen derivatives. The eye refracts view and light at the cornea by Snell's law onto an iris plane. Skin takes group bindings 130-131 and the eye 132-134, because clustered holds 141-143 and environment 144. Evidence: hair, skin against the table and the pupil against a Snell trace are measured on an RTX A6000, the last on a stand-in sphere; the only model in the repository with eyes has a shallow iris plate, so the real-mesh eye run proves position and opening, not refraction. Cost is not timed.

**Output dithering (2026-11-06).** Materials' `dithering` option (feature letter `q`) adds triangular noise (Gjol 2016) to the display-encoded colour just before it leaves the fragment shader, scaled by each channel's distance to 0 and 1 so black and white stay exact and nothing clips. The noise is the one `Bloom` and `Sky` already used, now shared from `packages/shared/dither.js`; it hashes the pixel, so a frame repeats exactly. A float scene target (`settings.w`) skips the step, as the presenting pass owns the 8-bit output there, and data shadings (`normal`, `depth`, `distance`) never get it. Evidence: an RTX A6000 run of the `dithering` GPU job in `packages/materials/test/features-browser.mjs`.

**Hardware clip distances (2026-11-06).** On a device with 'clip-distances' (asked for through core's existing `options.features`, so core is unchanged) `MaterialShading.shader` skips `clipShader` and marks the text; gltf-pro's one `createShaderModule` then runs `markedClipDistances` (`packages/shared/section.js`) after every other stage edit, because `vertexInputs` and the instanced stage still need `->Out {`. The vertex stage returns `MargoClipped`, a copy of `Out` with `@builtin(clip_distances)`, since a fragment stage cannot read them, and a plane past the count gets 1. `clipIntersection` stays on discard, as the maximum of the distances is not linear across a triangle. So does a material whose outputs reach location 13: six distances take two of `maxInterStageShaderVariables`, and instancing passes `margoK` at the next location. Cascaded casters take the same route through `clippedDepth(..., hardware)` and `clipHardware` on the primitive; TAA velocity, contact shadows, picking and local shadows stay on discard. Evidence: an RTX A6000 run of the `clip` GPU job, with and without the feature. No other device has run it, and its speed is not timed.

**Prefiltered cube maps (2026-11-06).** `prefilterCube` (`@margoengine/materials/prefilter`) resamples any `CubeTexture` to linear float faces in a compute pass, reads them back and hands them to `Environment.create`, so one GGX filter serves both; the CPU copy is what `restore` rebuilds from after a lost device. Evidence: `packages/materials/test/features-browser.mjs` (`prefilter`) reads the stored levels against a GGX integral worked out in the test, on an RTX A6000 only; `envMap` now refuses a 32-bit float cube on a device without `float32-filterable`, which used to fail WebGPU validation (`packages/materials/test/env-map.test.js`). Missing: a rough real sky compared with another renderer.

**Physical lobes under clustered lights (2026-11-06).** `lightPBR` takes a last `finish` hook that sees the composed text. `Clustered.lobes = physicalLobes` (`@margoengine/clustered/physical-lobes`) uses it to send each point, spot and extra directional light through the surface's own `margoDirect` and, after `layers()`, add the coat and sheen those lights earn; area lights reach the coat through its own Linearly Transformed Cosines. Text without `fn layers(` is returned as it is. `envMap` on a thin film or anisotropic surface now goes through `margoAmbientLayers`, as a scene IBL does. Evidence: `lobes` in `packages/materials/test/features-browser.mjs` compares each lobe under each light with the sun, and the area coat with a sum over the panel, on an RTX A6000 only; `packages/materials/test/env-map.test.js` holds the composed text. Missing: a curved surface, sheen, anisotropy and thin film under area lights, the `clearcoat()` model extension under local lights, and any timing.

**Dielectric Fresnel ends in lighting hooks (2026-11-05).** Ambient and local-light hooks read `s.f0` and `s.sw` (F0 and F90 of `KHR_materials_ior` and `KHR_materials_specular`); `lightPBR` writes the glTF defaults into shaders whose `Surface` has no such fields, so plain materials keep their numbers. Evidence: `tests/specular-ambient.test.js` and the `environment` browser check (specular 0 on a black dielectric reflects exactly 0 under an IBL).
**UV sets 2 and 3 (2026-11-06).** The 80-byte vertex holds two UV sets and many packages read it, so TEXCOORD_2 and 3 ride in a second vertex buffer at slot 2, location 11, passed on as `Out.uvs`. Only a primitive whose material or variant reads them gets it. `laterUVShader` (`packages/gltf-pro/src/vertex-inputs.ts`) rewrites the two-way UV select into `margoUVSet`, so every map, transform and extended slot follows without a shader of its own, and the pipeline key and draw memo gain a flag. Depth passes keep two sets: a cut-out on a later set casts uncut (docs/limits.md). Evidence: `tests/texcoord-later.test.js` and the `uv:` checks of `scripts/test-extensions-browser.js` on a Blender 5.3 file, on an RTX A6000 only; no speed measurement.

**Texture mip streaming (2026-11-06).** `textures` of `@margoengine/gltf-pro/progressive` reuses `KTX2Streamer` of `@margoengine/decoders/ktx2-stream` and adds what a model needs from it: a `GLTFStreamedImage` in the model's image list, which hands `bindMaterial` the current view in the colour space of each map slot (the texture allows its sRGB or linear twin through `viewFormats`), and `rebindStreamed`, which binds a draw again the moment its texture is replaced, in the same turn as the old texture's `destroy`, so no frame can see it. A texture's level follows its size on screen: `packages/shared/texture-density.js` measures the local length one whole texture spans (square root of surface over UV area, up to 4,096 triangles), and that length times the pixels a world unit covers at the nearest point of the bounding sphere is what `want` receives. The range reader in `stream.ts` leaves a KTX2 view unfetched and marks it received, so a GLB's texture bytes stay on the server; those bytes stay zero in `asset.buffers`, and nothing else reads an image view. Evidence: the real FlightHelmet and a real 1,024 px KTX2 file on an RTX A6000, pixel equal to the plain loader close up. Missing: timing on a quiet machine and a real network, a skinned model's posed bounds.

**Behaviour graphs in glTF (2026-11-06).** `@margoengine/gltf-pro/interactivity` adds no shader and no render path: it compiles the ratified `KHR_interactivity` graph of a document and runs it on a clock moved by `tick`, with no engine. `@margoengine/animation/interactivity` binds it to a model: it ticks on `onPreUpdate`, writes through `pointerWriter`, the writers of `KHR_animation_pointer`, and picks through `Picking` of `@margoengine/selection`, attached on first use without per-frame capture. It lives in animation because gltf-pro cannot peer on animation (animation already peers on gltf-pro, and `scripts/package-order.js` refuses the cycle). Evidence: 1,155 of 1,156 conformance sub-tests and 187 of 187 invalid graphs, and a GPU check that a real click reaches the graph and the screen. Missing: no timing of a large graph, and no real file that drives skins and physics together on a GPU.

**Rigid bodies in glTF (2026-11-06).** `@margoengine/gltf-pro/physics` adds no shader and no render path: it reads `KHR_physics_rigid_bodies` and `KHR_implicit_shapes` (drafts) from the document and builds bodies in `@margoengine/physics`, which gained a `generic` joint for the draft's joints, built of limits and drives, with frames on each body. Evidence: five committed real samples held to their mechanics on real Rapier, seven unlicensed ones run by hand through `MARGO_SPLAT_SAMPLES`, one GPU check that a loaded node moves on the engine loop. Missing: no conformance suite exists for a draft, and the combine rule order, soft limits and multi-axis ranges differ from it by what Rapier offers (`docs/limits.md`).

**XMP metadata in glTF (2026-11-06).** `@margoengine/gltf-pro/metadata` adds no shader and no render work: it reads `KHR_xmp_json_ld` from the document after load, and a broken packet never stops a model loading. Launch gate 11a gains the `gltf-pro/metadata` fuzz target over the published files that carry the extension. Evidence: real files for author, licence and copyright; the Creative Commons and `xmpRights` licence order has built documents only, as no published file found uses them.

**Fixture and image lights in glTF (2026-11-06).** `@margoengine/gltf-pro/lights` adds no shader: an `EXT_lights_ies` fixture is a clustered point light whose profile is resampled for its node's aim, and an `EXT_lights_image_based` cube goes through `Environment`. `parseIES` gains type B, resampled to a type C grid, and stops reading the 2002 and 2019 field after the ballast factor as a photometric factor, which had raised the real 2019 sample's peak from 8,500 to 9,350 cd. Evidence: the real Example wall within 3 percent of Lambert's law on the RTX A6000. Type B axes are now held to a real report: its planes meet at H = 90 and it integrates to its stated lumens only with H as the latitude. Missing: the sign of V, which no file shows, and any reference for what `irradianceCoefficients` mean.

**Scattering in glTF volumes (2026-11-06).** `KHR_materials_volume_scatter` (draft) adds map slots 19 (multi-scatter colour, sRGB) and 20 (volume thickness) and two rows to the extended Frame, which grows from 284 to 308 floats (1,232 B), so UV rows reach 42 and physical rows start at 272. `packages/shared/volume-scatter.js` holds the one WGSL text, `margoScatterShares`, and its JavaScript reference. Sigma_t and the albedo mapping are the spec's; the rest is a Margo reading: scattering over the depth x is 1 - exp(-min(sigma_s (1 - g), sigma_t) x), and that share of the entering light leaves as a diffuse lobe of the multi-scatter colour (`s.sc` in the extended shader, `materialScatterLobe` in `@margoengine/materials`, added to direct light and to the ambient hooks). Specular transmission keeps Beer-Lambert, which already counts scattering, and diffuse transmission takes exp(-(sigma_a + s) x). The lobe plus either straight term never passes the light that entered (`packages/gltf-pro/tests/volume-scatter.test.js`). Evidence: real-GPU checks in `packages/gltf-pro/scripts/test-extensions-browser.js` on the RTX A6000 only, among them the whole Khronos ScatteringSkull. Missing: any comparison with a path tracer's picture of the same file, light spreading under the surface, any other GPU, and speed.

**Bump maps in glTF (2026-11-06).** `EXT_materials_bump` adds map slot 18 and a `bump` row to the extended Frame, which grows from 272 to 284 floats (1,136 B), so physical rows start at 256. The normal comes from `margoBumpGradient` in `packages/shared/bump.js`, the Mikkelsen surface gradient `@margoengine/materials` `bumpMap` also uses. gltf-pro feeds it forward differences of the map a pixel away, three reads, where materials takes `dpdx` of one read. A node-space height scales by |transpose(M) n|, the node's stretch along the surface normal: a point moved d along the mesh normal moves that far along the world normal. Evidence: real-GPU checks in `packages/gltf-pro/scripts/test-extensions-browser.js`, on the RTX A6000 only. Missing: a file from an art tool (none found) and any other GPU.

**Flat splats (2026-11-06).** `splatsFromAttributes` keeps an axis variance at 2^-20 of the largest. Float32 rounding of a covariance moves an eigenvalue by up to 3 x 2^-24 of the largest, so a flatter splat rounded to a matrix `validateSplats` refused and one such splat stopped a whole real capture (CesiumJS tower.glb). Evidence: `packages/splats/test/splat-edit.test.js`. Projection adds 0.3 px^2 to every ellipse, so the lifted axis does not show at any distance Margo tests; no render comparison against an unlifted cloud exists, as Float32 cannot hold one.

**Splat depth (2026-11-07).** `@margoengine/splats/depth` adds one depth-only render pass per cloud at frame-graph order 3.5, after the clouds draw: the cloud's sorted ellipses drawn as the colour pass draws them, no colour target, `depthCompare: greater` with writes on, and a fragment discard where the Gaussian opacity is under the threshold. Meshes drawn before the cloud keep their depth; passes after it (order above 3.5) test against the splats. The depth is alpha-tested, not accumulated. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M, a synthetic splat and a real capture at 1x and 4x MSAA; missing: other GPU families, and a pass that reads the depth (fog, DOF) drawn over a capture.

**Splat level of detail (2026-11-07).** `@margoengine/splats/lod` adds no shader: a pass at order -8 picks the cut on the CPU and writes changed nodes into a fixed pool of one `Splats` with `queue.writeBuffer` (`Splats.write`, `Splats.clear`), before the cloud projects at -7. Hidden pool splats (opacity 0) are culled by the projection and sort to the end. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M (real capture, full cut against a plain cloud of the pool; 16.7 M-splat procedural stand-in); missing: a real capture past 3,000,000 splats, trained hierarchy levels, frame time.

**One splat sort for many clouds (2026-11-08).** `@margoengine/splats/set` adds no shader: `SplatSet` writes each added cloud into a first-fit range of one pooled `Splats` (`Splats.write`, `Splats.clear`), so the one projection and stable radix sort order every member far to near, as a merged cloud would. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M (two overlapping copies of a real capture match the merged cloud pixel for pixel at 1x and 4x MSAA, and differ as two clouds); missing: frame time for a large mostly free pool.

**Splat lighting (2026-11-08).** `@margoengine/splats/lighting` adds two shaders: a compute pass at order -6.5 scales the projected colours by core's diffuse terms with a per-splat normal from the smallest covariance eigenvector, and a depth-only `drawShadow` for `@margoengine/shadows` that rasterises each splat's ellipse in the light's clip space (0.3 texel^2 dilation) with stochastic per-texel coverage. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M (relit colours against the CPU formula; a synthetic disc and a real capture shadow a ground box); missing: splats receiving shadows, a specular term, frame time.

**Splat brush (2026-11-08).** `@margoengine/splats/edit` adds one compute shader with every operation behind a uniform switch: select, erase and paint test each splat's projected centre against a pixel region, and a pick runs two submissions (atomic min of an order-preserving view-depth key, then of the indices at that key; one submission would see only the second pass's uniform, as queue writes land before the command buffer runs). `Splats.read` copies positions, colours and SH back for export and restoration, reading again when a `write` lands during the read. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M; missing: stroke cost on a 3,000,000-splat cloud.

**Animated splats (2026-11-08).** `@margoengine/splats/animate` adds two compute passes at order -7.5, before a cloud's projection at -7: a sequence mixes two packed frames into the cloud's positions, covariances and colours; a skin copies the rest pose once (copyBufferToBuffer, so the root's covariance buffer now has COPY_SRC) and writes the blended joint transform of each centre and A S A^T of each covariance. `Splats.read` now reads covariances back too, so a posed cloud exports as posed. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M; missing: pass cost on a 3,000,000-splat cloud.

**Anti-aliased splats (2026-11-08).** `Splats.antialias` sets `counts.z` of the projection uniform; the projection pass then scales the ellipse opacity (ellipse centre w, which the render, depth, lighting and brush passes read) by sqrt(det(S) / det(S + 0.3 I)) of the dilated screen covariance. No recompile and no extra pass. Evidence: `packages/splats/test/gpu/check.mjs` on a Radeon 680M; missing: a real capture trained with the filter.

## 4. Quality architecture

### 4.1 Gate map

| Gate | Command or path | Contract |
| --- | --- | --- |
| Core and stage size | build and `npm run measure:size` | Combined minified ES2022 gzip must be strictly below 25,000 bytes. |
| Kernel payload | `scripts/build-modern.js` | Raw Wasm below 30 KiB, valid module, lossless raw-deflate round trip. |
| Quality ratchets | `npm run quality` | New or worse size, duplication, test, API, or clean-room item fails. |
| Formatting and lint | `scripts/hygiene.js --verify` plus normal lint/typecheck commands | Fast source checks; quality ratchets enforce selected non-regression classes. |
| API and parity | `npm run api:check`, `npm run check:parity` | Generated API and parity contracts remain current. |
| Unit tests | root and package tests | Functional and regression evidence. |
| Documentation | `npm run docs:links`, generated-site checks | Links and generated public material remain coherent. |
| README examples | `npm run check:readmes`, a step of `verify` | Every `ts`, `tsx` and `js` example of every package README and guide compiles against the built packages, each as its own module. An error off `scripts/support/readme-types-known.json` fails, and so does a fixed entry left on it; the list only shrinks and must be empty before release.. No example may `declare` a value: such a line passes the compiler and holds nothing at run time, so the check refuses it |
| Current proofs | `npm run proofs -- --current` | Ongoing golden-output guarantees match stored outputs. |
| Fresh checkout | `npm run check:fresh-clone` | Validation and current proofs do not depend on local history or artifacts. |
| Site and visual checks | site build, `visual:check`, compatibility visual budget | Built demos render against the correct per-hardware evidence. |
| GPU/package checks | `check:views`, `check:gpu-packages`, `check:depth`, `check:wgsl`, `check:no-webgpu` | Scoped rendering, shader, package, depth, fallback, and view behavior. `check:gpu-packages` refuses to plan while a `scripts/*-gpu-check.js` file is named by no command, unless `LOOSE_CHECKS` states why: on 2026-11-07 twenty-two such files ran by hand only and five had rotted. A check that compares with an earlier build (`--baseline`) says so and goes on when no baseline is on disk, since that proof belongs to one change. |
| README examples run | `npm run check:readme-run`, a step of `check:merge` after a build, GPU, 296 s on 2026-11-07 (about 25 minutes when first measured). Whole in the full check after a push; on a narrowed run, the examples of the affected packages, or all of them when a file the step runs changed. In no gate before the push and not in `verify`. Holds one shared GPU slot; the GPU lock ends its process tree at 60 minutes. An example's id is the heading above it and a hash of its code, never its place in the file, so the known list survives a new example above a listed one. A README edit renames the example it changes, so `tests/run-readme-examples.test.js`, in `verify`, fails while the known list names an example no README holds: 8 such entries went unseen until this step ran on 2026-11-07 | Runs every example of every package README and guide as a reader would paste it: in Node when it can, else in a real Chromium page with WebGPU, the elements it asks for and a real sample file of the format it fetches. Passes when nothing threw, no promise was left rejected and the GPU reported no validation error; a Node example still going at 30 s passes, as a server does. A failure off `scripts/support/readme-run-known.json` fails, and so does an entry left on it that passes or names an example that is gone. Examples that listen on one port take turns. 641 of 767 ran on 2026-11-07; the 126 left are in docs/known-bugs.md. |
| Consumer packaging | `modern:test:packages`, bundler matrix, quickstart | Packed declarations, docs examples (the same examples as `check:readmes`, against the tarballs, with no known list), browser packages, bundlers, licenses, and documented first use work. |
| Release rehearsal | `publish:rehearsal` (in `publish:dry-run` and the publish workflow) | Every tarball audited, then the one-line install, every entry imported and type-checked, and every template built, from a stand-in registry that refuses writes. |
| Public truth | `tests/public-truth.test.js` | Structured license and package-count statements match their canonical sources. |
| Timing-test hygiene | fixed-wait and wall-budget tests | Tests wait for readiness; code speed uses CPU time; justified real-time bounds are marked. Both read tracked files only (`git ls-files`), so git-ignored scratch builds cannot fail them. |
| Async hygiene | support async call test | Async helpers in tests/scripts are awaited or returned. |
| TypeScript checker transport | `tests/typescript-api-transport.test.js` | `scripts/hygiene.js` and `scripts/api-report.js` start tsgo through `typescript/unstable/async` (stdio, waits for the process); no tracked file uses `typescript/unstable/sync`, whose Windows client gives tsgo a fixed ~5 s to open a named pipe and failed `npm run quality` under verify's load on 2026-11-07. |
| Node compatibility | CI matrix and proof-golden tests | Minimum and supported Node APIs and proof results stay compatible. |
| Rust kernel | `npm run test:kernel`, in local CI's CPU set | Native kernel invariants. |
| Physics kernels | `npm run test:physics-kernel` and `npm run test:physics2d-kernel` (about 75 s and 3 s on the dev PC, 2026-11-08), each a step of local CI's CPU set on every `main` commit (hard limits 30 and 15 minutes); and `npm run check:rust-kernels` (`scripts/rust-kernel-tests.mjs`, CPU only, 20 minutes a crate), a step of `check:merge` that runs `cargo test` of each package with a Rust kernel whose own files changed (its `kernel/` folder counts as the package), every kernel when its script changed and in the full check; a kernel that ships as Wasm (a `cdylib` crate) is then built for wasm32 with the shipped flags, and a `wasm-check/` crate beside it, when there is one, is built the same way and run in Node (the 2D kernel's: the pinned-bits scenes against the native hashes). Not in `verify` | The 3D and 2D solvers' Rust tests that LIM-518 to LIM-522 and other claims cite. Until 2026-11-08 they ran in no check. `tests/rust-kernel-tests.test.js` holds the npm scripts and the step to the same cargo command. On the dev PC the npm scripts fail with "'cargo' is not recognized" from a shell that inherits the machine PATH: its entry `C:\Program Files\GitHub CLI"` carries a stray quote, and cmd.exe, npm's script shell, then reads every later entry (cargo's among them) as one quoted name. The PATH is 1,777 characters inside npm, far under cmd's 8,191, so length is not the cause. Local CI strips quotes from the PATH it hands its steps; `check:rust-kernels` starts cargo without a shell. The machine fix is to remove the quote from the system PATH. |
| Class fields | `tests/class-fields.test.js` | Packages on the shared tsconfig declare no bare class fields; `@margoengine/materials` is the one named exception. |
| Browser choice | `tests/browser-selection.test.js` | `MARGO_BROWSER` names edge, chrome, chromium, firefox or webkit, and each maps to its launcher. |

### 4.2 Size and ratchet contracts

The combined core-stage gate builds the stage entry with core bundled, every other bare package external, minifies for
ES2022, joins output chunks, gzips them, and enforces `bytes < 25_000`. The embedded kernel counts. There is no lower
bound. Core is frozen against features, not bug fixes; a core bug fix requires regression evidence and must remain
within the gate.

The detailed size record bundles public entries like consumers do and records raw/gzip size, commit, dirty state, and
lazy files. Generated records must identify their exact source revision. Current record-generation ownership is
external to this engine reference; the measuring scripts themselves remain authoritative.

Quality baselines have `{ gate, about, total, history, items }`. A new key or measured value above its limit fails.
Shrinking is free. Accepting growth requires a reason appended to history. Size headroom is the larger of 3% or 256
bytes; a static import that pulls a package entry of at least 10,000 bytes into another package is a leak item.

The five ratchets are:

- **sizes**: gzip budget for every public entry and worker, plus heavy-entry leaks.
- **duplicates**: normalized six-line windows of at least 200 characters, known algorithm families, and cross-package
  value re-exports.
- **tests**: each package has verification coverage and each public entry is imported by a test.
- **api**: public exports are documented and thrown errors follow the conventions.
- **clean-room**: engine source does not copy or depend on prohibited competing-engine implementation.

One stale comment says duplicate windows are eight lines; implementation and conventions use six.

Hygiene additionally scores format, lint, public/source `any`, strict TypeScript flags, duplicate type names, TSDoc,
bare errors, API rough edges, and dead files/exports. Not all scores are blocking by themselves; the quality ratchets
are the enforceable non-regression layer for the overlapping categories.

### 4.3 Verification and affected checks

`scripts/verify.mjs` runs fast hygiene and one package build in order, then independent chains in parallel: API,
quality, parity, sandbox build/tests, unit tests at bounded concurrency, documentation links, size measurement, and
current proofs. A chain failure terminates the other process trees. Serial mode remains available for diagnosis.
A killed tree counts as ended only when its processes have closed their handles (`endTree` in
`scripts/support/shutdown.mjs`): on Windows a process's exit code is set before its handles close, so the end waits on
each process object, and the folder, log and ports of a timed-out step are free when `runLimited` returns (fixed
2026-11-08 after an EPERM on a timed-out job's temp folder).
Three of those chains start a TypeScript checker (tsgo) at about the same time: API reports, quality (through hygiene
gate 6) and the API report tests in the unit step. Each starts it through the async API, whose start has no fixed time
limit, so a slow start under load waits instead of failing; the step's own timeout still bounds a hang. Evidence: a
repro that starves a new tsgo with high-priority busy loops on every core made the sync API fail after 11 s and the
async API connect once the load ended (Beelink, 2026-11-07).
The unit test step gives each test 300 s (`TEST_TIMEOUT_MS`, against 32 s for the longest measured), and
`scripts/support/test-watch.mjs` watches from the runner's process: a test file silent for 360 s, through a blocked event
loop or a process that stays alive after its tests, prints `HUNG TEST:` with the file and test and ends the run.
On Windows the runner ends last: it stops every process below it, waits on each one's handle, prints `HUNG RUN ENDED:`
and exits, so a caller may remove the run's folder as soon as the run ends. On other systems the run ends by SIGTERM,
and the test holds there that its children are gone; that path has not been run on the Mac or Linux yet.

`scripts/check-merge.mjs` classifies the actual changed files and runs only checks the change can affect. It expands
package dependents transitively and chooses full validation when shared/core/build/check infrastructure changes, a
file cannot be classified, more than the supported affected-package threshold is reached, or full mode is explicitly
requested. The plan and its reason are printed and written to a result file. Plan mode runs nothing and supports
synthetic file lists for testing the classifier.

Always-run steps include verification, fresh-checkout validation, site build, and quickstart. GPU, view, depth, WGSL,
package, no-WebGPU, visual, and bundler work is scoped by documented footprints. Tests require every configured step
to be assigned a class. A step may rerun automatically only after a Windows event-log GPU reset proves an external
driver failure; a second failure remains a failure and the result records that the first attempt reset.

Full validation is an explicit mode, not a default substitute for classification. Unknown or shared changes fail
closed to full coverage. This distinction is what prevents a local package edit from needlessly exercising unrelated
packages while preserving complete coverage when impact cannot be bounded.

### 4.4 Continuous integration

The audited CI matrix included:

- Lint/typecheck on the primary Node version.
- Build, API, quality, and unit tests on the repository minimum Node.
- Node compatibility on 22.12, current 22, and 26: build, engine checks, proof goldens, API availability, consumer
  package and bundler checks, with the broader test set on the newest entry.
- Node-22-specific tests.
- Locked native Rust kernel tests.
- An on-demand Windows browser workflow for broader browser/package coverage.

GPU proof, visual, and full local hardware checks are not assumed to run on a hosted CI GPU. Whether a remote workflow
actually ran is field evidence, not inferred from the YAML.

Since 2026-11-07 GitHub Actions is off while the repository is private (Scott: not paid for); local CI on the dev PC (Windows
11, RTX A6000) runs the same ground instead, see section 5, gap 34.

### 4.5 Golden-output proofs

A proof scripts a package story against a recording stand-in GPU and compares every call, descriptor, and buffer byte.
It must also exercise a feature-on path that differs, proving the comparison can see the feature. Stories cover
changes such as resize, format and sample changes, hidden state, empty state, model rescans, device restoration, and
dispose.

- **Current mode** compares the working implementation with committed lossless golden outputs and runs without old
  Git history. Missing output is a failure.
- **Pinned mode** reconstructs the baseline and claim revisions for historical claims. An unavailable historical
  revision is reported as historical, not silently presented as a live pass.
- Golden metadata records proof name, source ref, resolved revision, capture revision, facts, and SHA-256 per output;
  compressed values are stored separately.
- NaN payloads can be canonicalized only by the proof's declared comparison. Every other bit, including signed zero,
  counts. The sole standard shader normalization is the documented historical AgX-body case.

When an intentional feature-off output changes, audit the exact call-level difference, update the current reference,
capture only after the comparison passes, and update the whitepaper claim with the old/new evidence and reason. Pinned
baseline and claim revisions remain immutable.

### 4.6 Visual regression

Visual checks use real GPU rendering, a fresh browser context, reduced motion, deterministic view parameters, the
demo's readiness signal, and masking for dynamic telemetry. Images are box-downsampled. For each pixel, `d` is the
largest RGB-channel difference. Gated metrics are:

- `changed`: share with `d > 0`.
- `hot`: share with `d > 24`.
- Tolerance: measured worst pairwise noise times 3 plus fixed allowances (`0.0005` changed, `0.0002` hot).

Updates capture multiple independent launches and retake until consecutive captures agree, avoiding mid-raster frames
under load. Each baseline records view, dimensions, runs, noise, tolerance, browser/GPU/power state, date, revision,
and whether rendered inputs were dirty.

Profiles are keyed by GPU slug, browser family, and browser major. A run must never compare against a different
profile. Creating a profile requires the complete view set from clean rendered inputs. Missing hardware evidence is a
failure with an instruction to select the intended GPU or deliberately capture a new profile.

`MARGO_BROWSER=webkit` (2026-11-05) runs the browser suites in Playwright's WebKit build, which has WebGPU on macOS; the Mac sweep
needs it. It is not Safari, which needs safaridriver, and it is not a visual profile of its own.

At the audit snapshot, profiles existed for Intel Arc 140V/Edge 155 and RTX A6000/Edge 155 and 156. Intel on newer
Edge, Intel UHD, AMD, and Linux coverage remained absent. RTX A6000/Edge 157 was added on 2026-11-08 (4 runs per
view, 81 views, captured from `d9fa86e5b`) after Edge updated itself; against the 156 profile 16 of 81 views differ,
the largest per-pixel difference being 221 (FlightHelmet).

### 4.7 Public truth and benchmarking

`scripts/support/public-truth.mjs` validates structured license URLs against `package.json` and `LICENSE`, and package
count phrases against `docs/catalog.json`. It does not validate every size, timing, or test-count statement. Those must
cite generated records and retain evidence status. An older WebGL preview-size inconsistency demonstrates why this
scope matters. So does the audit of 2026-11-06: the 44 B of `Engine.renderTarget` reached `README.md`, `site/index.html` and
`docs/limits.md`, while 11 other files kept 22,815 B or older, `claims.md` among them, and a replace of the current figure had
rewritten the dated 22,189 B of the 2026-10-30 cleanup in `docs/limits.md`. Core alone read 21,134 B there; it is 21,285 B.

The benchmarking protocol uses AC power, a shared GPU-resource lock, a whole-machine idle gate, warmup, repeated
measurements, between-case load checks, fixed browser/canvas conditions, and a spread validity limit. Defaults at the
snapshot were one warmup, five measured runs, 300 frames after 60 warmup frames, at most 10% spread, and a 5%
regression threshold (1% for bytes). Report median; with five runs p95 is the slowest sample.

Timing regressions compare only matching machine identities and must exceed both the threshold and measured spread.
Bytes and counts are machine-independent. Engine comparisons use shared scene data, interleaved randomized order,
identical settings, harness timestamp queries, and an append-only ledger that keeps losses and records before/after,
cause, tradeoff, revision, and rerun command. Competing-engine code stays outside this clean-room repository.

Performance validation must include slower supported hardware before a conclusion is generalized. A pass caused by a
slower baseline is invalid; compare the run's baseline against the recorded baseline first.

### 4.8 Failure classes preserved by the gates

| Failure class | Guard |
| --- | --- |
| Current proofs depended on private local history | Committed golden outputs and fresh-checkout validation. |
| Historical proof used today's core on both sides | Claim-revision core pinning and dedicated tests. |
| Stand-in overhead erased a measured speedup | Shared recorder methods and focused regression test. |
| A timing comparison flipped under load because its two sides allocate differently | Compare work with the same allocation profile; a whole-job budget is a ratio to a control job that allocates alike (`packages/exporters/tests/exporters.test.js`: 10 of 10 with 32 processes allocating). |
| Proof digest differed by Node/V8 math | Exact proof inputs, deterministic stand-ins, and multiple pow modes. |
| Packed declarations referenced source outside the package | Every build creates declarations; consumer package check. |
| Visual profile mismatched browser or adapter | Exact profile key and explicit adapter selection. |
| Browser readiness assumed fixed time | Readiness-based waits plus fixed-wait gate. |
| Wall-time assertion failed only under CPU contention | CPU-time budget helper plus wall-budget gate. |
| GPU driver reset produced a misleading code failure | One evidence-backed retry with explicit result annotation. |
| Public generated records or prose drifted | Revision-stamped generation, public-truth checks, and whitepaper evidence. |
| A number field declared in a class started as `undefined`, so each write of a fraction allocated | `tests/class-fields.test.js`. |
| A GPU script nothing ran failed unseen (`area-lights-gpu.mjs` still mirrored a display curve core left on 2026-10-17) | The script runs in `test:gpu:area` of `packages/clustered`, and a correctness run no longer overwrites the bench record. |
| A pass other than the colour pass drew a material's whole surface | `packages/materials/test/cutout-passes-browser.mjs` (picking, contact shadows, TAA velocity) and `packages/shadows/test/cutout-casters-browser.mjs` (every shadow map pass, virtual included) read pixels and velocities through a cut-out, a displaced surface and a clipping plane. |
| A node graph's vertex offset and discards reached only the colour pass | `packages/shader/test/passes-check.mjs` compares a moved caster with a plain mesh placed there in `Shadows`, `VirtualShadows`, `LocalShadows` and integrated clustered shadows, and a cut caster with a half-sized one. Depth passes take the graph through the `displacement` record of a primitive (`CasterDisplacement` in `packages/shared/caster.d.ts`), so caster caches treat it as moving. Still missing: TAA velocity for such a surface (docs/limits.md). |
| Skinning and morphing written in a node graph could drift from the CPU maths or lose the normal | `packages/shader/test/deform-check.mjs` compares `@margoengine/shader/deform` with the same mesh deformed on the CPU, lit, so a stale normal changes the picture: a slanted bone turn, morph into skin, a stretched and mirrored mesh (`worldNormal` uses the model matrix's cofactors), a new pose and the shadow. `skinningFromModel` is checked on the real Fox.glb against `@margoengine/animation`'s compute deformer at two frames of its clip. |
| A scene pass runs before the colour pass, where uniforms upload ahead of the frame's commands and the canvas may be display-encoded | `packages/shader/test/pass-check.mjs` reads pixels back: `ScenePass` writes last frame's matrix before any draw of the frame (a write after its draws lands first in queue order and gives zero velocity), and shades into linear targets through a view block of its own (the sunlit and tone-mapped rows fail if the canvas encoding reaches the target). Multi-view frames have no such check yet. |
| A raw mesh draws through depth, G-buffer and pick pipelines of its own vertex stage, in passes that run before and after the colour pass | `packages/shader/test/raw-check.mjs` reads pixels, buffers, picks and counters back: the shadow of a caster moved by its vertex shader lands on the wall, `discard` opens it, a mesh's own ambient is darkened at a crease, and a pick lands where the shader put the mesh. |
| A graph using subgroups or f16 must give one answer on devices with and without the feature | `packages/shader/test/subgroups-check.mjs` runs one graph on two devices of an adapter and compares every operation with the lanes the hardware reported, then the one-lane form. No other GPU family has run it: subgroup sizes other than 32 are unproved here. |
| A hashed cut-out's coverage must equal its opacity, and TAA must average it | `packages/materials/test/features-browser.mjs` reads the pixels drawn at seven opacities, on plain and instanced meshes, and the grain with and without `stochastic` TAA. Only an RTX A6000 has run it. The default TAA resolve keeps a per-pixel depth rejection, which cannot average such a surface. |
| Exact transparency must blend as a per-pixel sort would, with hidden layers gone though its fragment shader runs ahead of the depth test | `packages/oit/test/gpu/exact-check.mjs` compares four layers, an opaque plane between them, crossing sheets, MSAA edges, a list that has to grow and a transparent canvas with blending worked out by hand, at 1x and 4x. Only an RTX A6000 has run it, on generated planes; no timing exists. |
| Moment transparency holds four power moments in half floats, where a rounding can break the moment matrix | `packages/oit/test/gpu/moments-check.mjs` holds the picture to blending worked out by hand and to weighted blending on the same scene at 1x and 4x, with one layer, dense layers and a moved model; the half and float cases were compared on a CPU model, not on the GPU. Only an RTX A6000 has run it, on generated planes; no timing exists. |
| Tints and light in OIT must equal the sorted path where order cannot matter, on encoded canvases too | `packages/oit/test/gpu/blending-check.mjs` compares each kind alone with the sorted path, and light with dimming against the formula, at 1x and 4x. Only an RTX A6000 has run it, on generated planes; no timing exists. |
| Effects in an order-independent pass must hand it the true view depth and blend in true order with models | `packages/oit/test/gpu/vfx-check.mjs` reads the depth each of particles, splats, points and sprites hands the pass, under perspective and orthographic cameras, and compares them with a 50% pane on both sides at 1x and 4x. Only an RTX A6000 has run it, on generated layers; no timing exists. |
| Splats must hide what later passes draw behind them, and nothing in front | `packages/splats/test/gpu/check.mjs` draws a quad from a later pass behind and in front of a splat and of a real capture, with and without `SplatDepth`, at 1x and 4x, perspective and orthographic, and compares the pixels with the cloud alone. Only a Radeon 680M has run it. |
| A streamed splat hierarchy must draw what the plain cloud draws when fully refined, and stay within its budget | `packages/splats/test/gpu/check.mjs` compares the streamed full cut of a real capture with a plain cloud of the same splats and streams a 16.7 M-splat stand-in in a 2 M budget. Only a Radeon 680M has run it. |
| The passes must hold on real models | `packages/oit/test/gpu/real-check.mjs` runs six Khronos files through every pass from eight sides. It asserts no GPU error, which parts each pass takes, depth that only comes nearer, and moments closer to exact than weighted on GlassVaseFlowers. No reference picture exists, so what it measures is gaps, not correctness. Only an RTX A6000 has run it; no timing exists. |
| Glass in the depth must match an opaque surface bit for bit, or TAA's equal test finds no vector | `packages/oit/test/gpu/depth-check.mjs` compares the depth value with an opaque plane at 1x and 4x, and reads a TAA vector and a DOF edge from it. Only an RTX A6000 has run it, on generated planes; no timing exists. |
| Hair, eye and skin must follow their published models under every light they claim | `packages/materials/test/features-browser.mjs` jobs `hair`, `skin`, `eye` and `character` compare the lobes with the formula, the skin with its table, the pupil with a Snell trace, and clustered lights with the sun. Only an RTX A6000 has run them. The eye's refraction has no real eyeball to measure on. |
| Clipping planes must cut the same in the rasterizer as by discard | `packages/materials/test/features-browser.mjs` job `clip` draws one scene on a device with the feature and on one without, reads the compiled shaders, classifies every pixel against the plane and compares the two pictures and shadows. Only an RTX A6000 has run it. |
| Graph-side normal, parallax and colour helpers could flip a handedness or drift from the maths they name | `packages/shader/test/utils-check.mjs` reads each `@margoengine/shader/utils` node back on a real GPU: the UV origin of a `Texture` against each normal map direction, a known slope through the Mikkelsen bump, the line of sight under a flat and a sloped height field, `matcapUV` against `MatcapMaterial`, and the maths and blend nodes against JavaScript formulas |

### Extruded text correctness gate (2026-11-08)

`@margoengine/text/extrude` remains an optional CPU font/mesh entry; core and stage are unchanged. All binary reads
are confined to their file/table/glyph/program span. Composite and Type 2 execution have bounded depth and work;
subdivision options reject nonfinite/fractional/excessive values with a coded error. Contours are filled by nonzero
winding before visible hole bridging and complete ear clipping; failed triangulations never return partial caps.
Both outward caps and the bevel walls share terminal ring coordinates. Invalid offset geometry is rejected.

`npm run check:text-extrude` is part of `check:merge:steps`, covering all extrusion tests, hostile font bytes,
curve/transform semantics, cap area, directed edge incidence, signed volume and unit normals. The package test
also discovers all extrusion test files. Independent reference and complete real-font runs cover Source Sans 3
Regular 3.052 in TTF and CFF1 (2,478 glyphs each; 2,469 nonempty solids per font); ten glyphs per font are compared
against frozen native unhinted cubic controls with a separate de Casteljau evaluator. The browser suite asserts
WebGPU orange pixels and native WebGL2 orange pixels, then zero orange pixels with the mesh hidden. The README
procedural font uses em coordinates and is executed as a regression case and by the README runtime gate.

Evidence limits: one family, two formats, one Windows GPU/browser, no speed claim or universal font guarantee.
CID CFF/CFF2, variations and shaping remain outside this entry; severe bevels throw instead of intersecting.
The all-glyph test covers unbeveled solids; synthetic cases cover rounded/chamfered bevels, holes and invalid offsets.

## 5. Current evidence gaps

### Procedural space colonisation (batch 68, job 4)

The optional trees entry owns its Rust crate and lazy Wasm asset. Attraction assignment and growth are
CPU operations with typed owned output and no core/stage imports. Tests compare accelerated neighbour
assignment with an exhaustive reference, validate connected finite parent graphs, segment lengths,
bounded hostile inputs, cancellation and disposal. Production consumer tests check lazy loading below
a non-root base and exact values on real WebGPU/WebGL2 before and after loss. These are stand-in
skeleton proofs; mesh appearance, biological fidelity, timing and cross-device coverage remain open
evidence boundaries (LIM-631).

The internal loader shared by Poisson, dungeon and trees now preserves exact abort reasons and
specific linked/CSP faults while coding file, fetch, body and ordinary compilation failures with
procedural help and the original cause. Seven regressions exercise real missing-file and malformed
Wasm errors plus simulated transport, CSP and cancellation cases; they do not claim a real CSP-policy
browser failure proof. Existing healthy backend values and independent feature assets are unchanged.

The lane-Q README repair (2026-11-09) executes all 40 examples of React, Stage, text and worker with zero
exceptions in that scope. The page runner prebundles React's CommonJS entries, compiles JSX automatically and writes
named page/worker companion sources into isolated program directories. Static glTF selection follows the imported
basic loader, including Stage's feature entry, rather than the owning package name. Browser automation stays in Node,
receives the selected browser/GPU launch environment and fails on unfinished assertions; it cannot pass as a server
that merely reaches its time limit. React's picking example owns its app/server and waits for real frames and the
click's asynchronous state update. Text's BMFont sample includes a generated, OFL-licensed ASCII SDF atlas and a
relative PNG page; its browser test fetches both and reads back rendered Hello pixels. These five exceptions are
removed from the known list. This evidence covers Chromium on this machine, not other browser engines or fonts.
The atlas writer is registered as a browser tool in the GPU planner; generation never replaces the planned text
rendering suite or rewrites a committed fixture during verification.

The lane-Q README repair (2026-11-09) executes all 40 examples of React, Stage, text and worker with zero
exceptions in that scope. The page runner prebundles React's CommonJS entries, compiles JSX automatically and writes
named page/worker companion sources into isolated program directories. Static glTF selection follows the imported
basic loader, including Stage's feature entry, rather than the owning package name. Browser automation stays in Node,
receives the selected browser/GPU launch environment and fails on unfinished assertions; it cannot pass as a server
that merely reaches its time limit. React's picking example owns its app/server and waits for real frames and the
click's asynchronous state update. Text's BMFont sample includes a generated, OFL-licensed ASCII SDF atlas and a
relative PNG page; its browser test fetches both and reads back rendered Hello pixels. These five exceptions are
removed from the known list. This evidence covers Chromium on this machine, not other browser engines or fonts.
The atlas writer is registered as a browser tool in the GPU planner; generation never replaces the planned text
rendering suite or rewrites a committed fixture during verification.

### Required S2 sample and IES README evidence (2026-11-09)

The pinned CesiumJS S2 standard-data sample expands 21 implicit cells; 45,738 points from
independent face-0 quadratic projection/WGS84 equations fit the loaded boxes at the file's
height ranges. Three exact data files join the required external manifest (352 inputs).
This is hierarchy/containment proof, without content meshes or production-world rendering.
Binary metadata heights do not tighten the inherited 0..10,000 m slab; other faces/octrees
retain generated controls. The IES README now runs its published CC-BY-4.0 profile, and all
10 clustered examples pass. These results establish no new image-quality or timing claim.


### Procedural BSP layouts (batch 68, job 3)

The optional dungeon entry owns one dungeon-kernel crate and one lazily loaded dungeon.wasm. Partitioning,
room generation and rasterization run in Rust compiled with SIMD enabled; no SIMD speed gain is claimed.
The shared internal byte loader preserves independent per-feature URLs and the existing Poisson entry's
abort/error behaviour. No core or stage source changes. Native Rust and TypeScript tests check bounded
inputs, owned outputs, seeded repeatability, wall borders, room margins, tree links, flood-fill connectivity
and an independent whole-grid raster oracle. Direct written-cell work excludes common grid initialization.
The production browser test covers both feature assets under a non-root base, no Wasm request on import,
WebGPU/WebGL2 exact values, real device/context loss, and idempotent disposal. All grids are STAND-IN;
gameplay, navigation clearance, 3D meshes, cross-device coverage and timing remain unmeasured (LIM-628).

### Procedural Poisson placement (batch 68, job 1)

`procedural/poisson` keeps rejection and area loops in one lazy feature-local Rust/Wasm module; core and stage
stay unchanged. Its hash matches a float64 all-pairs oracle on identical candidates: 3,329 versus 3,445,553
distance tests. This is deterministic work evidence, not language speed evidence. Synthetic rectangles and
sloped/disconnected triangles establish spacing, bounds, area weighting, hostile inputs and lifecycle behavior.
The browser test builds a production consumer under `/sampling/`, verifies no Wasm request on import, then
compares WebGPU/WebGL2 values after device/context loss. No renderer resources are owned. Rebuild with
`build:poisson`; native tests use `test:poisson-kernel`. SIMD is enabled without an acceleration claim.
Authored meshes, spectral quality, maximal covering and cross-platform bit identity remain unmeasured (LIM-621).

A pinned, required CC-BY-4.0 OpenVDB sphere now catches empty half-value node alignment: zero half values have no
compressed-size prefix. ZIP/Blosc synthetic cases and the outside sphere exercise the fix without changing values
or tolerances. Its 1,451 leaves, 270,638 active voxels and bounds match the file metadata; no new codec/version
coverage or renderer quality follows. The OFF parser uses explicitly LGPL-licensed standard samples; held physics
and benchmark knight workloads are unchanged. See the required-input inventory.

The required-input audit also exercised the newly landed SQL-store restart test. The unit watchdog caught a
Windows `EBUSY` folder hook before database closure, followed by a leaked server and generator workers. Its
test-body `AsyncDisposableStack` now closes resources before directory removal, including failed setup; the
unchanged watchdog remains the check for process leaks. Regression: `packages/voxel-net/tests/sql-store.test.js`.

### WebGL2 consolidation evidence

The optional compatibility package also owns `/preview`, `/pick`, `/restore` and
`/auto`. The real-context proof is `packages/webgl2-compat/test/preview-browser-check.mjs`,
covering selection, context loss and escalation, alongside the full compatibility
GPU suite. The preview remains necessary below the full device float-target tier.
See [the feature mapping and inventory](../webgl-consolidation.md).
The WFC browser test now tears down its browser and server together with bounded
`closeAll`, including failed startup. `tests/browser-teardown.test.js` caught its
previous unbounded shutdown while validating this consolidation.



The required-fixture audit is tracked in [missing-test-items](../work-lists/missing-test-items.md).
The verify root suite now runs `tests/fixture-skips.test.js`, which parses test/proof syntax with
`scripts/check-fixture-skips.mjs` and rejects the audited missing-file skip/early-success patterns.
Required reads also reject absent files and Git LFS pointers with an exact path and recovery command.
Download failures (HTTP, byte budget, digest) fail. Batch 160's four files and held physics packages
remain explicit ownership exclusions, not fresh proof. The initial existing-fixture run passed 561
tests with no skips; final strict CPU, GPU and gate results are recorded in the work list as they finish.
Missing real-file variants and reference renders remain pending there; no runtime quality or speed
claim follows from replacing a silent skip with a failure.

Batch 160 adds the first outside metallic-roughness picture budget: all 123 Khronos textureless sphere
primitives, matched embedded camera/sun, neutral display transform and every pixel, against Sample Viewer
PNG output. RTX A6000 RGB MAE 1.837511698404948 on WebGPU and 1.837506612141927 through WebGL2
compatibility; native WebGL2 explicitly rejects PBR. See whitepaper/results/batch-160-metallic-roughness.json
and scripts/reference-rendering/run.mjs. The remaining picture loss is open in known-bugs; other material
families and the independent path-traced IBL/Cornell controls are still unmeasured. No core change.

### Lighting2d batch 55 repair evidence (2026-11-08)

`packages/lighting2d/tests/frame-regressions.js` and `emission-regressions.js` extend the existing `test:gpu` suite,
already discovered by `check:gpu-packages` in `check:merge`; `frame-lifecycle.test.js` adds Node lifecycle coverage.
Every direct-light entry now runs the same
mask/layer, repeated-frame, format, name-reuse and device-loss scenarios. Independent arithmetic checks cover separate
height uniforms and isolated HDR threshold images; actual `Bloom.encodeImage` output is checked against a separately
encoded dispatch and must spread outside a zero-glow sprite. All six entries reject a native WebGL2 engine with a coded
error and help link. Direct-light storage ceilings are device limits rather than silent 64-item truncation.

Current evidence is one RTX A6000/Edge device. Cross-vendor rounding and adapter behaviour remain unproved. The spatial
GI replacement now has the independent energy, visibility and analytic-circle evidence described below. No speed claim
or benchmark is added. Scott approved the six exact measured optional ceilings on 2026-11-09; all gates remain mandatory.


The following remain technical gaps, not permission to weaken a check:

PixelScale, CRT and PaletteQuantize have CPU-reference/readback evidence on the RTX A6000 through native WebGPU and
the WebGL2 compatibility layer. The pixel regressions above cover format reuse, scene ownership, clipping and flat
nearest boundaries; the palette unit suite covers finite-cycle reduction and overflow. Curved CRT comparisons still
exclude samples within 0.001 texel of an edge (float32 versus float64 can choose different neighbours); flat/all-off
samples are never excluded, and all-off is exact. No other GPU/browser family, physical CRT fidelity or speed result
is established by these checks. Native WebGL2 preview remains unsupported for these optional GPU passes.

Extruded text has the scoped evidence above, not cross-font-family or multi-device certification; font hinting,
shaping and arbitrary bevel topology changes are not proved by those checks.

1. No gate directly proves that embedded Wasm matches current Rust source.
2. Native and Wasm turn reduction differ at an exact half-way case that lacks a regression test.
3. The kernel optimization experiment uses obsolete layout and compression assumptions.
4. Cross-machine bit equality of kernel output is not measured.
5. Precise-math GPU cost versus builtins is measured on the RTX A6000 only.
6. Intel Arc 140V precise-math bounds need a post-fix run; AMD and Intel UHD need one since the `pmLog2Pair` change of
   2026-11-05, and `precisePow`'s cost needs measuring again.
7. Compatibility CPU compute runs 13 to 41 times slower without `unsafe-eval` (interpreter); broad CSP prose must remain scoped to the native engine.
8. Compatibility path-tracer kernels remain outside the practical shader-compilation budget.
9. Visual baselines do not cover every supported GPU/browser/OS combination.
   A true GPU out-of-memory is not exercised either: failed allocations are proved on the throwing paths only (section 3.6).
10. The WebGL preview size was inconsistent across older public sources; current generated evidence should replace
    every stale statement.
11. One duplicate-window comment says eight lines while implementation and conventions use six.
12. GPU geometry generation has no speed measurement and no run on a GPU other than the RTX A6000.
13. Only the upper core-stage bound is enforced; there is intentionally no lower bound.
14. Public-truth checks cover license and package count, not every size or performance number, so a size figure in a guide or
    package README can go stale with no check failing (section 4.7).
    README examples are held by `check:readmes` in `verify` since 2026-11-06, but 328 known errors remain (docs/known-bugs.md), so
    those examples are not yet evidence that their package's types are right.
15. Remote workflow configuration is not proof that a workflow actually ran.
16. The quality classifier must keep a conservative full-mode fallback for genuinely unclassifiable or shared
    changes, while ordinary package changes remain affected-only.
17. Scatter's GPU cull keeps candidate order (2026-11-05; it used to append at `atomicAdd` slots, and an Apple M6 drew
    other 4x MSAA edge pixels every frame). The exact 4x MSAA repeat check (`packages/scatter/test/repeat.browser.mjs`)
    and `packages/biomes/tests/shadows-check.mjs --msaa` have passed on the RTX A6000 and the M6 only, run by hand;
    no gate runs either one on Apple GPUs, and other GPUs are not checked. Its shadow lists still append atomically
    (depth only, so the same depth in any order).
18. Subgroup kernels have run at subgroup sizes 32 and 4 only, and no gate runs size 4.
19. GPU BVH traversal and the GPU build have no quiet speed measurement and no run on a GPU other than the RTX A6000.
20. `CulledModels`, per-cascade caster culling, `LodInstances` and `MeshletMesh` have no timed run; each is proved by pixels on the RTX
    A6000 alone, as are occluders, oriented boxes and occlusion for core meshes.
21. Every timing since 2026-11-05 is diagnostic. The parity ledger's last run is 2026-10-27: after numbers sit in the row's cause text,
    and `p-morph-compiled`, `p-motion-blur-velocity` and `p-pmrem-refresh` have no ledger row yet.
22. The WebGL2 CPU tier's interpreter and the path tracer on the layer have no committed timing script.
23. `@margoengine/shader` compute passes have no check on the WebGL2 layer, and `@margoengine/compute/nn` and `/graph` no speed measurement.
24. The headless stage runs in Node on Windows only (Dawn on D3D12 and WARP), and a textured glTF does not load there.
25. Draw counts in LIM rows are printed by GPU checks and asserted only as bounds, and no result file holds them.
26. `ScenePass` (`@margoengine/shader/pass`) has no check in a multi-view frame, and its `velocity()` follows one camera.
27. Dual quaternion skinning has no frame-time measurement and no run on a GPU other than the RTX A6000.
28. Bone-texture crowds have no frame-time measurement and no run on a GPU other than the RTX A6000.
29. GPU Basis transcoding (`@margoengine/decoders/ktx2-gpu`) equals the Wasm transcoder byte for byte on the RTX A6000 only, and
    its load time against a cold Wasm transcoder is not measured.
30. The own physics kernel is proved bit-equal on one Windows x86-64 PC only: no run in Safari, on ARM or on a second machine, and it has no timing against Rapier yet. The range check runs once a step, so a run away of more than 23 orders of magnitude inside one step would reach a NaN: none seen in 200 random webs of 10,000 steps.
31. Voxel far levels (`@margoengine/voxel/lod`, a scaled `VoxelRenderer`) are proved on the M6 Mac mini (Metal) only: scale 2 against scale 1 drew the same image; frame cost at kilometre view distances is not measured on any GPU.
32. The own physics solver's body kinds, own mass and extra passes (LIM-438) are proved in Node and by the replay in Chromium and
    Firefox; nothing of it is timed against Rapier yet (batch 129). Sleep reads through `setType` and of still kinematic bodies
    (a RESTING flag: they stay on the awake list) are held to the root entry's measured reads in `next-bodies.test.js`; an island
    still wakes at the call rather than at the step, an accepted difference in `docs/limits.md`. A kinematicPosition body at its
    target is exactly still (`kernel/tests/sleep.rs`), so what rests on it sleeps.
33. Coloured voxel block light (`@margoengine/voxel/light-rgb`, a `VoxelRenderer` lighting effect sampling a wrapping 3D texture) is proved on the M6 Mac mini (Metal) only: a dark room is red by a red torch and blue by a blue lamp with it, black without; its frame cost and the upload cost when the camera crosses chunks are not measured.
34. Local CI replaces GitHub Actions while the repository is private (2026-11-07; the CI, Browser checks and Biomes
    digests workflows are disabled on GitHub). It runs in its own worktree, `C:\Development\Projects\margoengine-ci`, from
    a script in its git-excluded `.ci/` folder (`ci.mjs`, `quiet.mjs`, `register-tasks.ps1`), as Scott's user, not elevated,
    through Windows Task Scheduler (folder `\Margo\`):
    - CPU set at 08:00, 12:00, 14:00, 16:00, 18:00, 20:00 and 22:00 on the newest `origin/main` (skipped when that commit
      was already checked): `build:packages`, `lint`, `typecheck`, `hygiene`, `check-engines --run=repo`, every chain of
      `verify`'s stage 2 (API reports, quality, parity table, sandboxes, root unit tests, docs links, README checks, size,
      proofs), `test:kernel`, `test:physics-kernel` and `test:physics2d-kernel` (since 2026-11-08).
    - Full set at 10:00: the CPU set (reused from an earlier run on the same commit), then every `check:merge:steps` step
      after `verify` but `check:rust-kernels` (its kernels are in the CPU set), one at a time, each through the GPU lock as one shared slot (exclusive for its timing tests). No GPU
      step starts from 12:00 to 20:00 (benchmarks); one that would is recorded as deferred.
    - Weekly quiet hour, Sunday 06:00 to 07:00: waits up to 20 minutes for the whole machine under 10 percent CPU, else
      records "not quiet"; then, holding the GPU alone, Margo's two columns of the physics comparison harness (defaults
      and equal cost) and the three.js parity matrix (`bench/cli.mjs parity`, without the report that rewrites docs).
    Every step has a hard limit and a hang kills its process tree; nothing is retried, pushed or edited in tracked files.
    One run at a time (a lock with a heartbeat, reclaimed when dead). Results stay on the dev PC, in the main checkout's git-excluded
    folder for private notes. Status: `ci-status.json` (commit, times, each step's result, duration and CPU load, the failing tests by name, log paths; a time or
    speed failure under a mean load of 70 percent or more is listed apart as "time-only under load", unless it is more
    than 2x its budget). Timing trend: `ci-timings.jsonl`, each timed test and step per main commit with its load;
    a jump of 1.5x or more against the previous main commit at a load within 15 points is flagged in the status file.
    Quiet-hour results: `quiet-bench/<date>.json` with a diff against the last quiet run. Logs: the last 10 runs
    in `.ci/logs/`. Not covered locally: the Node 22.12, 22.x and Node 24.18 runs of `node-compat` and `node22-tests` (one
    Node, 26.12, is installed), the Linux and macOS biomes digests, and the on-demand Browser checks workflow's
    SwiftShader runs.
35. The own physics kernel's triangle meshes (batch 126 job 2, `kernel/src/mesh.rs`, `bvh.rs`): the tree is checked
    against brute force (`kernel/tests/bvh.rs`, and a box on a bumpy mesh gets the same parts and points as one mesh a
    triangle), the edge rule against closed cases and slides (`kernel/tests/mesh.rs`), the separating axis test of a flat
    triangle against every axis on 20,000 random poses (`kernel/tests/sat.rs`), and the physics-refs trimesh scenes pass
    in Node (flat slides, 1,000 boxes on St Helens, 11 broken meshes). Missing: rays and shape casts against a mesh (job
    6), a mesh against a mesh, any browser run of a mesh scene beyond the replay's hash, and speed parity: the build is
    65 ms against Rapier's 43 ms and a step of the box pile 1.52 ms median against 1.14 (`docs/limits.md`), for batch 129.

36. The own physics kernel's height fields (batch 126 job 3, `kernel/src/mesh.rs` `end_grid`): a field's triangles and
    neighbours are checked against the same cells held as triangle rows and joined by corner position, and its contacts
    against them bit for bit on 48 drops of boxes, balls and capsules with the edge rule on and off
    (`kernel/tests/mesh.rs`); its layout against Rapier 0.21 by 300 rays through the root entry
    (`tests/next-heightfield.test.js`); the physics-refs heightfield scenes pass in Node (flat slides, 1,000 balls on St
    Helens). Missing: rays and shape casts against a field (job 6), a field against a mesh, Rapier's per-cell status, any
    browser run beyond the replay's hash, and speed parity on the 499,849-cell build (16.3 ms against 8.6), batch 129.

37. The own physics kernel's compound colliders (batch 126 job 4, `kernel/src/compound.rs`): children are collider rows
    off the broad phase with fat boxes the broad phase writes, and a compound pair holds a part per touching child, child
    pair or child and triangle (PAIR_PART and the new PAIR_SUB column). Proved: mass the same bits as the parts as
    colliders, rest, one pair, mesh contact, stacking, empty gaps, sensors and row reuse (`kernel/tests/compound.rs`);
    mass, centre, inertia and rest against Rapier 0.21 (`tests/next-compound.test.js`). Fixed with it: removing a
    collider now wakes what touched it (`kernel/tests/sleep.rs`), as Rapier does. Missing: cylinder and cone parts, rays
    and casts, a tree over many children, and any browser run beyond the replay's hash.

38. Stable instance rows with changed-row uploads and `Engine.writePoses` (2026-11-07) are proved by deterministic counts
    (`tests/core-instance-cache.test.js`, `tests/core-write-poses.test.js`, `packages/physics/tests/next-sync.test.js`)
    and pixels: on Edge 157, which has no committed profile, `npm run visual:check` passed all 81 views against a local
    profile captured from the commit before them (4 runs, not committed), and `npm run visual:compat` failed only on
    `boulder` and `khronos-LightsPunctualLamp`, with the same numbers before them (`docs/known-bugs.md`). Missing: a timed run (the machines were busy; the
    plan is `bench parity boxes-10000` with culling on, and an orbit of 50,000 CAD parts), and the cost of a frame where
    several cameras view one scene.
39. Voxel GPU meshing (`@margoengine/voxel/gpu-mesher`, compute shaders writing `meshChunk`'s quad format) is proved on the M6 Mac
    mini (Metal) only: every chunk of a lit test terrain and five special chunks gives `meshChunk`'s words exactly, before
    and after a large edit, and a `VoxelRenderer` with it draws the worker mesher's picture pixel for pixel. The faces
    kernel finishes each slice's greedy merge in one invocation per workgroup (192 per chunk), so a dispatch is bounded by
    that serial scan; slabs and stairs stay on the CPU path. Timings in the check are diagnostic, one machine.
40. The own physics kernel's voxel grids (batch 126 job 5, `kernel/src/voxel.rs`): a mesh row flagged MESH_VOXELS, a new
    row class of VOXEL_WORD (four cells a word, a byte each: filled and six neighbour bits) and VOXEL_ columns on the mesh
    row, so ROW_CLASSES is 19 and the world's bytes, not its poses, changed. Contacts are cell boxes through the convex
    routines, a part per cell, with Catto's ghost rule on exposed faces. Proved: `kernel/tests/voxel.rs` (five tests
    fail with the rule switched off) and `tests/next-voxels.test.js` against Rapier 0.21. Missing: a tree
    or run-length walk for very large grids, and any browser run beyond the replay's hash.
41. `render_snippet` (`@margoengine/mcp/render`, `packages/mcp/tests/render-gpu-check.mjs`, in `test:gpu`) is proved on the
    RTX A6000 (Windows, D3D12 through `webgpu` 0.6.2) only: a box drawn and fitted shows green in the centre and an
    empty snippet one colour. Missing: Metal and Vulkan runs, a software adapter, and the cost of a render per call.
42. Smooth voxel terrain (`@margoengine/voxel/smooth`, Surface Nets over signed densities, drawn as core meshes) is proved on the M6 Mac
    mini (Metal) only: a ball meshes closed and wound outward, split over eight chunks it gives the same triangles with no
    seam, and sculpting re-meshes only the chunks that read the changed cells. Meshing runs on the page thread; speed and
    memory at large view distances, LOD, textures and collision with `@margoengine/voxel/physics` are not built or measured.
43. Voxel bounce light and soft sun shadows (`@margoengine/voxel/gi`, rays traced in WebGPU compute through the world's opaque blocks) are proved on
    the M6 Mac mini (Metal) only, in one scene: a white floor beside a sunlit red wall turns red and a one-block pole casts
    a soft shadow the renderer alone does not draw. Frame cost, other scenes, multi-bounce and sky light are not measured or built.
44. The own physics kernel's rays (batch 126, queries job, `kernel/src/query.rs`, exports `query_ray`, `query_ray_all`
    and `query_buffer`): no new columns, so the world's bytes and poses are as before; hits go through a static buffer
    of 256, paged by `raycastAll`. Convex shapes by intervals (ball and capsule side in the precise forms of Ray Tracing
    Gems ch. 7), meshes by their tree, height fields and voxel grids by cell walks. Proved: `kernel/tests/query.rs`
    (closed forms, each walk against brute force, f64 references for far and grazing rays; mutations of the walks fail
    it) and `tests/next-queries.test.js` against Rapier 0.21. Missing: a tree over colliders for the world ray (each
    collider is tested) and any browser run; shape casts and point queries are item 46.
45. Tonemap's grading, custom curves, metering modes and local exposure (`@margoengine/tonemap`, `/grade`, `/custom`,
    `/local`) are proved against CPU oracles of their maths on the M6 Mac mini (Metal) only, on synthetic sources and
    simple lit scenes; GPU time of the new passes, other GPUs and photographed HDR scenes are not measured.
46. The own physics kernel's shape casts, point projections and overlaps (batch 126, queries job, `kernel/src/cast.rs`,
    exports `query_shape_cast`, `query_shape_cast_all`, `query_project_point`, `query_project_point_all`,
    `query_point_all` and `query_shape_all`): no new columns, so the world's bytes and poses
    are as before; hits go through the static query buffer, paged. A cast is van den Bergen's GJK ray cast (2004,
    Algorithm 3), then his closest-point steps from a lower bound on the gap, so a hit is never stepped past; meshes,
    height fields and voxel grids share one walk (`each_part`) with overlaps and projections. Proved:
    `kernel/tests/cast.rs` (closed forms, bisected GJK distance, walks against brute force, the stop options) and
    `tests/next-shape-queries.test.js` against Rapier 0.21 and an exact f64 reference of the Minkowski difference.
    Missing: a tree over colliders (each collider is tested), mesh, height field, voxel and compound query shapes,
    and any browser run. Rapier faults found are in docs/rapier-parity.md Q-07 and Q-09.
47. The own physics kernel's continuous collision (batch 126, CCD job, `kernel/src/ccd.rs`, `World::ccd_pass`
    after the substeps and before the events): two bits of the body flags, `CCD` (1 << 13) and `CCD_ACTIVE`
    (1 << 14), no new columns, so the world's bytes and every pose without CCD are as before (replay hashes
    unchanged). A CCD body that moved further than it is thick is swept by conservative advancement (Mirtich
    1996; Catto 2013) on a lower bound of the gap, so the time found is never past a touch, and put back there
    with its velocity kept, or carried by the kinematic or non-CCD body it met for the rest of the step. A part
    touching at the step's start holds the body no deeper than half its thickness instead of reading as a touch
    at time 0: the drafted rule froze a fast ball sliding on a floor and let a wall that carried a bullet pass
    it, and both have regression tests. Proved: `kernel/tests/ccd.rs` and `tests/next-ccd.test.js` (1,000
    bullets and moving walls, with Rapier 0.21's counts for the record). Missing: a tree over colliders for the sweep (it tests every fat box),
    Rapier's CCD substeps, smallest CCD step, soft CCD and CCD sensor events (batch 140.5), and any browser run.
48. The own physics kernel's cylinders and cones (batch 126, job 5, `kernel/src/revolve.rs`, `kernel/src/smooth.rs`,
    `SHAPE_CYLINDER` 6 and `SHAPE_CONE` 7, size A radius, B half height, C border): no new columns. GJK numerics changed
    for every shape: a needle simplex's area vectors come from its two shorter edges (Kahan 2014) and its plane
    offsets and volumes from the vertex nearest the origin; the closest point is the projection point itself, not
    the lambda-weighted sum, whose error floor (van den Bergen 2004, sec. 4.3) stalled GJK on curved shapes; the
    distance keeps its search vector `v`, and contact and cast normals now use it (on_a minus on_b was up to 0.30 rad
    off near a touch). A sharp cone's ray is solved from the point of the line nearest its centre (Haines et al.
    2019): a far start had cancelled to 6.7e-3 m at 107 m. Replay hashes regenerated (native and Wasm agree).
    Proved: `kernel/tests/gjk.rs` (needle simplex, small gap between curved shapes), `kernel/tests/revolve.rs`,
    `kernel/tests/cast.rs` and `tests/next-revolved.test.js` against Rapier 0.21 and an exact f64 surface.
    Missing: round boxes, triangles and hulls (S-10b, batch 139.2), and any browser run.
49. The own physics kernel's eighth-rate spring for movable pairs at one pass a substep (2026-11-08, `CHAIN_LOAD` in
    `kernel/src/solver.rs`): proved natively (`kernel/tests/solver.rs`, both pyramids, sleeping on and off; `examples/bars.rs`)
    and in Node through the physics-refs harness at both settings, where every scene but the piles and the stacks' first
    steps reads bit for bit as before (the stacks' sag moves 0.003 mm). Missing: a browser run of a one-pass scene, as the
    replay keeps the default 2 passes, and a pile deeper than 30 rows, whose bottom pairs pass the 50 times bound.
50. Voxel-edit shader brushes (`@margoengine/voxel-edit/shaders`, batch 97): user WGSL `fn brush(p, value)` compiled
    after a fixed prelude into one compute pass per brush pass; a grid is packed four cells to a u32 word, one
    invocation per word, ping-pong buffers, an explicit bind group layout (a brush may leave the tool, table and
    selection bindings unused) and the shader module checked inside a validation error scope so a broken brush names
    its line instead of raising a device error. Proved on the M6 Mac mini (Metal) by `shaders-browser-check.mjs`: the
    grow and erode presets equal `dilateGrid` and `erodeGrid` cell for cell, over 1 and 3 passes and on a 256-cubed
    grid (16.7 million cells), and a tool grid through a lookup table equals `combineGrids` union. Missing: any other
    GPU; grids past one storage binding (the device limit) are refused, not split.
51. The 2D kernel's coherent contact ids (2026-11-08, `physics2d/kernel/src/manifold.rs` `collide_coherent`): proved
    natively only (`kernel/tests/manifold.rs`, a box rocking through level keeps every id; `kernel/tests/world.rs`, the
    100-row pyramid drops 731 mm by 5 s with at most 6 points a step losing their warm start after 1 s, against 1,441
    without the kept face). Missing: a Wasm or browser run (the 2D kernel has no Wasm build yet), and the references'
    per-row sag is compared by a probe outside the repository, not by a test.
52. The 2D kernel's compact solver bodies (2026-11-08, `physics2d/kernel/src/solver.rs`): proved bit for bit natively
    (`kernel/tests/bits.rs`, three scenes and their counts pinned before the change) and by sizes; the paired step time
    did not move beyond the spread. Missing: the colouring and four-lane solve that the layout is for, and a Wasm run.
53. The 2D kernel's colour order (2026-11-08, `physics/kernel-common/src/colour.rs`, `physics2d/kernel/src/solver.rs`):
    proved natively (`kernel/tests/common.rs`, random graphs: no colour holds two contacts that write one body, every
    contact once, key order inside a colour; `kernel/tests/world.rs`, the 20-row pyramid built top down rests as one
    built bottom up). The order (height top first, colours visited backward) was chosen by measurement over pyramids of
    10 to 40 rows, not derived. Missing: the four-lane solve, a Wasm run, and scenes other than piles for the order.
54. The 2D kernel's four-lane contact solve (2026-11-08, `physics/kernel-common/src/lanes.rs`,
    `physics2d/kernel/src/solver/wide.rs`): proved natively bit for bit against the one-at-a-time solve on three pinned
    scenes and their counts (`kernel/tests/bits.rs`), and lane by lane against scalar operations
    (`kernel/tests/common.rs`); paired time in perf history entry 87. The Wasm simd128 path type-checks but has not
    run: the 2D kernel has no Wasm build yet (no allocator). Missing: a Wasm run and a browser timing.
55. Voxel-edit GPU bulk edits (`@margoengine/voxel-edit/gpu`, batch 97): `GpuGrid` keeps a grid resident in the shader
    brushes' packed ping-pong buffers, so fills, booleans, morphology, smoothing, palette remaps and user brushes queue
    compute passes back to back and the grid is read back once. Fill, combine and remap are fixed brushes on the same
    prelude (box, sphere by whole-cell squared distance, tool lookup), so every operation is exact integer work.
    Proved on the M6 Mac mini (Metal) by `gpu-browser-check.mjs`: a chain of a box fill, a sphere erase, a union with
    a palette map, a subtract, two dilations, an erosion and a smoothing pass equals the same CPU chain cell for cell
    on 37 x 29 x 41 and on a 256-cubed grid (16.7 million cells), clipped counts included. Missing: any other GPU;
    grids past one storage binding are refused, not split; the tool grid is uploaded per combine.

### Four-pair 2D narrow phase evidence (2026-11-08, section 5 addendum)

`physics2d/kernel/src/manifold/four.rs` groups four independent quad pairs per SIMD evaluation, including relative
transforms, ordered SAT, history-aware reference and incident selection, clipping and world-space placement. It
retains the exact scalar Quad distance path for apart cores, reusing placed vertices and SAT results. Fixed lane
extraction and an out-of-line scalar branch avoid duplicating distance code inside the Wasm batch function.
`world.rs` queues only awake non-chain quad contacts; other shapes, chains and short tails keep their existing
paths. Refresh uses original IDs and impulse mapping. No core/stage or shared kernel-common changes are involved.

Evidence now present: pinned native and Wasm hashes; whole-field reference comparisons for scene/random pairs,
permutations, histories, signed zero and large coordinates; mixed world queues and every tail; Edge WebGPU/WebGL2
and Firefox WebGL2 browser hashes. Firefox WebGPU has no adapter and is not claimed. The paired Wasm narrow probe
is 0.795 to 0.752 ms; the uninstrumented step 2.885 to 2.852 ms (17/24 rounds). This is a modest loaded-machine
result, not the 0.35 ms target. [Entry 92](../whitepaper/perf-history.md) and its committed result include the
discarded variants, every A/B round and the browser before/after table. Missing: a quiet rerun and proof of a large
narrow-phase gain. Solver setup and the remaining Box2D loss stay open; no physics work or tolerance was reduced.

### External video material evidence (batch 112)

`@margoengine/video/material` uses the existing optional MaterialFeature hooks, with no core or stage changes. Its GPU test compiles standard, physical, unlit, Lambert, Phong, toon, normal, depth, distance and matcap surfaces on the RTX A6000 at 1x and 4x MSAA; generated VideoFrames and a real HTMLVideoElement backed by a generated MediaStream return the expected sRGB colours within 2 of 255. Each draw imports an external texture, including after a media task changes the video. The test observes zero material-path frame uploads, and a real WebGL2 engine gets `unsupported` with a help link. `packages/video/test/material-check.mjs` is the package's `test:gpu`, discovered by check:gpu-packages. No movie decoder, browser-internal copy, speed, other GPU/browser or auxiliary-pass video-alpha evidence is claimed. See the video material limit in docs/limits.md.

### Page recording evidence (batch 112, section 5 addendum)

`@margoengine/video/record` uses canvas captureStream and MediaRecorder independently of rendering backends. Core/stage and GPU maths are unchanged. Its package GPU suite also runs `packages/video/test/record-check.mjs`: Edge on the real RTX A6000 records WebM and MP4 with audio from each of WebGPU and WebGL2, then uses the browser demuxer/video and audio decoders to check dimensions, colour, audible tone and ownership of caller tracks. Generated canvas colour and tone are stand-ins. Unit tests cover final-chunk ordering, repeated stop, cancellation, disposal, startup/recorder errors, empty results, ended audio and unsupported containers. Missing evidence: other players/browsers, real microphones, long captures and an A/V synchronization bound. The compressed file stays in memory; this is real-time capture with browser-selected codecs, not deterministic offline encoding. No speed claim. LIM-571, result `docs/whitepaper/results/video-record-20261108.json`.

### 360 video evidence (batch 112, section 5 addendum)

`@margoengine/video/360` adds a sphere UV remap over the existing external material feature and delegates XR spheres to XRLayers, without core/stage changes. `packages/video/test/panorama-check.mjs`, included in video's GPU suite, compiles mono and both stereo-eye shader variants on RTX A6000/Edge and checks six directions within 2 of 255; WebGL2 refuses binding with code/help link. `panorama.test.js` integrates the XR adapter with real XRLayers and a stand-in XRMediaBinding/session, verifying equirect creation, source packing, radius and disposal. No headset or real movie was run; projection on a headset, other GPUs/browsers and speed remain unmeasured. See LIM-573 and the committed panorama result.

### Exact 2D rectangle and preferred-face certificates (2026-11-08, section 5 addendum)

The current-data rectangle certificate replaces four-vertex scans on each of the same eight SAT axes with exact
support projections. The distance certificate proves the old first preferred face succeeds for every original
rounded distance in a conservative interval. It never substitutes an estimated distance into output or fallback.
The private current SAT metadata omits repeated range scans; uncertified lanes and scalar calls keep complete
guards. [Proof](physics2d-manifold-proof.md) includes the 14uM coordinate /22uM norm bounds, absolute subnormal
error, public-array mutation, signed-zero comparisons and the three monotone acceptance checks.

Evidence: 20,384,784 scene, 2,400,000 randomized and 58,560 added boundary/mutation comparisons, zero differences;
unchanged scalar/SIMD/native/Wasm pins; Edge WebGPU/WebGL2 and Firefox WebGL2 bits. In 40 timed-window frames,
102,862 certificates avoid at least 3,030,990 squared-distance candidates after accounting for all attempted
upper bounds. A/B minima 3.0449→2.9581 ms, 11/24 wins, do not establish a stable speed gain. Firefox WebGPU and
quiet-machine timing remain missing. [Entry 101](../whitepaper/perf-history.md) includes browser losses and raw data.

The block solver remains unchanged. [Solver study](physics2d-solver-study.md) records failed setup and per-point
alternatives with all old bars retained and zero accepted hash re-pins. A new 1:1000 contact diagnostic exposes
the old recovery-bias support ceiling; it is distinct from the passing 1000:1 joint chain. Owned-2D CCD is missing,
not proved by speculation. Both acceptance gaps and the separate raw-density defect are tracked in known-bugs.

### Owned-2D input and absent-candidate checks (2026-11-08, section 5 addendum)

The raw `physics2d/kernel` World, collision, smooth-collision and bounds entry points return coded
`PhysicsError` results with a help link to [Own 2D input validation](../limits.md#own-2d-input-validation).
Body, shape and whole-chain creation validate before publication; chain proxies are staged until all segments
and mass updates succeed. The checked mass path retains the existing valid arithmetic and distinguishes
genuine zero mass/area from positive mass or inertia rounded to zero. Nonfinite derived centres, moments,
extents and required reciprocals are refused. Public `mass_of` remains a direct utility, not this checked boundary.
The reciprocal-metric check also prevents a finite rounded inverse from overflowing on reinversion. Both rounded
centre and origin are staged; shape ownership uses a linear visitation witness. Overflow-only friction mixing
uses a scale-safe mean with the ordinary finite-product bits retained. Dynamic scalar/SIMD clamp bounds propagate
invalid arithmetic to the checked step error instead of a Rust assertion; used negative normal caches are refused.

Before stepping, current public body/shape/contact/joint arrays and handles are checked, including used core
data, materials, chain ghosts and cached numerical state. Broad callbacks check stale shape IDs. Collision
also checks absent face/distance candidates before indexing. This matters on both native and aborting Wasm:
the reproduced `47f81f909` panic used a NaN pose together with a NaN cutoff; the literal finite-cutoff review
call returned empty here. It is now a coded refusal rather than a sentinel index or invented manifold.

The public Rust `solver::solve` entry shares the current-data preflight and final solver-output check.
The bf40 baseline let direct callers bypass `World::step` and panic by setting a manifold count to three;
`tests/solver_input.rs` covers that boundary and related handles, ownership, numeric domains and recovery.
`World::step` calls a private already-checked solver entry, preserving its single preflight, post-solve
check and separate post-sleep check. No physical equation, result pin or hot-step scan is changed.

Regression coverage is in `kernel/tests/input.rs`, `manifold_exact.rs`, `manifold.rs`, native unit checks and the
existing Wasm `check(i)` invalid-input checks. Two creation assertions copied unchanged into an isolated
`47f81f909` tree fail as expected (`.lane/p/input-baseline.log`); the current checked versions exercise rollback
and coded errors. Retained-reference tests and the three valid production hashes remain the compatibility
contract; the reference, scene, tolerance and hashes are not re-pinned. Final package/repository gate execution
is recorded separately at landing, not asserted by this addendum.

The final independent input audit also found squared-length rotation overflow/underflow, hidden nonfinite
integration and contact-metric sums overflowing despite finite individual inverse masses. Scale-safe exceptional
rotation normalization preserves the ordinary operation order, while zero stored rotations and unrepresentable
derived contact metrics are refused. `rotation_input.rs` and `contact_metric_input.rs` reproduce these failures
on the retained pre-edge input implementation; the same classes run in Wasm's existing checks. The rotation
regression uses one substep so zero/identity alternation cannot hide the failure.
`point_velocity_input.rs` additionally exercises overflow of `v + w cross r` with finite body velocities,
mass and contact metrics. The row builder checks relative point velocity, approach and base before publication,
so a NaN comparison cannot silently select a zero normal impulse. This class also runs in Wasm input checks.

The input correctness change does not alter solver formulation or prove a speed gain. The following separate
support correction establishes the required 1:1000 centered contact bar. Owned-2D CCD belongs to T-11 / 127.y; the existing 1000:1
joint-chain and separate 3D CCD tests do not establish it. An arithmetic error after simulation starts is
reported without claiming rollback of the complete step. The TypeScript Rapier facade is unchanged.

### Video frame decoding evidence (batch 112, section 5 addendum)

The optional `video/codecs` path owns MP4 demuxing and WebCodecs decode/flush lifecycle outside core/stage. Its unit tests cover decode versus presentation order, signed offsets, chunk runs, 64-bit offsets, edit timeline boundary regression, bounds, cancellation, exclusivity and caller-owned frames. The video GPU suite now includes `codecs-check.mjs`: real Edge/RTX A6000 decoding of a generated MP4, random frame access with exact timestamps, seek/step, cancellation and consumption on WebGPU/beside WebGL2. GOP decoding is renderer independent; external material binding still refuses WebGL2. Evidence is a stand-in; real B-frame files, third-party movies, other hardware/browsers and speed unmeasured. Supported container scope and memory limits are in LIM-575 and limits.md. No new open engine defect; known-bugs.md unchanged.

### Video alpha evidence (batch 112, section 5 addendum)

The optional `video/alpha` entry extends only the external material sample hook, before the colour-pass alpha test and lighting. No core/stage edit, extra texture upload or auxiliary-pass claim. `alpha-check.mjs` in video's GPU suite compiles both packing variants and keying, checks alpha 0/64/128/255 against source-over in the existing direct canvas output space, a fractional key edge, a cutout, and WebGL2 coded refusal. Generated sources are stand-ins on real RTX A6000/Edge. Unit regressions guard sparse colour tuples, float32-collapsed key intervals and packed dimensions, with unchanged numeric tolerances. Harness corrections read the final canvas in its render task (before presentation clears it), and use the direct material's documented encoding before blend. No real keyed movie, other GPU/browser, quality comparison or speed evidence. See LIM-578. No new open engine defect from this batch; other lanes' known-bugs entries remain intact.

### Mixer sidechain acceptance (batch 111, section 5 evidence)

The optional sidechain entry owns a two-input audio-thread detector, independent of the rendering
backend. Root mixer, core and stage remain unchanged. Generated OfflineAudioContext renders test
known attack, attenuation, recovery, key isolation and linked channels beside real WebGPU and WebGL2
contexts in Edge. Node processor stand-ins additionally prove hold across blocks, missing inputs,
zero times, shared registration, cancellation and idempotent disposal. Module loading is abortable
and CSP/unsupported failures are coded. Real speech, other browsers and timing remain unmeasured.
LIM-583 and the committed sidechain result identify the present evidence.

### Mixer snapshots (batch 111): section 5 evidence

Snapshots reuse existing bus ramps and native effect AudioParams, entirely in the optional entry.
Generated audio checks underwater filtering, fades and restoration beside both rendering backends;
Node tests check JSON silence, endpoint blending, matching layouts and atomic refusal of malformed
states, unsafe feedback and changed chains. No core/stage or GPU maths change. LIM-586.

### Mixer exact dynamics (batch 111): section 5 evidence

The optional entry owns compression and 11-sample lookahead, using a mathematical absolute-FIR
bound so changing gains cannot create an inter-sample overshoot in the specified ITU model.
[Proof](mixer-true-peak.md) states the conservative attenuation trade-off. Real Edge AudioWorklet
renders pass beside WebGPU/WebGL2; Node tests check independent convolution, static curves,
attack recurrence, linked channels, tails and adversarial ceilings across render quantum sizes.
The browser fixture now awaits rendering before leaving its using scope. No core/stage/GPU maths
change. Real recordings, other browsers, perceptual quality and timing remain unmeasured. LIM-589.
Both worklet factories also check cancellation at the post-registration allocation boundary.
Microtask-order regressions fail before the fix and confirm no node allocation after an abort.

### Mixer early reflections (batch 111): section 5 evidence

The optional entry combines first-order image-source geometry with the existing synthetic tail
and ConvolverNode; no core/stage or rendering maths change. Closed-form six-wall symmetry,
fractional tap placement, stereo paths, seed repeatability and malformed geometry have Node
coverage. A real Edge convolution matches the computed stereo IR beside WebGPU and WebGL2,
including early arrivals before the late tail. Geometry is static and first-order; no measured
room, binaural-head model, other-browser or performance evidence. LIM-591.

### Own 2D sustained support (batch 127, section 5 evidence)

The old 3 m/s penetration-bias clamp imposed a spring-force ceiling near 995 kg. The corrected monotone NCP
caps beta*s+C*lambda, preserving the original static spring root at every feasible representable load for P>0.
Scalar/f64 active-set fallbacks handle exceptional capped arithmetic; certified common lanes retain SIMD.
Per-visit shadow tests compare all live motion/cache/pushed/count results with the scalar reference.

The remaining mass-ratio settling mode is corrected on certified supported paths each substep before pose
integration, using current-J geometry and separate step-start-J physical projection. No mass freezing, cap
increase, fitted mass-ratio threshold, changed stiffness or loosened physical assertion. Immutable original
approach evidence prevents disconnected joint passes from changing domain decisions. Proposals stage all
body/contact/friction state, then commit atomically only after the domain and residual certificates hold.
Actual substep movement feeds the unchanged sleep policy.

Evidence includes the unchanged native 1:1000 regression red on 47f81f909, all 29 physical cases, cap/path numerical
units, full input/domain regressions, per-visit SIMD proof, creation/order/load/domain transitions, and the
disconnected-joint regression. The mixed hash is intentionally re-pinned 9acb68471fbe6ba0 -> 92db6847c4e919d4;
the other two pins and retained manifold reference remain. Final repository/Wasm/browser gates accompany
landing. Wasm `check(0)` also applies the identical two contact-stack bars; native scalar/SIMD and shipped
Wasm SIMD metrics agree. CCD remains separate T-11 / 127.y.

The [sourced derivation](physics2d-support-proof.md) states the method domain and work costs. The independently
verified negative bending tangent of the preserved soft law is a [constitutive limit](physics2d-support-bending.md),
not permission to relax centered axial bars or a claim of exact discrete collapse. Supported components still
allocate local buffers and compute two banded systems; no speed-success or allocation-free claim is made.

### Mixer loudness (batch 111): section 5 evidence

The optional CPU entry owns double-precision K filters, weighted 10 ms energies, 400 ms/3 s
window histories, two-stage integrated gating and copied PCM gain normalisation. No core/stage
or backend math change. Generated EBU cases 1/2 use the prescribed 20 s duration and 0.1 LU bars;
all twenty file offsets in cases 10/13 check window alignment. Node coverage includes rate
profiles, absolute/relative gates, gain covariance, 5.1 surround weight and LFE exclusion,
silence/short inputs, immutable PCM and true-peak-capped outcomes. Real Edge audio renders are
measured/normalised beside both renderers. No downloaded corpus, authentic programme, LRA,
live-meter, other-browser, certification or timing claim. LIM-596.
Mixer docs.test.js now measures every current mixer entry and compares its public bytes/budget
with the built entry and shared size baseline. It fails on stale public numbers after a size-ratchet
shrink, and runs in verify/check:merge through the package unit suite. No budget is raised.
The closing batch also fixes fail-atomic numeric scheduling in the existing mixer owner, not core:
validate audio times, durations and float32 values before state changes or cancellation, and retain
active ducks on invalid release. mixer.test.js proves target/flag/envelope and complete automation
trace preservation, plus unchanged valid/default fades. Root grows 6,670 to 6,901 B and snapshots
1,700 to 1,810 B, within their existing budgets; no budget or accuracy/time bar is raised.

### Own 2D planner storage (batch 127, section 5 evidence)

The frame planner keeps flat adjacency, traversal, path and gap scratch buffers in its owning solver Scratch.
It rebuilds current contents in the original contact/component order. Floating expressions, domain decisions,
physical bars and all three corrected-baseline hashes remain unchanged. Retained capacity depends on maximum
body/contact counts; it does not accumulate each component ordinal's or body slot's historical largest buffer.
Lifecycle tests cover growth/shrink, multiple components, joint/kind/sleep/topology changes and a fresh-workspace
full-world comparison. Fixed-V/E migrating-hub/path tests catch the rejected nested-capacity design.

The native whole-step allocator example and committed raw diagnostic record prove fewer allocation requests
on the unchanged pyramid, with identical work counts and final state. Paired/browser measurements accompany
perf history entry 106; they establish neither a stable timing gain nor Box2D parity. The existing point-normal
replacement is rejected again on the full corrected 29-case contract. Local accepted-component allocations and
two banded factorizations remain, and owned-2D CCD remains separate T-11 / 127.y.

### Own 2D exact SIMD certificates (batch 127, section 5 evidence)

The normal solver drops only finite predicates implied by its actual K-derived matrix and impulse/sum
expressions. No stored masks or layout fields are added. The [IEEE proof](physics2d-finite-certificates.md)
states the caller contract, including why unrelated helper arguments would invalidate the reduction.
Raw-row/used-soft domains, mutable RHS/answer overflow, cap membership, post-motion and exact fallback/error
behavior remain. Directed finite/nonfinite mask controls, retained-guard cases, the existing per-visit shadow,
all 29 physical bars and current native/Wasm/browser pins provide evidence. No physical assertion or pin changes.

Shipped Wasm emits 14 fewer each of abs, comparison and mask-AND operations in the identified hot function,
with unchanged solver add/subtract/multiply/divide counts. These are static branch-inclusive inventories.
Decoded source-path/panic-data relocations explain distinct artifact hashes; timing independence from layout
is not claimed. Entry 107 records paired/browser diagnostics without a demonstrated gain or Box2D parity.

### Audio occlusion evidence (batch 110, section 5)

The optional audio/occlusion entry reuses BVH CPU segment queries and owns gain/low-pass stages in the sound's existing filter chain. It registers after the sound with AudioListener, so normal frame updates supply world positions before tracing. Dynamic BVH import keeps the audio root unchanged. Real Edge OfflineAudioContext renders of generated tones beside WebGPU, native WebGL2 and the WebGL2 compatibility device prove spectral attenuation (2 kHz ratio 0.039128; 100 Hz 0.249970) and zero GPU validation errors. occlusion.test.js covers real engine transforms with stand-in renderer/audio, partial cover, visibility, endpoint/source exclusions, vertical rays, smoothing, cancellation and teardown. Stand-in content only; diffraction, deforming geometry, listening quality, other browsers and speed remain unmeasured. See LIM-602 and results/audio-occlusion-20261108.json in the whitepaper.

### VFX shadows and nodes (batch 79): section 5 evidence

Sphere impostor depth, including a centre at clip depth 1.02 whose front is still in range, is checked against the orthographic formula within 1e-4 on WebGPU (`packages/vfx/test/features-check.mjs`, `checkShadowFar`) and on the WebGL2 layer (`packages/vfx/test/shadows-nodes-webgl2.mjs`). The same pages check the light header 2, 5, 3, depths 0.45005, 0.48770 and 1.00000, and the node particle at (0.18781, 0.04877, 0.00000) with velocity (0.90369, 0.38525, 0.00000). `checkNodeNorm` requires normalize of (1e-21, 0, 0) and (1e20, 0, 0) to be (1, 0, 0) within 1e-4 on both backends; mixed-component tiny and huge vectors and a zero vector are also checked. `checkShadowRelease` requires both dispose and device restoration during the light read-back to leave no unhandled rejection, and the shadows check requires the published list to be empty after dispose. Finite doubles that are not finite f32 are rejected in `checkNodeF32` on both backends. The full WebGL2 suite also checks velocity stretch: the visibility kernel keeps the patched simulation declarations and feature bindings with its cull expression, instead of losing the stretch uniform. Lit particles check weighted OIT on WebGL2, and require ExactOIT to reject that device with `unsupported` before shader creation; native WebGPU retains the exact-pass pixel check. `packages/oit/test/oit.test.js` covers WebGL2, native compatibility and explicit insufficient fragment-storage limits. These GPU checks run on an RTX A6000. Still missing: time on any GPU, and any GPU other than the RTX A6000.


### Batch 168 lightmap: section 5 evidence

The Cornell reference keeps all 15 surfaces present throughout the black-box Cycles bake. A lifecycle
regression prevents isolated-face bakes. Independent solid-angle quadrature calibrates the light units;
Margo output does not set that scale. The direct-light test checks physical irradiance separately.
The 881-texel MAE is 0.069543, relative 0.211475; coarse per-quad radiosity, sampling and quantization
remain limitations. No core, stage or rendering implementation changes, and no convergence claim.


### Batch 168 OIT: section 5 evidence

An exact primary-ray coverage oracle now checks the external depth-peeling and own weighted pictures.
Background and single-layer error are zero. Default weighted blending has MAE 1.567519 (max 15 bytes),
versus depth peeling 0.048151. A binary palette isolates ordering from material display encoding;
the separate display-domain blending defect remains in known-bugs. No runtime/core/stage changes.
Seven alternating frame-plus-completion rounds are diagnostic only, with the readback asymmetry documented.


### Batch 168 sky: section 5 evidence

The shipped Preetham WGSL is evaluated directly before the display transform and compared with external
Mitsuba sunsky. Unit-direction, axis conversion, zenith normalization and error-metric tests accompany
297 samples over nine cases. Normalized RGB MAE 1.439228 remains an open loss. Separate physical units,
the sun disk and hemisphere integration are not covered. No rendering implementation/core/stage changes.

### Audio Doppler evidence (batch 110, section 5)

The optional audio/doppler controller registers after its positional sound and samples sound/listener world poses against context.currentTime. It owns the existing playback-rate control; no renderer or core change. Real browser generated-tone PCM frequency checks run beside native WebGPU, native WebGL2 and the compatibility device, with zero GPU validation errors. LIM-603 and whitepaper/results/audio-doppler-20261108.json record stand-in evidence. No recording, listening-quality, other-browser or performance proof. Reset explicitly for teleports; 0.95 radial Mach clamp is an approximation limit, not a supersonic claim.


### Batch 168 staging: section 5 evidence

The default contact cue now has a numerical comparison with cosine ray-traced ground occlusion.
The tracer agrees with the independent projected-solid-angle integral; blank renders fail explicit
caster/background/shadow checks. Across 15,472 exposed-ground pixels the darkness MAE is 0.048174.
The fixed-blur nearness field does not reproduce broad hemispherical occlusion; the loss remains open.
No runtime/core/stage changes and no speed or directional-light parity claim.


### Batch 168 closing path-tracer evidence

Cycles independently path-traces the same OIT emission/coverage scene. Its exact-oracle MAE is 0.094812
with identical centre RGB; Margo/Babylon MAE against it is 1.632960/0.132651. Residual path noise and
silhouette sampling limit full-frame PSNR. This is independent confirmation of the open weighted image
loss, with no runtime changes or added timing claim. Root scripts reproduce the comparison outside the repo.

### Audio event container evidence (batch 110, section 5)

Optional audio/events layers selection and variation over existing AudioVoicePool. Listener-owned teardown releases every pool; the container has no frame work or timers. LIM-605 and whitepaper/results/audio-events-20261108.json record real browser PCM generated-tone evidence beside WebGPU, native WebGL2 and compatibility WebGL2. Pitch, gain, sequence/random selection and silent cooldown gaps are measured with zero GPU errors. No renderer/core changes; recordings, listening quality, other browsers and speed remain unmeasured.

The event job also repairs AudioVoicePool input ordering: invalid per-play input is rejected before a free or stolen voice changes. Sparse position/range arrays are checked by explicit components, since Array.every skips holes. Focused before/after regressions in audio.test.js and events.test.js prove preserved sounding sources and rejected missing values.

### Own 2D frame preparation (batch 127, section 5 evidence)

Broad refits use a private derived-bounds helper only after complete current body/shape ownership and
numeric preflight in the same step. Public/creation bounds keep core-then-pose validation; transformed
or expanded bounds still refuse overflow. No validity certificate crosses a mutation or frame.
Support eligibility now uses lazy conjunctions after component invalidity, with every DFS/visited/member/
terminal operation retained. Eager-control traces and accepted Plan bits, malformed-input regressions,
all 29 physical bars and current native/Wasm/browser pins remain required.

The [proof](physics2d-frame-preparation.md) separates actual predicate-call counts, uninstrumented release
control flow and branch-inclusive compiler inventories. The matched 17-phase profile includes exact
per-step state/work fingerprints, 39-clock calibration/residuals, original harness failure and a portable
source-only reproducer. At 99.29% aggregate CPU busy its phase shares guide investigation; absolute times
are not substituted for the separate rival benchmark. Entry 112 records the combined bounded paired/browser
session; neither constituent receives an independently measured timing claim. No core/stage change or CCD.

### Creative texture targets (batch 77): section 5 evidence

The optional targets entry records color-only passes into cube faces, array layers, mips and volume slices.
It uses single-mip 2D attachment views for cube/array and a 3D view with depthSlice for volumes, per W3C WebGPU.
No core or stage changes. Unit checks reject invalid dimensions, memory, mips, layers and colors before recording.
Real WebGPU full texel readback covers 78 generated subresources across rgba8unorm/rgba16float, partial draws
with load, shrinking volume mips, explicit device loss and redraw on a replacement device. A real native WebGL2
engine gets unsupported with help link. Reproduce with packages/creative/scripts/test-targets.js under gpu-lock.
No scene capture, depth, MSAA, automatic mip generation, other-device or speed proof. Entry 4027 B gzip.

### Adaptive music evidence (batch 110, section 5)

Audio/music owns one source per stem and one mixer bus per source; mixer scheduling handles all state gain changes. Audio-clock grid and common starts/loopEnd preserve phase without frame timers. LIM-607 and whitepaper/results/audio-music-20261108.json record generated-stem sample-reference PCM beside WebGPU, native WebGL2 and compatibility WebGL2. Error below 5e-8 and zero GPU errors; Node tests cover restart, validation and listener teardown. No core/stage changes or speed claim; recordings and listening quality remain unmeasured.

### Reverb-zone evidence (batch 110, section 5)

Audio/zones routes additional wet sends to existing mixer/reflections effects and fades their inputs, so previous convolution tails remain intact while dry paths stay independent. Listener frame updates select copied AABBs; convolution topology is prepared once. LIM-608 and whitepaper/results/audio-zones-20261108.json record generated-impulse PCM against existing response sums beside WebGPU, native WebGL2 and compatibility WebGL2, within 1e-6 and zero GPU errors. No core/stage changes or speed claim. Real room recordings, listening quality and other browsers remain unmeasured.

### Ambisonic-bed evidence (batch 110, section 5)

Audio/ambisonics keeps four components discrete through a splitter and eight gain paths into two virtual cardioids, rotating decoder directions by listener pose and inverse field quaternion. No renderer/core/stage changes, worklet or convolution. LIM-610 and whitepaper/results/audio-ambisonics-20261108.json record real browser sample-reference PCM beside WebGPU, native WebGL2 and compatibility WebGL2, including generated looping components plus decoding/resampling of a licensed external rain stimulus. CPU tests additionally cover full orientation bases and lifecycle. Real headset tracking, HRTF localization, subjective quality and speed remain unmeasured.

### WFC unary output constraints (batch 69)

Overlapping pins/ground remove incompatible pattern domains at every covering origin before search. Initial bans are below all decision trail marks; retries rebuild them. Section 5 evidence: generated binary/maze Node tests and the wfc browser check on real WebGPU and WebGL2 contexts. No GPU maths, shaders or device capability requirement; no authored-level, cross-vendor or timing evidence yet.

### Scatter interaction input proof (batch 77 audit, section 5)

Interaction uploads now reject nonrepresentable GPU floats and sparse positions before modifying retained state.
Cell displacement is clamped at the field side before Int32 conversion: larger moves have no overlap and must clear
old pushes. All three interact-inputs.test.js regressions fail on the parent and pass with the fix. The existing
real-GPU interaction suite additionally asserts every field cell is zero after a 2^32-cell teleport. Its existing
stamp/recovery/pixel checks remain unchanged. The test is already part of the scatter GPU plan; the new unit file is
picked up by verify and check:merge. A scaled norm fixes squared-length overflow; two finite extreme GPU cases
(offset 1e30/radius 2e30 and nearby offset/radius 2e38) match the CPU reference for every cell within the existing 1e-5
bound. The usual 143 pressed cells match within 1.63e-7 on RTX A6000. Native WebGL2 is exercised and refused with a
coded unsupported error and help link. A CPU resource stand-in checks restoration and terminal disposal. Core/stage
are unchanged; no speed claim.

### Wasm policy diagnostics (2026-11-09)

The shared loader translates policy-blocked compilation through the shared error helper. Core transform compilation and instantiation, physics solver and Rust kernel loads, decoder initialization and encoder initialization preserve MargoError code `failed` and the CSP help link; decoder worker responses now carry their code back through the pool. The per-path `tests/csp.test.js` suites, `tests/deep-core-csp.test.js` and `tests/wasm-csp.test.js` run in verify and therefore check:merge. Evidence is simulated blocked compilation; browser-specific policy enforcement remains unproven by these tests. [CSP deployment requirements](../csp.md) include core transform-kernel compilation and worker response headers. No Rust ABI, GPU math or rendering behavior changes.

The approved core correction changes only `packages/core/src/kernel.ts`: core owns the transform-kernel compilation and instantiation, so an optional package cannot report its startup failure. Approval: Scott, "Yes approved", 2026-11-10. Core plus stage measures 23,797 B gzip with `npm run measure:size`, below 25,000 B.

Lighting2d height precision repair (2026-11-08): owned rgba16float accumulation precedes one target presentation. `frame-regressions.js` proves 100 individually sub-byte directional lights, in addition to format, resize, frame order and restoration checks. The historical height-repair checkpoint passed 148 pixel checks on RTX A6000 with no errors; the final suite evidence is below. Half-float blending retains its finite rounding precision; this is not a float32 accumulation claim.

Lighting2d spatial GI repair (2026-11-08): GPU compute builds each upper spatial/angular grid, retaining radiance and
transmittance. Per-child connectors implement Osborne/Sannikov appendix A before interpolation. Separate two-sided
surface fields ping-pong for each requested bounce, with current-frame resets. Explicit vec4-aligned light records
carry point/spot/directional and mask/layer/shadow data. New Node/GPU suites assert exact opaque darkness/energy,
all eight levels, distinct bounce orders, analytic circle angular measure (11 distances, <5% relative error),
and format/resize/removal/restore/dispose/reattach lifecycle. These suites extend lighting2d test:gpu, already a
check:merge GPU gate; there is no new bypass. Original GI fails 21 Node assertions and the GPU value checks.
Missing evidence: other GPUs, general scene convergence and performance. Surface patches/32-direction quadrature
are finite approximations, detailed in limits.md. The exact measured byte ceilings were approved by Scott on 2026-11-09 ("Approve new size"), with no headroom.

The GI angular merge additionally uses integer multiplication for direction counts, bilinear difference interpolation
and incremental angular means. This preserves a uniform unit field exactly for branching 2/3/5/7/8. Browser regressions
read every intermediate float32 cascade sample and assert the configured allocation sizes, not just the final pixels.
The first weighted-sum formulation failed these assertions (and the Node unit-field test at branching 7); no tolerance
was changed. The exported CPU class documentation omission caught by verify was corrected in source and its API quality
gate was checked again. Initial verification found the prior size ceilings and missing GI TSDoc; both were resolved,
with Scott approving the six exact measured ceilings on 2026-11-09. The first landing verify then found only the stale
generated `site/llms-full.txt` through the existing `tests/llms.test.js`. Canonical guide regeneration fixed the cause,
and the unchanged LLM, claims and umbrella regressions passed.

Full verification evidence (2026-11-09, main base `7bc32a1cb`): lint, hygiene and full verify passed. Full verify completed in 915.019 s under
its 2,400 s hard limit, including a 324.1 s global Node test chain. On that base the lighting2d package passed 99 Node tests,
236 RTX A6000/Edge GPU checks with zero wrong values or validation errors across 11 WGSL modules, and all 8 runnable
README examples. API reports were regenerated and checked. Cross-vendor rounding, general-scene convergence and speed
remain outside this evidence.

The subsequent rebase onto `571fb8d30` kept lighting2d source and tests identical; core/shared gained the CSP diagnostic
correction described above. Fresh integration checks passed the build, lint, hygiene, 165 Node tests with no skips
(including all 99 lighting2d tests, CSP and incoming regressions), and all 236 lighting2d GPU checks with zero wrong values
or validation errors across 11 WGSL modules. Full API update/check reports 99 packages, 856 entries and 8,525 exports;
all five quality gates pass, including 938 size items. All 8 README examples and generated LLM/claims/umbrella regressions pass;
the link check reports 208 documents with zero broken links. The full verify measurement above applies to the earlier `7bc32a1cb` base.

Batch 160 job 2 extends the outside picture evidence to all 27 ClearCoatTest primitives, including
factor/roughness textures and independent normal maps. All-pixel RGB error budgets are frozen on
WebGPU and actual compatibility WebGL2; native WebGL2 rejection is asserted. No core or GPU math
was changed. The full cause of the image loss remains unisolated in known-bugs. The 14 original
verify skips were missing assets, not hardware: docs/work-lists/batch-160-skips.md lists each;
external fixtures now run all 63 tests in the four affected files, with zero skips.

Job 2 verification also repairs the WFC browser harness's unbounded shutdown: closeAll now
covers startup and normal/failing assertions, with the existing repository-wide teardown
regression. The 14 missing-data skip conditions were all removed for the full verify run:
13,064 executed, zero skipped. A first-run stale-generated-doc failure is resolved by rebuilding
llms outputs from the authored source documentation.

### WFC global constraint evidence (batch 69)

The optional CPU constraints solver combines arc consistency, group lower/upper counts and possible-cell breadth-first reachability. Undo restores every ban from all propagators; a connected group is nonempty. Section 5 evidence: all 112 combinations of binary 3x2 count bounds, connectivity and corner paths agree with exhaustive 64-assignment truth; generated 3D and tile ID 256 cases, backtracking and browser WebGPU/WebGL2 parity also run. Logical authored traversability only, no physical-clearance or performance proof. Root WFC also rejects finite weights whose entropy arithmetic overflows, with a constructor regression.

Batch 160 job 3 extends outside evidence to all 20 SheenTestGrid primitives, at 512 x 512
with no IBL and a matched camera/sun. Both WebGPU and actual compatibility WebGL2 have frozen
all-pixel budgets; native WebGL2 rejects PBR. The sheen BRDF is shared by materials and
gltf-pro, but this picture measures default glTF import only. The unresolved image loss,
simplified visibility and albedo/roughness choices are recorded separately in known-bugs.
No core or shader math was changed and batch 168 measurements were not repeated.

### Scatter tile validation evidence (batch 77, section 5)

Tile rectangles are preflighted before replacing held pages; byte views need no word alignment. Node regressions
cover hostile conversion, collapsed bounds and atomic record/page storage. The generated grass clumps and records
in scatter/test/grass-tiles.browser.mjs are stand-ins on real RTX A6000 WebGPU: exactly one clump in each selected
near/middle/far ring, two after adding a tile, one after removal and restoration, zero after removing both. Ten
distinct shader modules compile without errors. Native WebGL2 refusal is exercised with a help link. Existing LOD
pixel/complementary fade tests remain the image proof; this new test asserts draw values, not artistic appearance.
No new core/stage API, shader algorithm or speed claim. Node tests enter check:merge via the package test glob.

Batch 77 review repairs: CPU ring needs now share the inclusive outer-limit rule with generated WGSL, retain the
uploaded f32 origin/side and convert the eye identically. A conservative distance bound covers placement and
distance rounding and squared-component flushing under the [WGSL accuracy rules](https://www.w3.org/TR/WGSL/#floating-point-accuracy).
`scatter/test/tiles-budget.test.js` enters verify and check:merge; the existing grass-tiles GPU step now covers
64 records at the exact far boundary, origin 16777217, the f32 control, camera conversion, rounded upper endpoints
and rounded distance, hard ring switches, fades, outside rejection and an explicit 32-instance cap. All five
allocation regressions fail on the parent. The recorded [before/after GPU counts](../whitepaper/results/scatter-tile-budget-20261109.json)
use generated records on RTX A6000 only. Ordinary Scatter and compatibility rings already reserve every candidate;
ordered compaction, shared rings, imposter and shadow capacities were also audited. No other allocation mismatch
was found. Optional tiles now measures 8,234 B minified / 3,401 B gzip within the unchanged 3,415 B budget.
Large-world throughput, other devices and artistic quality remain unmeasured.

### WFC rotation evidence (batch 69, section 5)

Optional CPU socket construction checks all 24 proper signed-axis transforms, independent face-normal mapping and a 48-ID 3D solve. Browser tests run the same seeded socket rules beside real WebGPU and WebGL2 contexts. No rendering/backend code changes. Labels are logical connectors, with no texture-orientation or imported-geometry proof.

### Audio camera orientation regression (section 5, 2026-11-09)

The listener copies camera.up as well as position/forward, so panner orientation follows camera roll and Top/Bottom views. Ambisonic beds retain their last independent orientation during a collinear manual pose, using -Z forward and +Y up initially. `packages/audio/tests/ambisonics.test.js` checks both exact poles, roll, finite initial/frozen decoder gains and continued updates of later sources. Browser offline PCM matrix proofs remain separate from live device evidence.

### Browser gate shutdown ownership (section 5, 2026-11-09)

Chromium checks use a loopback Playwright launchServer and a connected client. The owning server.kill API releases process and driver resources together; an external taskkill could end Chromium in 8 seconds while the launch client close promise stayed pending past the unchanged 30-second deadline. The WFC diagnostic now completes client disconnect and owned server termination. tests/browser-selection.test.js checks explicit ownership, loopback binding and bounded connection setup; existing browser-teardown/catalog tests retain process-death and teardown assertions. WFC resolves its server root from import.meta.url, disables unrelated optimizer discovery and watchers, unconfigures its test surface before destroying its device, and closes its browser/server together. The package GPU check exercises both backend routes from npm workspace execution.

### Batch 160 GPU teardown regression (section 5, 2026-11-09)

The material-suite shutdown uses the owned Chromium server repair in c1646e3ec. Native process termination alone did not settle the Playwright launch-client cleanup promise; it was driver ownership, rather than an outstanding BRDF readback or shader report. tests/browser-teardown.test.js now holds client cleanup pending until its owner kills the server, so the former external-termination path fails within a shortened test budget. The production shutdown limit remains 30,000 ms. The material GPU suite uses runSuite so teardown cannot replace a failed check; tests/gltf-pro-materials-lifecycle.test.js injects both failures and requires the original error plus a teardown diagnostic.

### Batch 99 emissive resampling: section 5 evidence

The optional `voxel-pathtracer/restir` subclass replaces only the emissive direct-light integral. Light proposals and cosine/phase directional proposals use balance weights in the same solid-angle measure. Visibility is in the reservoir target; continued non-delta paths do not count the same emitter integral again. Directional searches pass media, whose transmittance is then evaluated by the existing shadow walk. The endpoint is offset outside the source voxel to prevent self-occlusion. The root tracer now also retains the last scattering position for emissive and area-light MIS: transparent medium boundaries must not shorten the distance used to convert area PDFs to solid angle. Independent quadrature of a square light through an absorbing half-block slab guards this correction. Core and stage are unchanged.

`tests/restir.test.js` covers bounds, inherited identity, one-candidate source identity, disposal, replacement-device compilation and retention of helpers in the compatibility fragment route. `tests/restir-browser.mjs` retains the 2x squared-error bar against the fixed 8,192-sample reference, checks native WebGL2's coded refusal/help, and runs real device restoration. Native WebGPU and WebGL2 compatibility on RTX A6000 reduce the fixed ceiling scene's squared error from 2.884096 to 0.919089 at 32 samples, with zero shader compilation errors. This is independent RIS with full visibility per candidate, no spatial/temporal reuse and no measured wall-time benefit. Generated scenes are stand-ins, not outside reference images.

### Umbrella size drift check: section 5 evidence

The umbrella README now records the current core plus stage figure, 23,797 B gzip. `tests/umbrella-readme-size.test.js` compares its duplicate figure with the root README, so a future measurement update cannot leave the umbrella text stale. The existing `measure:size` gate supplies the actual measurement; this regression runs with the root tests in verify and check:merge. No runtime or size budget changes.

### Painterly post effects (batch 77): section 5 evidence

creative/paint is an optional LDR PostStack stage; no core/stage change. Single-pass WGSL implements classic
four-quadrant minimum RGB variance, a stylized quantized watercolour wash and a Sobel/hatching sketch. Neighbour
reads clamp to each viewport. Per-view uniforms prevent queue writes from overwriting earlier encoded views;
ViewStates prunes inactive resources. Pipeline keys include format and sample count; input changes rebuild bindings.
Real RTX A6000 WebGPU readbacks compare generated stand-in images to an independent double-precision CPU reference
using squared deviations, including radius endpoints, one-pixel images, hard edges, uneven split views, exact centre
alpha and bypass, BGRA and 4x MSAA. Real Engine/PostStack readbacks cover resize and replacement devices. Native
WebGL2 rejects with a code/help link. Shader compilation and uncaptured validation errors are checked. Node tests
cover hostile live edits before GPU writes, lifecycle, pruning and terminal restoration. No artistic quality,
temporal stability, speed, mobile or other-browser evidence. Entry 3073 B gzip, size class S.
### Asynchronous owned Chromium termination (section 5, 2026-11-09)

A later catalog after-hook hit the unchanged 30,000 ms shutdown bound with the owned launch server. Public Node child-process instrumentation then showed that BrowserServer.kill synchronously invokes Windows taskkill. That blocks the same event loop responsible for the deadline. The shared launcher now asynchronously ends the owned ChildProcess tree, observes its exit, then calls the driver kill API for server/profile cleanup while the client disconnects concurrently. No browser or process-handle wait is omitted. tests/browser-teardown.test.js adds failing-before controls for ordering and a never-settling termination while the deadline remains runnable. The trace of the original uninstrumented catalog timeout cannot identify which substep was pending; later zero-context traces showed prompt client disconnect and variable native exit. The demonstrated repair removes synchronous termination from the bounded path; it does not claim that every OS process exit can finish within 30 seconds.

### Audio review timing and lifecycle evidence (section 5, 2026-11-09)

Live Doppler uses monotonic frame time, resets on context state changes and treats gaps over 0.25 s or speeds over 0.95c as cuts. Offline derivative proofs retain the exact audio clock. Authored rate interception composes pool/event rates, including writes equal to the previous effective rate; controlled pools preflight invalid rates before stealing. Sound kind changes detach locally. Audio.isDisposed makes lifecycle explicit; occlusion detaches before BVH work and defers when its engine is absent/disposed. Node regressions are part of verify, and the existing package test:browser discovery puts live timing and long fractional-loop marker checks in check:merge. Retained audio-review-20261109.json separates live controlled clocks from offline PCM and unmeasured device output. The suspected music drift is not reproduced: every loop marker stays within 0.424 sample frames, including one virtual hour. No tempo or loop-period code was changed.

### Heartbeat gate startup evidence (section 5, 2026-11-09)

The slow-start heartbeat test now observes a marker from its injected worker preload, then a subsequent heartbeat. A file metadata change alone was not a startup acknowledgement: the failing 5.5-second run could not include both the Windows two-process injected startup and the unchanged four-second lease observation. A deterministic regression changes metadata before readiness and requires the helper to keep waiting. The production lock, two-second test lease, four-second observation and thirty-second readiness bound are unchanged. This strengthens the existing check:merge/verify gate rather than granting a timing waiver.

### Quiet crowd resume gate (section 5, 2026-11-09)

The 100-client zero-resend fixture now sends stationary controls and asserts the spawn column before cutting. VoxelBot.update always steers forward; using it made the supposedly quiet fixture stream new views, and a cut correctly resent 21 in-flight chunks. The new position guard fails with that original input driver. Client count, update cadence, 10-second resume bound and all zero-resend/identity assertions remain unchanged. Moving/in-flight recovery remains covered by the existing resume tests. No network implementation or throughput scene changed.

The voxel-net quickstart previously put Node server imports and browser Engine code in one executable block, so the runtime README gate externalized node:http. It now runs a complete Node server/client example on a free loopback port, with explicit shutdown; the obsolete known-failure entry is removed. All 19 audio/voxel-net examples execute successfully.

### SQL-store test ownership (section 5, 2026-11-09)

The voxel-net SQL restart fixture owns resources through a single reverse-order cleanup hook. A focused parent reproduction identified Windows EBUSY at directory removal: Node after hooks ran in registration order and the failing first hook prevented the server/database cleanup. The repaired integration test and five bounded subprocess failure-injection regressions cover cleanup during setup as well as normal restart, require process exit without forced termination, and are part of verify/check:merge. This changes test ownership only, with no SQL, transport or runtime API change.

### Batch 99 caustic guiding: section 5 evidence

The optional `voxel-pathtracer/guiding` subclass changes pure diffuse continuation sampling only. A uniform choice from the existing glass/mirror deflector table selects a box; visible faces are area-sampled and converted to solid angle. A cosine/box mixture divides the BSDF contribution by its complete density. All overlapping boxes contribute to both continuation and next-event MIS PDFs. Actual voxel traversal, dielectric events, light visibility, bounce limits and scene uploads remain in use. Inside a bound, enclosing faces are sampled; below-surface proposals contribute zero. No CPU-heavy loop, new buffer, core or stage change is involved.

Unit checks cover strength bounds, zero-strength kernel identity, compatibility helper retention, disposal and replacement-device compilation. `packages/voxel-pathtracer/tests/guiding-browser.mjs` checks a fixed 2x caustic squared-error bar, independent baseline energy, overlapping bounds, an analytic unit furnace including an origin exactly on a sparse bound, coloured absorption, mirrors, empty/huge bounds, native WebGL2 coded help, compatibility execution and real device restoration. Initial enclosing-cone and box proposals preserved energy but missed the unchanged 2x bar: ordinary throughput roulette terminated most successful guided rays at the glass exit. The entry now removes accumulated cosine/mixture factors from its survival heuristic, with the actual survival probability still dividing throughput. Faces containing the origin are excluded because they project to singular directional mass. These are generated stand-in scenes; no general variance, speed or outside-scene quality claim is made.

Native and compatibility evidence is committed in `docs/whitepaper/results/batch-99-guiding-20261109.json`: squared RGB error 9.984675 versus 350.318022 at 64 samples, zero shader errors, exact zero-strength/empty-table identity, and unit-furnace means within the unchanged 0.02 bound. Native device restoration and disposal pass.

### WFC large-world evidence (batch 69, section 5)

Optional CPU heap solver uses bit domains and an indexed heap; generated 192x192 open-grid checks show exactly two entropy updates per cell rather than scanning every cell per choice. Chunk halos pin retained neighbours on all axes, with atomic commits and copied outputs. Exhaustive symmetric binary relations, multiword IDs through 4095 and seeded Rust SIMD/TypeScript parity are tested. Reciprocal validation now does constant membership work per adjacency edge; a bounded-read regression guards the old cubic scan. Library asset URLs are relative for both build paths. Real browser WebGPU/WebGL2 tests load the actual SIMD artifact. Paired/interleaved loaded-machine measurements select the backend; quiet release numbers and real authored-world evidence remain absent.

### WFC worker responsiveness evidence

Optional wfc/worker runs the same local heap solver in a one-shot dedicated worker. TypeScript and the single Rust SIMD artifact emit bounded actual work counters without consuming randomness. shared/worker.js serves/transfers results and revives errors. Abort/dispose/watchdog end the worker and close listeners/progress. Package lifecycle tests cover clone/startup, crashes, malformed messages, timeout and seed/rule parity; real browser records show rendered frames during positive in-flight work on both WebGPU and WebGL2, then abort active TS and SIMD solves. Evidence: docs/whitepaper/results/batch-69-worker.json. No measured frame-time or general responsiveness budget; main-thread cloning still costs time. Core/stage and rendering backends are unchanged.

### README required assets (section 5, 2026-11-09)

Run `node scripts/fetch-readme-assets.mjs` before `npm run check:readme-run`. External standard files live in
`engine-bench/readme-samples` beside the worktrees, overridden by `MARGO_README_SAMPLES`; source, licence and SHA-256
are retained through the loader corpus and the fetcher. Explicit tracked aliases reject absent files and LFS pointers.
OBJ/MTL/PNG, TMX/TSX and LAZ/WDP companions keep their relative paths, and the sample server implements HTTP byte
ranges, including suffix/open ranges, HEAD and 416. `tests/readme-assets.test.js` checks those contracts; verify
also runs the existing README harness regressions. Scoped executions preserve their own report.json.

The loader/decoder/FBX/environment/points run passed 73/88 examples, 15 existing failures, zero fresh failures.
Thirty proved entries were removed from the runtime known list. This does not prove fictional asset identities or
close the remaining input, clip, cubic-curve, NURBS-only or MTL-as-OBJ errors. Physics remains held.

### Optional-peer declaration packaging: section 5 evidence

Typed declaration parameter patterns are emitted as named parameters in files
with optional-peer guards. Their annotations and optionality are unchanged, so
installed peers retain full checking and absent peers cannot make binding names
fail strict library checking. The declaration fixture runs the real strict
compiler without and with a peer, rejects wrong installed option types and checks
idempotency/name collisions. The packed bundler proof retains skipLibCheck false.
This changes declaration text only, without physics or renderer implementation.


### React camera-control tree shaking: section 5 evidence

All four camera-control forwardRef factories carry pure annotations. The Vite
module-graph regression proves orbit-only and arcball-only apps emit only their
requested lazy peer, while existing event/ref and real-browser checks exercise
both controls. The full packed-consumer matrix keeps its 100,000 B initial and
115,000 B emitted budgets and its original cube scene. This removes unused code
without reducing scene work or changing rendering output.

### Custom WGSL transitions: section 5 evidence (batch 76, job 1)

The optional transitions/custom factory compiles a function interface before attaching, with a fixed layout preventing extra caller bindings. Root transitions supplies a protected source hook; core and stage are unchanged. CPU lifecycle tests cover rejected source, cancellation, disposal and replacement during compilation. Real GPU value assertions cover 402 generated solid-color pixels, 1x/4x MSAA, exact endpoints, a nonlinear progress curve, resize and a replacement-device redraw. Native WebGL2 is refused with linked unsupported. Device restoration previously retained active progress after destroying its outgoing image, blending cleared history; it now cancels that missing history. The regression is in transitions/test/custom.test.js. This is single-device stand-in correctness evidence, not speed, artistic quality or cross-device proof.

### Missing standard format evidence (section 5, 2026-11-09)

The real-file runner now proves an outside MPD with all library/sticker dependencies, zipped AMF, PTS intensity/RGB,
and chemistry XYZ. PTS/XYZ compare all values with source text; the AMF reference applies independent elementary
point rotations/translations, including constellations, then compares every vertex/index. The Slic3r file caught the
old oracle's unplaced-bounds error; amf-reference.test.js covers it without changing the 1e-6 bar. The MPD has
13 embedded submodels, 526,895 triangles and zero missing parts/warnings. These are parse/geometry results,
not outside image or speed comparisons. A plain AMF control also passes.

The pinned optional Windows FFmpeg installer preserves the GPL archive outside the repository. MARGO_README_FFMPEG
enters only the relevant README child PATH; tests/readme-assets.test.js verifies the parent environment is unchanged.

### Single WebGL2 package: section 5 evidence

The preview's renderer, picking, restoration and automatic escalation live in
webgl2-compat feature entries. The former workspace and umbrella paths are gone.
Core implementation, hardware tiers and the strict 25,000 B combined core/stage
gate are unchanged. Real-browser preview tests retain picking, loss/recovery,
retained geometry, canvas replacement and native-WebGPU download isolation bars.
The full compat GPU suite remains the proof for the translated device. Source
and built-root isolation now inspect AST import edges; a regression distinguishes
actual imports/exports from comments and loader advice. The duplicate-gate TEMP
fixture detects cross-package exports when package names share a prefix.

### Batch 99 sky: section 5 evidence

The optional voxel-pathtracer sky entry reuses sky's atmosphere tables and integration through the public
`bakeHillaireEnvironment` in the existing Hillaire feature entry. It creates no root/core/stage capability. Compute
produces owned RGBA floats, plus the separate sun's transmittance; every temporary buffer and texture is released
before success, abort or failure settles. The tracer's existing map sampling and device restoration consume those
floats unchanged. Native WebGPU and WebGL2 compatibility pass value assertions, including added multiple-scattering
energy, ozone's twilight shift, stable night, moon phase, vacuum black, analytic Lambert ground and constant-radiance
tracing; native restoration reproduces the converged image exactly. Unit failure injection covers compilation,
mapping and cancellation. Evidence: `docs/whitepaper/results/batch-99-sky-20261109.json`. Proof uses generated
maps and scenes, not an outside radiometric oracle. Isotropic higher orders, finite angular maps and stylized night
remain accepted approximations; MagicaVoxel parity and moving-camera denoising remain separate unfinished jobs.

### WFC review regressions: section 5 evidence

Batch 69 review fixes enforce the overlapping 4096-pattern cap during extraction and dense validation across
legacy, heap, constrained, overlapping, socket and chunk inputs. A 128 MiB heap subprocess reproduced native OOM
on the parent; it now exits normally with RangeError. Input tests exercise every missing coordinate/dimension and
adjacency direction, tile groups and sparse collections. Socket tests reject rotation-weight division that rounds
to zero while retaining representable subnormals. Loading tests cover network/body/local-file/instantiation failures,
exact abort reasons and unsupported SIMD; actual shipped worker tests preserve coded missing-asset failures.
All regressions are in verify's package-test glob and therefore check:merge. No new gate or reduced budget.
Core/stage, Rust SIMD artifact, solver algorithms and benchmark workloads are unchanged.

### Scatter LOD representation audit: section 5 evidence

The batch 69 cross-package audit checked ordered ring compaction, inclusive far rejection, page/ring capacity and
CPU versus GPU float arithmetic. Existing tile-distance bounds already cover uploaded origins, sides, camera and
rounding/flush allowances. Another cause remained in Scatter's input validator: distinct positive float64 LOD
boundaries could upload as zero or equal f32 values. The constructor now validates the uploaded representation,
including sparse lists, before any GPU setup. packages/scatter/test/tiles-budget.test.js regresses zero/subnormal
and collapsed near/middle/far boundaries and accepts the smallest normal f32 boundary. Existing exact-endpoint,
conservative-distance and explicit-cap tests remain in verify/check:merge and grass-tiles.browser.mjs.

### Required outside assets in every worktree (section 5, 2026-11-09)

Four batch-160 test files previously selected data only through a shell-local environment
variable. That explained the differing 14-skip and zero-skip reports on identical main code;
result-cache shadow mode never served tests. Verify now preflights all 348 pinned outside
assets before build, and direct tests validate their complete input family. Missing, partial,
LFS-only and changed caches fail with the file path and fetch command. The syntax gate
no longer exempts those four files. Regression evidence includes empty-cache verify in a
subprocess, digest corruption, a missing companion and override/default path resolution.
Existing glTF importer mechanics tests remain unchanged apart from input enforcement;
physics and physics2d packages remain held. No hardware or performance claim is added.

### Texture mask transitions: section 5 evidence (batch 76, job 2)

The optional mask entry appends one owned RGBA8 texture binding through the transitions capture's protected binding seam. Capture and composite orders remain -80/50. ImageData is snapshotted; bitmap uploads retain a borrowed open image for restoration. Texture upload includes WebGPU's required render-attachment usage. 1344 generated-mask pixel assertions cover both upload paths, hard/soft thresholds, black/mid-grey/white, exact endpoints, odd-size resize, replacement-device reupload and native WebGL2 refusal at 1x/4x. An interpolated-UV nearest tie initially selected the wrong row after a 7x3 resize; integer centre addressing fixes the cause, with no tolerance change. Unit checks cover overflow rejection, closed images, upload rollback and disposal. Evidence is single-device correctness, not measured speed or branded-image aesthetics.

### Transitions scene disposal: section 5 evidence (batch 76 continuation)

Owner lookup through the existing extension sceneOf API removes the owning registration before releasing GPU resources. Unit regression preserves a default-scene effect while disposing a second scene; real WebGPU proof renders both afterward. The shared GPU test engine now models sceneOf identity lookup, so default-scene lifecycle tests exercise this contract too. No core or stage change.

### Ground backdrop composition: section 5 evidence (batch 56, job 1)

No renderer or optional entry is rebuilt: environment/ground already supplies the projected HDR floor,
and staging already supplies the contact catcher. Their composition needs background order 0.25 before
contact order 0.5. staging/test/ground-browser.mjs uses the licensed OpenEXR BrightRings image and a
generated box: on/off contact pixels, unchanged product/outside pixels, caster removal, disposal and
actual device replacement pass on WebGPU and the WebGL2 compatibility layer. Native WebGL2 remains
unsupported. The photo's lighting is not reconstructed by the contact cue; the existing physical-picture
loss remains open. No new core, stage, CPU geometry loop or shader is introduced.

### Live transitions: section 5 evidence (batch 76 job 3)

The optional entry uses existing core scenes and render views: two full-frame RGBA8 texture targets followed by a private composite scene's order-50 pass. No recursive render, core or stage modification. Scenes update once each, shared cameras once, with independent depths. Progress survives resize and replacement because no historical image is required. Owned images and the composite scene are removed on disposal; borrowed scenes/cameras survive. Actual WebGPU tests check 374 generated-background pixels at 1x/4x, both scenes changing at fixed progress, resize, destroyed-device recovery, canvas output and subsequent borrowed-scene rendering. Native WebGL2 refuses with a help link. Unit checks cover hostile values, foreign/same/disposed scenes, partial allocation cleanup and disposal. No performance, HDR or artistic-quality evidence is claimed.

### Real B-frame edited timestamps (section 5, 2026-11-09)

The video/codecs reader keeps exact rational native ticks through edit filtering and
movie-time conversion, then rounds once to microseconds. An outside MDN CC0 AVC clip
exposed the prior double rounding (one microsecond early). CPU regressions cover both
sub-microsecond edit boundaries, seek selection and unsafe raw timestamp collisions.
All 150 real frames match an independent FFprobe sample demux plus WebCodecs reference,
byte for byte, with every edited timestamp exact. This shares the browser decoder; it
is not independent H.264 decoder accuracy or other-device proof. The new required clip
uses the existing digest/fetch/preflight mechanism, now 349 outside inputs. The optional
entry is 3,458 B gzip within its unchanged 3,593 B gate; core/stage are unchanged.

Batch 160 section 5 job 6 extends external picture evidence to anisotropic GGX and thin film, on all 50/346 original primitives respectively. Exact separate WebGPU and WebGL2 compatibility budgets include silhouettes and all RGB channels. Native WebGL2 refuses PBR. GLB packing only relocates bytes, with hash-checked originals and invariant tests; this is not a geometry-build performance change. Full image residual causes stay open. No core/stage or shader code changed.

### Batch 99 RGB media and physical medium boundaries

The optional voxel tracer media entry converts palette extinction into the existing scalar density
plus three normalized coefficients in media's unused metal-reflectance row. Scene and model palettes
are copied and validated before replacement. Root/stage dependencies and GPU resource layouts are unchanged.
The existing hierarchy integrates RGB shadow depth. Chromatic free-flight sampling uses a three-channel
mixture with explicit collision/survival PDFs and cancels a common exponential before division. Pure
absorption and chromatic emission are analytic. Scalar media keep their established sampler.

The root tracer formerly moved its physical origin by 0.002 local units at media boundaries, losing
absorption and emitted path length. It now advances only the intersection query by a representable
forward amount and restores that distance before transport. Both path and refracted shadow walks carry
the boundary flag. A generated three-cell vacuum-emission regression requires radiance 3 within 1e-5.

Section 5 evidence: native WebGPU and compatibility value tests, zero-extinction channels, extreme RGB
coefficients, model palettes, conservative scattering, chromatic shadows, emission, real native device
replacement and raster restoration are exercised by media-browser.mjs. Evidence is scoped to generated
scenes on one workstation; continuous fields, overlapping medium composition, external density files,
cross-vendor accuracy and speed remain unmeasured. The existing finite boundary-iteration guard remains.

The medium-boundary regression also covers negative grazing directions at voxel and brick planes.
A floor-only start can select the cell behind the ray when the forward query displacement is below
one coordinate step, repeatedly switching media at zero distance. Forward half-open cell selection
uses ceil minus one for negative directions in the existing two-level walk. No retry or epsilon
attenuation correction is used. The grazing test failed at radiance about 0.997 before this repair,
against a physical path value about 3.5.

Batch 160 section 5 job 7 adds external constant-furnace IBL evidence for the full 123-primitive glTF scene, with Mitsuba direct/full transport references, unchanged display mapping and exact independent backend budgets. Raw/display hashes protect reference recapture; unit contracts cover ordering, finite radiance, source preservation and frozen counts/budgets. Native WebGL2 refuses the path; real compatibility renders it. Geometric IBL visibility/reflections and principled/glTF differences remain open. Constant radiance does not establish directional prefilter or nonuniform-sky accuracy; batch 168 evidence remains in force. No production renderer code changed.

Batch 160 section 5 job 8 adds independent direct-light picture evidence on the existing Cornell fixture: directional bounded orthographic shadows and point compute selection/six-face shadows, each with unshadowed control, on WebGPU and real compatibility. All pixels, default PCF/bias and exact first budgets are retained. Tests preserve every fixture quad/reflectance and frozen reference count/hash/budget; native WebGL2 explicitly refuses. Contact/visibility residuals stay open, and point finite-range attenuation differs from the ray-traced emitter. This does not repeat the batch 168 bake or prove GI, many-light stress or all shadow types. No core, package renderer or speed result changed.

### Accumulated planar shadows: section 5 evidence (batch 56, job 2)

staging/accumulate reuses the contact receiver, caster variants and lifecycle through protected projection,
coverage, update and cache seams. One binary point-light projection and one ping-pong sum pass run per
sample frame; converged frames draw only the receiver. R16F integer sums up to 1024 are divided once
when composing. The constant-size matrix and bounded 11-bit disk sampler add no CPU geometry/image
loop; GPU work holds visibility. Core and stage remain unchanged at 23,797 B gzip. The root receiver
is 8,129 B, within its unchanged 8,259 B ceiling; the new entry is 9,314 B including the receiver, with
the standard 9,593 B ceiling. No runtime speed was measured.

Native WebGPU and the WebGL2 compatibility layer each match 16,384 exact stand-in texel sums,
including Direct3D's specified subpixel snapping. Tests cover three heights, 1024-frame empty/opaque
sums, a PBR caster, convergence, resize, removal, actual device replacement and native WebGL2 linked refusal.
Ownership coverage found that ContactShadows.dispose removed by name from the default scene;
it now removes its owning scene's registration by identity. CPU and actual-device owner regressions
keep a same-name default-scene effect alive. This is single-machine raster evidence, not photographic
quality, arbitrary-axis or full radiometric light integration evidence.

The inherited receiver also registers its pass under the effect's own name, allowing contact and
accumulated effects in one scene. CPU and real-GPU coexistence regressions cover both registrations.

### Studio rig reuse: section 5 evidence (batch 56, job 3)

SKIPPED implementation: environment/studio already generates overhead, key, fill and rim softboxes.
The staging recipe composes its FloatImage with EnvironmentLighting, projected ground at order 0.25
and the contact receiver at 0.5. No new shader, CPU pixel loop, Wasm, runtime entry or core/stage change.
The existing studio GPU oracle verifies source-cube values and projected SH, with key irradiance above
1.5 times the fill, on WebGPU and WebGL2 compatibility. The new studio variant of staging's ground
oracle gives identical off/on contact RGB [80,80,80]/[70,70,70] on both paths, preserves product/outside
pixels, clears removed casters and restores after actual device destruction. Stand-in box and generated
image only; no photographic-product, local-light falloff, physical soft shadow or speed claim.

### Procedural dual contouring (batch 68, job 5)

The optional procedural/sdf factory loads its own Rust/Wasm asset. Uniform-grid
Hermite edge roots are shared among adjacent cells; analytic box/sphere normals
feed a mass-point QEF solved with symmetric Jacobi eigenvectors and all 27 bounded
constraint sets. World-space unit normals preserve rank in anisotropic cells.
The renderer receives owned geometry data and does not own the modeler. No core,
stage, CAD kernel or physics source changes. Real WebGPU and WebGL2 tests assert
sharp corner values, lazy loading, disposal and generation after device/context
loss. Native QEF rank/constraint tests and a required downloaded Khronos Box fixture
prove corner, plane, volume and closed-edge values. CSG and scale controls remain
generated stand-ins; arbitrary topology and render quality are unproven (LIM-632).

### Supplied mip chains: section 5 evidence (2026-11-09)

Materials/mips now uploads seven outside toktx v4.0 conformance chains, five levels
each, on a real WebGPU device. All 35 images (9,548 texel bytes) read through the
allowed linear view match independent ktx-extract hashes exactly. Missing, LFS and
changed fixture bytes fail before browser startup. GPU readback uses textureLoad
and pack4x8unorm into storage, since supplied textures promise sampling rather than
COPY_SRC. No rendering or core/stage code changes. The solid-colour density controls
remain; these outside solid-colour patterns add upload conformance, not production
texture quality, nonuniform authored-image evidence or speed measurements.

### Batch 65 job 1: at-grade road junctions

The optional road/junctions entry lazily loads existing polygon strokes, polygon union, shape triangulation and geometry transforms. Union precedes triangulation, so crossings and T junctions have one surface, including holes. Core and stage are unchanged. Section 5 evidence: road/test/junction-precision.test.js rejects float32 face collapse and UV overflow; road/test/junctions.test.js checks analytic area, half-open triangle coverage, winding, normals, UVs, ownership, extremes and abort boundaries. road/test/browser-check.mjs draws the result on native WebGPU and real WebGL2 compatibility, checks five interior pixels and a clear exterior, then exact reboot pixels and double disposal. Generated roads are stand-ins; no surveyed-road, graded-junction, curb, performance or other-hardware claim is made.

### Batch 76 review fixes: section 5 evidence

Root/custom capture reads now derive full-target UVs from fragment positions rather than viewport-local interpolants. The unchanged mask path already uses absolute pixels; live creates only full-frame views. viewport-browser.js adds 2304 exact spatial-color pixel comparisons across all four built-ins/custom/mask, idle/start/midpoint/completion, offset viewport, stacked scissor and 1x/4x. This suite is part of transitions test:gpu, automatically reached by check:merge's affected-package GPU selection; unit format/abort checks run in verify. This catches the partial-view class missed by solid full-frame fixtures.

A shared package-local format-domain check rejects integer/depth outputs and non-resolvable 32-bit float MSAA before live source updates, allocation or progress changes, and before frozen-frame capture allocation. Real-device tests accept baseline normalized/float output formats at 1x/4x, and reject invalid domains without a GPU validation error. Custom WGSL interface tests reject reachable extra textures/samplers/uniforms/storage, accept unused declarations and wrapper-global access, and compile/dispose a high-work loop without dispatch. This validates a resource interface, not execution safety. Trusted source remains mandatory; no timeout or hostile-dispatch safety claim.

The requested scatter audit inspected inclusive far rejection, near/middle selection, fade bands, tileDistance's conservative f32/flush bounds, uploaded LOD representation and ordered compaction/page/ring capacities. Existing fixes/tests cover these cases; no additional defect was found. All 72 scatter unit cases pass, including tiles-budget.test.js. No scatter code or budget changed. Generated fixtures and one RTX A6000 only, no new throughput claim. Review fixes fit existing entry budgets; core and stage remain unchanged.

### Static USDZ sample: section 5 evidence (2026-11-09)

The original introduction now runs on the complete outside Blender 5.1 BoxTextured
USDZ with its archived PNG. Required external inputs total 353; README aliases
share that cache and validate the pinned SHA-256 before serving. The regression
checks one mesh, 36 expanded vertices, 12 triangles, UVs, texture and zero issues.
No parser, rendering, core or stage code changed. This closes the introduction's
missing-file execution gap only; composition, reset-stack data, physical Quick
Look and production image quality remain separate gaps.
