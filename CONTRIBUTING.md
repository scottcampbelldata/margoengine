# Contributing

Thanks for taking a look. Bug reports, fixes, docs and new examples are all welcome.

## Setup

You need Node.js 22.12+ (24 is what CI uses) and [Git LFS](https://git-lfs.com).

```sh
git clone https://github.com/scottcampbelldata/margoengine.git
cd margoengine
git lfs install
git lfs pull
npm ci
npm test
```

Rust is only needed if you change `packages/kernel`. The toolchain is pinned in `rust-toolchain.toml`; `rustup`
picks it up. After a kernel change, run `npm run test:kernel` and `npm run modern:build` to rebuild the checked-in
Wasm.

## Before you open a pull request

```sh
npm run lint
npm run typecheck
npm run test:all
npm run api:check
npm run measure:size
```

CI runs the same commands on every push and pull request.

- Keep a pull request to one change. Small is easier to review.
- Add or update tests for what you change. Most packages have tests in `packages/<name>/tests/`.
- Run `npm run format -- <files>` on files you touch. Formatting and lint rules are in `biome.json`.
- If you change a public export, `npm run api:check` will tell you. Update the API report with
  `npm run api:update` and say why in the pull request.
- Core and the stage have a size budget (25,000 bytes gzip combined). New features normally go in their own package
  and attach through `@margoengine/core/extension`.
- Browser features need a check that runs in a real browser. The `modern:test:*` and `check:*` scripts show how.

## Reporting bugs

Open an issue with the browser and version, the GPU if you know it, what you expected, and the smallest snippet or
file that shows the problem. For a model that fails to load, attach the file if you can share it.

Security problems go to the address in [SECURITY.md](SECURITY.md), not a public issue.

## Where things are

| Path | What |
| --- | --- |
| `packages/core` | Engine, scene, renderer, the Wasm kernel binding |
| `packages/kernel` | Rust source of the kernel |
| `packages/stage` | `createStage` |
| `packages/*` | Everything else, one package per feature |
| `examples/` | Runnable demos |
| `docs/` | Design notes, limits and guides |
| `scripts/` | Build, test and release scripts |

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
