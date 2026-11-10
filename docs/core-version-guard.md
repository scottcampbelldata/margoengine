# Core version compatibility

The guard is an approved core bug repair. A package cannot own the engine's identity or validate every
plugin before core's registration mutates its scene and ownership maps. The engine therefore carries
one core requirement containing its exact version, module URL and runtime identity. `Engine.use` checks a package's
requirement before setup, pass registration, disposal or map changes. `engineRuntime` checks before
returning a runtime handle. A conflicting meeting throws one linked `MargoError` with code `version`.

The package emitter freezes the core manifest version into each emitted plugin declaration, static
attachment method and imported `engineRuntime` call. Optional, custom and plain TypeScript builds use
the same emitter. Imported runtime bindings are wrapped once, so aliases, callbacks and local shadowing keep their JavaScript semantics;
bundled dependencies keep their own existing build declarations. Pure modules receive no declaration.
No global registry or import-time registration is needed. Unbranded structural EngineKernel stand-ins
remain usable; custom plugins declare their requirement explicitly. Duplicate installations that never
exchange engine objects have not met and are not rejected. Repeated imports of the same path work.
The emitter handles ESM attachment boundaries. Classic worker Script programs keep their existing
syntax: injecting module imports into them broke biomes' worker startup. The Script/Module AST
distinction fixes that owning emitter fault; the transform regression runs the result as a Script,
and all 13 biomes editor/graph cases pass, including real worker replicas and the ecotone checks.
When an ESM dependency is bundled into a classic worker, its diagnostic source becomes that
worker's published package path. All identity/version checks stay in core; classic syntax and
parser asset URLs remain valid. Pure annotations on object-plugin declarations keep unused plugin
metadata tree-shakable without changing attachment checks. A bundler regression covers that case.

Research compared module identity with dependency version harmonization: object identity is needed for
same-version duplicate installs even when bundling collapses their URLs, while exact build declarations are needed when an installed runtime
changes without rebuilding a package. Semver ranges alone establish neither condition. Clean-room
implementation used these descriptions, not companion code or another engine's source:

- Node.js contributors, 2026, *Modules: ECMAScript modules*, URL caching and `import.meta.url`:
  <https://nodejs.org/api/esm.html#urls>.
- Ecma International / TC39, 2026 living specification, *ECMAScript Language Specification*,
  abstract module records and object identity: <https://tc39.es/ecma262/#sec-abstract-module-records>.
- WHATWG contributors, 2026, *HTML Living Standard*, Web workers and importing scripts and libraries:
  <https://html.spec.whatwg.org/multipage/workers.html#importing-scripts-and-libraries>.
- Rollup contributors, 2026, *Configuration Options: treeshake.annotations*:
  <https://rollupjs.org/configuration-options/#treeshake-annotations>.
- Donald Pinckney, Federico Cassano, Arjun Guha and Jonathan Bell, 2023,
  *A Large Scale Analysis of Semantic Versioning in NPM*: <https://arxiv.org/abs/2304.00394>.
- Kaifeng Huang, Bihuan Chen, Bowen Shi, Ying Wang, Congying Xu and Xin Peng, 2020,
  *Interactive, Effort-Aware Library Version Harmonization*: <https://arxiv.org/abs/2002.11066>.

Core measures 21584 B before and 21775 B after, a 191 B guard rather than the draft's 238 B.
Shorter diagnostics retain every version and source; shared default requirements remove repeated
declarations. Two version comparisons and a stronger runtime identity comparison remain in core.
The bundled-two-install regression fails with URL comparison alone and passes with identity comparison,
which saves four further bytes. The same-path import and same-runtime bundle cases still pass.
Core plus stage measures 23950 B before and
24209 B after, against the unchanged 25000 B hard limit. Packed-install regression covers two actual extraction paths, an exact
build mismatch, matching imports and absence of setup/registration/disposal effects on rejection.
Before the repair, the packed duplicate-path case failed with "Missing expected exception" because
the old engine silently accepted the foreign plugin. Build-transform tests cover aliases, local
shadowing, object plugins, static attach and preserving a bundled dependency's own version.

Core growth, 2026-11-10 (Scott approved): 21775 -> 21828 B gzip (+53 B), build ceiling 21776 -> 21829 B. Three
correctness fixes found by the batch 132 audit, each with a regression test that fails without it (e8f3decf6):
`storeQuaternion` lost roll at pitch +-90 degrees (both Euler atan2 pairs are (0,0) there; X is now 0 and Z takes
2 atan2(qz, qw), as Shoemake resolves the gimbal case); `resize()` clamped width and height to 4096 independently, so
5120x1440 rendered at 4096x1440 with the wrong aspect (both now scale by one factor); `fitToBoundingBox` padded the
radius to 2 near and never kept the box past the near plane (a 2 cm part sat 11x too far away, and at fov 120 near cut
the box). These are wrong results, not features, and none could move out of core: each sits on the engine's own
transform, backbuffer or camera path. No quality was traded for the bytes. e8f3decf6 first recorded 21812 B and a
ceiling of 21813 B, which no build of its sources gives, so `build:packages` failed on main. Measured by building
only `packages/core` and `packages/shared` from each commit with `node scripts/build-modern.js --precompiled`
(Node 26.12.0, zlib 1.3.2.1-motley, rolldown 1.2.13): 21775 B at e8f3decf6^, 21828 B at e8f3decf6 and on main after
it, the same in two worktrees. Scott's 2026-11-07 ruling (a core bug fix passes the cap by what it measures) and his
2026-11-10 ruling (the approved core fixes keep their measured cost) set the ceiling at 21829 B; a later core shrink
pass ratchets it back down.

Scott's later 2026-11-09 ruling retains a core-only ratchet at the final measured 21775 B. The build
uses a strict ceiling of 21776 B, and the quality entry is capped inclusively at 21775 B. The 26
optional entries that exceed their existing ceilings gain exactly 191 B of ceiling each, with no new
headroom. The complete before/after measurements and ceilings are in docs/limits.md and the size
baseline history. This shared guard must stay in core: splitting it would lose the owning engine's
identity and allow registration side effects before rejection. Optional emitter bytes keep each
package's exact build version at its attachment boundary; splitting these small declarations would
add another import and obscure that build identity. No rendering quality is removed.
The shader whole-entry unit ceiling rises 18500 -> 18691 B and viewcube's unit ceiling 5150 ->
5341 B, each by the same 191 B allowance. Their measured entries are 18489 -> 18568 B and
5130 -> 5220 B. Shader's minimal/ratio checks and viewcube's axis ceiling stay unchanged.

The rebase adds controls to the failing entries: 27469 -> 27530 B, with its ceiling
27517 -> 27708 B (+191 B). Alternative emitter layouts were measured without changing the checks; none
resolved the byte gap. The retained core guard stays at its smallest measured size.

GPU validation exposed two React package commands that served repository-relative
fixture URLs from the package directory, so both returned HTTP errors before loading
the fixture. The owning package commands now enter the repository root, matching
the browser harness process.cwd contract and the other package GPU commands.
The unchanged bindings and instances browser checks are the regression tests.

The command-root repair follows Node.js contributors (2026), *Process: process.cwd*,
https://nodejs.org/api/process.html#processcwd, and Vite contributors (2026),
*Shared Options: root*, https://vite.dev/config/shared-options.html#root.

The final XR rebase adds one optional allowance: 8965 B unguarded and 9041 B guarded, with the ceiling 8967 -> 9158 B (+191 B). Its new eye hooks are unchanged. The core/stage GPU results remain valid because incoming main changed neither package; all 12488 CPU cases and 1363 incoming-package cases pass. The independent SNORM failure was reproduced on clean main and tracked separately under lane rule 23.

The final rebase also repairs unresolved upstream merge markers in the umbrella manifest and size baseline. Both incoming optional entries and their budgets are retained, history is restored, and the total is recomputed from items. The existing tests/umbrella.test.js manifest/generator regression and the size quality gate reject the malformed records before repair.
