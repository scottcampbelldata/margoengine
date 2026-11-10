# Batch prompts for work list 4

Each section is the full prompt for one batch.

### Batch 121: proof audit (part 1 of 1, 4 jobs)

```text
Read AGENTS.md and follow it. Scott's order, 2026-11-06: passing checks is not the same as working. All 76 USDZ files passed usdchecker and the first iPhone test failed in seconds. Find every other place like that and fix it.

JOBS:
1. [High] Go through docs/whitepaper/claims.md and docs/limits.md. List each claim whose proof is only a validator, our own reader, a stand-in or a built file, and name what would really prove it: the app, device or real files a user would use. Write the table to docs/whitepaper/proof-audit.md, with counts as X of Y.
2. [High] Run every real test the machines can do: Blender, Unity, Unreal, Godot, PrusaSlicer, Safari and Quick Look on the Mac, real files downloaded free of charge with licences recorded. A missing test file gets downloaded; a missing tool or feature gets built clean room.
3. [High] Every failure found gets a root-cause fix and a regression test in the owning package, or a docs/known-bugs.md entry with a repro and cause. Correct any claim that says more than was proved.
4. [Medium] Write the short list of tests only Scott can do on a real phone or headset, with the files ready to open. Rerun jobs 1 to 3 for the batches landed since the last audit, once more after all feature batches end.
```

## Phase 17: Margo's own physics (Scott, 2026-11-07; replaces batches 90, 91, 92)

### Batch 132: research and quality audit of every package (part 1 of 1, 6 jobs)

```text
Read AGENTS.md and follow it. Scott's order, 2026-11-07: look at all 100+ packages and make sure each was built from science, research papers and references, to the highest standard, and that nothing is just AI slop. Runs after every feature batch and after own physics, before the release. Work package by package, a few per helper run, lowest-level packages first. A helper reviews code it did not write. Papers and specs only, never another engine's or repo's code, and never a paper's companion repo.

JOBS:
1. [High] Sources. For each package list every algorithm, formula and non-trivial technique, and the published source behind it. Compare with docs/clean-room.md. Flag anything with no source, read only as an abstract, or resting on memory.
2. [High] Check the code against the source. Fetch and read each paper or spec in full. Check equations, constants, units, conventions and edge cases against the text. Every magic number needs a source or a measurement. Where the code differs from the paper, fix it or write down why, with proof.
3. [High] Slop review. Find features whose name promises more than they do, stand-ins presented as real, code that does nothing, needless wrappers, copy-pasted helpers, comments that repeat the code, filler docs, try/catch that hides errors, and tests that pass whatever the code does. Use mutation scores where they exist.
4. [High] Standard check. Each package: a real test on a real file, device or tool where one applies; README examples that run; coded errors with help links; every option documented with its default; speed measured where it is claimed.
5. [High] Fix every finding at the root in the owning package with a regression test, or put it in docs/known-bugs.md with a repro and cause. Build what is missing clean room. Correct any claim that says more than was proved.
6. [Medium] Publish the result: one table of all packages with sources read in full, what was checked, what was found and fixed, and what is still open, losses included, in docs/whitepaper/. It must be true for a sceptical Hacker News reader to check.
```

## Phase 18b: no outside code ships (Scott, 2026-11-07; runs before batch 132)


### Batch R5: review of landed list 2 and 3 work (1 job per package)

```text
Read AGENTS.md and follow it. Review the feat and fix commits that landed on origin/main since 2026-11-10 in these
packages: environment, clustered, lightmap, scatter, water, inspector, terrain, sky, weather, biomes, road,
procedural, audio, mixer, video, tiles, splats, ui, labels, html, selection, viewcube. Per package: list its commits
(git log origin/main --since=2026-11-10 -- packages/<p>), read the diffs, and look for correctness bugs only: wrong
results, state not restored, GPU or audio resource leaks, disposal order, off-by-one, NaN on edge inputs, async races,
AbortSignal not honoured, units. No style findings. A finding counts only with a concrete input and the wrong output;
confirm it with a failing test, then fix the root cause in the owning package with that regression test (a fix(scope)
commit that changes a test file). A finding not fixed in 3 rounds goes in docs/known-bugs.md with repro and cause.
Record every finding (commit, file:line, defect, input, fix hash) in docs/work-lists/review-5.md. Fast gate before
each push as machines.md says; never verify.
```
