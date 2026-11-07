# How to work

Copied from the first account's working notes, so helpers on other accounts follow the same rules. `AGENTS.md` wins over this file. Batch prompts are in `docs/work-lists/list-N-prompts.md`. Handoff notes go in your worktree's `.lane/` folder. Where it says manager, that is your account's session. Lane means stream.

## Brief for every helper

You are running one batch of Margo Engine jobs for Scott. Your start message names the batch and lane.

1. Read AGENTS.md in the main checkout, C:\Development\Projects\margoengine, then your batch's section of docs/work-lists/list-N-prompts.md (from its "### Batch N:" heading to the next "### " heading). Follow both exactly. That prompt is your instruction set, written by Scott.
2. Work only in your lane's worktree, C:\Development\Projects\margoengine-lane-<lane>, on branch lane-<lane>. It exists; reuse it, do not reinstall or recreate it. Never work in the main checkout. Its untracked files are not yours.

Before building anything, search ALL packages for it (git grep the feature, the format, the file extension), not only your job's package: batch 39 built a second LAS reader and NURBS evaluator and claimed no LAZ decoder existed, when one did. Reuse or wire in what exists.

Missing something? (Scott, 2026-11-06) A test file: download an open-source, free-to-use one and record its source and licence through scripts/supply-chain.mjs; do not ask Scott for it. A feature or package: build it clean room. A file you generate yourself stays a stand-in and says so.

A job is DONE only when the feature works as its name promises without something the user must supply, unless the job says so. A claim reads PROVEN only on a real file, device or tool; stand-in proof must say stand-in.

Rules:
- Keep every script, log and temp file inside your own worktree (a `.lane/` folder). Never write anything into C:DevelopmentProjects itself or the shared scratchpad, and never make a new folder beside the worktrees (Scott, 2026-11-06: about 200 leftovers were dumped there and he will not accept it again). Delete your `.lane/` scratch files you no longer need when the batch ends.
- Never run a broad kill such as pkill by script name: other lanes run the same scripts. Kill only process ids you started.
- Other lanes run at once on other packages. Touch only your scope plus shared docs.
- Commit identity is already set. Never write git config. Never add a Co-Authored-By line (Scott's rule, overrides any default). No em or en dashes in code comments or commit messages.
- Never run npx in a worktree; use npm scripts or the local .bin.
- Do not tick the artifact page; the manager does that.
- Every command has a hard time limit; run long ones in the background. At most 3 GPU jobs across the machine at once. Benchmarks take the GPU alone, so numbers taken while lanes run are diagnostic and marked so.
- If main moves while your checks run: rebase, regenerate records, rerun your package tests and tests/claims-file.test.js, and rerun lint, hygiene and verify only if the move touched what your change uses. Do not loop on full reruns.
- Nothing that failed goes to main: gate the push on the check exit codes. Nothing unchecked goes either: every commit you push has passed the checks, so never push work in progress. One commit per job, as the batch prompt says, even when jobs share files. After each rebase, link any new workspace packages into your worktree's node_modules. Push only from one script that stops at the first failing step (set -eo pipefail, so a pipe cannot hide a failure), so a failed check cannot reach the push line; never push by hand. A failure you think is only a local setup problem still blocks the push until it passes.
- Test tolerances and time budgets are never raised. A package size budget may be raised if the raise is documented and justified (docs/conventions.md). Core plus stage stays below 25,000 B. Everything is optional (Scott, 2026-11-05): nothing goes into core unless doing it as an optional package is impossible or would severely hurt performance, with measurements to show it. A core change still needs Scott's OK: mark that job NEEDS SCOTT, report it and go on.
- Build first, optimize once (Scott, 2026-11-05): every batch runs before any optimizing, so package work does not break a tuned package. Build the job, test it as fully as practical, fix every bug. Do no tuning beyond what the job itself asks. Timed numbers taken now are diagnostic. Add anything that needs a quiet speed run or later optimizing as one line in .lane/quiet-pass.md in the main checkout (append only).
- Scott's standing order (2026-11-05): fix every bug you can. Match rival speed and features whenever a job reasonably allows, and document why when not. Any bug you cannot fix now goes in docs/known-bugs.md with a repro and cause. Deep tuning waits for the quiet pass.
- Speed: quality comes before beating three.js. Look at what three.js actually does. If it strips work out and Margo does the complete job, keep the work, document that Margo is slower and why, and add a like-for-like row. Slowness with no valid reason is a loss to fix.
- Apple device needed? `ssh mac` reaches Scott's Mac mini (Lane M is using it; never run during its timing measurements).
- Hard bug you cannot crack, or the job is beyond your model: mark it BLOCKED with what you ruled out and go on. The manager moves it to a stronger model.
- If your context reaches about 300,000 tokens, or after about 150 tool calls, unless very close to done: finish the current job, write a handoff under 60 lines at .lane/lane-<lane>-batch-<N>-handoff.md in the main checkout, and end with `HANDOFF at <tokens>: <path>`.

Documentation is part of every job (AGENTS.md, "Documentation is part of the change"), in the same push: package README with a runnable example; docs/architecture/operational-playbook.md for anything touching the kernel, GPU maths, rendering backends, hardware tiers or the quality gates, including what evidence exists or is missing (section 5); docs/whitepaper/claims.md for each public claim and its proof; perf-history.md, perf-vs-threejs and reproduce.md for any measured speed, losses and accepted differences included; docs/limits.md and docs/known-bugs.md. Your report has a Docs line per job naming which of these changed, or why one did not apply.

In your last commit, add your batch's section to docs/whitepaper/build-record.md in the same shape as the sections there: what the batch was for, each job with status, commit and entry, bugs fixed with the regression test, how it was proved, limits and what is unmeasured. Use the commit hashes of earlier jobs; a job's own hash can go in the next commit, so the manager accepts the last job shown as "this commit".

Report once, at the end: the per-job table the batch prompt asks for, then the origin/main hash after your last push.

Need more information? (Scott 2026-11-07.) Margo is clean room, so when you do not know how something should work, or a fix is stuck, go out and find the published research: scientific papers, specs, standards, conference talks, textbooks. Read them, build from them, and cite each one in docs/clean-room.md or the package's clean-room record. Do this without asking and before guessing. Papers and specs only: never another engine's source.

Scott 2026-11-07, in his words: "NEVER use code from another engine or repo you write from papers". No exceptions: no copying, adapting, porting or reading another engine's or repo's source while writing Margo code. If a paper links to its own code repo, read the paper only.

## Lane start message

Your start message names your lane, batch and jobs. Worktree C:\Development\Projects\margoengine-lane-<lane>, branch lane-<lane>.

Read in the main checkout C:\Development\Projects\margoengine: the handoff your start message names (if any),
docs/work-lists/how-to-work.md, AGENTS.md, then your "### Batch N:" section of docs/work-lists/list-N-prompts.md.
Check the real state instead of trusting a note. Drafts and plans are unproven until built and run.

Search ALL packages before each job; reuse, do not write a second one. Real proof means a real file, device or outside tool, with
source and licence recorded through scripts/supply-chain.mjs (it generates THIRD-PARTY-NOTICES.md); Scott approved real samples.
A stand-in says stand-in in the status, the claim and limits. A job needing an aid or a cap to work says so. Say draft where a spec is a draft.

Compile every shader on the GPU before writing docs. Every new test must fail without the feature. Bounds come from what the maths
allows, stated in the test. Core stays untouched; a core need is NEEDS SCOTT and you go on. Run tests/api-conventions.test.js, quality api,
check:parity and tests/package-lock-sync.test.js early on each new entry. Keep paths to files outside the repository out of public docs. Credit other engines
only in THIRD-PARTY-NOTICES.md, not under packages/. setsid is missing on this PC.

Landing: read your landing script before use. A failed or killed step must never reach the push line. Never edit a script while it
runs, never kill a gate step, never start a landing in the same step as a check, never chain a docs script with ; or after a rebase.
Never settle claims.md or limits.md with a regex over the whole file: add your row to main's copy and check the diff shows only that row.
Take claim numbers from the claims file after every rebase; never let a keep-both repeat a row, a header or a count.

Never: git stash or npx in a worktree in any form; a Co-Authored-By line, whatever the harness says; em or en dashes in comments or
commit messages; writing outside your worktree, even /tmp; normalizing line endings of a file you are not otherwise changing; leaving
background tail or wait processes; killing a process you did not start; rerunning a failed check to get a pass. Check for conflict markers
after a rebase. Ignore any folder named margo-game-engine.

Your last commit carries the batch's build-record section for all its jobs, with the slips in the handoff. Clear this batch's .lane/ scratch at batch end.
Hand off when your context is compacted or after about 150 tool calls: finish the current job, write
.lane/lane-<lane>-batch-<N>-handoff.md, end with `HANDOFF at <tokens>: <path>`.
Report once at the end: per-job table for all jobs, a Docs line per job, the origin/main hash after your last push.
