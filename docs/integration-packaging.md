# Packages bundled together (integration J5)

An app composes Margo packages from their READMEs and its bundler joins them. These checks cover what no single
package's own tests can see. All are CPU only and need `npm run build:packages` first (the packages resolve to dist).

## Every public entry in one type program

`examples/all-entries/entries.ts` has one `export * as` line for every public entry of every package, generated from
the packages' `exports` maps by `node scripts/generate-all-entries.mjs`. The project `all-entries` in
`scripts/support/example-projects.mjs` type-checks it with `npm run check:examples-types`, with `skipLibCheck` off, so
every entry's declarations are checked in one program. Two packages whose declarations fight (a global declared
twice, an entry whose types name a file that is not built, a type that only resolves inside one package's own build)
fail here. The file follows the exports maps the way the API reports do: `npm run api:update` rewrites it
and `npm run api:check` (and `tests/all-entries.test.js`) fail when it is stale, so a new or removed entry is caught
by the fast gate.
check:merge picks the project for a change to any package, because the file imports every package.

Left out until done, each with its reason in the script's `PENDING` list (it must end empty): sciviz entries and the
kit entries that re-export them (work list 5: sciviz batches 175, 176 and 178).

Measured on the Beelink (2026-11-10): 4,725 entries from 101 packages, 5,543 files in the program, 367 MB, no
errors. Byte and file counts only; no timing.

## Contract groups bundled in two orders

`scripts/support/contract-groups.mjs` names the groups of packages that share a contract (render passes, scene
content, tools and input, animation, assets, materials and environment, stage, gameplay, voxel). For each group,
`tests/packaging-bundles.test.js` bundles a probe that imports every package of the group, forward and backward, with
Rolldown (Vite's bundler) and nothing external:

- both orders build the same set of modules, and each module imports the same bindings (source and name);
- the probe, run in Node, prints byte-identical output in both orders: every export's kind and its value (a
  primitive) or own keys (an object or class), sorted, and the globals importing added;
- importing a group adds no globals. The one exception is the state `packages/shared` keeps under
  `Symbol.for('margoengine.<name>')` keys on `globalThis` (`frame-resources.js`, `mesh-source.js`), on purpose: every
  package bundles its own copy of those modules, and the copies must share one registry per device.

A self-check plants two modules whose state depends on which loads first and that add a global; the check must name
both faults, and pass two clean modules.

A module's raw bytes are not compared across orders: the bundler orders a module's hoisted imports by discovery and
numbers clashing local aliases (`i$1`, `i$2`) by it, so the bytes move with the import order while every package
emits the same code.

Physics (on hold) and sciviz (still being built) are in no group (`LEFT_OUT`).

## Core plus one package pulls in nothing else

For every public package with a root entry (sciviz and physics left out), a bundle of core plus that package must
statically reach only the package, core, `packages/shared` and what its manifest names: dependencies and required
peers, transitively, and declared third-party framework peers (`react`, `react-dom`: optional so that
`npm i margoengine` does not install React for apps that never import the React bindings). An optional Margo peer must
stay behind `import()`. Lazy chunks are not followed: a lazy `import()` may reach more, by design. A self-check adds a
static import of `@margoengine/sky` to `@margoengine/tween`'s bundle and must see it named.

## One core whatever the path

`@margoengine/core`, `@margoengine/core/extension`, `@margoengine/stage`, `margoengine` and `margoengine/core` must
give the same `Engine` class, bundled (one copy of each core module in the bundle) and in plain Node.

## Findings

First run on 2026-11-10 (origin/main b2ed6af30): all checks pass once the two by-design cases above are written into
them (React as an optional framework peer, the shared Symbol.for registries). No package fix was needed and no check
needed a core change.
