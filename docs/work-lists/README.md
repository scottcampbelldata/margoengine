# Work lists

Scott is running more than one Claude account at once. The remaining work is split into three lists that share no packages. This folder is temporary and is deleted before the repository goes public.

- `list-1.md`: the first account. Do not touch it.
- `list-2.md` and `list-2-prompts.md`: the second account.
- `list-3.md` and `list-3-prompts.md`: the third account.
- `machines.md`: which machine runs which list, and what is different on each.

## Starting an account

Scott tells the new session which list is its own. That session is the manager for that list:

1. Read `AGENTS.md`, then this file, `machines.md`, `how-to-work.md`, your `list-N.md`.
2. Run the list's 3 streams at once, each through its own helper agent, one batch at a time, top to bottom. Opus at medium effort for normal jobs, high for hard ones, Fable only to write a plan for design-heavy work. Hand a helper's work to a new helper at compaction or 300,000 tokens.
3. On each finished batch, check its commits are on `origin/main`, that its README, `docs/limits.md`, claims and build record changed, and that its row in your list reads `done`. Then start the stream's next batch.
4. Report to Scott briefly, only when something lands, blocks or needs his decision. When the list is done, say so; the first account then shares out what is left.

## Worktrees

One worktree per stream, beside the main checkout, named `margoengine-lane-<stream>`: `git worktree add --detach ../margoengine-lane-D origin/main`. Then `git lfs checkout`, and set up dependencies as `CONTRIBUTING.md` and `package.json` say, without npx. Push with `git push origin HEAD:main`. Set commit identity through environment variables: author and committer email `251750033+scottcampbelldata@users.noreply.github.com`, name Scott Campbell. Never write git config.

On another computer, clone the repository first and check that the GPU tests run there. If that machine has no GPU, stop and tell Scott.

## Staying out of each other's way

- Touch only your stream's packages, plus the shared docs each job updates. Never touch `packages/physics`, `packages/physics2d`, `packages/ragdoll`, `packages/voxel/src/physics.ts` or `packages/core`. A core need goes to Scott.
- More accounts mean more pushes. When main moves during a landing, rebase and follow the short rule in `how-to-work.md`; do not rerun the full check again and again.
- Claim numbers in `docs/whitepaper/claims.md` collide most often. Take the number from the file after every rebase and check for duplicates before pushing.
- At most 3 GPU jobs at once per machine, counting every account on it. Benchmarks take the GPU alone. Watch memory on a shared machine: `tsc` has already run out under load.
- `npm run check:readme-run` uses README example positions: a new example above a listed one needs the known list updated.

## Never

Use code from another engine or repo; write from papers and specs. Publish to npm or PyPI. Deploy. Touch live servers. Force-push. Add a Co-Authored-By line. Delete another session's work. Work on anything Scott keeps out of this repository. Touch the Rust engine. Open a folder named margo-game-engine.
