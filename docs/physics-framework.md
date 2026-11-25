# Physics framework

Margo's physics is many solvers on one framework: rigid and articulated bodies, soft bodies, cloth, rods, fluids,
granular matter, the atmosphere, the ocean, rivers and floods, terrain, destruction, vegetation, characters and more.
They must interact as nature does (wind fills a sail that drives a hull that cuts a wake into a sea the wind grew), and
every film shot must re-render bit for bit on any machine. This file is the contract every solver is built on. The
findings it answers are in [physics-audit.md](physics-audit.md), and the rigid and soft rows in
[rapier-parity.md](rapier-parity.md). Every solver built on it, with its methods, kernels and couplings, is in
[physics-solvers.md](physics-solvers.md).

**Basis.**

- A survey of the literature on coupled multiphysics: partitioned and monolithic coupling, operator splitting, multirate
  stepping, and the added-mass instability.
- The architecture of published coupled systems (preCICE, ESMF and OASIS, SOFA, Chrono, MOOSE, FleX, Genesis, Taichi,
  Warp, Houdini DOPs), read from their papers and public documentation only, under the clean-room rule.
- A survey of Margo's own kernels, which the framework reuses rather than replaces.

Sources are cited per section, and the full reference list is at the end.

## 1. The shape: partitioned solvers on a coupling graph

There are two published ways to build many coupled solvers:

- **One unified solver.** Everything is particles and constraints (FleX), so coupling comes for free. But it cannot
  hold an Eulerian atmosphere, a spectral ocean or a material-point (MPM) continuum at their natural accuracy.
- **A graph of solvers with explicit coupling.** This is the approach of preCICE, the earth-system couplers, SOFA and
  Houdini's dynamics networks (Keyes et al. 2013; Felippa, Park and Farhat 2001).

Margo takes the second, and uses the first inside the constraint family, where rigid, soft and cloth share one
constraint pass.

- **Encapsulation.** A solver never calls another solver. All data between solvers flows through declared ports on
  shared fields.
- **The graph.** The world builds the coupling graph from what each solver declares it reads, writes and accumulates.
  Two-way edges are grouped into coupling groups, which are the strongly connected components (Tarjan 1972). Groups are
  ordered topologically. One-way edges (wind to vegetation, sea surface to acoustics) stay outside the groups.
- **Coupling scheme.** Each coupling edge gets a scheme chosen for its physics (section 5).

## 2. The world, the clock and the tick grid

`PhysicsWorld` owns the clock, the field registry, the solvers, the coupling graph, the random-number streams and the
state hash. A render asks for "the state at frame N", and the world advances to it. Nothing reads wall-clock time.

**FilmClock** (`@margoengine/math/clock`, pure, no core change):

- Time is the frame number over a rational frame rate (24000/1001, 24, 25, 30, 48, 50, 60, 120).
- `ticks(rate) = floor(frame * den * rate / num)` in integer arithmetic. A tick count is therefore a pure function of
  the frame and the rate, a seek is an assignment, and no film length or frame rate loses time.
- Motion-blur sub-frames get a rational time, so a resumed render lands on the same ticks as the original. This cures
  PA-01 and PA-02.

**Solver rates are fixed in seconds, not tied to the frame rate**, so a shot rendered at 24, 30 or 60 fps runs the same
physics:

- Every solver steps at a dyadic rate, `60 * 2^k` Hz with k from 0 to 7. That is 60, 120, 240 and so on up to 7,680
  steps a second.
- Two coupled solvers therefore always meet on a shared tick (Neal and Belytschko 1989; Gear and Wells 1984): the
  faster one subcycles a whole power of two of steps per coupling interval.
- A solver may choose its level adaptively (CFL), but only as a deterministic function of state, rounded down to the
  next level, and the chosen level is part of state.
- Frames sample the simulation by interpolating between the two ticks around the frame time. Today's rigid
  interpolation and the soft interpolation (PA-06) are this rule.

**No dropped time.** In film mode `advance(frame)` runs every tick owed. A tick cap per call is allowed only with
`settle()` finishing the remainder (the flood's contract), never by discarding time.

**Per-tick inputs to GPU solvers** are computed on the CPU in f64, rounded once to f32, and written to a ring of uniform
slices. GPU division is not correctly rounded, so a tick time computed on the GPU differs between devices and the
WebGL2 compatibility layer.

**Large worlds (floating origin).** A ship crossing an ocean or an army on a continent must not lose precision far
from the origin. The world keeps positions as an integer cell plus an f32 offset inside the cell. Each solver steps
in a region-local frame centred on its own cell, and the renderer draws relative to the camera (Thorne 2005). Moving
an origin is an exact integer cell shift, never a float subtraction, so the shift changes no bit of the simulated
state. A coupling between solvers in different cells converts through the cell difference, which is exact.

## 3. Memory: one shared memory, many solver modules

Today each kernel is its own WebAssembly instance with its own memory, so soft-rigid coupling copies particles,
contacts and impulses through TypeScript twice a step. With n solvers that becomes up to n(n-1)/2 hand-written bridges.
The framework removes the copying:

- **One memory.** All solver modules of a world import one shared `WebAssembly.Memory`. Threads need shared memory
  anyway, and the shared-memory build exists on stable Rust (atomics, bulk-memory, import-memory, shared-memory).
- **One crate and one `.wasm` per solver family, loaded lazily by its optional entry.** This is unchanged. Each module
  is linked with its own `--global-base` and stack region from a build-time module table
  (`scripts/physics-modules.mjs`), so static data never overlaps. Dynamic data lives in regions that the world assigns
  to each solver.
- **Ports are addresses.** A port is a region in the shared memory (address, length, type, layout version) published
  through the field registry. A solver reads another solver's port in place, without a copy.
- **Bridges.** TypeScript calls each module's `step` in schedule order. Calls stay on the JS side (one call per solver
  per tick), and data stays in shared memory.
- **The rigid kernel's arena** stays as it is: one region, its column table, growth and snapshot by copy. It becomes
  the rigid solver module and its region.

The first task of the framework work is a prototype that proves this layout (two modules, one memory, a port read in
place, a snapshot of both, thread-count independence). If the linker cannot give fixed non-overlapping bases for some
module, the fallback is one framework module that statically links the shared kernels, with solver families as lazy
modules that keep their data only in world-assigned regions.

**Status (2026-11-25): proven, no fallback needed.** Two prototype modules (`packages/physics/tests/modules`) built on
stable Rust import one memory, each with its data at its own slot's `--global-base` (`scripts/physics-modules.mjs`: 16
windows of 64 KiB from 64 KiB; regions above `DYNAMIC_BASE`). rustc links `--stack-first`, which puts every module's
stack at address 0, so stacks are linked at size 0 and each instance, one per thread, gets a stack region of its own
through its exported `__stack_pointer`. The reader reads the source's port in place; a snapshot of both restores and
steps on bit for bit; and the reader's results are the same bits on 1, 2 and 4 worker threads and on a plain memory
(`packages/physics/tests/world-modules.test.js`). A shared memory needs a cross-origin-isolated page, so each module also
has a plain build of the same layout for one thread. The loader is `loadSolverModule` in `world/memory.ts`.

## 4. The field registry and ports

Every quantity that crosses a solver boundary is a field in the registry:

| Property | Meaning |
| --- | --- |
| kind | uniform grid, sparse grid, heightfield, particle set, mesh vertex set, surface sample set, body set, scalar series |
| quantity and unit | velocity, pressure, temperature, density, water vapour, height, bed elevation, level set, force or impulse, heat; always SI |
| centring | cell, face, vertex, particle |
| owner | the one solver that may write it |
| readers | solvers that read it (an edge in the graph) |
| accumulators | solvers that add to it (impulses, momentum, heat or mass sources), summed in canonical order |
| time | the tick it is valid at, with the previous value kept for interpolation |

**Access rules.**

- One writer per field.
- Accumulation is order-independent by construction: contributions are summed by solver id, then by element index.
- Readers see the value at the coupling tick.

This is the "privileges" idea of Legion and of render graphs (Bauer et al. 2012; O'Donnell 2017), applied to physics
fields (MOOSE, Gaston et al. 2009; ESMF, Hill et al. 2004).

**Shared foundation fields**, settled before any solver family is built:

| Field | Owner | Contract |
| --- | --- | --- |
| gravity | world | One vector in `@margoengine/math`, passed to every solver and shader (PA-08). |
| wind | atmosphere | `sample(x, y, z, t)`: air velocity, density and temperature anywhere, on the world clock (PA-26 to PA-28). The physics attachment now called `WindField` becomes a wind force that consumes this field, ending the name clash with weather's `WindField`. |
| sea surface | ocean | Height, normal, orbital velocity and current, plus river and flood depth and velocity, from a pure synchronous query (PA-11). Bodies accumulate pressure and volume sources into it (hull displacement, impacts). Below the surface the same contract gives the water velocity at any depth (wave orbital motion decaying with depth, plus tides and currents), so fish, kelp, divers, sand and floating debris all feel the swell's surge. |
| terrain bed | terrain | One bed elevation that erosion, slides and craters write and colliders read (PA-37). |
| rain | atmosphere | Rain rate in mm/h with a drop-size distribution, per position (PA-23): `Precipitation` of `@margoengine/math/fields`, `sample(x, y, z, t)` giving rain, snow, graupel and hail, each with its rate, exponential size distribution, fall speed, impact rate, energy flux and water content; `PrecipitationField` of `@margoengine/weather/precipitation` is the atmosphere's (ATMO-04). |
| cloud water | clouds | Cloud water mixing ratio per cell of a cloud box, kg/kg (`cloudWater`, a `uniformGrid`), owned by `CloudSolver` of `@margoengine/physics/clouds` (ATMO-03), whose rain at the ground is a `source` of the precipitation field and whose flow can be added to a wind. |
| wave spectrum | waves | The sea's directional spectrum E(f, theta) per cell (`waveSpectrum`, a `uniformGrid`, m^2/(Hz rad)) and the `WaveSpectrumField` contract of `@margoengine/math/fields` that samples it with the water's depth and density, owned by `WaveSolver` of `@margoengine/physics/waves` (SEA-01); the sea surface (SEA-02) synthesises from it. |
| tracers | tracers | Particles of dye, sediment, cargo and oil in the water (`tracers`, a `particleSet`: x, y, z, mass, material, state per particle), owned by `TracerSolver` of `@margoengine/physics/tracers` (SEA-15); the sea surface tints its water from their concentration. |
| bodies | rigid | Pose, velocity, mass and inertia of every rigid body, the boundary signed-distance field of each, an accumulator for impulses at points (`bodyImpulses`, landing at the start of the rigid step) and one for forces held over the rigid step (`bodyForces`, force and torque about the centre of mass, taken off after it). |
| follow targets | each moving solver | Pose, velocity and acceleration of anything a camera can follow (rigid bodies, vehicles, trains, ships, animals, birds, fish, flock and herd members), interpolated to the frame time on the world clock and expressed in large-world cells, so a following camera never jitters against the simulation. |

**Transfers between representations** are registered operators owned by the framework, not code inside each solver:

- particle to grid and back: affine particle-in-cell, APIC (Jiang et al. 2015), which keeps angular momentum;
- grid to grid: conservative remapping (Jones 1999; Ullrich and Taylor 2015);
- mesh loads and motion: momentum- and energy-conserving transfer (Farhat, Lesoinne and Le Tallec 1998).

## 5. The solver interface and the coupling scheduler

Every solver implements one contract:

```
describe()           fields it reads, writes and accumulates; its ports; its preferred rate level;
                     its stability limit as a function of state
init(world, params)  allocates its state in its world-assigned region
step(ctx, dt)        a pure function of its own state, its input ports, dt and its random-number counter
exportPorts(tick)    publishes interface data
importPorts(tick)    reads accumulated contributions
stateRegions()       the regions that make up its state, for snapshot, restore and hash
extraState()         history beyond state: wave-radiation memory, predictor and acceleration histories,
                     undelivered impulses
iterate(), rollback() for strong coupling: re-run a tick from a saved start, and return to that start
```

**The scheduler** turns the graph into a static schedule. For each coupling edge it uses the scheme the physics needs:

| Scheme | Use | Source |
| --- | --- | --- |
| staggered | weak couplings and heavy bodies, one exchange per coupling tick | Felippa, Park and Farhat 2001 |
| Strang-symmetric | physics-dynamics pairs where order matters, such as atmosphere sources | Strang 1968; Gross et al. 2018 |
| predicted | cheap second-order coupling: extrapolate the interface state | Farhat, van der Zee and Geuzaine 2006 |
| implicit pressure | light bodies in dense fluid: the body enters the pressure solve | Batty, Bertails and Bridson 2007; Robinson-Mosher et al. 2011 |
| iterated | strong two-way coupling, with a fixed iteration count and Anderson or Aitken acceleration | Degroote, Bathe and Vierendeels 2009; Walker and Ni 2011; Peng et al. 2018 |

Inside a staggered coupling the members step in the order given to `couple()` (soft before rigid, so the soft step meets
the bodies where the tick began and its push lands in that tick's rigid step); solvers left uncoupled step in coupling
order, ids within a group. The same calls give the same order whatever order the solvers were added in.

**Rules for the coupling.**

- **Impulses, not forces.** Solvers exchange impulses (force times dt) into mirrored accumulators, so the sender's
  loss equals the receiver's gain exactly and momentum is conserved at every interface (Gravouil and Combescure 2001).
  `bodyForces` is the same exchange spread through the step: a force the rigid solver holds over exactly its next step
  and then takes off, so the body gains force times dt, as an impulse would give, but through the step (a cloth holding a
  box up must not throw it at the step's start and let it fall through the rest).
- **Added mass.** For a light body in a dense fluid, plain staggering is unstable whatever the step size (Causin,
  Gerbeau and Nobile 2005). The scheduler tests the mass ratio of each body to the fluid it displaces, and forces the
  implicit or iterated scheme below a threshold.
- **Iteration counts are fixed.** Residual tests use fixed-order sums, so a loop never stops at a different count on
  another machine.
- **One level per strongly coupled group.** Every member of an iterated (or predicted or implicit-pressure) group steps
  at the finest rate level any member chooses, so a re-run of the group's tick re-runs one step of each member.

**Other engines as solvers.** The rigid-body contract (the bodies field of section 4 plus the public body, collider,
joint and query API) does not depend on Margo's kernel. Another engine can stand in for the rigid solver by
implementing that contract, as Babylon.js physics plugins do. Margo's own kernel is the default and the reference for
the coupling tests. A plugged-in engine is held to the same tests, and the determinism rules of section 7 apply only
when that engine is deterministic itself.

## 6. Shared numerical kernels

Each building block exists once, in `kernel-common` (a library linked into every module, with no `.wasm` of its own),
and every solver uses it:

| Kernel | Notes |
| --- | --- |
| math | V2, V3, quaternions, matrices; pinned `exp`, `log`, `sin`, `cos`, `pow` compiled in (never the host `Math`, whose results the language leaves to the implementation) |
| random numbers | counter-based, keyed by seed, solver, tick, element and stream (Philox; Salmon et al. 2011), so results never depend on loop order or thread count |
| sort | deterministic radix sort with ties broken by id |
| particle neighbours | one uniform-grid neighbour search for SPH, PBF, MPM, granular and cloth self-contact |
| broad phase | one dynamic tree and sweep (today the 3D kernel and kernel-common each have one; they merge) |
| islands and colouring | one union-find, graph colouring and mass splitting for parallel constraint solves (Tonge et al. 2012) |
| boundaries | signed-distance fields with surface velocity, surface sample sets, cut-cell fractions (Batty 2007; Koschier and Bender 2017) |
| grids | dense and sparse storage (in the spirit of VDB and SPGrid), semi-Lagrangian and MacCormack advection, pressure projection |
| linear solvers | preconditioned conjugate gradient, multigrid-preconditioned CG, banded Cholesky, fixed-order dot products |
| FFT | for the spectral ocean and spectral turbulence |
| transfers | APIC, conservative remap, mesh load transfer |
| allocator | one region allocator over the shared memory (today there are three) |

## 7. Determinism

Every solver must follow these rules. They are checked by tests, not by review alone.

1. Only `+ - * /`, `sqrt`, compares, integer operations and the pinned math library reach state. No FMA contraction,
   no relaxed SIMD, NaNs canonicalised or refused.
2. No floating-point atomics, no races. Scatters become gathers after a sort, or are coloured so concurrent work never
   touches the same data (Blelloch et al. 2012).
3. Reductions use fixed partitions that do not depend on the thread count, combined in a fixed tree order (Demmel and
   Nguyen 2015; Ahrens, Demmel and Nguyen 2020).
4. Iteration order never depends on hashes, pointers or allocation order. Sorts are stable with total-order keys.
5. Random numbers are counter-based.
6. Adaptive steps and iteration counts are functions of state.
7. Threads: a static schedule over islands, colours or fixed chunks. Results are bit-identical at 0, 1, 2, 4 and 8
   threads, by test.
8. The state hash covers simulation state, not scratch or memory layout. Golden hashes are checked natively, in Node,
   in both the SIMD and the scalar builds, and in a browser.

**GPU solvers** (today the flood and the effects particles) are deterministic per device, not across devices, because
GPU arithmetic is not specified to the bit. A film bake on one machine replays exactly. For cross-machine re-renders
every GPU solver gets a CPU reference path behind the same interface, and until it has one, its row states the
difference.

## 8. Snapshot, restore, seek and bake

- **Snapshot** is the union of every solver's state regions and extra state, the clock, the random-number counters,
  and the coupling memory (predictor and acceleration histories, undelivered impulses), with a versioned manifest and
  a hash. Restore reproduces the next tick bit for bit, by test.
- **Restore across a change in the set of objects**, such as pieces made by tearing, debris spawned by a blast, or
  bodies removed since, is the world's job, through each solver's regions. No solver needs the same object set to
  restore.
- **Seek** restores the nearest checkpoint and replays forward. Checkpoints are placed on a memory budget (the revolve
  schedule, Griewank and Walther 2000).
- **Bake** records each coupling group's port data on the tick grid (transforms, surfaces, heightfields, particles,
  grids). A `PlaybackSolver` replays it through the same interface.
  - A coupling group is baked as a whole, because baking one side of a two-way coupling silently makes it one-way.
  - Exports: glTF animation and point caches for transforms and meshes, OpenVDB-style volumes for fields (Museth 2013).

## 9. Threads

Large solvers (fluids, MPM, the atmosphere) at film resolution need threads to be practical, so threads land before
them:

- The shared memory of section 3 feeds a worker pool.
- Each worker instantiates the modules over the same memory with its own stack, and claims islands, colours or
  chunks.
- The reduction rules of section 7 keep the result independent of the thread count.
- Without cross-origin isolation, a world runs single-threaded and reports the mode it chose.

## 10. The guard: coupling tests in the merge gate

For every coupling edge and every solver that claims a physical effect, `check:merge` runs:

- **Effect both ways:** force goes in and motion comes out, in each direction the physics is two-way.
- **Conservation:** momentum is conserved across every interface each tick, and total energy plus the energy
  dissipated never rises against a static boundary.
- **Frame-rate independence:** the same shot at 24, 30 and 60 fps gives identical physics at shared times.
- **Snapshot:** a snapshot, a restore and a re-run match an uninterrupted run bit for bit.
- **Order sensitivity:** swapping two solvers changes results only by the scheme's expected truncation order.
- **Added mass:** a sweep of body-to-fluid mass ratios stays stable.

## 11. Build order

1. **Foundation:**
   - the clock and dyadic rates;
   - the shared-memory module prototype;
   - the world, the field registry and the scheduler skeleton;
   - the solver interface with snapshot, restore and hash;
   - the shared kernels (math, random numbers, sort, neighbour grid, allocator);
   - gravity, units and the wind and sea-surface contracts;
   - the coupling-test harness;
   - threads.

   Today's rigid and soft kernels move onto the interface as the first two solvers.
2. **The vertical slice, a ship at sea**, end to end on the framework: wind with a height profile and turbulence grows
   the sea, the spectral ocean swells, a 6-DOF hull with hydrostatics, Froude-Krylov forces, added mass and damping
   rolls and pitches with real mass, sails pull, the hull cuts a dispersive wake through hull displacement, and breaking
   crests and spray leave as particles. It is proven by the coupling tests and checked against naval architecture (draft,
   heave period, roll period).
3. **Fan-out to every solver in the catalog**, each built once what it depends on exists. Nothing is deferred for being
   less important.

## References

- Ahrens, Demmel and Nguyen (2020). Algorithms for efficient reproducible floating point summation. ACM TOMS 46(3).
- Batty, Bertails and Bridson (2007). A fast variational framework for accurate solid-fluid coupling. ACM TOG 26(3).
- Bauer, Treichler, Slaughter and Aiken (2012). Legion: expressing locality and independence with logical regions. SC 2012.
- Blelloch et al. (2012). Internally deterministic parallel algorithms can be fast. PPoPP 2012.
- Bungartz et al. (2016). preCICE: a fully parallel library for multi-physics surface coupling. Computers and Fluids 141.
- Causin, Gerbeau and Nobile (2005). Added-mass effect in the design of partitioned algorithms for fluid-structure problems. CMAME 194.
- Degroote, Bathe and Vierendeels (2009). Performance of a new partitioned procedure versus a monolithic procedure in fluid-structure interaction. Computers and Structures 87.
- Demmel and Nguyen (2015). Parallel reproducible summation. IEEE Transactions on Computers 64(7).
- Farhat, Lesoinne and Le Tallec (1998). Load and motion transfer algorithms for fluid/structure interaction problems with non-matching discrete interfaces. CMAME 157.
- Farhat, van der Zee and Geuzaine (2006). Provably second-order time-accurate loosely-coupled solution algorithms for transient nonlinear computational aeroelasticity. CMAME 195.
- Faure et al. (2012). SOFA: a multi-model framework for interactive physical simulation.
- Felippa, Park and Farhat (2001). Partitioned analysis of coupled mechanical systems. CMAME 190.
- Gaston et al. (2009). MOOSE: a parallel computational framework for coupled systems of nonlinear equations. Nuclear Engineering and Design 239.
- Gear and Wells (1984). Multirate linear multistep methods. BIT 24.
- Gravouil and Combescure (2001). Multi-time-step explicit-implicit method for non-linear structural dynamics. IJNME 50.
- Griewank and Walther (2000). Algorithm 799: revolve. ACM TOMS 26(1).
- Gross et al. (2018). Physics-dynamics coupling in weather, climate, and Earth system models. Monthly Weather Review 146.
- Hill et al. (2004). The architecture of the Earth System Modeling Framework. Computing in Science and Engineering 6(1).
- Jiang et al. (2015). The affine particle-in-cell method. ACM TOG 34(4).
- Jones (1999). First- and second-order conservative remapping schemes for grids in spherical coordinates. Monthly Weather Review 127.
- Keyes et al. (2013). Multiphysics simulations: challenges and opportunities. IJHPCA 27(1).
- Koschier and Bender (2017). Density maps for improved SPH boundary handling. SCA 2017.
- Macklin, Müller, Chentanez and Kim (2014). Unified particle physics for real-time applications. ACM TOG 33(4).
- Museth (2013). VDB: high-resolution sparse volumes with dynamic topology. ACM TOG 32(3).
- Neal and Belytschko (1989). Explicit-explicit subcycling with non-integer time step ratios for structural dynamic systems. Computers and Structures 31(6).
- O'Donnell (2017). FrameGraph: extensible rendering architecture in Frostbite. GDC 2017.
- Peng, Deng, Wang and Kim (2018). Anderson acceleration for geometry optimization and physics simulation. ACM TOG 37(4).
- Robinson-Mosher, Schroeder and Fedkiw (2011). A symmetric positive definite formulation for monolithic fluid structure interaction. Journal of Computational Physics 230.
- Salmon, Moraes, Dror and Shaw (2011). Parallel random numbers: as easy as 1, 2, 3. SC 2011.
- Thorne (2005). Using a floating origin to improve fidelity and performance of large, distributed virtual worlds.
  International Conference on Cyberworlds 2005, IEEE.
- Strang (1968). On the construction and comparison of difference schemes. SIAM Journal on Numerical Analysis 5(3).
- Tarjan (1972). Depth-first search and linear graph algorithms. SIAM Journal on Computing 1(2).
- Tonge, Benevolenski and Voroshilov (2012). Mass splitting for jitter-free parallel rigid body simulation. ACM TOG 31(4).
- Ullrich and Taylor (2015). Arbitrary-order conservative and consistent remapping. Monthly Weather Review 143.
- Walker and Ni (2011). Anderson acceleration for fixed-point iterations. SIAM Journal on Numerical Analysis 49(4).
