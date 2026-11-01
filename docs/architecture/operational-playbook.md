# Operational playbook

Reference, not rules; AGENTS.md wins.

**Never more than 6 in the queue (Scott, 2026-11-01): at most 6 unlanded branches exist at once, READY or being built, counting every helper. The coordinator counts `private/queue/*.ready` and the unlanded branches before starting or resuming any builder, and when 6 exist no new branch starts until one lands. With 6 READY nothing gets built: `scripts/queue-limit.mjs` refuses edits, commits and new helpers, git refuses a seventh branch, and the integrator lands 6 per batch.**

## Purpose

This document describes how the Margo Engine project is run and verified, in enough detail to build the same systems
elsewhere. It covers five systems: how several coding agents work in parallel and hand work over, how the shared lock
queues and crash protections keep the build machines healthy, how the Wasm kernel stores and updates scene data
deterministically, how rendering falls back across hardware tiers, and how the quality gates and pinned proofs keep
releases honest. Each system lists the rules, the real scripts and files they live in, the numbers recorded, the
failures that were seen, and a "replicate from scratch" section with generic reference code.

## Contents

1. [Multi-agent coordination and context handoff](#1-multi-agent-coordination-and-context-handoff)
2. [Process integrity, lock queues and crash protections](#2-process-integrity-lock-queues-and-crash-protections)
3. [Memory architecture and the deterministic Wasm kernel](#3-memory-architecture-and-the-deterministic-wasm-kernel)
4. [Hardware fallback and rendering tiers](#4-hardware-fallback-and-rendering-tiers)
5. [Quality gates, pinned proofs and verification guardrails](#5-quality-gates-pinned-proofs-and-verification-guardrails)

After the five systems: [Known gaps](#known-gaps), [Sources and commits](#sources-and-commits) and the appendix
[Claims not verified](#appendix-claims-not-verified).

## How to read this document

- Status words used in the text:
  - **VERIFIED**: the code that does it was read.
  - **DOCUMENTED**: a repository document says so; the code was not traced.
  - **NOT VERIFIED** (also written as a plain "not verified" claim): the statement could not be confirmed from the
    repository, a log or a file.
  - **Note:** an implementation note: the repository has no X; what exists is Y.
- Paths are repository-relative. `<repo>` is the main checkout folder; `<repo>-wt-<name>` is a worktree made beside
  it; `<projects>` is the folder that holds the checkouts; `<user>` is any user name. `<dev-pc>`, `<linux-server>`,
  `<mini-pc>` and `<laptop>` stand for machine roles: a Windows dev PC with an NVIDIA GPU, a Linux test server with
  Intel graphics, a small Windows test PC with an AMD iGPU, and a laptop with an Intel Arc GPU.
- Code blocks that name a path and a commit (for example `<path> @ 67ca53a5`) are copied from that file at that
  commit; a cut is marked `// ...` (or `# ...`). Local paths and identities in copied text are replaced by
  placeholders. The lock script's flag and JSON field that name the agent holding a lock are `--owner` and `owner` (the generic reference lock in 2.5 spells its own flag `--holder`). A few other words in copied code and messages were reworded for neutrality (for example a test message); the logic is unchanged.
- Snippets marked `generic reference version, not from the repo` were written for this playbook.
- The commit identity used in examples is `<noreply-id>+<github-user>@users.noreply.github.com` with the name
  `<author name>`.
- The maintainer is the person who sets goals and approves pushes. The coordinator, helpers and other roles are
  described in section 1.1.

---

## 1. Multi-agent coordination and context handoff

### 1.1 Roles

| Role | What it does | What it never does | Model and effort (rule in 1.2) |
| --- | --- | --- | --- |
| Maintainer | Sets goals, gives rulings, approves pushes, downloads, publishing, system settings, hardware actions. Talks only to the coordinator. | Nothing is assumed approved without the maintainer saying so in chat. | n/a |
| Coordinator | Keeps the queue, starts and stops helpers, writes briefs, keeps `RESUME.md`, the bug queue and the dashboard current, reports to the maintainer in short lines. Plans around shared bottlenecks. | Never runs two agents on one task. Never polls helpers. Never relays every helper message. Never trusts a "landed" claim without checking `origin/main`. | Opus 5.5, high effort (never Sonnet or Haiku; never the planner model, which is too token-hungry for an all-day role; it makes the high-level choices). A successor coordinator is the same. It says so to the maintainer if it finds itself on a weaker model or lower effort. |
| Helper (feature or fix) | One task in its own worktree on its own branch cut from current main: code, regression tests, quick checks, one full `check:merge`, landing through the landing lock. Reports once, at the end. | No progress messages. No shared scratch files. No hand edits of generated records. Never deletes a lock. Never stops or waits silently: when it has no next job or needs a decision it asks the coordinator, not the maintainer. | Picked per job: see 1.2. |
| Planner (only for design-heavy or risky work, rule in 1.2) | Reads the code, writes a plan file under about 60 lines in the handoff folder, ends with one line: `PLAN: <path>`. | Never implements, never lands, never touches the landing lock. | Fable 5.1, high effort (Opus 5.5 high if unavailable). |
| Bug-hunt agent | A dedicated agent for a bug whose cause is not obvious (GPU or timing, concurrency, maths, unclear responsible package, failed once already). Finds the root cause, fixes it in the owning package, adds a regression test. | Not the cheap model that happened to find the bug. Never a band-aid (retry, loosened tolerance, skip). | Opus, high effort when truly hard. |
| Planning agent | Writes a plan file and prepares work, with no push and no landing until the maintainer says go. | Executes nothing irreversible. | Opus, medium or high. |
| Investigator | A read-only probe into a host or tool behaviour (which GPU a browser picks, why a reset happened). Writes notes and probe scripts into `handoffs/<topic>/`. | Changes no repo code unless re-briefed as a fixer. | Opus high for hard host questions. |
| Nightly job | Windows Task Scheduler runs the full check every day with no model tokens. | Not an agent at all. | n/a |

Real examples of each role, from `handoffs/coordinator-handoff-2026-10-29.md` (identifiers shortened):

- Helper: "biomes (Opus): B7 streaming+workers"; "font (Sonnet): Source Sans 3 self-hosted".
- Bug-hunt agent: "bug 61 hunter (Opus): FIX for Intel Arc: at 4x MSAA a draw whose colour comes only from the blend
  constant writes black".
- Hardening helper on a cheaper model working a list of small known bugs: "hardening (Sonnet): bugs 62 (quickstart
  fixed waits), 70 (teardown), 68 (jupyter shim) ...".
- Planning agent: a planning agent told "Plan and prepare only; NO push until the maintainer's go."
- Investigator: bug 33c, "Opus investigator ... notes handoffs/gpu-choice-notes.md, scripts
  handoffs/gpu-choice/".

### 1.2 Model and effort per job

Rule text, from the global agent rules file, section "Save tokens (always)":

```text
- **Pick the right model AND effort for every job, every time.** Easy/mechanical work (docs, renames, landings,
  running tests or benchmarks, cleanup): Haiku or Sonnet at low/medium effort. Normal feature work: Sonnet or Opus at
  medium. Hard work (deep performance debugging, architecture, tricky bugs, maths, risky changes): Opus at high, or
  extra-high/max only when the problem truly needs it. Never put hard work on a cheap model to save tokens (it wastes
  more in slow, failed rounds), and never spend a top model on chores. Set both `model` and `effort` when starting a
  session or helper, and switch a stuck job to a stronger model rather than letting it grind.
```

As a table:

| Job class | Examples from this project | Model | Effort |
| --- | --- | --- | --- |
| Mechanical | docs, renames, landing an already-checked branch, running a suite or benchmark, worktree cleanup, handoff continuation, status checks | Haiku or Sonnet | low or medium |
| Normal feature | a new optional package from a written design, DX passes over packages | Sonnet or Opus | medium |
| Hard | GPU or timing bugs, concurrency, maths precision, performance diagnosis, architecture, risky refactors | Opus | high (extra-high or max only when truly needed) |

Coordinators run Opus 5.5 at high effort (the maintainer, 2026-10-29): they make the high-level choices, so they are never a cheaper model, and not the planner model either, which uses too many tokens for an all-day role. The same goes for the coordinator started at a handoff.

**Planner helper (maintainer, 2026-10-29).** For design-heavy or risky work (new architecture, changes across several packages, size-gate tradeoffs, a bug that already failed once, anything where a wrong approach costs a full `check:merge` round) the coordinator first starts a planner on the strongest model (Fable 5.1, `claude-fable-5-1`, at high effort; max only when truly stuck; Opus 5.5 high if Fable is unavailable). The planner reads the code and writes a plan file under about 60 lines in the project's handoff folder (files, approach, what is ruled out, how to test, size and lock use). It does not implement. A helper on the right tier (Sonnet or Opus medium) then builds from that file. No planner for chores, landings, docs, renames or obvious fixes.

Two rules that keep this honest:

1. Set both `model` and `effort` explicitly at every start. A missing value inherits the coordinator's, which is
   usually the most expensive.
2. A stuck job moves up a model; it is not left to grind. A cheap finder of a hard bug stops and tells the coordinator
   (session rule 9, section 1.4).

### 1.3 Shared resources and how many agents to run

#### 1.3.1 The rule

From the global agent rules file, "Landing and parallel-agent limits" and "Coordinator: plan around bottlenecks":

```text
- **Match the number of parallel agents to the shared bottleneck.** When agents share one GPU, one landing lock or
  one check queue, run about 3 at a time, not 6 or 7: extra agents only queue and slow everything. If a backlog
  forms (agents waiting on the lock), pause the least urgent ones (they commit work in progress, release locks,
  stop) and resume them one at a time as spots free up. Start the fixes that unblock everyone first.
```

```text
- Goal is maximum efficiency, not maximum parallelism: if one hour of work would take two because agents queue on the
  same resource, the plan was wrong.
- Before starting or resuming any agent, name the shared resources it will touch (GPU, landing lock, check queue, a
  port, a build cache) and how long it holds them. Start only as many as fit: run 2-3 when they share a bottleneck,
  run 4+ only when they truly don't (separate worktrees, no GPU, no shared checks).
```

#### 1.3.2 Why about 3

The numbers that drive it, all from the project's own notes:

| Resource | Capacity | Typical hold |
| --- | --- | --- |
| GPU lock, correctness tests | 3 shared slots (`MARGO_GPU_SLOTS`, default 3) | one GPU test, default limit 10 min (`scripts/support/run-limited.mjs`) |
| GPU lock, benchmarks | 1 exclusive holder, nobody else | default limit 60 min |
| GPU lock, timing tests in `check:gpu-packages` | 1 exclusive holder, one step per hold | a test whose file calls `acquire({ mode: 'exclusive' })` (the biomes flythrough) runs after the shared tests as its own step; the hold is its step limit plus 5 min, released after it. A timing test chained with other checks fails the plan (`GPU_TIMING_TEST_SHARED`); one run in a shared slot throws at once. A GPU file (a package GPU test, or a check:merge step file that uses `gpu-lock.mjs`) that reads `performance.now()` and holds it to a time budget without an exclusive hold fails the plan too (`GPU_TIMING_MEASURED_SHARED`, `measuresTiming`); a clock that times something else carries a `gpu-timing: none (<reason>)` comment |
| Landing lock | 1 exclusive holder | "About 40 min of lock per landing; queue is the bottleneck." (coordinator handoff). NOT VERIFIED as an average; the live holder in 2.3 had `maxMinutes` 170. |
| A full `check:merge` | runs before the landing lock in the newer pattern, inside it in the newest (see 2.6) | 5400 s hard limit in the landing scripts |

With one landing lock at about 40 minutes a landing, at most about 1.5 landings per hour go through no matter how many
helpers exist. Each extra helper beyond what the lock can drain adds waiting, and each waiting helper still holds a
worktree (thousands of junctions, see 2.16.4) and often a running browser or Node process. On 2026-10-29 at 00:57 the
landing lock had one holder and three queued (section 2.3), the visible form of this.

#### 1.3.3 What actually happened

- 2026-10-26: "Run about 3 helpers at once (shared GPU and landing lock). Paused until the fixes land: DX pass A-L
  ..., top-15 input onward ..., sciviz bricked volumes" (`handoffs/RESUME.md`).
- 2026-10-27: the maintainer set a 7-helper ceiling and four helpers were paused with handoffs, with a stated resume order
  ("pinned proofs first") (`handoffs/RESUME.md`, "7-HELPER LIMIT"; `bug-queue.md` header).
- 2026-10-28: "do not pause anything; let the queue drain, about four hours" with an explicit landing order
  (`handoffs/RESUME.md`, "Landing queue order").
- 2026-10-27 about 15:15: the Windows dev PC blue-screened while a landing verify and other helpers' checks ran (bug 32f,
  section 2.16.4). One data point, but it is why concurrency was capped "at 3 or 4" while the crash is unexplained.

#### 1.3.4 Pause procedure

1. Pick the least urgent running helper.
2. Tell it to commit work in progress in its worktree, release any lock it holds by finishing or stopping its
   locked command (never by deleting the lock), write its handoff note (template in 1.7), and stop.
3. Record it in the bug queue header and `RESUME.md` with its handoff path and its place in the resume order.
4. Resume one at a time as a slot frees, with a fresh agent whose brief points at the note.

### 1.4 The helper brief

#### 1.4.1 What every brief contains

Assembled from the real briefs and rules (`RESUME.md` "How to resume" step 3, `session-rules.txt`, the session-switch
table in `RESUME.md`, and the handoff files in `handoffs/`):

1. Goal and what done means (measurable: "every material scene at or below three.js CPU (p-unlit 6.3 ms)").
2. Files to read first (point at them, never paste): `AGENTS.md`, the handoff or design file, the bug-queue row.
3. Known facts and what is already ruled out, so the agent does not re-survey.
4. Rules: the whole of `handoffs/session-rules.txt` pasted in, plus any ruling that applies.
5. Setup: the worktree path (existing or new), `node scripts/worktree-node-modules.mjs`, `git lfs checkout`.
6. Landing: the background landing script pattern (2.6) and the landing lock command line.
7. Shared resources it will touch and for how long.
8. Report once: what to report, in one short paragraph, at the end; `HANDOFF at <tokens>: <path>` if it hands off.
9. `model` and `effort`.

Every brief also carries these, each from a trap that cost a landing round (2026-10-30 and 2026-10-31):

- The quick checks a builder runs before it calls the work ready are `npm run quality`, `npm run hygiene`, the unit
  tests of what it touched, the unit tests at the repository root (`node --test tests/*.test.js`, which hold repo-wide
  gates such as fixed waits, error-page entries, teardown and file classes) and `npm run api:check`. Helpers that ran
  only their package tests failed these at landing three times in one day.
- A change that alters exports commits the output of `npm run api:update`. Skipping it because `land-records`
  regenerates the API reports fails: the integrator runs `api:check` before `land-records`.
- After a README change, `npm run modern:test:packages -- --packages=<pkg>`. README examples are type-checked there,
  which sits late in `check:merge` (about 27 minutes in on one run), so a failure otherwise costs a whole run.
- Builders never run `check:merge`, narrowed or full (session rule 24). It runs once, at landing, in the mode it
  prints. There is no exception: anything to be proven with a check is proven by a run that was happening anyway, and a
  check never runs twice on one code tree.
- A landing that re-records a visual baseline on the workstation also queues the same views for re-record on the
  laptop profile, or the laptop's nightly fails on them.
- Pictures: do not judge colour or banding from a PNG over 3,932,160 bytes (session rule 23, section 1.16).
- Check scripts run from a current worktree. The main checkout can be 100 or more commits behind `origin/main` and
  holds old check code.
- Notes carry the real time from `date -u`, never an estimated one. A handoff once held invented times.

When the brief asks a peer machine to run a test, it gives the exact commit, the exact commands and the exact lines to
report, and asks for the lines that match the new checks by name. A report filter once hid the lines that decided the
run, so ask for the raw matching lines, not a summary.

#### 1.4.2 The rules file every brief carries

`handoffs/session-rules.txt` has 25 numbered rules. The ones that belong in this part, quoted:

```text
1. Quiet: don't send "waiting" or progress messages. Run long checks in the background and message the coordinator only when something lands, when you're blocked, or when you need a decision. One short paragraph.
2. One landing at a time: wrap your final `git pull --rebase` + post-rebase checks + push in the landing lock, so no one rebases onto a moving main:
   Put the rebase+checks+push steps in a script file inside your worktree (e.g. .tmp/land.sh), then run:
   MARGO_GPU_LOCK=<repo>/test-results/land.lock node scripts/gpu-lock.mjs run --owner=<you> -- bash .tmp/land.sh
   with the script itself setting MARGO_GPU_LOCK=<repo>/test-results/gpu.lock before its GPU steps.
   (Do not pass a quoted bash -c string: on Windows the lock wrapper runs the command through cmd.exe and splits it.)
   The landing runner runs check:merge once inside the lock, after the rebase, in the mode it prints (rule 24, section 2.6.5). Never hold the lock while waiting for anything else.
3. Fail fast: before you call work ready, run npm run quality, npm run hygiene, the unit tests for what you touched, the root unit tests (node --test tests/*.test.js) and npm run api:check (minutes, not 15). Builders never run check:merge (rule 24).
4. Own files only: keep scripts and logs inside your own worktree (e.g. .tmp/ there), never in a shared scratchpad or /tmp; other agents may overwrite them.
5. Timeouts: every long command you run (tests, checks, benchmarks, waits) gets a hard time limit (e.g. timeout 1800 cmd). Never hold the GPU or landing lock without one; if something hangs, kill the process tree, release the lock and report it.
```
(`handoffs/session-rules.txt`, rules 1 to 5; the two absolute lock paths replaced by `<repo>`; rules 2 and 3 as reworded for batch landings, 2026-10-31.)

Rules 6 to 12 (never land dirty, failures are yours, public-release bug rule, mandatory regression test, rerun of one
step, never skip work for speed, accepted differences) are quoted where they apply: sections 1.12, 1.13 and 2.11.
Rules 13 to 15 are website design rules and are out of scope here. Rules 16 to 25 are the per-job model and effort
tiers (1.2), never stopping or sitting idle (1.1), the coordinator model and the planner (1.2), narrowing (2.10.2),
core as the last resort, the shared git config, pictures, builders never running `check:merge` and the result cache (sections 1.16, 2.6.5
and 2.10.4).

Rule 2 once said to run the full `check:merge` before taking the lock. The landing scripts have run it inside the lock,
after the rebase, since 2026-10-29, and since 2026-10-31 the landing runner owns that run (rule 24). The quoted text
above is the current wording.

#### 1.4.3 Brief template

Generic reference version, not from the repo:

```markdown
Task: <one line>. Model <model>, effort <effort>.
Goal and done: <measurable result>; done = landed on main (commit on origin/main) with regression tests.
Read first: AGENTS.md; <plan file from the planner, if one was run (rule 1.2)>; <handoff or design file>; bug-queue row <n>. Known: <facts>. Ruled out: <list>.
Rules: <paste session-rules.txt>.
Setup: worktree <path> (or create one from origin/main); node scripts/worktree-node-modules.mjs; git lfs checkout.
Shared resources: GPU shared slot for <tests> (<minutes>); landing lock once (about 40 min).
Landing: you do not run check:merge. End READY: the work committed on your branch, rebased on current origin/main, quick
  checks (1.4.1) passed. The landing runner puts it in a batch (playbook 2.6.5). A lone landing, when the coordinator
  asks for one, uses the pattern in playbook 2.6, started in the BACKGROUND:
  MARGO_GPU_LOCK=<repo>/test-results/land.lock node scripts/gpu-lock.mjs run --max=170 --wait-max=240 --owner=<task> -- bash <script>
Hand off at 300,000 tokens (or about 150 tool calls, or at a compaction): write <repo>/handoffs/<task>-handoff.md
  from the template and end with one line: HANDOFF at <tokens>: <path>.
Report once at the end, one paragraph: commits, READY <hash> or BLOCKED <why> (or what landed, or the script, log and lock holder still running), bugs found.
```

### 1.5 Quiet sessions

From the global agent rules file, "Save tokens (always)":

```text
- **Quiet sessions.** No "waiting" or progress messages. Run long commands in the background and report only when
  something lands, something is blocked, or a decision is needed: one short paragraph.
- **No status chatter.** Don't wake up just to say "still running"; ignore interim notifications; coordinators answer
  automatic notices in one line or less and never poll. Avoid chains where a session relays its helpers' updates;
  helpers report once, at the end.
- **No duplicate work.** Never give the same task to two sessions; cancel the old one before reassigning. Don't
  re-plan or re-survey what is already known; pass the known facts in the brief.
```

In practice:

| Situation | Do | Do not |
| --- | --- | --- |
| A long check is running | Run it in the background with a hard timeout; wait for the completion notice. | Sleep loops, "still running" messages, reading partial logs every minute. |
| A helper's interim notice arrives at the coordinator | Answer in one line or not at all. | Relay it to the maintainer. |
| Helper finishes | One short paragraph: what landed (hash on `origin/main`), what did not and why, bugs found. | A recap of every step. |
| Holder asks for status | Measured numbers, answer first. | Predicted results of agents that have not reported. |
| A message arrives from a peer session (for example over Remote Control) | Acknowledge it in one line and give the coordinator's session name so replies arrive. This is the one exception to staying quiet. | Leave a peer message unanswered. |
| A helper or peer session needs a decision or has no next job | Ask the coordinator. The maintainer talks only to the coordinator. | Stop or wait silently, or ask the maintainer directly. |

Known cost of breaking it: the coordinator handoff records that the old coordinator session "stays open only to relay
helper reports to the new one", because helper ids answer only the session that started them. That relay is the
chain the rule warns about; it was accepted as the price of a coordinator handoff mid-flight (section 1.14).

### 1.6 The context handoff at 300,000 tokens

#### 1.6.1 Rule text

From the global agent rules file, "Context handoff at 300,000 tokens (added 2026-10-29)", quoted in full because
every field matters:

```text
Why: an agent re-reads its whole context on every step, so each step costs more as the context grows, and answers get
worse. Some Margo Engine helpers ran past 800,000 tokens. A fresh agent with a good note is cheaper and clearer.

- **Threshold.** When an agent's context (what it is carrying, about 300,000 tokens) reaches that size it stops starting new work, writes a handoff note, and ends with one line:
  `HANDOFF at <tokens>: <path>`. The coordinator starts a fresh agent (same or cheaper model and effort, whichever
  the job needs) with a short brief that points at the note.
- **Who counts.** Agents often cannot see their own context size. Use the best figure available: the context size if
  the agent can see it, otherwise the usage figure on the helper's notification (it may be a running total, so it can
  read higher than the real context; hand off anyway, an early handoff is cheap). The coordinator tells the helper to
  hand off when that figure passes 300,000. A helper that cannot see any figure hands off after about 150 tool calls,
  or when its context is compacted, whichever comes first.
- **When not to hand off.** Nearly done (under about 15 percent left): finish it. Holding a lock or mid landing:
  finish that step first. A landing script already running in the background keeps running; the note names its
  script, log and lock holder so the successor or the coordinator can finish it.
- **What the note holds** (a file in the project's handoff folder, for example `handoffs/<task>-handoff.md`,
  under 60 lines, plain words): the goal and what done means; what is done (commit hashes, files); what is not done,
  in order; decisions made and why, including the maintainer's rulings that apply; state to know (worktree path, branch,
  scripts, logs, background processes and pids, locks held or waited for, temp files and venvs); traps and things
  already ruled out; the exact commands to resume; what to report when done. Point at files, never paste big outputs.
- **The successor** reads the note first, checks the real state (git status, logs, running processes) instead of
  trusting memory, then carries on. It reports once at the end and names the handoffs it came from.
- **The coordinator** keeps the chain: records each handoff in the resume notes, never runs two agents on one task,
  and stops the old one first. The coordinator session itself hands off at 500,000 tokens (the maintainer,
  2026-10-30): write the resume file and continue in a fresh session. Helpers stay at 300,000.
```

#### 1.6.2 Why a fresh agent is cheaper (and better)

- Cost: each model step reads the whole context again. If the context is C tokens and a job needs S more steps, those
  steps read roughly S x C tokens. At C = 800,000 (seen on this project) a 50-step tail reads about 40 million input
  tokens; the same 50 steps from a fresh agent starting at, say, 30,000 tokens of brief and note read about 1.5 to 5
  million, depending on how fast the new context grows. The figures here are an illustration of the formula, not a
  measurement.
- Quality: a long context holds stale state (old commit hashes, superseded plans, a lock that has since been released)
  next to current state, and the agent's answers get worse. A note forces the state to be written once, in its current
  form.
- Measured on one job (2026-10-29): biomes streaming had four bug hunters, each stopped at about 150 tool calls
  without a fix. A successor started from a good note finished the hunt that the three before it could not. The cost
  of a handoff is the note; the saving is a context free of stale state.
- Compaction: when a context is compacted the agent keeps a summary it did not write and cannot check. The rule treats
  a compaction as a handoff trigger for that reason: write the note while the details are still there, or at the
  latest right after the compaction, from the real state (git, logs, processes), not from the summary.

#### 1.6.3 How usage is read

| Figure | Who sees it | Reliability | Action |
| --- | --- | --- | --- |
| The agent's own context size | the agent, when the host shows it | best | hand off at about 300,000 |
| Usage on a helper's notification | the coordinator | may be a running total, so it can read high | coordinator tells the helper to hand off when it passes 300,000; early is fine |
| About 150 tool calls | the agent, by counting | proxy | hand off |
| A compaction happened | the agent | proxy | hand off |
| The host's usage query | the coordinator | the real context figure, when the host offers one | use it for the coordinator's own 500,000 and when a helper's notification figure is doubtful |

NOT VERIFIED: whether the notification figure on this host is a running total or the live context. The rule assumes it
may be either.

#### 1.6.4 Built-in exceptions

1. Under about 15 percent of the task left: finish.
2. Holding a lock or mid landing: finish that step first.
3. A landing script already running in the background keeps running; the note names its script, log and lock holder.

#### 1.6.5 Coordinator handoff

The coordinator follows the same rule, with a higher threshold: about 500,000 tokens (the maintainer, 2026-10-30), and
also at its first automatic compaction. On the host used here the window compacts at 368,000 of 400,000 tokens
(observed 2026-10-31; NOT VERIFIED on other hosts), so a 500,000 trigger by itself never shows. The real figure comes
from the host's usage query, not from the coordinator's own guess. Over Remote Control the host app refuses to
start a new session (a limit that exists on this host, not a choice); only a message typed in the desktop app can, so the coordinator writes the resume file first and
asks the maintainer to start the successor. The successor is again Opus 5.5 at high effort (1.2).

On 2026-10-29 the coordinator wrote
`handoffs/coordinator-handoff-2026-10-29.md` (46 lines) and added a pointer at the end of `RESUME.md`:

```text
## Coordinator handoff 2026-10-29
Read handoffs/coordinator-handoff-2026-10-29.md first: current helpers, landing lock and queue procedure, the maintainer's decisions of the last day (...), open bugs and the machines. The old coordinator session stays open only to relay helper reports to the new one.
```
(`handoffs/RESUME.md`, last section; one topic elided as `...`.)

### 1.7 The handoff file template (under 60 lines)

#### 1.7.1 Template

Generic reference version, not from the repo. Keep every heading; write "none" rather than deleting one.

```markdown
# <task> handoff, <date> (<who wrote it>, at about <tokens> tokens)

## Goal and done
- Goal: <one or two lines>.
- Done means: <measurable criteria>; landed = commit visible on origin/main.

## Done (with hashes)
- <commit> <one line>; files: <paths>.
- Landed on origin/main: <hash> (checked with git log origin/main at <time>), or "nothing landed".

## Not done, in order
1. <next step>.
2. <step>.

## Decisions and rulings (do not re-ask)
- <maintainer ruling, date>: <text>.
- <own decision>: <what and why>.

## State
- Worktree: <path>; branch: <name>; HEAD <hash>; base origin/main <hash>; uncommitted: <none or list>.
- Scratch branches or stray folders: <none or list, and when to remove them>.
- Scripts and logs: <worktree>/test-results/<script>.sh, log <path>.
- Background processes: pid <n> = <command>, started <time>, hard limit <minutes>.
- Locks: <land.lock or gpu.lock>, holder <holder>, taken <time>, maxMinutes <n>; or "none held"; queued: <ticket>.
- Helpers (coordinator notes only): <id> <model> <what it is doing> <worktree>.
- Temp files and venvs: <paths>.

## Traps and ruled out
- <trap>.
- Ruled out: <hypothesis> (<evidence>).

## Resume commands
    git -C <worktree> fetch -q origin && git -C <worktree> log --oneline -5 origin/main
    node scripts/gpu-lock.mjs status
    <the exact next command>

## Report when done
- One paragraph to the coordinator: <what>; name this handoff and earlier ones in the chain.
```

That is 41 lines with one entry per list; it leaves room under 60 lines for real entries.

#### 1.7.2 Filled example

Built from the real coordinator handoff of 2026-10-29, with identifiers, paths and URLs removed or
replaced by placeholders. Values are the real ones from that file.

```markdown
# Coordinator handoff, 2026-10-29 (old coordinator, about 1 day of work)

## Goal and done
- Goal: keep the helper queue running, land fixes and new areas, keep the dashboard and resume notes current.
- Done means: every queued item landed on origin/main or recorded with its blocker; known-bugs list empty at release.

## Done (with hashes)
- origin/main = eae9edb1 (Jupyter requirements fix), checked about 01:00 local.
- Landed 10-28/29: react fallback 5549b1f2, weather, ragdoll, animator graph, WebGL2 M0 to M5 + M3b, biomes B0 to B6,
  lighting setters, security fixes 42 to 50, bug 25 retry and marker, teardown 30.

## Not done, in order
1. Let the landing queue drain; then bug 41 (Linux colour emoji test) and rerun the 3 heat-stopped Linux packages.
2. After bug 61 lands: the maintainer runs the laptop recheck of react test:browser:extras and check:quickstart.
3. Re-measure the white paper numbers before posting.

## Decisions and rulings (do not re-ask)
- Typeface Source Sans 3 approved (one download, done by the font helper).
- Server limits approved and landed. Home page redesign deferred to the website item.
- 300,000 token handoff rule (maintainer, 2026-10-29).

## State
- Landing lock test-results/land.lock: held by font-site. Never delete a lock by hand.
- Landing = ONE complete script run in the BACKGROUND (pattern: <repo>-wt-nbreq/test-results/land-full.sh).
- <repo>-main: read only clone for apps; only ff pull + npm ci + build:packages by the coordinator; it is behind.
- Helpers (ids answer only the old session, which relays):
  - <id-1> biomes (Opus): B7 streaming+workers, bug 64.
  - <id-2> WebGL2 (Opus): bug 58b first, then 65, 66, M6, M7; worktrees <repo>-wt/webgl2-m6, webgl2-next.
  - <id-3> hardening (Sonnet): bugs 62, 70, 68, 67, 63; worktrees <repo>-wt-hard..hard4.
  - <id-4> bug 61 hunter (Opus): fix found; landing script in background; worktree <repo>-wt-bug61.
  - <id-5> font (Sonnet): its landing holds the lock now.
- Stale: 3 stash entries "aae9 records" (safe to drop, ask the maintainer).

## Traps and ruled out
- Hand-backs arrive before landings finish: never trust "landed" until origin/main shows the commit.
- Run node scripts/worktree-node-modules.mjs after rebasing a worktree.
- Commit work in progress often: the crash zeroed uncommitted files.
- Security warnings on helpers so far were lock or rebase activity: check origin/main and the worktree, not transcripts.

## Resume commands
    git -C <repo>-main fetch && git -C <repo>-main log --oneline -10 origin/main
    node scripts/gpu-lock.mjs status        (and MARGO_GPU_LOCK=<repo>/test-results/land.lock ... status)
    git -C <repo> worktree list

## Report when done
- One line to the maintainer per item complete AND pushed; batch the rest.
```

### 1.8 Ground-truth verification on boot

Every fresh session (helper successor or coordinator) runs this before believing any note, memory or hand-back. The
coordinator handoff's first trap says why: "Subagent hand-backs arrive before landings finish: never trust 'landed'
until origin/main shows the commit."

Procedure:

1. Read the note, then `AGENTS.md`, then the global rules. Do not act yet.
2. Fetch and read main:
   ```bash
   git -C <repo> fetch -q origin
   git -C <repo> log --oneline -15 origin/main
   git -C <repo> merge-base --is-ancestor <claimed-commit> origin/main && echo landed || echo NOT landed
   ```
   A note's commit hash is the commit in the worktree; after a rebase the landed commit has a different hash. Search
   by subject when the hash is not found: `git log --oneline origin/main --grep='<subject words>'`.
3. Check the history guard from `RESUME.md`: `git merge-base --is-ancestor f505157615d6 HEAD` must succeed in any
   checkout you will push from (the history was rewritten once; a checkout from before it must not push).
4. Read the locks (never edit them):
   ```bash
   node scripts/gpu-lock.mjs status
   MARGO_GPU_LOCK=<repo>/test-results/land.lock node scripts/gpu-lock.mjs status
   ```
   `status` prints JSON: the exclusive holder, or `{mode: 'shared', holders, slots}`, plus `waiting` when there are
   queued exclusive requests. Compare `takenAt` and `deadline` with the clock: a holder past its deadline plus 2 minutes
   is reclaimed by the next waiter automatically (section 2.2.6).
5. List worktrees and their state:
   ```bash
   git -C <repo> worktree list
   git -C <worktree> status --short
   git -C <worktree> log --oneline origin/main..HEAD
   ```
6. List running processes that belong to the job (node, bash, msedge, python) and match them to the note's pids:
   `tasklist /fi "imagename eq node.exe"` on Windows; `ps -ef` elsewhere. Never kill by a broad pattern (section
   2.17, the Linux `pkill -f` trap).
7. Read the logs the note names, from the end.
8. Only then decide: continue, finish a landing, or restart from the last good commit.

Confirm a landing by its content, not only by an ancestor hash. A hash a helper names can be a different landing's
commit: the leak scrub was reported landed as a hash that was another landing's records commit, and the scrub had never
reached main. After the ancestor check, look at what the landing was meant to change on `origin/main` (files gone or
changed, `git log origin/main --grep='<subject words>'`) and treat a mismatch as NOT landed.

More traps from 2026-10-31: run check scripts from a current worktree, because the main checkout can be 100 or more
commits behind; write the real `date -u` in every note; and a runner's report can leave list rows unrecorded, so check
the landed hashes against the dashboard's `items.json` (1.11).

Why "never trust the note or memory" is literal here: on 2026-10-29 the main checkout was 91 commits behind
`origin/main`, so a session that read files from the working tree instead of `origin/main` would have documented a
version of `scripts/gpu-lock.mjs`, `scripts/check-merge.mjs` and others that no longer existed.

### 1.9 The RESUME file

Location: `handoffs/RESUME.md`, git-excluded, in the project folder. First lines:

```text
# Resume here

Kept out of git. For any new session: read this file, then continue as the coordinator.
```

The "How to resume" block, quoted:

```text
1. Read `AGENTS.md` (repo rules), then this file, then `handoffs/*.md`.
2. Check `git log origin/main -15` and `git worktree list` to see what landed since this was written.
3. For each running item below whose session is gone, start a fresh session with the handoff file as its brief.
   Put `handoffs/session-rules.txt` in every brief. Use Sonnet for routine work (docs, landings, benchmark
   runs), Opus for design-heavy work.
4. Report to the maintainer briefly. Plain language, short, measured numbers only.
```

What the file holds (sections in the real file): standing rules; dated DECISIONS blocks with the maintainer's rulings;
dated RULES ADDED blocks; SESSION SWITCH and RESTARTED blocks with a table of worktree, job and model; coordinator
handovers; a "Running now" table; "Next in the queue (in order)"; "Where things are" (dashboard, plans,
nightly job); "Restart list after a PC reboot"; the landing queue order; and a pointer to the newest coordinator
handoff.

Lessons from the real file:

- It is append-mostly and grows (154 lines on 2026-10-29) with older blocks that are no longer true ("Last updated:
  2026-10-25" at the top, while blocks from 10-29 sit below). Put the date on every block and keep a pointer to the
  newest handoff at the end, as it does; or rewrite the top summary at each coordinator handoff.
- A restart list after a reboot is worth its own block: which worktrees hold committed work, which commits are ready,
  and what to run first (on 10-27: "first run the adapter probe 5 times ... only start landings when it prints nvidia 5
  of 5").

### 1.10 Session switch: state lives on disk

A session can end without warning: a usage limit is reached, the host crashes, or work moves to another login. The rule
from the global agent rules ("Never lose work across sessions"): keep the state needed to continue on disk in the
project (here `handoffs/RESUME.md` and `handoffs/`), not only in a chat or in a folder that only one login can reach.

What happened on 2026-10-26 (`RESUME.md`, "SESSION SWITCH"): the previous session ran out of usage and its background
helpers stopped. Their work was safe in worktrees (each held commits and/or uncommitted work). The new coordinator
restarted each from a table of worktree, job and model, each told to rebase onto `origin/main`, finish, check, land
through the landing lock and `land-records`, then remove the worktree.

Consequences to design for:

1. Helper ids belong to the session that started them. A new session cannot message them; only the worktree
   and the note survive.
2. Anything in a login-specific folder (a hosted page only one login can open, memory under the user folder) may be
   unreachable after a switch. The dashboard's data files are therefore copied into the project (1.11).
3. Uncommitted work survives a session switch but not a crash (2.16.6). Commit work in progress.

### 1.11 The dashboard and progress records

Pattern: the dashboard is a hosted page that reads two JSON datasets. The source of truth is two files in the project,
`handoffs/items.json` and `handoffs/stats.json`; the page is updated by publishing them.

Real shapes, read 2026-10-29:

```json
{"order":1,"stage":"Landed","item":"Visual parity with three.js","status":"Done","result":"848555bc","detail":"Fog, shadows, post effects, textures, fonts, SVG, OBJ; parity 138 of 161"}
```
(`handoffs/items.json`, first of 82 entries.)

```json
{"metric":"Core + stage size","value":21974,"target":25000,"unit":"bytes gzip","kind":"limit","note":"Measured after the frame-loop lifecycle fix (da915339); ..."}
```
(`handoffs/stats.json`, first entry; note shortened.)

Update procedure (coordinator handoff, "Dashboard"): edit the two files; publish each to the dashboard page (one
file per call); then point the page's `datasets/items` and `datasets/stats` records at the new file, passing the
expected record version so a concurrent edit is refused rather than overwritten. Update after each landing.

The to-do list is the plan (the maintainer, 2026-10-31): `items.json` sets what is built, in its order. All work gets a
row first. The coordinator's own ideas are proposed to the maintainer, not started. Work that is not on the list is
left alone, and built work that is on it is committed. Keep `Running` true: 18 of 24 rows marked Running had no helper
on them when counted.

The list stays short (the maintainer, 2026-10-31): one row per item, with the jobs of an item in a working file that a script
rolls up into the row. The list grew from 108 to 305 rows in one day when items were split into jobs.

Rules that make it trustworthy:

- `result` holds a commit hash only after `origin/main` shows it (1.8).
- `value` holds measured numbers with the commit and date in `note`.
- Keep numbered backups before a rewrite (the folder holds `items.json.bak` to `items.json.bak13`); a malformed upload
  is then cheap to undo.

### 1.12 Bugs: the queue, the regression test rule and the bug-hunt agent

#### 1.12.1 Rules

From the global agent rules file, "Bugs: mandatory regression test, and the right model hunts them":

```text
- **Every bug found gets a regression test, no matter what it is. Mandatory, no exceptions.** The test fails without
  the fix and passes with it. No fix lands without one. A bug that cannot be fixed yet goes in the project's
  known-bugs list with a repro and cause.
- **Bugs are going to be shown publicly (public release), so find and fix them: any bug seen anywhere, related to
  the current task or not, is tracked to its root cause and fixed in the package that owns it.**
- **Don't hand a bug hunt to whichever agent happened to find it.** Judge how hard the bug is first. If the finder is
  a cheap model (Sonnet or Haiku) and the cause is not obvious (GPU or timing, concurrency, maths, unclear responsible package,
  failed once already), start a dedicated bug-hunt agent on a stronger model (Opus, high effort when truly hard) with a
  short brief: repro, what is already ruled out, where to look. Easy, obvious fixes stay with the finder. Switch a
  stuck hunt to a stronger model rather than letting it grind.
```

And `AGENTS.md`, "Bugs: fix the cause, properly":

```text
- Find and fix the root cause in the package that owns it, core included (the freeze blocks features, not bug
  fixes). No band-aids: no try/catch that hides an error, no retry loops, no special cases for one input, no
  loosened tests or tolerances, no skipped tests, no "left as is" notes.
- Every fix ships with a regression test that fails without it. When a whole class of bug slipped through, add a
  check to `check:merge` that catches the class.
- A bug you cannot fix now goes into `docs/known-bugs.md` with a repro and its cause. That list must be empty
  before release.
```

Core is the last resort (the maintainer, 2026-10-31; session rule 21). A change to `@margoengine/core` is made only when
no package can hold it and it fixes a bug or flaw that will cause an engine failure. Look or quality improvements,
options and features go in packages. The report and commit message of a core change say why no package can hold it and
which failure it prevents, and the helper asks the coordinator before writing one. `AGENTS.md` carries the same rule.

Note the one sanctioned retry: rerunning a step once after a GPU driver reset that the Windows event log confirms
(2.15.3). It is a host-fault rule, printed and recorded, never a hidden retry of a failing test.

#### 1.12.2 The bug queue file

`handoffs/bug-queue.md`. Header rule and legend, quoted:

```text
Rule: the known-bugs list must be empty before release. This file tracks every open bug, who owns it and what is next. The coordinator starts the next unowned bug as soon as a helper slot frees, alongside new-area work (new areas keep priority for NEW slots; bugs are never dropped).
```

```text
Legend: RUNNING = a helper is on it now. QUEUED = no helper yet. HW = needs hardware only the maintainer has.
```

Table columns: `# | Bug | Where | State | Next step`. States used in practice: `RUNNING`, `QUEUED`, `PAUSED <date>
(handoff <file>)`, `WAITING ON <n>`, `FIX RUNNING`, `FIXED, NOT LANDED`, `FIXED AND LANDED <hash>`, `DONE`,
`OPEN (cause), fix landed`, `OPEN (mitigated, not fixed)`, `HW`, `NOTE`, `Info`, `DECISION`.

Row naming: a follow-up to row 25 is `25b`, `25c`; a row that merges two is `17/23` or `3/13`. A row is rarely
edited in place: new findings get a new lettered row with the date, so the history of a hunt stays readable (rows 32 to
32f show a crash diagnosis correcting its own timeline twice).

How bugs flow:

1. Anyone finds a bug (helper, nightly, another machine's run, an outside audit). It gets a row with where, the
   evidence and the machine.
2. The coordinator judges difficulty. Obvious: the finder fixes it. Not obvious: a dedicated bug-hunt agent with a
   brief of repro, ruled out, where to look.
3. The row's State moves to RUNNING with the helper named.
4. The hunter writes findings into lettered rows (`CAUSE FOUND`, `HUNT`, `FINDINGS`).
5. The fix lands with its regression test; the row says `FIXED AND LANDED <hash> (records <hash>)` and names the test.
6. Anything the fix did not cover is recorded as `OPEN` in the same row and in `docs/known-bugs.md`.

Known mess to avoid when copying: the real file has duplicate numbers for different bugs (two rows `51`, two `52`, two
`53`, two `61`, two `62`, two `65`, two `66`) and one line where three rows were pasted together. Allocate numbers from
one counter, held by the coordinator.

### 1.13 Never skip work for speed; accepted differences

From the global agent rules file:

```text
## Speed work: never skip work to match speed (added 2026-10-26)

- Never skip, weaken or shrink work just to match another tool's speed. A speed fix does the same work and gives the
  same output, features and correctness. If the other tool is faster because it does less, keep the work, publish the
  number as an accepted difference in work, and add a like-for-like row that shows both costs.
- Never change a benchmark scene so ours does less than it did; if a scene must change, keep the old one beside it.
- Anyone who finds a place where work was skipped for speed reports it.

## Accepted speed differences (added 2026-10-26)

- Being slower than a rival is fine when there is a valid, measured, documented reason: we do more or better work, or the
  rival cuts a corner we should not. Record it as an accepted difference (cause, what we do extra, trade-off, a
  like-for-like row) for the public write-up and release notes. Slowness with no valid reason is still a bug to fix.
```

An accepted-difference record has four fields: the measured cause; what we do that the rival does not; the
trade-off; a like-for-like row showing both costs. Rows without a valid reason stay in the bug queue as losses (for
example bug-queue row 10, "Precise trig is slower than builtins: no measurement recorded").

The same principle applies to process: the bug 25b fix bounded the path tracer's dispatches to at most 2^20 paths each
"same pixels, native4k frame time unchanged", so a host protection did not change output.

### 1.14 Failure modes and what we saw

| What happened | Effect | Rule that came from it |
| --- | --- | --- |
| Helpers ran past 800,000 tokens | each step expensive, answers worse | 300,000 token handoff (1.6) |
| Helpers handed back before their landing had finished; the coordinator reported "landed" | false status to the maintainer | check `origin/main` before any landing claim (1.8) |
| A session ran out of usage; every background helper stopped | work survived only in worktrees | state on disk, session-switch table (1.10) |
| 6 or 7 helpers at once on one GPU and one landing lock | long queues; three landings waiting at once | about 3 per bottleneck; pause procedure (1.3) |
| A helper fixing a bug made a branch and worktree outside the convention (`fix/force-discrete-gpu` in `<repo>-wt/gpu-flag`; `bug38-spec-math-time`) | stray branches against the one-branch rule | the rows say "remove after merge"; cleanup only of merged branches (2.7 step 12) |
| The old coordinator had to relay helper reports to the new one | a relay chain | plan coordinator handoffs at a quiet moment; accept the relay only for helpers already running |
| Older handoffs taught `bash -c "..."` through the lock wrapper (`handoffs/handoff-gpu-tests.md`) | on Windows the wrapper ran it through cmd.exe and split it | script file inside the worktree, `bash <script>` (rule 2) |
| The bug queue reused numbers | ambiguous references | one counter, coordinator owned (1.12.2) |
| A cheap finder kept working a GPU bug | slow, failed rounds | judge difficulty first; dedicated Opus hunter (1.12.1) |
| A docs-only change was pushed to main outside the landing lock | the lock holder's push was rejected and its landing ran again | every push to main through the lock (2.4 rule 6) |
| Helpers were started with a model but no effort | effort inherited a default instead of matching the job | set both at every start (1.2); every brief states them (1.4.1) |

### 1.15 How to replicate system 1 from scratch

Build in this order:

1. A global rules file for every session (the global rules quoted in 1.2 to 1.13) and a repo rules file
   (`AGENTS.md`) with the landing procedure.
2. A git-excluded folder in the project (here `handoffs/`) holding `RESUME.md`, `session-rules.txt` and
   `bug-queue.md`. Add it to `.git/info/exclude` (or `.gitignore`).
3. `session-rules.txt` with the numbered rules from 1.4.2 and 2.11, pasted into every brief.
4. The brief template (1.4.3) and the handoff template (1.7.1) as files in `handoffs/`.
5. One worktree per agent, made from `origin/main` (2.7), and the lock script (system 2) before the second agent
   starts.
6. The boot checklist (1.8) at the top of `RESUME.md`.
7. Dashboard data files (`items.json`, `stats.json`) in the project, with backups, published to whatever viewer you use.
8. A bug queue with a legend and one number counter; a known-bugs document in the repo for anything not fixed.

Generic reference version, not from the repo: a boot script a successor runs first.

```bash
#!/bin/bash
# boot-check.sh <repo> [claimed-commit...]: print the real state before trusting any note.
set -u
R="$1"; shift
git -C "$R" fetch -q origin || echo "FETCH FAILED"
echo "== origin/main"; git -C "$R" log --oneline -10 origin/main
for c in "$@"; do
  if git -C "$R" merge-base --is-ancestor "$c" origin/main 2>/dev/null; then echo "landed: $c"; else echo "NOT on origin/main: $c"; fi
done
echo "== locks"
node "$R/scripts/gpu-lock.mjs" status
MARGO_GPU_LOCK="$R/test-results/land.lock" node "$R/scripts/gpu-lock.mjs" status
echo "== worktrees"; git -C "$R" worktree list
echo "== node and browser processes"
if command -v tasklist >/dev/null; then tasklist | grep -iE '^(node|bash|msedge|python)' ; else ps -eo pid,etime,cmd | grep -E 'node|msedge|chrom|python' | grep -v grep; fi
```

### 1.16 Standing rulings that shape the queue

Rulings from the maintainer that every brief inherits (session rules 21 to 24 and the rulings of 2026-10-31):

1. Every new branch is cut from current `main`, built work lands, and no branch is held back. A job that needs an
   unlanded branch waits for it to land, or is written so it does not need it. Trap seen: three builders cut from
   unlanded branches and had to be stopped or re-cut. Only pairs already built on each other land as one landing with
   one check.
2. Demo work stops until the engine is done. Stopping demo work never means stopping a running service: a running
   server is stopped only on the maintainer's explicit word.
3. The to-do list sets what is built (1.11).
4. Core is the last resort (1.12.1).
5. Shared git config (session rule 22). Every worktree shares one `.git/config`, and on Windows a git command that reads
   it while another process replaces it fails with status 128 ("Permission denied" on `.git/config`). Never write
   `git config` from a worktree, add worktrees with `--no-track`, and avoid `git push -u` and `git branch -m` while
   checks run. A check that names `.git/config` in a failure is reported to the coordinator, not retried silently.
6. Pictures (session rule 23). The tool that shows a picture to an agent re-encodes any file over 3,932,160 bytes with a
   reduced palette, which shows false bands and colour shifts. Judge colour or banding from numbers or from
   `scripts/review-png.mjs` (a lossless rewrite that proves the pixels equal), never from a large PNG.
7. Builders never run `check:merge` (session rule 24); landings are batched (2.6.5). In plain words: anything to be proven
   with a check is proven by a run that was happening anyway, and a check never runs twice on one code tree.

---

## 2. Process integrity, lock queues and crash protections

### 2.1 Overview

| Lock | Folder | Mode | Default hold limit | Used for |
| --- | --- | --- | --- | --- |
| GPU lock | `<repo>/test-results/gpu.lock` (in the MAIN checkout, shared by every worktree) | shared, up to 3 holders (`MARGO_GPU_SLOTS`) | 20 min | GPU correctness tests |
| GPU lock | same | exclusive | 60 min | anything that measures speed (benchmarks), the nightly run |
| Landing lock | `<repo>/test-results/land.lock` | always exclusive | 30 min (landings pass `--max=170`) | rebase, records, checks and push |

One script, `scripts/gpu-lock.mjs`, implements both. `MARGO_GPU_LOCK=<folder>` chooses the lock; any lock whose folder
name is not `gpu.lock` is exclusive.

### 2.2 The lock script

#### 2.2.1 Header comment (the design in the author's words)

```js
// GPU access across agents and worktrees, as a reader/writer lock in test-results/gpu.lock of the MAIN checkout.
//   shared     correctness tests: up to MARGO_GPU_SLOTS (default 3) holders at once. The default for `gpu.lock`.
//   exclusive  anything that measures speed: `--exclusive` / acquire({mode: 'exclusive'}), and automatically every
//              `bench*` npm script and every script under bench/, benchmarks/ or *-benchmarks/ (or named bench*.mjs).
//              It waits until no holder is left and, while it waits, new shared holders queue behind it, so it cannot
//              starve. Every lock other than `gpu.lock` (the landing lock, say) is exclusive.
// Nothing hangs while holding or waiting:
//   hold limit  every holder has a maximum hold time (default 20 min shared, 60 min exclusive, 30 min for any other lock
//               such as the landing lock; `--max=<min>` / acquire({max})). `run` kills the command's whole process tree
//               (Windows: taskkill /T /F) when it is exceeded, frees the lock and exits 124 with
//               "TIMEOUT after N min: <command>". A holder that called acquire() itself is ended the same way by its
//               heartbeat process, a few seconds after the limit.
//   heartbeat   a heartbeat process refreshes each holder's entry every 15 s while the holder lives; a waiter reclaims an
//               entry whose process is dead, or that nobody has refreshed for 2 min (MARGO_GPU_LEASE_MIN), live or not.
//   wait limit  a request waits at most 60 min (`--wait-max=<min>` / acquire({waitMax})), then fails naming each holder,
//               its holder and the command it runs.
// Layout of the lock folder: shared/<token>.json per shared holder, exclusive.json for the exclusive holder and mutex/
// (a mkdir held for microseconds around every state change). Queued exclusive requests are <ts>-<token>.json in the
// folder beside it, gpu.lock-waiting/, which an old client's release (it removes the whole lock folder) leaves alone. A holder, waiter or legacy owner.json whose process is gone is stale and removed. Release removes
// only our own entry: never delete an entry you don't own.
```
(`scripts/gpu-lock.mjs` lines 1 to 20 at `67ca53a5`; the remainder of the header covers compatibility with the older
one-holder lock, the CLI and the environment variables, summarised in 2.2.9.)

#### 2.2.2 Folder layout

```
test-results/
  gpu.lock/
    mutex/                 mkdir-based mutex held for microseconds around each state change
    shared/<token>.json    one per shared holder
    exclusive.json         the exclusive holder
    holder.json             a holder from the older one-holder client (compatibility)
  gpu.lock-waiting/
    <15-digit ms>-<token>.json   queued exclusive requests, oldest first by file name
  land.lock/
    exclusive.json
  land.lock-waiting/
    <15-digit ms>-<token>.json
  gpu-lock-timeouts.log    one line per holder ended by its heartbeat past its hold limit
```

#### 2.2.3 Entry fields

The entry is written by `acquire()`:

```js
  const token = `${owner.replace(/[^\w.-]/g, '_')}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    entry = (beats = true) => {
      const now = Date.now();
      return JSON.stringify({
        owner,
        pid: process.pid,
        token,
        mode,
        command,
        takenAt: new Date(now).toISOString(),
        maxMinutes,
        deadline: now + maxMinutes * MIN,
        beats,
      });
    };
```
(`scripts/gpu-lock.mjs`, `acquire()`, at `67ca53a5`.)

| Field | Meaning |
| --- | --- |
| `owner` | the `--owner=` given; required ("gpu-lock: pass an owner (agent id)") |
| `pid` | the process that called `acquire()` (for `run`, the lock wrapper itself) |
| `token` | holder, pid, time and a random suffix; release removes the entry only if the token matches |
| `mode` | `shared` or `exclusive` |
| `command` | what the holder runs (up to 300 characters), shown to waiters |
| `takenAt` | ISO time the entry was written (for a waiter: when it queued) |
| `maxMinutes` | the hold limit |
| `deadline` | epoch ms when the hold limit ends |
| `beats` | `true` for a holder (its file's mtime is refreshed every 15 s); `false` for a queued waiter |

The heartbeat is the file's modification time, not a field: the beat process calls `utimesSync(file, now, now)`.

#### 2.2.4 Mutex

```js
// Runs `fn` (synchronous, short) while holding the lock's mutex. A mutex older than 10 s belongs to a crashed process.
// `fn` gets {fresh}: true when the folder was made by someone else less than freshMs() ago (an old client mid-acquire
// when nothing is in it; see Compatibility). A folder `fn` leaves empty is removed again unless it is fresh: an empty
// folder would make old clients wait forever.
```
(`scripts/gpu-lock.mjs`, comment above `locked()`, at `67ca53a5`.)

`mkdir` is atomic on every file system used here, so `mkdirSync(mutexDir)` either creates the mutex or throws
`EEXIST`. A mutex older than 10 s is removed as left over by a crash.

#### 2.2.5 How a request is granted or queued

```js
      if (mode === 'shared') {
        if (!state.exclusive && !state.waiting.length && state.shared.length < slots()) {
          mkdirSync(sharedDir, { recursive: true });
          const file = join(sharedDir, `${token}.json`);
          writeFileSync(file, entry());
          return { file };
        }
        return { held: [state.exclusive, ...state.shared, ...state.waiting].filter(Boolean) };
      }
      if (!state.exclusive && !state.shared.length && first) {
        if (queued) rmSync(join(waitingDir, ticket), { force: true });
        writeFileSync(exclusiveFile, entry());
        return { file: exclusiveFile };
      }
      if (!queued) {
        mkdirSync(waitingDir, { recursive: true });
        writeFileSync(join(waitingDir, ticket), entry(false));
        queued = true;
      }
```
(`scripts/gpu-lock.mjs`, inside the `acquire()` loop, at `67ca53a5`.)

Read it as:

1. Shared request: granted only when there is no exclusive holder, no exclusive request queued, and a slot is free.
   Otherwise it polls (every 1 s) without a ticket.
2. Exclusive request: granted only when nobody holds anything and it is first in the queue.
3. Otherwise an exclusive request writes one ticket `<15-digit ms>-<token>.json` into `<lock>-waiting/` and polls.
   File names sort by time, so tickets are served in arrival order (test: "exclusive requests are served in the order
   they arrived").
4. Because a queued exclusive ticket blocks new shared grants, a benchmark cannot be starved by a stream of
   correctness tests (test: "an exclusive request cannot starve: new shared holders queue behind it, though slots are
   free").

Why this prevents races: every read-modify-write of the lock state happens inside the mutex, so two agents can never
both see "free" and both write `exclusive.json`. On the landing lock this serialises "fetch, rebase, check, push" so
no agent rebases onto a main that another agent is about to move.

#### 2.2.6 Stale entries and reclaim

```js
/** Why a holder's entry is dead, or null when it is alive: its process is gone, its heartbeat stopped, or it overran. */
function deadReason(entry, file) {
  if (entry.pid && !alive(entry.pid)) return `pid ${entry.pid} gone`;
  if (entry.beats) {
    let beat = 0;
    try {
      beat = statSync(file).mtimeMs;
    } catch {}
    if (Date.now() - beat > leaseMs()) return `no heartbeat for ${Math.round((Date.now() - beat) / 1000)} s`;
    // The limit is enforced by the holder's wrapper and heartbeat process; this covers both having died.
    if (entry.deadline && Date.now() > entry.deadline + 2 * MIN) return 'past its hold limit';
  }
  return null;
}
```
(`scripts/gpu-lock.mjs` at `67ca53a5`.)

Every waiter calls `snapshot()` inside the mutex on each poll; `snapshot()` removes dead entries and logs
`gpu-lock: removing stale <kind> entry of <holder> (<reason>)` or `gpu-lock: taking over stale lock from <holder>
(<reason>)`. So a stale lock is reclaimed by the next waiter within one poll after:

- the holder's process is gone (any entry, holder or waiter), or
- no heartbeat for the lease (default 2 min, `MARGO_GPU_LEASE_MIN`), live process or not (holders only), or
- the deadline passed by more than 2 minutes (holders only).

Waiters' tickets have `beats: false`, so they are reclaimed only when their process is gone.

#### 2.2.7 The heartbeat process and the hold limit

```js
  else if (verb === 'beat') {
    // The heartbeat process: node gpu-lock.mjs beat <entry file> <token> <holder pid> <deadline ms>
    const [file, token, parent, deadline] = rest;
    const grace = Number(process.env.MARGO_GPU_GRACE_MS ?? 15_000);
    setInterval(() => {
      const entry = read(file);
      if (!entry || entry.token !== token) process.exit(0); // released
      if (!alive(Number(parent))) {
        rmSync(file, { force: true });
        process.exit(0);
      }
      if (Date.now() > Number(deadline) + grace) {
        killTree(Number(parent));
        rmSync(file, { force: true });
        try {
          appendFileSync(
            join(dirname(lockDir), 'gpu-lock-timeouts.log'),
            `${new Date().toISOString()} TIMEOUT after ${entry.maxMinutes} min: ${entry.owner}: ${entry.command}\n`,
          );
        } catch {}
        process.exit(0);
      }
      try {
        const now = new Date();
        utimesSync(file, now, now);
      } catch {}
    }, beatMs());
```
(`scripts/gpu-lock.mjs`, CLI `beat` verb, at `67ca53a5`.)

The beat is a separate detached process because "a holder busy in a long synchronous call (spawnSync) cannot refresh
anything itself" (comment above `startHeartbeat`). It exits on release, deletes the entry if the holder died, and past
the deadline plus 15 s kills the holder's whole tree, deletes the entry and appends to `gpu-lock-timeouts.log`.

`run` also enforces the limit itself: `spawnLimited` sets a timer for `maxMinutes`, kills the tree at the limit, frees
the lock and exits 124 with `TIMEOUT after N min: <command>`.

```js
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
}
```
(`scripts/gpu-lock.mjs` at `67ca53a5`.) On Windows a plain kill "stops only the shell or launcher and leaves browsers,
servers and kernels running", hence `taskkill /T /F`; elsewhere the child is spawned `detached` so it leads a process
group that `-pid` kills.

#### 2.2.8 Wait limit

Past `--wait-max` (default 60 min, `MARGO_GPU_WAIT_MAX_MIN`) the request removes its own ticket and fails with:

```text
gpu-lock: gave up after <n> min waiting for the GPU (<mode> request by <holder>); it is held by <holder (mode, since <takenAt>, running: <command>)>; ... Wait longer with --wait-max=<min>, or look at the holder: node scripts/gpu-lock.mjs status
```
(Template of the message built in `giveUp()`, `scripts/gpu-lock.mjs` at `67ca53a5`.) `run` exits 2 in that case. While
waiting it prints `gpu-lock: <mode> request waiting for <holders>` at once and then every 10 minutes.

#### 2.2.9 CLI, flags and environment

```text
node scripts/gpu-lock.mjs run [--exclusive] [--max=<min>] [--wait-max=<min>] --owner=<agent id> -- <command...>
node scripts/gpu-lock.mjs status
```

| Flag or variable | Effect |
| --- | --- |
| `--owner=<id>` | required; names the holder in every message |
| `--exclusive` | exclusive on `gpu.lock` (other locks are always exclusive) |
| `--max=<min>` | hold limit; must be positive |
| `--wait-max=<min>` | wait limit; must be positive |
| `MARGO_GPU_LOCK=<folder>` | which lock (default `<main checkout>/test-results/gpu.lock`) |
| `MARGO_GPU_SLOTS=<n>` | shared slots, default 3; a non-integer or less than 1 throws `RangeError` |
| `MARGO_GPU_EXCLUSIVE=1` | raises every request to exclusive; never lowers one |
| `MARGO_GPU_LEASE_MIN` | heartbeat lease, default 2 min |
| `MARGO_GPU_WAIT_MAX_MIN` | default wait limit, 60 min |
| `MARGO_GPU_LOCK_NESTED`, `MARGO_GPU_LOCK_NESTED_MODE` | set by `run` for its child: a nested `acquire()` of the same lock is a no-op; an exclusive request nested in a shared hold throws and says to start the outer command with `--exclusive` |

Automatic exclusive mode for benchmarks:

```js
const BENCH_SCRIPT = /(^|[\\/])(bench|[\w-]*benchmarks)[\\/].*\.[cm]?[jt]s$|(^|[\\/])bench[\w.-]*\.[cm]?[jt]s$/i;
```
plus any npm lifecycle event starting with `bench`.

Nesting the landing lock and the GPU lock: under the landing lock, `run` points the child's `MARGO_GPU_LOCK` at the
`gpu.lock` beside it, so GPU tests inside a landing still take a GPU slot:

```js
        // MARGO_GPU_LOCK chose the lock this run holds. Under another lock (the landing lock) the command's own GPU
        // work must take the GPU lock beside it, not this one again: inherited, it made every GPU test inside the
        // landing lock skip the GPU lock and fail its exclusive requests as if nested in a shared slot.
        ...(isGpuLock ? {} : { MARGO_GPU_LOCK: join(dirname(lockDir), 'gpu.lock') }),
```
(`scripts/gpu-lock.mjs`, `run` verb, at `67ca53a5`.)

Windows command lines: on Windows `run` builds a cmd.exe command line with every argument quoted and every cmd operator
outside quotes escaped with a caret (`quoteWindows`, `windowsCommandLine`), because "cmd reads the line first and
toggles its own quoting at every \", the escaped \\\" included". The practical rule for users stays simpler: pass
`bash <script>`, never `bash -c "<string>"`.

#### 2.2.10 Finding the main checkout

```js
const main = resolve(import.meta.dirname, '..').replace(/[\\/]\.[\w-]+[\\/]worktrees[\\/][^\\/]+$/, '');
```
(`scripts/gpu-lock.mjs` at `67ca53a5`.)

Note: this strips a `.claude/worktrees/<name>` suffix only. Bug-queue row 62 (2026-10-29) records the
consequence and a fix: "a worktree made elsewhere (margoengine-wt/...) got a lock folder of its own: its GPU tests took
no shared slot and its landings took no turn. Now read from the worktree .git file. Regression: tests/gpu-lock.test.js."
That fix is in a WebGL2 branch and is NOT on `origin/main` at `67ca53a5`. Until it lands, worktrees outside
`.claude/worktrees/` must set `MARGO_GPU_LOCK` explicitly for both locks, which the landing scripts in 2.6 do. A new
project should find the main checkout from `git rev-parse --git-common-dir` from day one.

#### 2.2.11 Tests

At `67ca53a5`: `tests/gpu-lock.test.js` (14 tests), `tests/gpu-lock-limits.test.js` (5), `tests/gpu-lock-compat.test.js`
(9), fixture `tests/fixtures/gpu-lock-v1.mjs` (the old one-holder client). Titles that define the contract:

- "shared holders share: up to the slot count at once, the next waits for a free slot"
- "an exclusive request cannot starve: new shared holders queue behind it, though slots are free"
- "exclusive requests are served in the order they arrived"
- "holders and waiters whose process is gone are removed; live ones stay"
- "a release removes only our own entry"
- "run: a command past --max is killed with its children, the lock is freed, the error says so"
- "a holder that called acquire() itself and hangs in a synchronous loop is ended by its heartbeat process"
- "a heartbeat keeps a holder alive, and a stale heartbeat is reclaimed even though the process lives"
- "a waiter gives up after --wait-max and names the holder and its command"
- "run under the landing lock points the command at the GPU lock beside it, which it then really takes"
- "a quoted multi-word argument reaches the command intact"
- "every lock other than gpu.lock (the landing lock) is exclusive with a 30 min hold limit"

### 2.3 Real lock files

Snapshot of `test-results/` in the main checkout, 2026-10-29 about 00:57 local:

```json
{"owner":"biomes-g1b7","pid":48724,"token":"biomes-g1b7-48724-1793247167748-v501wd","mode":"exclusive","command":"sh .tmp/land2.sh 3d394de9","takenAt":"2026-10-29T04:55:04.716Z","maxMinutes":170,"deadline":1793259904716,"beats":true}
```
(`test-results/land.lock/exclusive.json`.)

```json
{"owner":"hard-g1","pid":50136,"token":"hard-g1-50136-1793247194722-3hjyfb","mode":"exclusive","command":"bash test-results/land-g1.sh","takenAt":"2026-10-29T04:13:14.729Z","maxMinutes":170,"deadline":1793257394729,"beats":false}
```
(`test-results/land.lock-waiting/001793247194722-hard-g1-50136-1793247194722-3hjyfb.json`; two more tickets, for
`hard-g3` and `bug61-msaa-clear`, were queued behind it.)

```json
{"owner":"no-webgpu-browser","pid":4436,"token":"no-webgpu-browser-4436-1793249800061-c9ninv","mode":"shared","command":"<repo>-wt/webgl2-m6/scripts/test-no-webgpu-browser.mjs","takenAt":"2026-10-29T04:56:40.062Z","maxMinutes":20,"deadline":1793251000062,"beats":true}
```
(`test-results/gpu.lock/shared/no-webgpu-browser-4436-....json`; path replaced.)

What the snapshot shows: the landing lock had one holder and three queued for over 40 minutes; the waiting tickets'
`takenAt` is the time they queued; their `deadline` was computed at queue time and is replaced when the real entry is
written on grant.

### 2.4 Lock rules

1. Never delete a lock file or folder by hand. Release happens when the holder's command ends; a dead or overrunning
   holder is reclaimed by the next waiter (2.2.6). Deleting by hand can let two landings run at once.
2. Never hold a lock while waiting for something else (session rule 2). In particular, never take the landing lock and
   then wait for a GPU slot for minutes in the foreground of an agent; the background script does that, bounded.
3. Every hold has a limit (`--max`) and every wait has a limit (`--wait-max`).
4. Build-only steps do not take the GPU lock; GPU-using scripts take it around the browser only (`build:site` and
   `test:basic-scene` "take the GPU lock themselves, only around the browser; do not wrap them in it", `AGENTS.md`).
5. Inspect with `status`; to see a holder's progress, read its log, not its lock entry.
6. Every push to main goes through the landing lock, docs-only pushes included. A push made outside it moves main under
   the holder, whose own push is then rejected as non-fast-forward and has to queue and run again (2026-10-29: a
   docs-only playbook push outside the lock cost the leak-scrub landing a full rerun, about 40 minutes of lock time).

7. Run at most three `check:merge` pipelines at once on the video card (the maintainer, 2026-10-31), never more. About eight
   at once on 2026-10-30 exhausted the Windows process table (bash fork: "Resource temporarily unavailable"), killed a
   landing mid check and forced a reboot. Pushes stay one at a time under the landing lock.
8. Logs: every run of a pipeline or landing writes a new dated log, or appends. A restart never overwrites the log of the
   run that failed (the cause of one failed first verify was lost this way, 2026-10-30).

### 2.5 Generic reference lock (for a new project)

Generic reference version, not from the repo. About 90 lines: exclusive lock with a queue, heartbeat by mtime, stale
reclaim, hold and wait limits, tree kill. It leaves out shared slots, nesting and the old-client compatibility; add
shared slots only if a resource really supports several holders.

```js
// lock.mjs: node lock.mjs run --holder=<id> [--max=<min>] [--wait-max=<min>] -- <program> [args...]
//           node lock.mjs status
// Env: LOCK_DIR=<folder> (default ./test-results/run.lock). Exit 124 on hold timeout, 2 on wait timeout.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const dir = resolve(process.env.LOCK_DIR ?? 'test-results/run.lock');
const queue = `${dir}-waiting`, holder = join(dir, 'holder.json'), mutex = join(dir, 'mutex');
const LEASE_MS = 2 * 60_000, BEAT_MS = 15_000, MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const killTree = (pid) => process.platform === 'win32'
  ? spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  : (() => { try { process.kill(-pid, 'SIGKILL'); } catch {} })();

function dead(entry, file) {
  if (!alive(entry.pid)) return 'process gone';
  if (entry.beats && Date.now() - statSync(file).mtimeMs > LEASE_MS) return 'no heartbeat';
  if (entry.beats && Date.now() > entry.deadline + 2 * MIN) return 'past its limit';
  return null;
}
async function withMutex(fn) {
  mkdirSync(dir, { recursive: true });
  for (;;) {
    try { mkdirSync(mutex); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(mutex).mtimeMs > 10_000) rmSync(mutex, { recursive: true, force: true }); } catch {}
      await sleep(10);
    }
  }
  try { return fn(); } finally { rmSync(mutex, { recursive: true, force: true }); }
}
function clean() {
  const h = read(holder);
  if (h && dead(h, holder)) { console.error(`lock: reclaiming from ${h.holder} (${dead(h, holder)})`); rmSync(holder, { force: true }); }
  mkdirSync(queue, { recursive: true });
  for (const name of readdirSync(queue).sort()) {
    const t = read(join(queue, name));
    if (!t || !alive(t.pid)) rmSync(join(queue, name), { force: true });
  }
  return readdirSync(queue).sort();
}
async function acquire({ holder, max, waitMax, command }) {
  const token = `${holder}-${process.pid}-${Date.now()}`, ticket = `${String(Date.now()).padStart(15, '0')}-${token}.json`;
  const entry = (beats) => JSON.stringify({ holder, pid: process.pid, token, command, takenAt: new Date().toISOString(),
    maxMinutes: max, deadline: Date.now() + max * MIN, beats });
  const start = Date.now();
  await withMutex(() => { mkdirSync(queue, { recursive: true }); writeFileSync(join(queue, ticket), entry(false)); });
  for (;;) {
    const got = await withMutex(() => {
      const waiting = clean();
      if (!read(holder) && waiting[0] === ticket) { rmSync(join(queue, ticket)); writeFileSync(holder, entry(true)); return true; }
      return false;
    });
    if (got) return token;
    if (Date.now() - start > waitMax * MIN) {
      rmSync(join(queue, ticket), { force: true });
      throw new Error(`lock: gave up after ${waitMax} min; held by ${JSON.stringify(read(holder))}`);
    }
    await sleep(1000);
  }
}
const [verb, ...rest] = process.argv.slice(2);
if (verb === 'status') console.log(JSON.stringify({ holder: read(holder), waiting: readdirSync(queue, { withFileTypes: false }).length }));
else if (verb === 'run') {
  const split = rest.indexOf('--'), flags = rest.slice(0, split), cmd = rest.slice(split + 1);
  const flag = (n, d) => Number(flags.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d);
  const holder = flags.find((a) => a.startsWith('--holder='))?.slice(8);
  if (!holder || split < 0 || !cmd.length) throw new Error('usage: lock.mjs run --holder=<id> [--max=] [--wait-max=] -- <cmd...>');
  const max = flag('max', 30), waitMax = flag('wait-max', 60);
  let token;
  try { token = await acquire({ holder, max, waitMax, command: cmd.join(' ') }); } catch (e) { console.error(e.message); process.exit(2); }
  const beat = setInterval(() => { try { utimesSync(holder, new Date(), new Date()); } catch {} }, BEAT_MS);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', detached: process.platform !== 'win32', shell: false });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, max * MIN);
  const release = () => { clearInterval(beat); if (read(holder)?.token === token) rmSync(holder, { force: true }); };
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { killTree(child.pid); release(); process.exit(130); });
  child.on('close', (code) => {
    clearTimeout(timer); release();
    if (timedOut) console.error(`TIMEOUT after ${max} min: ${cmd.join(' ')}`);
    process.exit(timedOut ? 124 : (code ?? 1));
  });
}
```

Limitations of this reference version, stated plainly: the heartbeat runs in the same process as the wrapper (fine for
`run`, which only waits on the child; the real script uses a separate process so in-process `acquire()` callers that
block in `spawnSync` still beat); on Windows `.cmd` programs such as `npm` need `shell: true` and careful quoting, which
is why the real script has `windowsCommandLine()`; pass `bash <script>` to avoid both.

### 2.6 The background landing script

#### 2.6.1 Why a script, and why in the background

- A script file keeps the whole landing (rebase, checks, records, push) inside ONE lock hold, so main cannot move
  between the rebase and the push.
- On Windows the lock wrapper goes through cmd.exe; a quoted `bash -c "..."` is split (session rule 2), so the steps
  live in a file and the wrapper runs `bash <file>`.
- In the background, because "Helpers hand back BEFORE the lock queue drains, so landings must be background scripts"
  (coordinator handoff). A helper that waits in the foreground for a queue of up to several hours burns tokens on
  every poll and may be killed by its own session limits, or by a session switch, while it holds or waits for the
  lock. The background process keeps its place in the queue regardless of the agent.
- The script's own log is the record a successor or the coordinator reads to finish the job.

#### 2.6.2 The newest script (2026-10-29)

Real script, `<repo>-wt-bug61/test-results/land-bug61.sh`, read 2026-10-29 (the worktree path replaced by a
placeholder; `test-results/` is git-ignored, so the script is never committed):

```bash
#!/bin/bash
# Complete landing for bug 61 (partial-view clears from the shader), run inside the land lock.
set -e
cd <repo>-wt-bug61
E=<noreply-id>+<github-user>@users.noreply.github.com
export GIT_AUTHOR_NAME="<author name>" GIT_AUTHOR_EMAIL=$E GIT_COMMITTER_NAME="<author name>" GIT_COMMITTER_EMAIL=$E
export MARGO_GPU_LOCK=<repo>/test-results/gpu.lock
git fetch -q origin && git rebase origin/main
node scripts/build-llms.mjs >/dev/null
git add site/llms-full.txt site/llms.txt site/errors.html 2>/dev/null || true
git diff --cached --quiet || git commit --amend --no-edit -q
node scripts/worktree-node-modules.mjs
timeout 5400 npm run check:merge
git checkout -- examples/package-benchmarks/results 2>/dev/null || true
git status --short | head -5
node scripts/land-records.mjs
timeout 3000 npm run verify
# Every commit going to main carries the noreply identity.
bad=$(git log --format='%ae %ce' origin/main..HEAD | grep -v "^$E $E\$" || true)
if [ -n "$bad" ]; then echo "WRONG IDENTITY: $bad"; exit 1; fi
git push origin HEAD:main
echo LANDED $(git rev-parse HEAD)
```

This script is the form of 2026-10-29. Since 2026-10-31 `land-records` runs with `--no-build` (the build is `verify`'s)
and landings are batched (2.6.5).

The coordinator's reference pattern `<repo>-wt-nbreq/test-results/land-full.sh` is the same without the identity
check and with one extra line, `export MARGO_JUPYTER_VENV="$PWD/test-results/.venv-fresh"`, specific to that fix.

Line by line:

| Line | Why |
| --- | --- |
| `set -e` | any failing step stops the landing; nothing after a failure runs, so nothing dirty is pushed |
| `cd <worktree>` | the script runs from wherever the wrapper started it |
| `GIT_AUTHOR_*`, `GIT_COMMITTER_*` | the amend and any commit made here carry the noreply identity |
| `MARGO_GPU_LOCK=.../gpu.lock` | GPU steps inside take a GPU slot, not the landing lock again |
| `git fetch && git rebase origin/main` | rebase inside the lock, onto a main that cannot move until the push |
| `build-llms.mjs` then `git add ... && commit --amend` | `site/llms*.txt` and `site/errors.html` are generated from READMEs and docs; regenerating after the rebase and folding them into the change keeps them consistent with the rebased tree |
| `worktree-node-modules.mjs` | relinks `node_modules` after the rebase (new or renamed packages; new guards need fresh links) |
| `timeout 5400 npm run check:merge` | the full pre-merge check, 90 min hard limit |
| `git checkout -- examples/package-benchmarks/results` | discard the size records the checks rewrote, so `land-records` sees a clean tree |
| `git status --short \| head -5` | prints anything still dirty, for the log; `land-records` refuses a dirty tree |
| `node scripts/land-records.mjs` | rebuilds and commits the generated records once, at the rebased HEAD (2.9) |
| `timeout 3000 npm run verify` | verify on the exact tree being pushed, records commit included |
| identity check | refuses to push any commit whose author or committer is not the noreply address |
| `git push origin HEAD:main` | the push; fails, and so stops, if main moved (it cannot under the lock, unless someone pushes without it) |
| `echo LANDED <hash>` | the line the coordinator greps for |

#### 2.6.3 The exact command line

From the coordinator handoff (paths replaced):

```bash
MARGO_GPU_LOCK=<repo>/test-results/land.lock node scripts/gpu-lock.mjs run --max=170 --wait-max=240 --owner=<x> -- bash <script>
```

Start it in the background with its output to a log in the worktree, for example
`nohup <that command> > <worktree>/test-results/land-<task>.log 2>&1 &`, or the host's own background-run facility;
then end the agent's turn. NOT VERIFIED: the exact background invocation the helpers used; the notes give only the
command line above.

Why `--max=170`: 90 min for `check:merge`, 50 min for `verify`, plus records, rebase and build, leaves a margin under
170. Why `--wait-max=240`: the queue held up to about four hours of landings on 2026-10-28 ("let the queue drain, about
four hours").

#### 2.6.4 Older script (for contrast)

```bash
set -e
git pull --rebase origin main
node scripts/land-records.mjs
timeout 1500 npm run verify
git push origin HEAD:main
```
(`.claude/worktrees/agent-a2bda8a83b510dd54/.tmp/land.sh`, 2026-10-27.) In this older pattern the full `check:merge`
ran before taking the lock and only `verify` ran inside. The newer one runs the full `check:merge` inside, after the
rebase, at the cost of a longer hold (the queue got slower; the push is checked against the exact main it lands on).

#### 2.6.5 Batch landings (the rule since 2026-10-31)

The maintainer approved batching ("Batch them"). A queue of finished branches lands in batches: one `check:merge` on the
batch tip, one records commit, and every branch keeps its own commits and author.

- A batch is built in the first branch's worktree, on that branch (no extra branch, per `AGENTS.md`). Each further branch
  is rebased onto the batch tip in a stated order, with its special steps folded in (regenerated llms files, a record
  re-amended for that branch, a size raise with its reason). Rebase and conflict work for the next batch happens off the
  GPU while the current batch checks.
- Then one `check:merge` in the mode it prints for the whole diff, `land-records --no-build`, `verify`, the identity
  check and the push. The landing runner owns this. Builders end READY and never run `check:merge` (session rule 24).
- Batches group branches so the mode is honest: fixes and check code together, new packages and tooling together
  (the lock file and the root `package.json` force a full run), core together, and branches that touch one narrow area
  together so the affected run stays narrow.
- Stacked batch checks: a later batch's tree sits on the earlier batch's tip and may be checked while the earlier one
  still checks. After the earlier batch lands, the later one pushes without a new check only if `git diff` against its
  checked tip shows generated records alone (the records commit). Anything else gets its own check on the new tip.
- A failure in a batch: find the root cause first, never a plain rerun. A failing suite or golden names a package, which
  names a branch. Drop that branch, rebuild the batch without it, rerun; the dropped branch gets its own hunt and lands
  later alone. A flake is a bug: its fix goes into the batch, then the rerun. Only when the failure names no branch is
  the batch halved.
- Conflict-heavy rebases (core, a shared render path) go to a stronger model, off the GPU. The runner itself is a cheaper
  model.
- During a landing check, no new GPU builder starts, and at most two stay running, so a GPU slot is always free for the
  check. A slot wait once cost a check 457 seconds on a step that takes about 3.

The land script is a per-batch bash file in the batch worktree's `test-results/` (own files only). It leaves out what
`verify` and `check:merge` already run on the same tree: no `build:packages`, `api:check`, `quality`, `proofs`, unit
tests or `modern:test:packages` before `check:merge`. Measured on one queue, those repeats took about 3.5 minutes of a
roughly 9 minute wrapper; `verify` is the first step of `check:merge` and fails in under 4 minutes, so fail-fast holds.
It keeps what nothing else covers: the llms regeneration with the errors-page commit, the fixed-waits check and the
identity check. `check:fresh-clone` is not a repeat either (it proves the committed tree builds without untracked,
ignored or LFS-pointer files). The verify after `land-records` stays whole, because `AGENTS.md` says to run `verify`
before pushing. The batch script template is in 2.17.

### 2.7 The complete landing procedure

1. Worktree per agent, from current main:
   `git -C <repo> fetch -q origin && git -C <repo> worktree add --no-track <path> -b <branch> origin/main` (`--no-track`: 1.16 item 5).
   Branch names follow the host convention (`worktree-agent-<id>`); no extra branches (`AGENTS.md`, "One branch: main").
2. Set up the worktree: `node scripts/worktree-node-modules.mjs` (2.7.1), then `git lfs checkout` (fresh worktrees hold
   LFS pointers).
3. Work; commit often with the noreply identity; keep scripts and logs in the worktree's `.tmp/` or `test-results/`.
4. Fail fast: `npm run quality`, `npm run hygiene`, the unit tests of what you touched, the root unit tests, and
   `npm run api:check` (session rule 3; 1.4.1 has the traps behind each).
5. Write the landing script (2.6.2, or the batch form in 2.6.5) into `<worktree>/test-results/`. Builders stop at READY;
   the landing runner lands (2.6.5).
6. Start it in the background under the landing lock (2.6.3). Report to the coordinator once: script path, log path,
   lock holder name.
7. The script: fetch, rebase, regenerate llms files and amend, relink `node_modules`, full `check:merge`, discard the
   rewritten size records, `land-records --no-build`, `verify`, identity check, push.
8. If any step fails: the lock is released when the script exits. Fix the cause (2.11), commit, start the script again.
   Never edit the script to skip the failing step.
9. Confirm the landing on `origin/main` (1.8), not from the log alone.
10. Update the bug queue row, `RESUME.md`, and the dashboard.
11. Delete the remote branch if one was pushed.
12. Remove the worktree safely (2.7.2).

#### 2.7.1 Per-worktree node_modules

```js
// Gives a git worktree of this repository a real node_modules folder:
// third-party entries are junctions to the main checkout's node_modules, and every @margoengine/* package (and the
// `margoengine` stage) is a junction to THIS worktree's own packages, so builds and tests use the worktree's code.
// Tool caches (`.vite`, `.vite-temp`, `.cache`: every dot entry but `.bin`) are not linked: each worktree's tools
// create their own. A shared `.vite` let one worktree's Vite dev server re-optimize the dependencies another was
// serving, so that page got 504 "Outdated Optimize Dep" for react/jsx-runtime and never started (the intermittent
// "waitForFunction: Timeout 30000ms" of modern:test:browser, 2026-10-27).
// Usage, from inside a worktree: node scripts/worktree-node-modules.mjs
// Never run a full `npm install` in a worktree; run it once in the main checkout.
```
(`scripts/worktree-node-modules.mjs` header at `67ca53a5`.)

```js
  const target = join(root, 'node_modules');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, '@margoengine'), { recursive: true });
  for (const name of linkedEntries(readdirSync(join(main, 'node_modules'))))
    symlinkSync(join(main, 'node_modules', name), join(target, name), 'junction');
```
(Same file.) Note `rmSync(target, { recursive: true, force: true })` on a folder of junctions: Node removes a junction
as a link, without following it, so the main checkout's `node_modules` is not touched. NOT VERIFIED as a general
guarantee across Node versions; the script relies on it and the main checkout has not lost its `node_modules` in this
project. The same script registers the merge drivers (2.8). Test: `tests/worktree-node-modules.test.js` ("a worktree
links the installed packages and .bin, never a tool cache or its own packages").

Related trap: never run `npx` inside a worktree without `node_modules`; it can fetch a look-alike package
from the registry. Use the main checkout's `node_modules/.bin`.

#### 2.7.2 Removing a worktree with junctions

Real script `handoffs/cleanup-worktrees.ps1` (read 2026-10-29), key part:

```powershell
foreach ($id in $finished) {
  $path = Join-Path $repo ".claude\worktrees\agent-$id"
  $branch = "worktree-agent-$id"
  if (-not (Test-Path $path)) { Write-Host "skip  ${id}: no worktree folder"; continue }
  git -C $path merge-base --is-ancestor HEAD origin/main 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Host "SKIP  ${id}: HEAD is not merged into origin/main"; continue }
  $dirty = git -C $path status --porcelain --untracked-files=no
  if ($dirty) { Write-Host "SKIP  ${id}: tracked files changed"; continue }
  $links = Get-ChildItem -Path $path -Recurse -Directory -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\.+\\node_modules' }
  Write-Host ("ok    {0} : merged and clean, {1} junction(s) to unlink" -f $id, @($links).Count)
  if (-not $Apply) { continue }
  foreach ($l in $links) { [System.IO.Directory]::Delete($l.FullName, $false) }   # unlinks the junction only
  git worktree remove --force $path
  git branch -d $branch 2>$null
```
(`$repo` is set to the main checkout at the top of the file.) Rules it encodes:

1. Dry run by default; `-Apply` to act.
2. Only worktrees on an explicit finished list, whose HEAD is an ancestor of `origin/main`, with clean tracked files.
3. Unlink every junction first with a non-recursive delete, so nothing is followed into the main checkout.
4. `git branch -d` (not `-D`): git's own merged test is a second check.
5. `git worktree prune` at the end.

The older hand-off advice was `git worktree remove -f -f <path>` and `git branch -D <branch>` after
`merge-base --is-ancestor` (`RESUME.md`, 2026-10-26). Prefer the script: it unlinks junctions first and refuses
unmerged work. Deleting a big worktree can take minutes on Windows; run it detached (`Start-Process` or a background
job) so the agent is not blocked (global rule "Make slow checks cheap").

Also: the session classifier blocks cleanup of other sessions' worktrees, so the coordinator hands the
holder a script to run rather than deleting them itself.

### 2.8 Merge drivers for generated records

`.gitattributes` at `67ca53a5`:

```text
# Generated records: a rebase keeps main's copy and scripts/land-records.mjs regenerates it; quality baselines merge item by item
# (scripts/merge-driver.mjs, registered by scripts/setup-merge-drivers.mjs)
api/*.api.md merge=margo-derived
docs/api-surface.md merge=margo-derived
site/llms.txt merge=margo-derived
site/llms-full.txt merge=margo-derived
examples/package-benchmarks/results/entry-sizes.json merge=margo-derived
examples/package-benchmarks/results/basic-scene-network.json merge=margo-derived
scripts/quality/baselines/*.json merge=margo-ratchet
```

Registration, `scripts/setup-merge-drivers.mjs` at `67ca53a5`:

```js
export const DRIVERS = {
  'margo-derived': 'Generated records (kept as on main, regenerated by land-records)',
  'margo-ratchet': 'Quality baselines (limits only shrink)',
};

/** Writes the driver entries of git config in `cwd`. The command is relative: git runs drivers at the work tree root. */
export function setupMergeDrivers(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  for (const [name, description] of Object.entries(DRIVERS)) {
    git('config', `merge.${name}.name`, description);
    git('config', `merge.${name}.driver`, `node scripts/merge-driver.mjs ${name.slice(6)} %O %A %B`);
  }
}
```

The driver, `scripts/merge-driver.mjs` at `67ca53a5`:

```js
const [mode, basePath, oursPath, theirsPath] = process.argv.slice(2);
if (mode === 'derived') process.exit(0);
if (mode !== 'ratchet' || !theirsPath) {
  console.error('usage: merge-driver.mjs <derived|ratchet> <base> <ours> <theirs>');
  process.exit(2);
}
try {
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(
    oursPath,
    JSON.stringify(mergeRatchet(read(basePath), read(oursPath), read(theirsPath)), null, 2) + '\n',
  );
} catch (error) {
  // An unreadable side (a hand edit that broke the JSON) stays a conflict for a person to resolve.
  console.error(`merge-driver: ${error.message}`);
  process.exit(1);
}
```

- `derived` exits 0 without touching `%A`: during a rebase `%A` is main's side, so main's copy is kept and
  `land-records` regenerates the file afterwards.
- `ratchet` merges baselines item by item: limits only shrink, every reasoned history entry stays
  (`mergeRatchet` in `scripts/support/derived-records.mjs`, not reproduced here).
- The config lives in the shared `.git/config`, so one registration covers every worktree; `worktree-node-modules.mjs`
  calls `setupMergeDrivers` so a new worktree always has it.
- Never resolve these files by hand (`AGENTS.md`).

### 2.9 land-records

Header and steps, `scripts/land-records.mjs` at `67ca53a5`:

```js
// Regenerates the generated records on the rebased tree and commits them once (AGENTS.md, "Generated records").
// Run it inside the landing lock, after `git pull --rebase`, from a clean worktree:
//   node scripts/land-records.mjs [--no-build] [--no-commit]
// 1. build every package (skipped with --no-build when verify just built them)
// 2. API reports and docs/api-surface.md (api-report.js --update), then site/llms.txt and site/llms-full.txt, which
//    are made from the READMEs, those reports and docs/ (build-llms.mjs)
// 3. quality baselines, shrink only (quality-gate.mjs --update; a baseline that would grow stops here and asks for a
//    reason, exactly as `npm run quality -- --update` does, so a landing never widens a limit by accident)
// 4. entry sizes, then the basic-scene network record (it takes the GPU lock only around its browser)
// 5. both size records must name the same commit; then one commit `records: ... at <short HEAD>` if anything changed.
// A tree with uncommitted changes is refused, so nothing hand-edited is overwritten or swept into the records commit.
```

```js
export const STEPS = [
  { name: 'build', command: ['npm', 'run', 'build:packages'], skippable: true },
  { name: 'api reports', command: ['node', 'scripts/api-report.js', '--update'] },
  { name: 'llms files', command: ['node', 'scripts/build-llms.mjs'] },
  { name: 'quality baselines', command: ['node', 'scripts/quality-gate.mjs', '--update'] },
  { name: 'entry sizes', command: ['node', 'examples/package-benchmarks/entry-sizes.mjs'] },
  { name: 'basic-scene network', command: ['node', 'scripts/basic-scene-network.mjs'], gpu: true },
];
```

Guards in the same file: refuses a dirty tree; `pairedRecords()` throws unless `entry-sizes.json` and
`basic-scene-network.json` name the same commit and are not dirty; throws if that commit is not HEAD; commits with the
noreply identity set through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`; the GPU step runs with `MARGO_GPU_LOCK` deleted from
its environment so it takes the shared GPU lock, not the landing lock. The resulting commit subject is
`records: entry sizes, API reports and baselines at <short HEAD>` (visible throughout `git log origin/main`).

Run it with `--no-build` from a landing script: `verify` just built the packages and `dist` is still that build. The API
reports are checked by `api:check` in `verify` before this step, so a change that alters exports must already carry the
`api:update` output (1.4.1). Planned, not built: reuse the entry-size and basic-scene results that `build:site` measured on
the same tree (about 25 to 35 seconds a landing, an estimate); it is a change to the check scripts.

Why one place: "Generated records (sizes, baselines) that every change rewrites cause rebase conflicts; regenerate them
in one place (nightly or a single records commit) rather than in every landing where possible" (global rules).

### 2.10 check:merge: what runs, changed-only versus full

#### 2.10.1 The steps

`package.json` at `67ca53a5`:

```json
"check:merge": "node scripts/check-merge.mjs",
"check:merge:full": "node scripts/check-merge.mjs --full",
"check:merge:steps": "npm run verify && npm run check:fresh-clone && npm run build:site && npm run visual:check -- --no-build && npm run visual:compat -- --no-build && npm run visual:compat:budget -- --chunk=8 && npm run check:views && npm run check:gpu-packages -- --no-build && npm run check:depth && npm run check:wgsl && npm run modern:test:packages && npm run check:no-webgpu && npm run modern:test:bundlers && npm run check:quickstart",
```

`check-merge.mjs` splits `check:merge:steps` on ` && ` and runs the steps in order, stopping at the first failure.
Steps are classified so a new step cannot be added unclassified (test: "every check:merge step is either narrowed GPU
work or plain; a new step has to be classified"):

```js
export const GPU_STEPS = [
  'visual:check',
  'visual:compat',
  'visual:compat:budget',
  'check:views',
  'check:gpu-packages',
  'check:depth',
  'check:wgsl',
  'check:no-webgpu',
];
/** Steps known to need no GPU narrowing; a step in neither list fails the unit test so someone decides. */
export const PLAIN_STEPS = ['verify', 'check:fresh-clone', 'build:site', 'check:quickstart'];
/** Package-level steps (no GPU) that always run in some form and are narrowed by packageScopes. */
export const SCOPED_STEPS = ['modern:test:packages', 'modern:test:bundlers'];
```
(`scripts/check-merge.mjs` at `67ca53a5`.)

**Timing steps.** A check:merge step that measures speed takes the GPU exclusively itself (`await acquire({ owner, mode: 'exclusive' })`), runs alone as its own step, and, when it runs long, holds the GPU in chunks with a hard limit each and releases it between them, so shared GPU work queues for minutes, never for the whole run. `scripts/gpu-package-tests.mjs` `mergeTimingSteps` lists those steps and `lockMode` fails the plan for a GPU step that holds a measured time to a budget from a shared slot (`GPU_TIMING_MEASURED_SHARED`, added 2026-10-30 after visual:compat's frame budget read 86 ms against 50 beside other suites); `tests/gpu-timing-lock.test.js` runs each timing step in a shared slot and expects it to fail at once. The first such step is `visual:compat:budget` (`scripts/visual-compat-budget.mjs`): the frame cost of every WebGL2 layer demo, 8 demos per exclusive hold (`--chunk`), each hold limited to 15 min (`--chunk-minutes`, the lock entry's `max` is 2 min more), released between chunks; `visual:compat` itself compares pixels only, in a shared slot. Both narrow to the affected demos like `visual:check`.

#### 2.10.2 Selection

Session rule 20 (the maintainer, 2026-10-30): check only what a change can affect. check:merge runs the GPU tests of the changed
packages plus their dependents, not every package; a package's own package.json counts as that package; a script
runs only the checks that use it; a new standalone script no check imports runs none; everything runs only for core,
stage, shared code, the check code itself, the root package.json or the lock file; an unplaceable file gets
added to the map, not a full run; never narrow by skipping a test the change can affect; the nightly full run (on a
machine other than the main dev PC, plus the weekly uncached run in 2.10.4) is the backstop.

File classes (`scripts/support/file-classes.mjs`, checked in this order; `classify(file)` gives the class):

| Class | Files | Runs |
| --- | --- | --- |
| inert (first) | any `.md`, the quality baselines | nothing beyond verify (a package README still narrows `modern:test:packages`) |
| lock | root `package.json`, any `package-lock.json`, `npm-shrinkwrap.json`, `.npmrc` | everything; a package that adds a workspace dependency also changes the lock file, so it runs everything (accepted for now) |
| floor | `FULL_DIRS` (core, stage, shared, the umbrella) and `packages/kernel/**` (the Rust kernel build-modern.js compiles into core) | everything |
| package | a workspace file, its own `package.json` included | that package and its dependents (MAX_AFFECTED 12 still widens to full) |
| build-config | `biome.json`, `tsconfig*.json`, `rust-toolchain.toml`, `vite.config.*` | everything |
| check-code | `CHECK_CODE` (check-merge.mjs, affected-gpu.mjs, affected-packages.mjs, file-classes.mjs, verify.mjs, driver-resets.mjs) plus every file the `build:packages` chain reaches (`buildCheckCode`, found by the scan) | everything |
| runner | `RUNNER` (gpu-package-tests.mjs, run-limited.mjs, heat.mjs, machine-profile.mjs, machine-profiles.json) | `RUNNER_SMOKE` plus what the change affects |
| wgsl-loose | a `.wgsl` outside any package | everything |
| unit | `tests/*.test.js` | nothing beyond verify (verify runs every one) |
| visual-baseline | `tests/visual/**/<demo>-<tier>.png` | `visual:check --only=<demo>` (every demo when the name matches none) |
| visual-record | any other file under `tests/visual/` (manifest.json) | the whole visual check |
| fixture | `tests/fixtures/**` | the steps whose closure holds it or whose files name it, else nothing beyond verify |
| root-browser | `tests/browser/**` | the root suites whose closure holds it, else every root suite |
| proof | `examples/package-benchmarks/proofs/**` | nothing beyond verify (`proofs --current`; fresh-clone runs it again) |
| python | `python/**` | the Python notebook suite |
| asset | `examples/assets/**` | the steps whose closure holds it or whose files name it, else everything |
| script | every other file under `scripts/`, `tests/`, `examples/`, `bench/`, `tools/` | the steps whose closure holds it (or, for a page or fixture, whose files name it), else nothing beyond verify |
| inert | `docs/`, `site/`, `private/`, `api/*.api.md`, `benchmarks/`, `.github/` (no local step runs a workflow; it was a full run before), `public/favicon.ico`, licences, root dotfiles | nothing beyond verify; footprint patterns still apply (catalog data under `docs/` runs the catalog suite; a `site/` page or script runs `check:no-webgpu`, which opens every page of `site/dist`) |
| unknown | anything else | everything at run time; the class gate makes it unreachable for tracked files |

Closure scan (`stepClosure` in `scripts/support/affected-gpu.mjs`): for every check:merge step command, every verify
`SERIAL`/`PARALLEL` command, every GPU test command (plus a root suite's `PREPARE` commands) and every visual demo,
the files it runs are found by `scan()` (relative and root imports, `src`/`href`) and then by the repo paths its files
name in strings (`'scripts/build-site.js'`, `'tests/fixtures/basic-scene'`), followed until nothing new is named
(`closure()`). The visual check follows only the scripts it names (the site build), not the other pages that build
makes. A file in step X's closure runs step X whole; a GPU test or demo runs when its closure holds the file. The
footprint ids that only place a file are `wgsl` (check:wgsl whole), `packages` (modern:test:packages whole), `bundlers`
(the matrix runs), and `verify`, `fresh-clone`, `site`, `quickstart` (always run). Every visual demo holds
`visual-regression.js` and the site build it names; every GPU test holds the runner's own files other than `RUNNER`
(`gpu-lock.mjs`, `browser.js`, `lib/browser.mjs`: they sit in nearly every closure and so run nearly every GPU test,
correctly). A fixture, page or asset no closure holds is looked for by name (its basename, or `parent/basename` for
`index.*`, `main.*` and the like) in every footprint's files (`mentionIndex`), because tests load fixtures by built
path strings.

RUNNER exception (the maintainer's decision, 2026-10-30): the GPU package runner does not change what a test draws, and its
planning, limits, lock modes and heat guard are pinned by unit tests (heat-containment, gpu-timing-lock,
voxel-pathtracer-gpu-split), so a RUNNER change runs `check:gpu-packages --select=` the pinned `RUNNER_SMOKE` list in
`scripts/gpu-package-tests.mjs` plus every test the change affects through packages: shader test:gpu (a shared test
that splits into steps, 10 s), biomes test:gpu:flythrough (the only exclusive timing test, with its own time limit;
about 400 s), voxel test:gpu (a split suite, 17 s), root test:lifecycle:browser (a root suite, 12 s) and root
modern:test:usdz:browser (a root suite with PREPARE, 2 s plus its prepare). A unit test checks each kind is present.
`driver-resets.mjs` is not RUNNER: check-merge.mjs and nearly every GPU check import it, so it is check code.

Class gate: `tests/file-classes.test.js` classifies every tracked file (`git ls-files`, a tree walk without git) and
fails on any file whose class is unknown, naming the file and the fix ("add a rule for it to classify() in
scripts/support/file-classes.mjs, or move it under a folder the map knows"). verify runs it, so an unplaceable file
cannot land.

Planned results (`node scripts/check-merge.mjs --plan --files=...`, 2026-10-30): the quiet gate, benchmark scripts and
a unit test run the floor plus the four voxel visual views (`examples/voxel-sandbox/bench.mjs` imports the quiet gate
and the voxel views scan the whole sandbox folder); the MSAA repro check and its page, and a proof with its claim, run
the floor only; `packages/voxel-pathtracer/package.json` runs the path tracer, its dependents' tests and the voxel
views (plus `check:no-webgpu` when a site page changed with it); the runner files with the voxel and path tracer
package.json run RUNNER_SMOKE plus the voxel, path tracer and dependent tests. The floor (verify, fresh clone, site
build, the packed smoke test, quickstart) is about 500 to 560 s.

How each GPU step is narrowed (`planSteps`): `visual:check --only=<demo ids>`; `check:gpu-packages --select=<test
ids>`; `check:wgsl -- --packages=<dirs>`; `check:views`, `check:depth`, `check:no-webgpu` run or are skipped as a
whole. `modern:test:packages -- --packages=<dirs>` type-checks only affected READMEs (packing, install, licence checks
and the umbrella smoke test always run); `modern:test:bundlers` runs only when a changed package is one the matrix
builds or imports (`MATRIX_ROOTS`: the umbrella, react, shadows, controls, stage, core; plus `examples/vite`,
`examples/next`) or one of their dependencies.

Commands:

```bash
npm run check:merge                         # affected only; prints mode and reason first
npm run check:merge:full                    # everything (also MARGO_FULL=1)
node scripts/check-merge.mjs --plan         # print mode, reason, commands; run nothing
node scripts/check-merge.mjs --plan --files=packages/lod/src/a.ts
node scripts/check-merge.mjs --base=<ref>   # diff against another ref
```

Output record: `test-results/check-merge.json` with `mode`, `reason`, `affected`, `passedAfterDriverReset`, `seconds`
and per-step `results` (`command`, `ok` or `skipped`, `seconds`, `driverReset`, `driverResetTests`).

Build reuse: `verify` builds every package; `modern:test:packages` then reuses that build
(`MARGOENGINE_PACKAGE_TEST_PREBUILT=1`), and `verify` plants stale marker files (`MARGOENGINE_PLANT_STALE=1`) that no
pack may contain, so reuse cannot hide a stale-file bug.

#### 2.10.3 Parallel suites inside check:merge (under way)

The parallel check is built and still under way: it is off by default (the run stays serial) and is turned on with
`MARGO_CHECK_PARALLEL=1`. It is not proven, and no time saving is claimed. The measured starting point: on the
development PC the GPU package suites ran one at a time, with the GPU about 39 percent busy and 4.8 of 48 GB of GPU
memory in use during the longest suite (a biomes test), while the CPU and memory were far from full. Over three full
runs the 68 to 69 GPU suites summed to 1,289 to 1,947 seconds, and 59 of them took under 30 seconds each.

What the design has to respect: each running suite takes its own shared GPU slot; each browser gets its own temporary
profile directory; no two suites start on one fixed port at once (70 test files name a port, and a busy port is waited
for up to 20 minutes); timing tests keep running alone under the exclusive hold after the shared ones. Proof: the
parallel run happens inside a batch's own check (2.6.5), with no extra run, and `scripts/compare-check-runs.mjs`
compares its step list, suite labels and results with the serial record: the same steps, the same suites, every one ok
and none skipped. Until it matches, the serial run stays the rule.

Tests: `tests/check-merge-affected.test.js` (40 tests), for example "core, stage, shared and the margoengine umbrella
run everything", "a package's own package.json runs that package and its dependents, not everything", "a change to the
GPU package runner runs the smoke list plus what the change affects", "RUNNER_SMOKE holds one real test of each kind
the runner treats differently" and the five planned cases; `tests/file-classes.test.js` (one case per class and the
class gate).

#### 2.10.4 Result reuse (session rule 25, the maintainer, 2026-10-31)

Narrowing (2.10.2) works from the package graph. A result cache works from bytes: the same test on the same bytes is the
same result, so rule 20 ("never skip a test the change can affect") holds by construction, because a step reruns when
any byte it reads changed. The design is in a private planning note; this section is the rule.

- **Reuse.** A step whose recorded inputs are byte-identical to a first-try pass counts as passed on the pushed tree.
  `test-results/check-merge.json` names the source run and commit, and the log prints which results stand from an
  earlier tree. A reuse is reported, never silent.
- **Never reused.** Failures, rerun passes, timing tests, benchmarks and pinned proofs. A failure on a key that holds a
  pass poisons that key and goes on the bug list.
- **Record before serving.** Each step kind first runs in recording mode only: every step still runs, and the cache
  notes where it would have hit. A "would hit" whose real run then fails is a key lie and blocks that step kind. Serving
  starts per step kind only after 3 landings and 2 nightlies with no disagreement.
- **Backstop.** The nightly runs with the cache off, writes keys anyway, and re-executes everything, so a flake cannot
  hide behind a hit. Until the laptop has visual baselines, one uncached full check a week runs on the development PC at
  night. That is the only full nightly-type run allowed there, and it stops when the laptop has the baselines.
- **One run per code tree.** A check never runs twice on one code tree, and anything to be proven with a check is proven
  by a run that was happening anyway (session rule 24). A stacked batch whose diff from its checked tip is generated
  records alone pushes without a new check (2.6.5).

Estimates for a one-line change once every phase is live (ESTIMATES, not measurements; replace with measured numbers):
docs 2.5 to 4 min, a leaf package 4 to 7, a package with many dependents 9 to 12, core code 15 to 22, a core comment
3 to 5. The measured figures today are in 2.6.5 and 2.10.2. Status: being built in phases; no phase is live yet
(NOT VERIFIED beyond the plan).

### 2.11 Never land dirty, and rerunning one step

Session rules 6, 7 and 10, quoted from `handoffs/session-rules.txt`:

```text
6. Nothing lands with a failing or dirty check:merge (the maintainer, 2026-10-26). Every step must pass. If a step fails, fix the cause (or, if it is not yours, report the blocker to the coordinator and wait); never land anyway, never skip, retry-until-green, or loosen a check. ...
7. A failing check:merge step is always yours to resolve (the maintainer, 2026-10-26), related to your change or not. Find the root cause, go to the package that owns it and fix it there, with a regression test. Never dismiss it as unrelated or pre-existing, never land around it. Only wait instead of fixing when the coordinator has already assigned a fix helper to that exact failure ...; then rebase once it lands.
10. Rerunning only a failed check:merge step instead of the whole check is allowed (the maintainer, 2026-10-26) when ALL hold: every other step in that run passed; since then the only code that changed is a rebase onto commits that already passed their own full check, or a fix confined to the failing area; and your report names the step you reran and why. A FULL rerun is still required if the fix touches shared or core code, build or check scripts, or package/lock files, or if the rebase pulled in commits with no clean full check. Inside the landing lock you still run verify plus the tests of what you touched.
```
(Rules 6 and 7 shortened where they named the failures of that day.)

Note on rule 10: it allows rerunning the failed step alone when every other step passed. In practice `check-merge.mjs` stops at the first
failure, so the steps after a failed one never ran in that run; "every other step in that run passed" cannot hold for
them, and they must run too. So the safe reading is: rerun the failed step and every step after it, never the steps
before it only if the conditions hold. `check-merge.mjs` has no option to start at a given step; the rerun is done by
running the step's npm command(s) by hand (`npm run <step>`). NOT VERIFIED: whether any helper scripted a "resume from
step N" mode; none exists in `scripts/check-merge.mjs` at `67ca53a5`.

Decision table for a failed run:

| Situation | Rerun |
| --- | --- |
| Failure is a host fault confirmed by the event log | none by hand: `check:merge` already reran the step once (2.15.3) |
| Fix confined to the failing area; all earlier steps passed; no rebase or rebase onto fully checked commits | the failed step and the later ones |
| Fix touches core, shared, stage, build or check scripts, package or lock files | full |
| Rebase pulled commits with no clean full check | full |
| Inside the landing lock | the landing script reruns everything anyway |

### 2.12 The nightly full run

`scripts/nightly-full.mjs` at `67ca53a5` runs two commands in order and logs both to
`test-results/nightly/<YYYY-MM-DD>T<HHMM>.log`:

```js
export const nightlyCommand = () => [
  process.execPath,
  [
    'scripts/gpu-lock.mjs',
    'run',
    '--owner=nightly-full',
    '--exclusive',
    '--max=240',
    '--',
    'npm',
    'run',
    'check:merge:full',
  ],
];

/** The command that runs the pinned proofs after it, holding the GPU lock exclusively so the timed rounds run quiet. */
export const pinnedProofsCommand = () => [
  process.execPath,
  ['scripts/gpu-lock.mjs', 'run', '--owner=nightly-proofs', '--exclusive', '--max=60', '--', 'npm', 'run', 'proofs'],
];
```

Both run with `MARGO_FULL=1` and `MARGO_NIGHTLY=1` (tests with a nightly depth run it). The exit code is the first
failing run's. The script "registers nothing with the OS".

Where it runs: the maintainer moved the nightly full run off the development PC. It runs on the mini PC or the Linux server, and the development PC's nightly task is disabled. The one exception is the weekly uncached full check at night on the development PC (2.10.4), which lasts only until the laptop has visual baselines. The Task Scheduler description below is the historical setup of that task.

Windows Task Scheduler: task "MargoEngine Nightly Full Check", daily at 10:00, task to run
`<projects>/margoengine-nightly/nightly.cmd` (read with `schtasks /query /v` on 2026-10-29: Status Ready, Last Result 0).
The wrapper, read 2026-10-29 (paths replaced):

```bat
@echo off
rem Skip mechanism: create skip-next-run.flag in this folder to skip ONE nightly run; the flag is deleted when it skips.
if exist "<projects>\margoengine-nightly\skip-next-run.flag" (
  del "<projects>\margoengine-nightly\skip-next-run.flag"
  echo %date% %time% skipped by flag >> <projects>\margoengine-nightly\last-run.log
  exit /b 0
)
rem Nightly full GPU check for Margo Engine. Runs in its own detached worktree.
set W=<repo>\.claude\worktrees\nightly
cd /d %W%
git fetch -q origin && git checkout -q --detach origin/main
node scripts\worktree-node-modules.mjs
git lfs checkout
set MARGO_GPU_LOCK=<repo>/test-results/gpu.lock
node scripts\nightly-full.mjs >> <projects>\margoengine-nightly\last-run.log 2>&1
```

Design points:

- Runs in its own detached worktree at `origin/main`, never in anyone's working tree.
- On the workstation profile, takes the GPU lock exclusively for each run, so landings wait their turn and the timed
  proofs run quiet. On a heat profile the full check holds no outer lock (`heatFullCommand`): its steps take the GPU
  lock themselves, as in any check:merge, and a heat-stopped step's tree ends, so nothing is held while the machine
  cools. One whole-run hold would need a cap covering every possible cooldown (check:gpu-packages can pause each of its
  tests), hours that would guard nothing. The pinned proofs keep their exclusive hold. Cooldowns still count against
  the overall deadline (`MARGO_NIGHTLY_DEADLINE_MIN`); a night they push past it ends as TIMEOUT with the alert.
- Costs no model tokens.
- Timing: the full check runs at 10:00 and long benchmarks are scheduled 12:00 to 20:00 (global rules).
- The pinned proofs run only here, not in every landing: about 40 of them time a speed-up with margins near 5 percent,
  which a busy landing machine can erase (`nightly-full.mjs` header; bug-queue row 6b).

Observed, from `last-run.log`: the 2026-10-26 run "FAILED at npm run check:gpu-packages -- --no-build in 1087 s"; the
10-27 and 10-28 runs were "skipped by flag". Note: `RESUME.md` records a ruling that "the next run
(2026-10-28 10:00) stays regardless of what is open", yet the log shows 10-28 skipped by flag. The flag was evidently
created again; who created it is not recorded.

Missing pieces to add when copying: the wrapper has no overall timeout of its own (the inner limits are 240 and 60
minutes per lock hold, which bound it); nothing alerts anyone on failure; the log is only read when someone looks.
(Since then `nightly-full.mjs` has an overall deadline, last-status.json and ALERT.txt, and the status repository
below.)

Profile steps (2026-10-30, `scripts/support/machine-profiles.json` `nightly`, labels from `NIGHTLY_STEPS`): this is the
backstop for check:merge's narrowing (session rule 20).

| Profile | Nightly steps |
| --- | --- |
| `laptop` (the Intel Arc laptop) | `full check:merge`, `pinned proofs`, `nightly-status`; nothing excluded, voxel-pathtracer included; heavy suites in short steps, and every GPU step of check:merge under its heat watch (2.15.9). Its visual baselines are captured on the laptop itself, later; until they are committed its visual:check has no matching profile |
| `mini-pc`, `thermal-limited` | `gpu package tests` (builds every package first; voxel-pathtracer excluded), then the light GPU checks `check:wgsl`, `check:views`, `check:depth`, `check:no-webgpu` (after `npm run build:site`), `modern:test:bundlers` (after `npm run modern:test:packages`), then `nightly-status` |
| `workstation` | `full check:merge`, `pinned proofs` (its nightly task is disabled; the only full run there is the weekly uncached check of 2.10.4, until the laptop has visual baselines) |

The light checks run through `node scripts/check-merge.mjs --steps=<a>,<b>` (`stepsCommand`), check:merge's own step
runner, so the profile's heat watch covers them as in check:merge (2.15.9); they take the GPU lock themselves.

Status repository (`nightly-status`, `publishStatus` in `nightly-full.mjs`): after the night's record is written it
copies `last-status.json` and the last 40 lines of the night's log to `<profile>/last-status.json` and
`<profile>/last-log.txt` in a clone of a private status git repository, commits (`nightly <profile>: <result>`) and
pushes, so the coordinator reads one place each morning. `MARGO_STATUS_REPO` (the repository URL) and
`MARGO_STATUS_DIR` (the local clone; cloned when missing, else pulled with `--ff-only`) say where; neither, nor any
account or machine name, is written in this repository. With either unset it prints one line, "nightly-status:
skipped, MARGO_STATUS_REPO and MARGO_STATUS_DIR are not both set", and does nothing. Every git command has a 2 min
limit; a failure prints "nightly-status: FAILED to publish (<reason>)" and raises the local alert (ALERT.txt) without
changing the night's exit code. The repository itself is created separately (never a branch of margoengine). Tests:
`tests/nightly-deadline.test.js` (a local bare repository stands in for it).

### 2.13 Timeouts everywhere

Rule: "Every test, check, benchmark and background job gets a hard time limit; a lock is never held without one. On
timeout, kill the whole process tree, release the lock, and report what hung. Locks use a heartbeat so a stuck holder
can be reclaimed. Nothing may sit for 30 minutes blocking other work." (global rules, "Parallel work and checks").

Where each limit lives, at `67ca53a5`:

| What | Limit | Where | On timeout |
| --- | --- | --- | --- |
| Shared GPU hold | 20 min default | `gpu-lock.mjs defaultMaxMinutes` | tree killed, lock freed, exit 124, `TIMEOUT after N min: <command>` |
| Exclusive GPU hold | 60 min default | same | same |
| Landing lock hold | 30 min default; landings pass 170 | same; `--max=170` | same |
| Holder that hangs inside `acquire()` | deadline plus 15 s grace | `beat` process | holder tree killed, entry removed, line in `gpu-lock-timeouts.log` |
| Lock wait | 60 min default; landings pass 240 | `--wait-max` | ticket removed, message names holder and command, exit 2 |
| Mutex | 10 s | `locked()` | removed as left by a crash |
| One GPU test | 10 min default (`MARGO_GPU_TEST_TIMEOUT_MIN`, or package `margo.gpuTestTimeoutMinutes`, a number or an object per script; biomes `test:gpu:flythrough` has 12.5 min, 750 s; voxel-pathtracer splits its check into five scripts, 10 or 15 min each) | `scripts/support/run-limited.mjs` | tree killed, result names the test and the fix |
| Browser suite teardown | 30 s | `scripts/support/shutdown.mjs SHUTDOWN_BUDGET_MS` | throws `SHUTDOWN_TIMEOUT` naming what is still open |
| Page waits | 30 s default | `scripts/browser.js`, `page.setDefaultTimeout(30000)` | Playwright timeout; a lost device fails it at once (2.15.4) |
| Port wait | 20 min | `listenWhenFree` | throws naming the port and `netstat -ano` |
| Event-log lookup | 30 s | `driver-resets.mjs runPowerShell` | the lookup reports "could not be read", never a reset |
| DXGI adapter lookup | 30 s | `gpu-adapter.mjs runLookup` | one warning, no adapter flag |
| Full `check:merge` in a landing | 5400 s | landing script `timeout 5400` | script stops (`set -e`), lock released |
| `verify` in a landing | 3000 s | landing script `timeout 3000` | same |
| Nightly | 240 min and 60 min | `nightly-full.mjs` | per-run lock limit |

Float comparisons in timing checks compare in whole timer steps. A limit such as 1 ms against a timer that reports in
fixed steps must be compared after converting both sides to whole steps; a raw float comparison can fail on rounding
alone. The fix is the comparison, never a looser limit.

Two gaps found in the bug queue and closed: a fixed port that made a 5-second check sit silently behind another
suite's 7-minute run until the 10-minute limit killed it (bug 38b, fixed with `port: 'free'` and progress lines every
30 s of silence); a teardown that never ended after every assertion passed (bug 30, 2.14). One gap still open in the
queue: a `verify` unit-test step that ran 3,338 s once with no record of which test hung (bug 27: "Add a per-file
timeout and a hung-test report to the unit-test runner").

### 2.14 Teardown, dev-server caches and ports

#### 2.14.1 Bounded teardown (bug 30)

```js
// Tears down a browser suite in the one order that cannot hang (bug 30). `httpServer.close(callback)` calls back only
// once every connection is gone, and a browser keeps keep-alive and half-closed connections to the servers it loaded
// from; closing the server first, with the browser still open, never called back and the suite (every assertion
// passed) was killed after 600 s. So: browser context, then browser, then the servers' connections, then the servers,
// then the child processes' whole trees, all inside one budget that names what was still open when it ran out.
```
(`scripts/support/shutdown.mjs` header at `67ca53a5`; landed in `510dd229`.)

Order inside `closeAll`: context, browser, then in parallel every child tree (`taskkill /T /F` on Windows) and every
server (`closeIdleConnections`, `closeAllConnections`, then close once). Every step runs even if an earlier one failed;
the first failure is thrown at the end; past 30 s it throws `SHUTDOWN_TIMEOUT` with the list of what is still open.

Note: `openBrowser().close()` in `scripts/browser.js` at `67ca53a5` still does
`await browser.close(); await closeServer();` directly rather than calling `closeAll`; the order (browser before
server) is the safe one, but without the 30 s budget. Bug-queue row 70 records that the bounded teardown "covered
modern-browser-tests only; apply the shared bounded teardown to every script that opens a browser, add a check that
finds any script that does not". Open at `67ca53a5`.

#### 2.14.2 Dev-server cache per server (bug 26)

From `scripts/browser.js` at `67ca53a5`, `startDevServer`: every Vite dev server gets its own dependency cache under
`test-results/vite-cache/<pid>-<random>`, removed on close; folders of dead pids are removed at the next start; no file
watcher (`watch: null`, because its first crawl of the repository and every worktree "blocked this process for 30-140
s on a busy machine"); the root is `realpathSync.native(process.cwd())` because Vite refuses Windows short (8.3) paths
with 403. Measured in the bug 26b row: "4 of 25 loads hung before, 0 of 25 after". Guard test:
`tests/vite-cache-isolation.test.js`.

#### 2.14.3 Ports

Fixed ports wait while held (`listenWhenFree`, up to 20 min, with a message naming the port); suites should pass
`port: 'free'`, which takes a system-assigned port (`freePort()`), so they never queue behind another suite (bug 38b).

### 2.15 Host protection safeguards

#### 2.15.1 What a GPU driver reset is, and the two kinds

From `docs/known-bugs.md` at `67ca53a5`, "GPU resets during busy check:merge runs on the NVIDIA workstation PC (nvlddmkm event
153)":

```text
- **Two kinds of reset, told apart by measurement (2026-10-28):** a Windows watchdog reset (TDR) of one GPU engine
  writes a WER `LiveKernelEvent` 141 report and a `WATCHDOG-*.dmp`; event 153 comes with none, so it is the NVIDIA
  driver's own reset, not the Windows 2 s watchdog. A deliberate 3 s compute dispatch on the NVIDIA GPU gives exactly the
  first kind (141 at 02:08 and 03:11) and no event 153, so our long dispatches are not what makes 153.
```

| | Event 153 (`nvlddmkm`, System log) | LiveKernelEvent 141 (WER, Application log) |
| --- | --- | --- |
| Who resets | the NVIDIA driver itself | the Windows GPU watchdog (TDR), one engine |
| Evidence left | the System log entry only | WER report 1001 plus `WATCHDOG-<date>-<time>.dmp` |
| Effect on WebGPU | the device of a page using the GPU is lost; a page asking for a device just then is refused ("D3D12 create command queue failed with E_OUTOFMEMORY") | the submission is cut short; the device is NOT lost; "the page got wrong results with no error" |
| Reproduced by | not reproduced deliberately; 8 of 9 came while a Remote Desktop session was connected | a deliberate 3 s compute dispatch |
| Cause | OPEN | long submissions on a slow adapter (nine 141s on 10-27 evening came while Edge ran on the integrated GPU, bug 33) |

The second column is the dangerous one for a test system: only the event log shows it, which is why checks read the
log.

#### 2.15.2 What driver-resets.mjs reads

```js
//   nvlddmkm (NVIDIA), amdkmdag / amdwddmg (AMD), igfx* (Intel)   driver errors in the System log, for example
//                                                                 nvlddmkm event 153 (the NVIDIA driver reset a GPU)
//   Display event 4101                                            "display driver stopped responding and has recovered"
//   Windows Error Reporting LiveKernelEvent 141, 117, 1a8         the Windows watchdog (TDR) reset an engine or the GPU
```

```js
export const DRIVER_PROVIDERS = ['nvlddmkm', 'amdkmdag', 'amdwddmg', 'igfx', 'igfxn', 'igfxnd', 'Display'];
/** LiveKernelEvent codes Windows Error Reporting files for a GPU watchdog reset. */
export const WATCHDOG_CODES = ['141', '117', '1a8', '1a1'];
```
(`scripts/support/driver-resets.mjs` at `67ca53a5`.)

The query is read only: `Get-WinEvent` on the System log for those providers at levels 1 to 3, and on the Application
log for Windows Error Reporting event 1001 whose message matches `LiveKernelEvent`. A watchdog report counts once per
dump, at the time in the dump's name, because "Windows Error Reporting files the same dump again at every upload
attempt, hours later". Display entries count only for id 4101. Non-Windows platforms return no resets. A lookup that
fails is reported as "the Windows event log could not be read ..., so a GPU reset cannot be confirmed", never as a
reset.

#### 2.15.3 Retry once after a logged reset

```js
export async function retryAfterDriverReset(
  label,
  run,
  { lookup = driverResets, log = (line) => console.error(line), settleMs = 5000, now = () => new Date() } = {},
) {
  const started = now();
  const first = await run();
  if (first.ok) return first;
  // The driver logs a reset after it recovers, a few seconds after the page saw its device go.
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  const resets = lookup({ since: new Date(started.getTime() - 10_000), until: now() });
  if (!confirmed(resets)) {
    const why = describeResets(resets);
    if (why) log(`${label}: ${why}`);
    return first;
  }
  log(
    `\nGPU RESET: ${label} failed during a ${describeResets(resets)}. The failure is kept in this log; running the whole step once more (bug 25).`,
  );
  const second = await run();
  log(`GPU RESET: the rerun of ${label} ${second.ok ? 'passed' : 'failed too'}.`);
  return { ...second, driverReset: { resets, firstRun: first, rerunOk: second.ok } };
}
```
(`scripts/support/driver-resets.mjs` at `67ca53a5`; landed in `51d8786a`.)

The rule, in steps:

1. Run the step.
2. Pass: done, no lookup.
3. Fail: wait 5 s, look up resets from 10 s before the step started until now.
4. No confirmed reset: the failure stands; no retry.
5. Confirmed reset: print it, run the whole step once more, print the outcome, record both.
6. A second failure fails the run.

`check:merge` applies this to every step except `check:gpu-packages`, which applies it per test, "so a reset there
costs one test, not the whole step".

#### 2.15.4 The receipt text, the marker and the JSON flag

Printed lines, from `driver-resets.mjs` and `check-merge.mjs` at `67ca53a5`:

```text
GPU RESET: <step> failed during a GPU driver reset in the Windows event log: nvlddmkm event 153 at 01:21:49. The failure is kept in this log; running the whole step once more (bug 25).
GPU RESET: the rerun of <step> passed.
GPU RESET during <step>: GPU driver reset in the Windows event log: nvlddmkm event 153 at 01:21:49; the rerun passed
PASSED WITH A DRIVER RESET: <step>, GPU driver reset in the Windows event log: nvlddmkm event 153 at 01:21:49
PASSED WITH A DRIVER RESET in <seconds> s: 1 rerun after a GPU driver reset, see above
```
(Assembled from the template strings; the event and time are the example the code's own comment uses.) For a
`check:gpu-packages` test the marker line is `PASSED WITH A DRIVER RESET: <step> > <test label>, <reset>`.

JSON: `test-results/check-merge.json` and `test-results/gpu-packages.json` carry `passedAfterDriverReset: true` at
the top, and each affected step or test carries `driverReset: { resets, rerunOk }` (commit `6a8f7658`: "so it never
reads like a clean pass").

Note: there is no amber (or any) colour in the output. A search of `scripts/` at `67ca53a5` for ANSI colour
codes and the word "amber" found none in these files; commit `6a8f7658` adds text lines and the JSON flag only. The
coordinator handoff's phrase "bug 25 retry+amber" refers to that marker as a warning level, not a coloured string. To
add colour, add it as an extra, never as the only signal (logs and JSON have no colour).

#### 2.15.5 The device-loss guard

`scripts/support/device-loss.js` at `67ca53a5`, installed by `scripts/browser.js` in every page it opens:

```js
export function deviceLossGuard() {
  if (typeof GPUAdapter === 'undefined' || GPUAdapter.prototype.requestDevice.margoDeviceLossGuard) return;
  const request = GPUAdapter.prototype.requestDevice;
  const report = (reason, message) =>
    console.debug(
      `[gpu] lost ${JSON.stringify({ reason, message: String(message ?? ''), at: new Date().toISOString() })}`,
    );
  const guarded = async function (...args) {
    let device;
    try {
      device = await request.apply(this, args);
    } catch (error) {
      // Only driver failures: a bad descriptor (a TypeError or a limit the adapter lacks) is the page's own mistake.
      if (
        /D3D1[12]|DXGI|E_OUTOFMEMORY|VK_ERROR_DEVICE_LOST|device (was )?(lost|removed|hung)/i.test(
          String(error?.message),
        )
      )
        report('request-failed', error.message);
      throw error;
    }
    device.lost?.then((info) => {
      if (info?.reason === 'destroyed') return;
      report(info?.reason ?? 'unknown', info?.message);
    });
    return device;
  };
  guarded.margoDeviceLossGuard = true;
  GPUAdapter.prototype.requestDevice = guarded;
}
```

On the Node side `watchDeviceLoss(page)` listens for `[gpu] lost` console lines, looks up resets for up to 8 s
(`resetsAround`, polling every 1 s, because the driver logs after it recovers), and makes every `page.waitForFunction`
reject at once with an error coded `gpu-device-lost` whose message says what happened and names the reset, for example
"... so it cannot get ready: the GPU driver reset the GPU (GPU driver reset in the Windows event log: nvlddmkm event
153 at 01:21:49). A reset removes the WebGPU device of every page on that GPU, so this page may only have been the one
that was using it; check:merge runs the step once more after a confirmed reset." Before this, the page "never became
ready and the check failed only at its timeout (30 s, 120 s for a site view), with nothing saying the GPU had gone".
Losses from `device.destroy()` are deliberate and not reported. Tests: `tests/device-loss-guard.test.js` (7 tests).

#### 2.15.6 Choosing the GPU by LUID on Windows (bug 33)

What happened (bug-queue rows 33 to 33c): after a reboot, headless Edge used the integrated AMD GPU instead of the
discrete NVIDIA one, so every visual check ran a profile with no baselines and every helper's `check:merge` failed.
Switches (`--use-webgpu-power-preference=high-performance`, `--force_high_performance_gpu`) and the Windows per-app
preference changed nothing measurable. The investigator found the cause:

```text
headless Edge gets DXGI adapter 0 and WebGPU offers only that. Windows puts the adapter that carries the current session display output first: while a Remote Desktop session is connected ... the NVIDIA GPU carries the RDP output so Edge gets nvidia; while disconnected the order is AMD, NVIDIA, 2x Microsoft Basic Render and Edge gets amd.
```
(`handoffs/bug-queue.md` row 33c, shortened.)

The fix, `scripts/lib/gpu-adapter.mjs` at `67ca53a5` (landed `85c96a55`):

```js
/**
 * Which GPU a Chromium-family browser uses on a Windows PC with more than one, decided at launch (bug 33).
 *
 * Headless Chromium runs on DXGI adapter 0 and WebGPU offers only that adapter. Windows puts the adapter that carries the
 * current session's display output first, so on a PC with an integrated and a discrete GPU the answer changes with
 * whether a Remote Desktop session is connected. requestAdapter powerPreference, --force_high_performance_gpu and the
 * Windows per-app GPU preference do not change it. `--use-adapter-luid=<high>,<low>` (decimal) does. A LUID changes at
 * every boot and driver restart, so it is looked up here, never written down.
 *
 *   MARGO_GPU=default            add no flag: whichever adapter Windows and the browser pick
 *   MARGO_GPU=nvidia|amd|intel   prefer that vendor's hardware adapter (largest video memory when there are several)
 *   MARGO_GPU_LUID=high,low      use exactly this adapter (decimal, as Chromium reads it); wins over MARGO_GPU
 *   (unset)                      the hardware adapter with the most dedicated video memory; no flag with only one
 */
```

How it works:

1. A PowerShell script compiles a small C# class with `Add-Type` that calls `CreateDXGIFactory1` and enumerates
   adapters (`EnumAdapters1`, `GetDesc1`), printing `ADAPTER|name|vendor|device|memory|luidHigh|luidLow|flags`.
2. `parseAdapters` keeps decimal LUIDs, marks software adapters (`DXGI_ADAPTER_FLAG_SOFTWARE` or vendor `0x1414`
   Microsoft).
3. `chooseAdapter` applies `MARGO_GPU_LUID`, then `MARGO_GPU`, else the hardware adapter with the most dedicated video
   memory; with only one hardware adapter, no flag.
4. The list is cached per process and in `<temp>/margo-gpu-adapters.json`, keyed by host name and boot time, for 30
   minutes (a driver restart can change LUIDs without a reboot).
5. `launchArgs` in `scripts/lib/browser.mjs` adds `--use-adapter-luid=<high>,<low>` for Chromium-family browsers on
   Windows. A failed lookup prints one warning and launches without the flag; it never throws.
6. `visual:check` prints the adapter it asked for and the one it ran on; the missing-baseline message names the
   adapter, the committed profiles and the fix.

Separately, `openBrowser` asserts the adapter when `GPU_VENDOR` is set ("WebGPU used the wrong physical adapter",
"Software WebGPU adapter selected").

Still unproven at the time of the bug-queue row: the disconnected state with the LUID flag (disconnect the
Remote Desktop session for a few minutes with the probe loop running). NOT VERIFIED whether that was done; the
coordinator handoff says only "NVIDIA GPU (Edge picks it by LUID)".

Tests: `tests/gpu-adapter.test.js` (9 tests), for example "two hardware adapters: the one with the most video memory
wins, whatever order Windows lists them in".

#### 2.15.7 Windows bugcheck 0x18 in bindflt.sys

Observed (bug-queue rows 32, 32b, 32e, 32f):

- The Windows dev PC blue-screened on 2026-10-27, about 15:15 to 15:18 local (the first timeline said 14:42; corrected twice).
- WinDbg `!analyze -v` on the dump reported: bugcheck `0x18 REFERENCE_BY_POINTER`, bucket
  `0x18_OVER_DEREFERENCE_bindflt!BfPreCreate`, module `bindflt.sys` (the Windows Bind Filter driver, a Microsoft
  in-box driver), faulting process `node.exe`, stack `NtCreateFile -> ... -> FLTMGR FltpCreate -> bindflt!BfPreCreate
  -> ObfDereferenceObject -> KeBugCheckEx`.
- Windows build 26300 with `bindflt.sys` 10.0.26100.9711; VBS/HVCI on.
- At the time: a landing `verify` (build and many Node test processes) held the landing lock, other helpers ran checks.
- The machine had run 7 days at full load before this, so the trigger is new in that window.

What is known: a file open by `node.exe` through a path the bind filter handles over-dereferenced a kernel object. That
is a Microsoft driver bug, not engine code and not the GPU driver.

Hypothesis, untested: the trigger is a very high rate of file opens through thousands of directory junctions (each
worktree links about 90 to 184 `node_modules` entries; about 45 old worktrees at the time) plus many concurrent Node
and browser processes. Candidate changes in that week: per-server Vite cache folders created and deleted, junction
relinking, browser GPU-process crash tests, more concurrent full checks.

Mitigations recorded (rows 32b, 32e):

1. Windows Update for a newer build; file the dump through Feedback Hub if on a preview channel.
2. Remove finished worktrees (`cleanup-worktrees.ps1 -Apply`): fewer junctions.
3. Cap concurrent helpers running checks at 3 or 4 while unexplained.
4. Consider fewer links per worktree (link only the root `node_modules`) as a script change. NOT VERIFIED: not done at
   `67ca53a5`; `worktree-node-modules.mjs` still links each entry.
5. Do not disable `bindflt` (a system driver; system settings belong to the maintainer).
6. Delete big folders in a detached process after a check (global rule), so deletion does not overlap the next
   file-heavy step.
7. Monitoring idea: a minute-level log of running Node and browser processes and lock holders, so the next crash has
   context; compare the next dump's bucket. NOT VERIFIED whether a minute-level logger runs; the GPU logger in 2.15.9
   samples GPU state, not processes.

#### 2.15.8 Hard reset with no bugcheck; crash hygiene

- Coordinator handoff: "Unexplained hard reset 10-28 13:43 (no bugcheck)." NOT VERIFIED beyond that line.
- The small Windows test PC (row 32c, 32d): Kernel-Power 41 and an "unexpected shutdown" with no bugcheck and no dump; it turned out
  a reboot had been forced after the Remote Desktop session froze during a GPU-heavy test. Whether the machine
  itself hung is unknown. Lesson: Remote Desktop uses a remote display adapter, and a GPU reset or heavy GPU job can
  freeze or drop the session; run GPU jobs from the console session or a tool that keeps it, and keep logs on disk.
- Coordinator handoff trap: "commit work in progress often (the crash zeroed uncommitted files)". NOT VERIFIED: which
  files and which crash; the note does not say.

Crash hygiene rules that follow:

1. Commit work in progress in the worktree at every meaningful step; a WIP commit costs nothing and is rebased later.
2. Keep a scratch copy (a patch file under `handoffs/`, as `usdz-rotation-wip.patch` and
   `old-jupyter-attempt-*.patch` are) of anything not yet committed that matters.
3. After a reboot, every helper is dead. The restart list in `RESUME.md` names worktrees and commits; check each worktree
   with `git status` before restarting.
4. After a reboot on a two-GPU PC, check which adapter the browser gets before starting landings (the 10-27 restart
   list: "run the adapter probe 5 times ... only start landings when it prints nvidia 5 of 5").
5. A hard reset with no bugcheck was later seen next to a Windows Update restart that killed the temperature logger.
   Restart the logger after any reboot, and check that it is advancing (two reads 30 s apart show different
   timestamps) before every heavy job. A logger that stopped silently leaves no data for the next reset.

#### 2.15.9 Thermal protections and remote test machines

GPU logger on the Windows dev PC, `handoffs/pc-health-log.sh` (read 2026-10-29):

```bash
#!/bin/bash
# Logs GPU temperature, power, clocks, utilisation and memory every 5 s, with a 24 hour limit, to find what precedes a hard reset.
# Run: nohup bash pc-health-log.sh > /dev/null 2>&1 &
OUT="$(dirname "$0")/pc-health.log"
END=$(( $(date +%s) + 86400 ))
echo "start $(date -Is)" >> "$OUT"
while [ "$(date +%s)" -lt "$END" ]; do
  echo "$(date -Is),$(timeout 10 nvidia-smi --query-gpu=temperature.gpu,power.draw,clocks.sm,utilization.gpu,memory.used,pstate,clocks_throttle_reasons.active --format=csv,noheader,nounits 2>&1 | tr '\n' ';')" >> "$OUT"
  sleep 5
done
echo "end $(date -Is)" >> "$OUT"
```

Note its own limits: a 24-hour end time and a 10 s timeout on each `nvidia-smi` call. A sample line from the log:
`2026-10-29T00:58:20-04:00,59, 36.06, 225, 1, 1914, P8, 0x0000000000000001;`.

A heavier read-only recorder for reset hunts, `handoffs/bug25-watch/reset-watch.ps1`: samples once a second into
a ring buffer (150 s by default, `-Minutes 240` by default) and saves it when a GPU driver event appears; it runs
`nvidia-smi -lms 1000` into its own CSV and reads the lock holders from the lock folders. Bug-queue row 25c notes a
flaw: "its summary line hard-codes one NVIDIA GPU LUID (0x14440), which changes at reboot".

Other machines (from bug-queue rows 29, 40, 41b, 60 and the coordinator handoff; the scripts live on those machines and
were not read; all thresholds NOT VERIFIED against code):

| Machine | Observed | Rules |
| --- | --- | --- |
| `<linux-server>` (a Linux test server with Intel graphics; Intel N100, fanless class) | 94 to 96 C during `verify` (4 test processes at once); 88 to 89 C in GPU package tests; a watchdog stopped a run at 90 C after 368 s; another run stopped three packages at 82 C | no `verify`, no unit-test step, no GPU package run; only single light jobs; heat watchdog stop at 85 C with cooldown to 72 C (row 40), later stop at 82 C (coordinator handoff); a 10 W power cap installed |
| `<mini-pc>` (a small Windows test PC with an AMD iGPU) | 81.4 C CPU and 64 C GPU peak over a full GPU-package run; one freeze during a path tracer test | heavy jobs only with the elevated temperature logger fresh; stop at 90 C; never the path tracer there |
| `<laptop>` (a laptop with an Intel Arc GPU) | shared with another coding agent | only through the maintainer; its checkout belongs to the other agent |

Remote test machine rules (coordinator handoff and rows above):

1. One test at a time; run packages one by one with cooldowns rather than a whole suite.
2. Every job has a hard timeout.
3. No heavy job without a fresh sensor log and an armed temperature stop.
4. Never `pkill -f` with a broad pattern ("killed my own shell twice"); kill by pid, or by an exact command line.
5. Do not install packages on someone else's machine; ask.
6. Logs and results are written to disk on the machine, so a freeze leaves evidence.

Generic reference version, not from the repo: a temperature guard for Linux that stops a job above a threshold and
waits for a cooldown.

```bash
#!/bin/bash
# heat-guard.sh <stop-C> <resume-C> <timeout-s> -- <command...>
# Runs the command in its own process group; if the hottest thermal zone passes <stop-C>, kills the group, waits until
# every zone is below <resume-C>, and exits 75. Logs a sample every 5 s to heat-guard.log.
STOP=$1; RESUME=$2; LIMIT=$3; shift 4
hottest() { cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | sort -n | tail -1 | awk '{print int($1/1000)}'; }
setsid timeout "$LIMIT" "$@" & PID=$!
while kill -0 "$PID" 2>/dev/null; do
  T=$(hottest); echo "$(date -Is) ${T}C" >> heat-guard.log
  if [ "${T:-0}" -ge "$STOP" ]; then
    kill -KILL -- -"$PID" 2>/dev/null
    echo "$(date -Is) STOPPED at ${T}C" | tee -a heat-guard.log
    until [ "$(hottest)" -lt "$RESUME" ]; do sleep 10; done
    exit 75
  fi
  sleep 5
done
wait "$PID"
```

The reference guard's cooldown `until` loop has no maximum wait: on a box that never cools below the resume
temperature it waits forever. Give any copy a hard limit.

Machine profiles and heat pauses in the runner (item 57.1a, `scripts/support/machine-profiles.json`,
`scripts/support/heat.mjs`): `MARGO_MACHINE_PROFILE` picks `workstation` (default: no heat watch, every test as one
step), `mini-pc`, `laptop` (heat watch at 88 C, excludes nothing) or `thermal-limited` by name, never by hostname. A heat profile makes `check:gpu-packages` watch the
same sensor as the guard (hottest thermal zone, or `MARGO_THERMAL_FILE`) a little below the guard's stop, so the guard
stays the machine-level safety net. Outcomes the runner prints, one line per step in its summary:

| Line | Meaning | Exit |
| --- | --- | --- |
| `PASS ... (paused for heat once: peak 81 C, stopped at 81 C (...), resumed at 69 C after 412 s)` | the step reached the stop, its tree was ended, the GPU lock released, the machine cooled within the maximum wait, and the same step ran again and passed | 0 |
| `PAUSED FOR HEAT: NOT RESUMED <step> (still 72 C after the maximum wait of 45 min ...)` | the cooldown ran out; the rest of the run is `NOT RUN` with that reason | 75 |
| `PAUSED FOR HEAT: NOT RESUMED <step> (this step reached the stop 3 times ...)` | the step does not fit the thermal budget; the run goes on with the next step | 75 |
| `EXCLUDED BY PROFILE <step> (excluded by profile thermal-limited: <reason>)` | the profile leaves the package out, with its stated reason | 0 |

A failure stays `FAIL` (exit 1). No limit is raised automatically and every wait is bounded. Split profiles run heavy
suites as short steps (one step per command of a `node ... && node ...` chain, or the argument sets in a package's
`margo.gpuTestSteps`), with the assertions unchanged. `scripts/nightly-full.mjs` takes its steps from the profile and
ends a night with an unresumed heat stop as `PAUSED-FOR-HEAT`.

`check:merge` (and `check:merge:full`) applies the same watch to every other step that drives the GPU (2026-10-30;
visual:check reached 88.9 C on the laptop with none): `build:site`, `visual:check`, `check:views`, `check:depth`,
`check:wgsl`, `modern:test:packages`, `check:no-webgpu`, `modern:test:bundlers` and `check:quickstart` each run
through the runner's own `runPlan`, as one step: at `stopC` the step's process tree is ended, the run waits (at most
`maxWaitMin`) for `resumeC` and runs that step again from its start, at most `maxResumesPerStep` times. Only
`verify` and `check:fresh-clone` (no GPU) are unwatched, and `check:gpu-packages` is not watched twice: it watches
each of its tests itself, and its exit 75 counts as a heat stop. Only a step the watch ended runs again; a step that
fails on its own is `FAILED at <step>` and is never rerun for heat, so the rerun is not retry-until-green. The
summary prints `PAUSED FOR HEAT during <step> ...` per pause and ends `PASSED AFTER A HEAT PAUSE`, or
`PAUSED FOR HEAT: NOT RESUMED at <step>` (exit 75, the rest not run); `test-results/check-merge.json` carries
`profile`, `pausedForHeat`, `heatStopped` and each step's `pauses`. A heat profile with no reading stops before
`verify`. The workstation profile (`heat` null) runs every step exactly as before. Pinned by
`tests/check-merge-heat.test.js`.

### 2.16 Failure modes and what we saw

1. Fixed dev-server port shared by suites: a 5 s check waited silently behind another suite's run and was killed at
   10 min (bug 38b). Fix: free ports, progress lines.
2. Shared Vite cache: 504 "Outdated Optimize Dep", page never ready, about 1 in 38 runs (bug 26). Fix: one cache per
   server; worktrees do not link dot folders.
3. Teardown order: closing the server before the browser never called back; a passing suite killed at 600 s (bug 30).
4. GPU lock found by path suffix: worktrees outside `.claude/worktrees/` took a lock of their own (bug 62; fix not on
   main at `67ca53a5`).
5. Under the landing lock the inherited `MARGO_GPU_LOCK` made GPU tests skip the GPU lock and fail exclusive requests
   (fixed; see the comment in 2.2.9).
6. `bash -c "..."` through the wrapper on Windows: split by cmd.exe (rule 2).
7. GPU driver resets failed random steps at their timeouts with no explanation (bug 25). Fix: device-loss guard names
   the reset at once; one recorded rerun after a confirmed reset.
8. Engine watchdog resets (141) cut submissions short without losing the device: silent wrong results. Only the event
   log shows them.
9. Wrong GPU after a reboot: headless Edge on adapter 0, which depends on where the session's display is (bug 33).
   Fix: LUID chosen at launch.
10. Kernel crash in `bindflt.sys` during heavy file opens by `node.exe` (bug 32b). Mitigated, not fixed.
11. Flaky tests under load: heap-growth test (bug 34), clipboard shared by every process (bug 35), a per-frame movement
    check that a legitimate slow frame broke (bug 37). Each traced to a cause, not retried.
12. A unit-test step ran 3,338 s once with no record of the hung test (bug 27, open).
13. A step's time limit counted time spent queueing for a lock or a port (bug 20, then traced to bug 25 and 38b). Rule:
    measure a step's timeout from when it holds its resources and report lock wait separately.
14. A child process exited `0xC0000142` (failed to start) under heavy load once (bug 26b note: "Windows desktop heap
    with many processes"); not reproduced.
15. A thermal watchdog on a small Linux box kept killing jobs while the box stayed above 90 C (bug 40). Rule: no heavy
    jobs there at all.

### 2.17 How to replicate system 2 from scratch

Build in this order (each step is usable alone):

1. `test-results/` git-ignored; all locks, logs and per-run scripts go there.
2. The lock script (2.5 reference version, or a copy of the design in 2.2): exclusive mode, queue, heartbeat, stale
   reclaim, hold and wait limits, tree kill, `status`. Find the main checkout with `git rev-parse --git-common-dir`.
   Write the tests from the titles in 2.2.11 before relying on it.
3. A worktree setup script that links `node_modules` by junction or symlink, never links tool caches, links the repo's
   own packages to the worktree, and registers merge drivers.
4. Merge drivers for generated files (`derived`: keep main's copy; `ratchet`: limits only shrink) and one
   `land-records` script that regenerates and commits records once per landing at the rebased HEAD.
5. The landing script pattern (2.6.2) with `set -e`, rebase, regenerate, full check, discard rewritten records,
   records commit, verify, identity check, push, `LANDED <hash>`.
6. A pre-merge check runner that reads its steps from one place, classifies every step, runs affected work only, and
   runs everything when unsure (2.10). Print the mode and reason first; write a JSON result.
7. Hard timeouts on every step and every test (`timeout`, a per-test limiter that kills the tree).
8. Bounded teardown for browser suites (context, browser, connections, servers, child trees; one budget).
9. Per-suite dev-server cache and free ports.
10. Host fault detection: an event-log reader (Windows) and a device-loss guard; one printed, recorded rerun only after
    a confirmed host fault; a distinct "PASSED WITH ..." marker and a JSON flag.
11. Explicit GPU choice on multi-GPU Windows machines (LUID at launch), with an override and an assertion of the
    adapter actually used.
12. A nightly full run in a detached worktree, under the exclusive GPU lock, from the OS scheduler, with a skip flag and
    a dated log. Add a failure notice.
13. Health loggers (GPU temperature and clocks; processes and lock holders per minute) with their own end times.
14. A worktree cleanup script: dry run by default, merged and clean only, unlink junctions before deleting.

Generic reference version, not from the repo: a minimal landing script for a new project.

```bash
#!/bin/bash
# land.sh: run inside the landing lock, in the BACKGROUND:
#   LOCK_DIR=<repo>/test-results/land.lock node <repo>/scripts/lock.mjs run --holder=<task> --max=170 --wait-max=240 -- bash <worktree>/test-results/land.sh > <worktree>/test-results/land.log 2>&1 &
set -euo pipefail
cd "<worktree>"
ID="<you>@users.noreply.example"
export GIT_AUTHOR_EMAIL=$ID GIT_COMMITTER_EMAIL=$ID
git fetch -q origin
git rebase origin/main                         # a batch: rebase each branch onto the batch tip in order (2.6.5)
# No build, API check, quality, proofs, unit tests or package pack here: check:merge starts with verify and runs them.
node scripts/regenerate-docs.mjs && git add -A docs/generated && { git diff --cached --quiet || git commit --amend --no-edit -q; }
node scripts/worktree-setup.mjs
timeout 5400 npm run check:merge
git checkout -- records/                       # discard records the checks rewrote
test -z "$(git status --porcelain)" || { git status --short; echo "DIRTY TREE"; exit 1; }
node scripts/land-records.mjs --no-build      # one records commit at HEAD; verify's build is still current
timeout 3000 npm run verify
bad=$(git log --format='%ae %ce' origin/main..HEAD | grep -v "^$ID $ID\$" || true)
[ -z "$bad" ] || { echo "WRONG IDENTITY: $bad"; exit 1; }
git push origin HEAD:main
echo "LANDED $(git rev-parse HEAD)"
```

Generic reference version, not from the repo: a minimal Windows driver-reset lookup to wrap any step.

```powershell
# resets.ps1 -Since <ISO time>: prints GPU driver resets since then as JSON lines (read only).
param([string]$Since)
$s = [DateTime]::Parse($Since).ToLocalTime()
Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='nvlddmkm','amdkmdag','amdwddmg','igfx','Display'; Level=1,2,3; StartTime=$s} -ErrorAction SilentlyContinue |
  Where-Object { $_.ProviderName -ne 'Display' -or $_.Id -eq 4101 } |
  ForEach-Object { [pscustomobject]@{ at = $_.TimeCreated.ToUniversalTime().ToString('o'); source = $_.ProviderName; id = $_.Id } | ConvertTo-Json -Compress }
Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Windows Error Reporting'; Id=1001; StartTime=$s} -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -match 'LiveKernelEvent' -and $_.Message -match 'P1: (141|117|1a8|1a1)' } |
  ForEach-Object { [pscustomobject]@{ at = $_.TimeCreated.ToUniversalTime().ToString('o'); source = 'LiveKernelEvent'; id = $Matches[1] } | ConvertTo-Json -Compress }
```

Use: record the start time, run the step; on failure wait 5 s, run `resets.ps1 -Since <start minus 10 s>`; rerun the
step once only if it prints a line, and print and record both runs. Remember that WER may file the same dump again
later; the real script dedupes by dump name (2.15.2).

---

## 3. Memory architecture and the deterministic Wasm kernel

### 3.1 Files and build

| File | Role |
| --- | --- |
| `packages/kernel/Cargo.toml` | Crate `margoengine-kernel`, `cdylib` + `rlib`, release profile tuned for size and speed. |
| `packages/kernel/Cargo.lock` | Locked; CI runs `cargo test --locked`. |
| `packages/kernel/src/lib.rs` | The whole kernel (475 lines): layout constants, `Kernel` struct, tick, change tracking, culling, exports, native unit tests. |
| `rust-toolchain.toml` | Pins Rust 1.99.0, profile minimal, target `wasm32-unknown-unknown`. |
| `scripts/build-modern.js` | Builds the Wasm (cargo + wasm-opt), checks it, deflates it and writes `packages/core/src/wasm.ts`. |
| `packages/core/src/wasm.ts` | Generated: the kernel as base64 of raw deflate. Excluded from Biome. |
| `packages/core/src/kernel.ts` | `TransformStore`: instantiates the Wasm, binds typed-array views, grows, ticks. |
| `packages/core/src/engine.ts` | Slot allocation, transform setters, per-frame tick and instance collection. |
| `scripts/kernel-opt-experiment.js` | Isolated opt-level comparison. Stale at 67ca53a5 (see 3.11). |

```toml
# packages/kernel/Cargo.toml @ 67ca53a5 (one metadata field omitted)
[package]
name = "margoengine-kernel"
version = "0.1.0"
edition = "2024"
publish = false

[lib]
crate-type = ["cdylib", "rlib"]

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"
overflow-checks = false
strip = "symbols"
```

```toml
# rust-toolchain.toml @ 67ca53a5
[toolchain]
channel = "1.99.0"
profile = "minimal"
targets = ["wasm32-unknown-unknown"]
```

The `rlib` crate type exists so `cargo test` can run the same code natively (`Vec<f32>` storage instead of a static
slice); see 3.12.

#### Build steps (VERIFIED in `scripts/build-modern.js`)

1. Unless `--precompiled` is passed: `cargo build --manifest-path packages/kernel/Cargo.toml --target
   wasm32-unknown-unknown --release` with `RUSTFLAGS=-C target-feature=+simd128` and
   `CARGO_TARGET_DIR=packages/kernel/target`.
2. Unless `--precompiled`: `wasm-opt` from the `binaryen` npm package with `-Oz -ocimfs 300`, SIMD, bulk memory and
   non-trapping float-to-int enabled, debug info, producers and target features stripped, `--converge`.
3. With `--precompiled`: the Wasm is decoded back out of `packages/core/src/wasm.ts` instead.
4. Either way: assert size under 30 KiB, assert `WebAssembly.validate`, deflate (raw, level 9, memLevel 6, windowBits
   12), assert the round trip is lossless.
5. Unless `--precompiled`: write `wasm.ts`.

```js
// scripts/build-modern.js @ 67ca53a5 (cut)
const wasmPath = 'packages/kernel/target/wasm32-unknown-unknown/release/margoengine_kernel.wasm',
  optimizedPath = wasmPath.replace('.wasm', '.optimized.wasm');
if (!precompiled)
  execFileSync(
    'cargo',
    ['build', '--manifest-path', 'packages/kernel/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        CARGO_TARGET_DIR: resolve('packages/kernel/target'),
        RUSTFLAGS: '-C target-feature=+simd128',
      },
    },
  );
// ... (the build passes -Oz and -ocimfs 300 to wasm-opt; its comment records 3.5 vs 4.8 ms per tick at 100k entities)
const wasm = precompiled
  ? inflateRawSync(
      Buffer.from(
        /wasmBase64(?::\s*string)?\s*=\s*'([^']+)'/.exec(await readFile('packages/core/src/wasm.ts', 'utf8'))[1],
        'base64',
      ),
    )
  : await readFile(optimizedPath);
assert.ok(wasm.length < 30 * 1024, `Kernel exceeds 30 KiB: ${wasm.length}`);
assert.ok(WebAssembly.validate(wasm), 'Invalid Wasm artifact');
// -Oz and raw deflate measured smallest for core + stage, with identical kernel output and speed (test-results/wasm-opt-bench.mjs).
const compressedWasm = deflateRawSync(wasm, { level: 9, memLevel: 6, windowBits: 12 });
assert.deepEqual(inflateRawSync(compressedWasm), wasm, 'Kernel compression must be lossless');
if (!precompiled)
  await writeFile(
    'packages/core/src/wasm.ts',
    `// Generated raw-deflate blueprint; consumers need no Rust toolchain.\nexport const wasmBase64: string = '${compressedWasm.toString('base64')}';\n`,
  );
```

`package.json` @ 67ca53a5: `build:packages` = `node scripts/build-modern.js --precompiled` (what `verify` and CI use);
`modern:build` = `node scripts/build-modern.js` (rebuilds the Wasm from Rust); `test:kernel` = `cargo test --locked
--manifest-path packages/kernel/Cargo.toml`.

Measured while writing this, by decoding `packages/core/src/wasm.ts` @ 67ca53a5: 3,435 B deflated, 9,011 B raw Wasm.
Exports: `memory`, `kernel_new`, `kernel_data`, `kernel_flags`, `kernel_tick`, `kernel_sync_rotation`, `kernel_drop`.
The file comment says `test-results/wasm-opt-bench.mjs` measured the choice; that file is under `test-results/` and
NOT VERIFIED (not in the tree read).

### 3.2 Linear memory layout

One Wasm instance holds one kernel. The kernel owns one float region and one byte region, both carved out of linear
memory starting at `__heap_base` (4-byte aligned). `n` is the capacity in slots; `TAIL` is 24 floats.

```rust
// packages/kernel/src/lib.rs @ 67ca53a5
// Each Wasm instance owns one fixed-capacity kernel; no allocations occur in tick. JS grows it by dropping it and
// creating a larger one at the same address (TransformStore.grow); at most 2^23 slots keep the layout under 4 GiB.
// Columns: translation X..SZ, PARENTS, WORLD_MATRIX (16 floats), LOCAL_SPHERE (4), WORLD_SPHERE..WORLD_R.
// PLANES is TAIL frustum floats, then Euler XYZ at PLANES * n + TAIL. LIMITS is six min/max pairs at LIMITS * n + TAIL.
// SCRATCH_MATRIX, SCRATCH_SPHERE and SNAPSHOT follow. Flags: ACTIVE, VISIBLE, CONSTRAINED, HIDDEN,
// DEPTH (low 7 bits, bit 128 hidden), TICK_STATE, CHANGED. `flags[id]` is ACTIVE. ROTATION is the Euler constraint mask.
const X: usize = 0;
const Y: usize = 1;
const Z: usize = 2;
const QX: usize = 3;
const QY: usize = 4;
const QZ: usize = 5;
const QW: usize = 6;
const SX: usize = 7;
const SY: usize = 8;
const SZ: usize = 9;
const PARENTS: usize = 10;
const WORLD_MATRIX: usize = 11;
const LOCAL_SPHERE: usize = 27;
const WORLD_SPHERE: usize = 31;
const WORLD_Y: usize = 32;
const WORLD_Z: usize = 33;
const WORLD_R: usize = 34;
const PLANES: usize = 35;
const LIMITS: usize = 38;
const SCRATCH_MATRIX: usize = 50;
const SCRATCH_SPHERE: usize = 66;
const SNAPSHOT: usize = 70;
const TAIL: usize = 24;
const DATA_LANES: usize = 86;
const ACTIVE: usize = 0;
const VISIBLE: usize = 1;
const CONSTRAINED: usize = 2;
const HIDDEN: usize = 3;
const DEPTH: usize = 4;
const TICK_STATE: usize = 5;
const CHANGED: usize = 6;
const FLAG_LANES: usize = 7;
const ROTATION: u8 = 56;
```

Float region (`DATA_LANES * n + TAIL` f32 values). Index of entity `id`:

| Lanes | Name | Index formula | Shape | Written by |
| --- | --- | --- | --- | --- |
| 0..2 | X, Y, Z | `c*n + id` | SoA column each | JS setters |
| 3..6 | QX, QY, QZ, QW | `c*n + id` | SoA column each | JS `setQuaternion`, kernel `sync_rotation` |
| 7..9 | SX, SY, SZ | `c*n + id` | SoA column each | JS setters |
| 10 | PARENTS | `10n + id` | SoA, parent id as f32, -1 for none | JS `setParent` |
| 11..26 | WORLD_MATRIX | `11n + id*16 + k` | 16 floats per entity (column-major) | kernel, published after validation |
| 27..30 | LOCAL_SPHERE | `27n + id*4 + k` | 4 per entity: centre xyz, radius | JS (geometry bounds) |
| 31..34 | WORLD_SPHERE, WORLD_Y, WORLD_Z, WORLD_R | `c*n + id` | SoA columns (so culling loads 4 entities per SIMD lane) | kernel |
| 35..37 | PLANES | `35n + p` for p < 24, then Euler at `35n + 24 + id*3 + axis` | 24 frustum floats (6 planes x 4), then 3 per entity | JS (`store.planes.set`), JS Euler writes |
| 38..49 | LIMITS | `38n + 24 + id*12 + axis*2 (+1)` | 6 min/max pairs per entity (3 translation, 3 Euler) | JS |
| 50..65 | SCRATCH_MATRIX | `50n + 24 + id*16 + k` | 16 per entity | kernel (staging) |
| 66..69 | SCRATCH_SPHERE | `66n + 24 + id*4 + k` | 4 per entity | kernel (staging) |
| 70..85 | SNAPSHOT | `70n + 24 + id*16 + k` | 16 per entity (bit copies of inputs) | kernel |

Byte region (`FLAG_LANES * n` bytes, placed right after the floats):

| Lane | Name | Meaning |
| --- | --- | --- |
| 0 | ACTIVE | 1 when the slot holds a live entity |
| 1 | VISIBLE | output: not hidden (self or ancestor) and inside the frustum when culling |
| 2 | CONSTRAINED | bit mask: bits 0..2 clamp X/Y/Z, bits 3..5 clamp Euler X/Y/Z (`ROTATION = 56` = bits 3..5) |
| 3 | HIDDEN | input: `mesh.visible = false` writes 1 |
| 4 | DEPTH | low 7 bits hierarchy depth, bit 128 "hidden through an ancestor" |
| 5 | TICK_STATE | per tick: 0 unvisited, 1 in progress, 2 done unchanged, 3 done recomputed |
| 6 | CHANGED | output: 1 when the world matrix was republished; sticky until the engine clears it |

Memory per slot: 86 x 4 = 344 B of floats plus 7 B of flags = 351 B by layout. `docs/limits.md` (row "Entities") and
`claims.md` LIM-003 record 352.1 B measured at 1,048,576 slots. The engine adds 5 B per slot outside the kernel
(`seen: Uint8Array`, `slots: Int32Array`; `packages/core/README.md`).

Why the mixed layout (inferred from the code, not stated in one place): SoA columns where the kernel streams one lane
over all entities (translation inputs, world spheres for 4-wide SIMD culling); per-entity blocks where the kernel or the
GPU wants a whole record (a 16-float matrix copied into an instance buffer with one `set`).

The 2^23 cap keeps `86 * 2^23 * 4 + 7 * 2^23` bytes (about 2.9 GiB) under the 4 GiB address space of wasm32.

### 3.3 Allocation inside Wasm and sharing with JS

`kernel_new` is the only allocator. In Wasm it uses a `static mut KERNEL: MaybeUninit<Kernel>` and an `INITIALIZED`
flag: one kernel per instance. It grows linear memory with `memory.grow` when the layout needs more pages, and never
shrinks it.

```rust
// packages/kernel/src/lib.rs @ 67ca53a5
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn kernel_new(capacity: usize) -> *mut Kernel {
    unsafe {
        if INITIALIZED || !(1..=1<<23).contains(&capacity) { return core::ptr::null_mut(); }
        let start = (core::ptr::addr_of!(__heap_base) as usize+3)&!3;
        let length = capacity*DATA_LANES+TAIL;
        let end = start+length*4+capacity*FLAG_LANES;
        let required = end.div_ceil(65536);
        let current = core::arch::wasm32::memory_size::<0>();
        if required>current && core::arch::wasm32::memory_grow::<0>(required-current)==usize::MAX { return core::ptr::null_mut(); }
        let data = core::slice::from_raw_parts_mut(start as *mut f32,length);
        let flags = core::slice::from_raw_parts_mut((start+length*4) as *mut u8,capacity*FLAG_LANES);
        data.fill(0.0); flags.fill(0); data.get_unchecked_mut(PARENTS*capacity..(PARENTS+1)*capacity).fill(-1.0);
        let handle = core::ptr::addr_of_mut!(KERNEL).cast::<Kernel>();
        handle.write(Kernel {capacity,data,flags,full:true}); INITIALIZED=true; handle
    }
}
```

```rust
// packages/kernel/src/lib.rs @ 67ca53a5
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kernel_data(kernel: *mut Kernel) -> *mut f32 { unsafe { (*kernel).data.as_mut_ptr() } }
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kernel_flags(kernel: *mut Kernel) -> *mut u8 { unsafe { (*kernel).flags.as_mut_ptr() } }
// ...
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kernel_drop(kernel: *mut Kernel) {
    unsafe { if !kernel.is_null() { (*kernel).flags.fill(0); INITIALIZED=false; } }
}
```

Pointers: `kernel_data` and `kernel_flags` return byte offsets into `memory.buffer`. JS builds every view from them.

The unchecked accessors are justified in a SAFETY comment: every index is inside the regions by layout, the parent id
is validated before use, and `kernel_sync_rotation` checks its id. The comment says dropping slice bounds checks saves
about 2 KB of Wasm and that "every value, finiteness, hierarchy and capacity check stays".

#### JS binding (VERIFIED in `packages/core/src/kernel.ts`)

1. `TransformStore.create(capacity = 1024)` compiles the module once per page (cached promise, cleared on failure):
   base64 decode, `DecompressionStream('deflate-raw')`, `WebAssembly.compile`. Each store gets its own instance.
2. `bind(capacity)` checks `1 <= capacity <= 2^23`, calls `kernel_new`, and builds every view over
   `api.memory.buffer` at `offset + lane * capacity * 4`.

```ts
// packages/core/src/kernel.ts @ 67ca53a5 (cut)
  private bind(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1 << 23)
      throw rangeError('Capacity: 1..8388608', 'limits');
    const api = this.api,
      handle = api.kernel_new(capacity);
    if (!handle) throw fault('failed', 'Transform allocation', 'limits');
    const offset = api.kernel_data(handle),
      flags = api.kernel_flags(handle),
      buffer = api.memory.buffer;
    const floats = (at: number, length = capacity) => new Float32Array(buffer, offset + at * 4, length),
      bytes = (column: number) => new Uint8Array(buffer, flags + column * capacity, capacity);
    this.handle = handle;
    // ...
    Object.assign(this, {
      capacity,
      transforms: {
        x: floats(X * capacity),
        // ... y, z, qx, qy, qz, qw, sx, sy, sz the same way
      },
      parents: floats(PARENTS * capacity),
      matrices: floats(WORLD_MATRIX * capacity, 16 * capacity),
      bounds: floats(LOCAL_SPHERE * capacity, 4 * capacity),
      planes: floats(PLANES * capacity, TAIL),
      rotations: floats(PLANES * capacity + TAIL, 3 * capacity),
      limits: floats(LIMITS * capacity + TAIL, 12 * capacity),
      active: bytes(ACTIVE),
      visible: bytes(VISIBLE),
      constrained: bytes(CONSTRAINED),
      hidden: bytes(HIDDEN),
      changed: bytes(CHANGED),
    });
  }
```

The column constants are duplicated in `kernel.ts` with the comment "Same columns as packages/kernel/src/lib.rs". No
automated check compares the two lists (NOT VERIFIED that one exists; none found). A drift would show up as wrong
matrices in the dirty-transform and kernel tests.

The class comment states the contract for callers:

```ts
// packages/core/src/kernel.ts @ 67ca53a5
/** Column views into the kernel's Wasm memory. `grow` replaces every view (old ones are detached or alias the new layout): re-read them (and `Mesh.matrix`) after creating meshes, never keep them. */
```

### 3.4 Slot allocation: free list first, then doubling

```ts
// packages/core/src/engine.ts @ 67ca53a5 (createMesh, cut)
    const id = this.free.pop() ?? this.next++;
    // Double the store when full (seen and slots are rebuilt by the full collection the new mesh forces).
    if (id >= this.store.capacity)
      try {
        const size = Math.min(id * 2, 1 << 23);
        this.seen = new Uint8Array(size);
        this.slots = new Int32Array(size);
        this.store.grow(size);
        this.meshes.forEach(views);
      } catch (error) {
        this.next = id;
        throw error;
      }
    const t = this.store.transforms;
    for (const key of ['x', 'y', 'z', 'qx', 'qy', 'qz'] as const) t[key][id] = 0;
    for (const key of ['qw', 'sx', 'sy', 'sz'] as const) t[key][id] = 1;
    this.store.parents[id] = -1;
    this.store.constrained[id] = 0;
    this.store.hidden[id] = 0;
    this.store.rotations.fill(0, id * 3, id * 3 + 3);
```

```ts
// packages/core/src/engine.ts @ 67ca53a5 (remove, cut)
    this.store.active[mesh.id] = 0;
    this.store.visible[mesh.id] = 0;
    this.free.push(mesh.id);
```

- `free` is a plain `number[]` used as a stack (LIFO). Removed ids are reused before `next` advances.
- A new id equal to `capacity` doubles the store (`id * 2`), capped at 2^23. Past the cap `grow` throws `RangeError:
  Capacity` and `next` is rolled back.
- A reused slot is reset field by field (translation 0, quaternion identity, scale 1, no parent, no constraint, not
  hidden, Euler 0). Bounds are written later by `setGeometry`.
- `views(mesh)` rebinds `mesh.matrix` (a `subarray` of `store.matrices`) for every live mesh after a growth.

### 3.5 Growth step by step

```ts
// packages/core/src/kernel.ts @ 67ca53a5
  grow(capacity: number): void {
    if (!(capacity > this.capacity)) throw rangeError('Capacity', 'limits');
    // Every typed-array view, in the same (assignment) order before and after bind.
    const views = () =>
      Object.values({ ...this.transforms, ...this }).filter(ArrayBuffer.isView) as (Float32Array | Uint8Array)[];
    const copies = views().map((view) => view.slice()),
      previous = this.capacity;
    this.api.kernel_drop(this.handle);
    try {
      this.bind(capacity);
    } catch (error) {
      this.bind(previous);
      throw error;
    } finally {
      views().forEach((view, i) => view.set(copies[i]));
    }
  }
```

1. Copy every view out to JS (`slice`). The new layout overlaps the old one (columns move to `lane * newCapacity`), so
   the data must leave Wasm memory first.
2. `kernel_drop` clears the flags and the "initialized" bit.
3. `kernel_new(newCapacity)` at the same start address; `memory.grow` if needed. A grow detaches the old
   `ArrayBuffer`, so every old view is now length 0. Without a grow the old views alias the new layout. Either way they
   are stale.
4. Build new views (`bind`).
5. Copy each old view into the start of its new view. Each view keeps its per-entity layout, so the old values are a
   prefix of the new view.
6. On failure, rebind at the old capacity and restore the copies, then rethrow: the store is unchanged.
7. The new kernel starts with `full = true`, so the next tick recomputes every entity once.

Cost: one JS copy of every view, about 351 B per slot. Not measured on its own (NOT VERIFIED that a timing exists).

### 3.6 Change detection and world-matrix order

There are no dirty flags and no descendant marking. Change detection is a per-entity snapshot of everything the world
matrix depends on, compared as bits:

```rust
// packages/kernel/src/lib.rs @ 67ca53a5
    // Stores everything world_matrix reads for one entity (TRS, parent, local bounds, hidden flag) and returns whether
    // any of it is different from the previous call. A failed tick sets `full`, so a snapshot taken by it is never trusted.
    // Lanes compare as bits, so signed zeros and NaN payloads count as changes. Wasm compares and stores four lanes at
    // once and always visits all four groups (bitwise `|`), so every changed lane is stored.
    #[inline(never)]
    fn snapshot(&mut self, id: usize) -> bool {
        let n = self.capacity;
        let lane = |k: &Self, f: usize| if f < PARENTS + 1 { k.float(f*n+id).to_bits() } else if f < PARENTS + 5 { k.float(LOCAL_SPHERE*n+id*4+f-(PARENTS+1)).to_bits() } else { k.flag(HIDDEN*n+id) as u32 };
        let at = SNAPSHOT*n+TAIL+id*16;
        #[cfg(target_arch = "wasm32")]
        unsafe {
            use core::arch::wasm32::*;
            let group = |k: &mut Self, g: usize| {
                let value = u32x4(lane(k, g*4), lane(k, g*4+1), lane(k, g*4+2), lane(k, g*4+3));
                let to = k.data.as_mut_ptr().add(at+g*4).cast::<v128>();
                let changed = v128_any_true(v128_xor(v128_load(to), value));
                if changed { v128_store(to, value); }
                changed
            };
            group(self, 0) | group(self, 1) | group(self, 2) | group(self, 3)
        }
        // ... native: a scalar loop over the same 16 lanes
    }
```

The 16 snapshot lanes: X, Y, Z, QX, QY, QZ, QW, SX, SY, SZ, PARENTS (11), the 4 local-sphere floats (15), the HIDDEN byte
(16).

```rust
// packages/kernel/src/lib.rs @ 67ca53a5
    // Returns whether the entity was recomputed: its inputs differ from the snapshot or its parent was recomputed.
    #[inline(never)]
    fn world_matrix(&mut self, id: usize, level: usize) -> Option<bool> {
        let n=self.capacity;let state=self.flag(TICK_STATE*n+id);
        if level>=64 || state==1 {return None;}
        if state!=0 {return Some(state==3);}
        self.set_flag(TICK_STATE*n+id,1);
        let mut changed=self.snapshot(id)|self.full;
        let parent=self.float(PARENTS*n+id);
        if parent!=-1.0 {
            if !parent.is_finite() || parent<0.0 || parent as usize as f32!=parent || parent>=n as f32 || self.flag(ACTIVE*n+parent as usize)==0 {return None;}
            changed|=self.world_matrix(parent as usize,level+1)?;
        }
        if changed {self.compute(id,parent)?;}
        self.set_flag(TICK_STATE*n+id,2+changed as u8);
        Some(changed)
    }
```

Order of a tick (`Kernel::tick`, VERIFIED):

1. If culling: reject the tick (`n + 1`) when any of the 24 plane floats is not finite.
2. Constraint validation pass over active constrained entities: value, min and max finite and `min <= max`, else
   return `id + 1`.
3. Constraint clamp pass: clamp each constrained axis; if any Euler axis is constrained, rebuild the quaternion
   (`sync_rotation`).
4. Clear `TICK_STATE` for all slots.
5. For `id` in `0..n` (index order), for each active entity: `world_matrix(id, 0)`. It recurses to the parent first,
   so a parent is always resolved before its child whatever their ids. `TICK_STATE` memoises (each entity is visited
   once) and detects cycles (state 1 seen again returns `None`). Depth over 64 fails.
6. `compute` writes into SCRATCH only. Any failure sets `full = true` and returns `id + 1`. Nothing is published.
7. Publish pass: for every active entity with `TICK_STATE == 3`, copy SCRATCH_MATRIX into WORLD_MATRIX and
   SCRATCH_SPHERE into the four WORLD_* columns, and set CHANGED = 1. Write VISIBLE from the hidden bit.
8. If culling: `cull()` clears VISIBLE for spheres fully outside any plane.
9. `full = false`; return 0.

"A changed parent marks its descendants" happens through step 5: `changed |= world_matrix(parent)`, so any entity whose
ancestor was recomputed is recomputed too. The unchanged path costs a snapshot compare plus the parent lookup.

```rust
// packages/kernel/src/lib.rs @ 67ca53a5 (compute, cut)
    // Separate so the two parent tests are not threaded together (which duplicates the matrix code).
    #[inline(never)]
    fn compute(&mut self, id: usize, parent: f32) -> Option<()> {
        let n=self.capacity;
        let mut matrix=self.matrix(id)?;let mut depth=1;let mut hidden=self.flag(HIDDEN*n+id)!=0;
        if parent!=-1.0 {
            let parent=parent as usize;let p=self.floats(SCRATCH_MATRIX*n+TAIL+parent*16,16);
            depth=(self.flag(DEPTH*n+parent)&127)+1;if depth>64 {return None;}
            hidden|=self.flag(DEPTH*n+parent)&128!=0;
            let mut result=[0.0;16];
            // Local transforms are affine; the last row is always [0, 0, 0, 1].
            // ... 3x4 multiply accumulated in f64, rounded to f32
            if result.iter().any(|v|!v.is_finite()) {return None;}
            matrix=result;
        }
        let sphere=self.sphere(id,&matrix)?;
        self.floats_mut(SCRATCH_MATRIX*n+TAIL+id*16,16).copy_from_slice(&matrix);
        self.floats_mut(SCRATCH_SPHERE*n+TAIL+id*4,4).copy_from_slice(&sphere);
        self.set_flag(DEPTH*n+id,depth|if hidden {128}else{0});
        Some(())
    }
```

Note: the child reads the parent's SCRATCH matrix, not its published WORLD matrix. SCRATCH holds the last computed
value for every entity (also unchanged ones), so it is always current after step 5.

Local matrix (`Kernel::matrix`): rejects non-finite TRS, zero scale and a zero quaternion; normalises the quaternion
in f64 with a SIMD `f64x2_sqrt`; builds a column-major TRS in f64 and rounds each element to f32.

### 3.7 Cached bounds and culling

```rust
// packages/kernel/src/lib.rs @ 67ca53a5
    fn sphere(&self, id: usize, m: &[f32; 16]) -> Option<[f32; 4]> {
        let b = self.floats(LOCAL_SPHERE*self.capacity+id*4, 4);
        if b.iter().any(|v| !v.is_finite()) || b[3] < 0.0 { return None; }
        let mut out = [0.0; 4];
        for row in 0..3 {
            out[row] = (m[row] as f64*b[0] as f64 + m[4+row] as f64*b[1] as f64 + m[8+row] as f64*b[2] as f64 + m[12+row] as f64) as f32;
        }
        if b[3]!=0.0 {let mut rows=[0.0;3];let mut cols=[0.0;3];
        for c in 0..3 {for r in 0..3 {let v=m[c*4+r].abs() as f64;rows[r]+=v;cols[c]+=v;}}
        let norm1=cols.into_iter().fold(0.0,f64::max);let norm_inf=rows.into_iter().fold(0.0,f64::max);
        out[3] = (b[3] as f64 * sqrt(norm1*norm_inf)) as f32;}
        out.iter().all(|v| v.is_finite()).then_some(out)
    }
```

- World centre: the local centre transformed by the world matrix.
- World radius: `r * sqrt(norm1 * normInf)` of the 3x3 part. `sqrt(||A||_1 ||A||_inf)` is an upper bound of the
  spectral norm, so the sphere is conservative under non-uniform scale and shear.
- Bounds are recomputed only when the entity is recomputed (they are part of its snapshot and output).
- Culling: 6 planes x 4 floats in the PLANES head. An entity is culled when `dot(plane, centre) + d < -r` for any
  plane, so a sphere touching a plane stays visible (`culling_includes_touching_and_ignores_inactive_slots`). Wasm
  culls 4 entities at once from the SoA WORLD_* columns; the remainder loop is scalar. The code says: "shortcut: linear
  sphere culling, add a spatial index when measured scenes need it."

### 3.8 Rotations and joint limits

- Euler XYZ radians live in the PLANES region after the 24 plane floats (`store.rotations`).
- `Kernel::sync_rotation` is "the only XYZ (qX * qY * qZ) expansion". It uses the kernel's own `sin` (range reduction
  by `TAU` and an 11-term Taylor series in f64) for both sine and cosine (`cos(a) = sin(a + pi/2)`).
- JS calls it through `kernel_sync_rotation` after every Euler write (3.9). The tick calls it after clamping a
  constrained Euler axis, so a clamped rotation and a direct write give the same bits
  (`sync_rotation_matches_a_constrained_tick_and_ignores_a_bad_id`).

```rust
// packages/kernel/src/lib.rs @ 67ca53a5
fn sin(value:f64)->f64 {
    #[cfg(target_arch = "wasm32")]
    let turns = {use core::arch::wasm32::*;f64x2_extract_lane::<0>(f64x2_nearest(f64x2_splat(value/core::f64::consts::TAU)))};
    #[cfg(not(target_arch = "wasm32"))]
    let turns=(value/core::f64::consts::TAU).round();
    let x=value-turns*core::f64::consts::TAU;let mut term=x;let mut sum=x;for i in 1..12 {term *= -x*x/((2*i)*(2*i+1)) as f64;sum+=term;}sum
}
```

Observation while reading (NOT VERIFIED to matter): Wasm `f64x2_nearest` rounds ties to even, native `f64::round`
rounds ties away from zero. The native unit tests and the shipped Wasm could therefore pick a different `turns` when
`value / TAU` is exactly half-way. No test covers that case.

### 3.9 The frame loop: what JS does, bridge calls and allocation

#### Setters (VERIFIED in `engine.ts`)

| Call | What it writes | Wasm calls |
| --- | --- | --- |
| `mesh.position.x = v`, `.set(x, y, z)`, `setPosition` | `store.transforms.x/y/z[id]` | none |
| `mesh.scale...`, `setScale` | `store.transforms.sx/sy/sz[id]` | none |
| `mesh.rotation.x = v`, `.set`, `setRotation` | `store.rotations[id*3 + axis]` | one `kernel_sync_rotation` per write (per `set` call for `.set`) |
| `setQuaternion(q)` | qx..qw (normalised) and the Euler lanes (computed in JS with `asin`/`atan2`) | none |
| `setParent(p)` | `store.parents[id]` after a JS cycle and depth walk (max 64) | none |
| `mesh.visible = b` | `store.hidden[id]` | none |

Every setter validates first (`Math.fround(value)` finite, scale not 0, quaternion not 0), throws a coded
`RangeError`, and writes straight into the typed-array view. There is no JS-side copy of transforms.

```ts
// packages/core/src/engine.ts @ 67ca53a5
  setQuaternion(value: readonly number[]): this {
    this.check();
    finite(value, 4, 'Quaternion');
    // No spread or map: physics and animation call this for every moving body each frame.
    const length = Math.hypot(value[0], value[1], value[2], value[3]);
    if (!length) throw rangeError('Quaternion nonzero', 'transform');
    const x = value[0] / length,
      y = value[1] / length,
      z = value[2] / length,
      w = value[3] / length,
      t = this.engine.store.transforms,
      id = this.id;
    t.qx[id] = x;
    t.qy[id] = y;
    t.qz[id] = z;
    t.qw[id] = w;
    const lanes = this.engine.store.rotations,
      at = id * 3;
    lanes[at + 1] = Math.asin(Math.max(-1, Math.min(1, 2 * (x * z + w * y))));
    lanes[at] = Math.atan2(2 * (w * x - y * z), 1 - 2 * (y * y + z * z));
    lanes[at + 2] = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
    return this;
  }
```

#### Per frame (VERIFIED in `Engine.update` and `collectInstances`)

1. Plugin `onPreUpdate`, canvas resize, camera update.
2. `store.planes.set(camera.planes)`: 24 floats into Wasm memory.
3. `store.tick(culling)`: one `kernel_tick` call per drawn view (and once more for the main camera after a views
   frame). This is the only per-frame Wasm call that does not depend on entity count.
4. `collectInstances`:
   - a full collection when the mesh set, scene, layers or any material value changed, or when any `visible[id]`
     is different from the last collection's `seen[id]` (a JS loop over `next` bytes every frame);
   - otherwise a patch: walk `changed.indexOf(1, ...)`, clear each byte, copy `mesh.matrix` (a precomputed subarray)
     into that batch's instance array at its slot, and widen the batch's dirty range.
5. The renderer uploads each batch's dirty range once per frame.

Per-entity bridge overhead: zero Wasm calls per entity per frame, except one `kernel_sync_rotation` per Euler rotation
write. Per-entity JS work per frame: one byte compare (`visible` vs `seen`) for every slot, plus one 16-float copy per
entity whose matrix changed. The cost of a single `kernel_sync_rotation` call is NOT measured anywhere in the repository.

Allocation: the patch path and the setters create no arrays or objects (by reading the code). The only guard that
asserts it is `tests/core-set-quaternion.test.js`, which counts array iteration and `map` calls, not heap bytes:

```js
// tests/core-set-quaternion.test.js @ 67ca53a5 (cut)
// setQuaternion runs for every moving physics body and animated node each frame, so it must not build arrays:
// no spread (array iteration), no map, no destructuring of a fresh array.
test('setQuaternion normalizes and writes the rotation without building arrays', async (t) => {
  // ... engine with a stand-in renderer and TransformStore.create(4)
  mesh.setQuaternion(q); // warm up outside the count
  Array.prototype[Symbol.iterator] = function (...args) {
    counts.iterate++;
    return iterate.apply(this, args);
  };
  Array.prototype.map = function (...args) {
    counts.map++;
    return map.apply(this, args);
  };
  try {
    for (let i = 0; i < 1000; i++) mesh.setQuaternion(q);
  } finally {
    Array.prototype[Symbol.iterator] = iterate;
    Array.prototype.map = map;
  }
  assert.deepEqual(counts, { iterate: 0, map: 0 });
  // ...
});
```

Heap-growth measurements with `--expose-gc` exist in other packages (for example `packages/lod/test/lod.test.js` runs a
probe in its own process), not for core's setters.

The kernel itself never allocates in `tick` ("no allocations occur in tick", lib.rs header). Stack arrays only.

### 3.10 Errors and atomic publish

- `kernel_tick` returns 0 on success, `id + 1` for an invalid transform, bounds, parent or limit, and `n + 1` for an
  invalid frustum.
- `TransformStore.tick` turns that into `RangeError('Invalid transform/bounds: <id>', 'transform')` or
  `RangeError('Invalid frustum', 'camera')`.
- Nothing is published from a failed tick (SCRATCH is staging), and the next tick recomputes everything (`full`).
  Tests: `transforms_and_failed_updates_are_atomic`, and the million-entity test's "a failed tick publishes nothing".

### 3.11 Size and optimisation

| Item | Value | Source |
| --- | --- | --- |
| Raw Wasm limit | under 30 KiB, asserted at every build (also `--precompiled`) | `scripts/build-modern.js` |
| Raw Wasm today | 9,011 B (measured while writing this) | decoded from `packages/core/src/wasm.ts` |
| Embedded, deflated | 3,435 B before base64 (measured while writing this) | same |
| wasm-opt flags | `-Oz -ocimfs 300`, SIMD, bulk memory, non-trapping f2i, strip, converge | `scripts/build-modern.js` |
| Why `-ocimfs 300` | keeps the recompute path out of line so the unchanged path stays small; the comment records 3.5 vs 4.8 ms per tick at 100k entities | `scripts/build-modern.js` comment (DOCUMENTED) |
| Core + stage gzip, kernel included | 21,974 B at 777bca5b | `examples/package-benchmarks/results/entry-sizes.json` |

`scripts/kernel-opt-experiment.js` compares Cargo `opt-level = 3` against `"z"` in an isolated copy, checks
bit-for-bit parity of data and flags against the shipping kernel, times 31 interleaved samples per scenario, keeps the
variant only when gzip drops and no scenario is over 2% slower, and asserts that it changed none of the protected files
(by SHA-256).

Note: at 67ca53a5 the experiment is stale and cannot run as written.

- It decodes the shipping kernel with `gunzipSync`, but `build-modern.js` now writes raw deflate (`deflateRawSync`).
- It builds views of `capacity * 70 + 24` floats and `capacity * 5` flag bytes; the layout is now 86 float lanes and 7
  flag lanes.
- It compresses variants with gzip while the shipping path uses raw deflate, so its size comparison would not match
  the build either.

### 3.12 Tests that guard the kernel and the store

| Guard | Where | Runs in | Asserts |
| --- | --- | --- | --- |
| `transforms_and_failed_updates_are_atomic` | `packages/kernel/src/lib.rs` | CI `kernel` job (`cargo test --locked`) | TRS math; NaN input fails and keeps the previous output |
| `culling_includes_touching_and_ignores_inactive_slots` | lib.rs | CI kernel | touching sphere visible; inactive slot not visible |
| `parents_compose_and_cycles_reject` | lib.rs | CI kernel | composition; a two-node cycle fails |
| `joint_limits_clamp_in_rust_and_hidden_parents_keep_descendants_hidden` | lib.rs | CI kernel | clamps; hidden inherited |
| `only_changed_inputs_and_their_descendants_are_recomputed` | lib.rs | CI kernel | exact CHANGED sets after each edit; failed tick publishes nothing; next tick recomputes all |
| `sync_rotation_matches_a_constrained_tick_and_ignores_a_bad_id` | lib.rs | CI kernel | same quaternion bits both ways; bad id ignored |
| `layout_edges_preserve_validation_and_bitwise_change_tracking` | lib.rs | CI kernel | n = 1 and 257 (edge of SIMD groups); every rejection path; `-0.0` counts as a change |
| `snapshots_keep_every_lane_bitwise_at_both_allocation_edges` | lib.rs | CI kernel | every lane stored bitwise, NaN payloads, all four SIMD groups visited |
| "dirty transform propagation matches a full recompute" | `tests/core-dirty-transforms.test.js` | `npm run verify` (unit tests) | incremental matrices, instance data and visibility equal a fresh kernel's full recompute, bit for bit |
| "the store grows in place and keeps every value; failed growth and invalid capacities change nothing" | same | verify | values survive `grow(5)` from 3; views replaced; invalid capacities rejected |
| "one million entities: growth, 1% moves, 63-deep chains, removal and dispose match a fresh kernel bit for bit" | same, timeout 600 s | verify | capacity doubles 1,024 -> 1,048,576; an unchanged tick recomputes 0; 1% moves recompute exactly the movers and their descendants; removal and slot reuse; failed tick publishes nothing |
| setQuaternion builds no arrays | `tests/core-set-quaternion.test.js` | verify | 0 iterator and `map` calls in 1,000 calls |
| 30 KiB Wasm limit, validate, lossless deflate | `scripts/build-modern.js` | every build | asserts |
| core + stage under 25,000 B gzip | `scripts/core-budget.js` | every build and `measure:size` | asserts (5.2) |

```js
// tests/core-dirty-transforms.test.js @ 67ca53a5 (cut)
// The kernel recomputes only entities whose inputs or ancestors changed. Oracle: a fresh kernel given the same inputs
// computes everything from scratch; published matrices and visibility must match it bit for bit after every edit.
// ...
    assert.equal(engine.store.capacity, 2 ** 20, 'doubled from 1,024 to 1,048,576');
    // ...
    engine.store.tick(true);
    assert.equal(changedCount(engine.store), 0, 'an unchanged tick recomputes nothing');
    // Move 1%: every 100th entity (chain roots included, so whole chains follow).
    for (let i = 0; i < n; i += 100) meshes[i].position.y += 0.5;
    let expected = 0;
    for (let i = 0; i < n; i += 100) expected += chain - (i % chain); // the mover and the rest of its chain
    engine.store.tick(true);
    assert.equal(changedCount(engine.store), expected, '1% moved recomputes exactly them and their descendants');
```

Gaps:

- No gate rebuilds `lib.rs` and compares it with the embedded `wasm.ts`. A Rust change that is not followed by
  `npm run modern:build` ships the old Wasm while `cargo test` tests the new source. NOT VERIFIED that anything catches
  this; nothing found.
- `cargo test` runs the native build (`rlib`), not the Wasm. The Wasm paths (`v128` snapshot, SIMD culling, `nearest`)
  are covered only through the JS tests on the shipped Wasm.
- Whether the GitHub Actions jobs run is NOT VERIFIED.
- No property or fuzz test targets the kernel directly. `tests/fuzz-regressions.test.js` and `scripts/fuzz/` cover file
  parsers (NOT VERIFIED in detail for kernel inputs).

### 3.13 Recorded numbers about the kernel

| Number | Source (status) |
| --- | --- |
| 352.1 B of kernel memory per slot at 1,048,576 slots, 351 B by layout | `docs/limits.md` "Entities", `claims.md` LIM-003 (PROVEN there; the result file and command are named in that row) |
| static tick 3.3 ms at 100,006 entities, 20.2 ms at 499,992, 41.5 ms at 1,000,012; about 41 ns per entity per frame when nothing moves | `claims.md` LIM-004 (Node CPU timings, same Wasm, stand-in renderer) |
| above 1,048,576 slots: not measured | `docs/limits.md` |
| 1,024 initial slots, doubling to 8,388,608 | `claims.md` headline table, `packages/core/README.md` |

### 3.14 Determinism: what "bit for bit" means here

| Statement | Where it holds | How it is checked | Status |
| --- | --- | --- | --- |
| Incremental tick equals a full recompute | Same Wasm, same machine | `tests/core-dirty-transforms.test.js` (bits of every matrix and visibility) | VERIFIED |
| A clamped Euler and a direct Euler write give the same quaternion | Native kernel | `sync_rotation_matches_a_constrained_tick_and_ignores_a_bad_id` | VERIFIED |
| The kernel gives the same bits on every machine | Expected from the design: Wasm f32/f64 arithmetic is IEEE with round-to-nearest, `sqrt` is correctly rounded, the kernel uses its own `sin`, and no host `Math` function is called | No cross-machine test of the kernel | NOT VERIFIED |
| Precise WGSL maths equals the host mirror | RTX A6000 (reported share; asserted only within 2 ulp of the mirror) | `packages/compute/tests/compute-precise-browser.js` | VERIFIED as code; share is reported, not asserted |
| Precise WGSL maths within its ulp bound | A6000, Intel UHD (Mesa), Radeon 680M (sweep not committed); Intel Arc 140V NOT verified after the fix | 3.15 | see the matrix in 3.15.7 |
| Compat layer equals native WebGPU | 32 semantic probes, M3 features, compute check: same GPU (A6000) | `packages/webgl2-compat/test/*` | DOCUMENTED (roadmap, README) |
| Golden proof digests | Every supported Node, after bug 17's fix | `tests/proofs-golden.test.js` | VERIFIED as code |
| JS `Math.sin/cos/tan/pow/hypot` | Not promised across JS engines | `claims.md` "Host-rounded maths" | DOCUMENTED |

### 3.15 Precise float maths

#### 3.15.1 The problem

WGSL lets builtins be far from exact and lets compilers reassociate. The header of `packages/shared/precise-math.js`
records both:

```js
// packages/shared/precise-math.js @ 67ca53a5 (header, cut)
// Precise f32 elementary functions in WGSL, the same on every GPU. WGSL lets the builtins be far off: sin and cos 2^-11
// absolute inside [-pi, pi] and unbounded outside, atan and atan2 4096 ulp, asin and acos 6.8e-5 absolute, exp
// 3 + 2|x| ulp, log 2^-21 absolute near 1, pow unbounded and undefined for x < 0. Measured: an RTX A6000 (Dawn, D3D12)
// is within 3e-7 for sin and cos in [-pi, pi] but 1e-5 at |x| near 100, 133 ulp for tanh and 114 for pow; an Intel Arc
// 140V is 1.1e-5 off for sin and cos near 1.5. Code that compares the GPU with the CPU, or one GPU with another, uses
// these instead. Each is within 2 ulp of the exact value: sin, cos, acos, exp, exp2 and log within 1, asin and log2
// 1.5, tan 2.5, pow 2 while |y log2 x| < 16 and 5 beyond (the bounds are shown over dense inputs, with fused and
// unfused rounding and with the builtin division and sqrt at WGSL's limits, by tests/precise-math.test.js, and on the
// GPU by packages/compute/tests/compute-precise-browser.js).
// ...
// Only exactly rounded WGSL operations are relied on (+, -, *, comparisons, integer and bit operations, ldexp, floor,
// round); a fused multiply-add anywhere is allowed. The builtin division and sqrt are used only where their error is
// corrected or scaled away. Infinities and NaN follow Math.* where the GPU keeps them (WGSL may assume there are none).
//
// WGSL also lets a compiler reassociate (15.7.5), and real ones undo the classic tricks, which are zero in exact
// arithmetic: AMD's D3D12 compiler (Radeon 680M) folds (1 + x) - 1 to x, which took the correction out of log1p
// (preciseLog1p(5.963922e-8) gave 2^-23), adds the constants of (x + C1) + C2 and C1 + (x + C2) first and leaves
// fma unfused about half the time; Mesa on an Intel UHD (ADL-N, Vulkan) also folds (a + b) - a to b, adds the
// constants of C1 + (x + C2) first (pi/2 high and low words), factors a c + b c (a / b + r / b, which undid the
// division's correction) and regroups sums of differences, and there 14 of the 17 functions were out of bound
// (probes of 2026-10-27: what those drivers did then, not a promise either way). So every
// step whose rounding error matters takes its operands through pmHide, which rebuilds a value from its bits in
// integers: a compiler cannot see what a hidden value is made of, so the step is one operation it can only commute.
```

Methods named in the header (written clean room from public papers): Payne-Hanek reduction in integers with a 2/pi
bit table, Cody-Waite reduction by ln 2, Dekker exact products from 12-bit halves, minimax polynomial coefficients from
`scripts/precise-math-coefficients.mjs` (constants derived from pi, ln 2 and 2/pi at 600 bits).

Public functions (`PRECISE_FUNCTIONS`, 19): `preciseDiv`, `preciseSqrt`, `preciseSin`, `preciseCos`, `preciseTan`,
`preciseAtan`, `preciseAtan2`, `preciseAsin`, `preciseAcos`, `preciseExp`, `preciseExp2`, `preciseExpm1`, `preciseSinh`,
`preciseCosh`, `preciseTanh`, `preciseLog`, `preciseLog2`, `preciseLog1p`, `precisePow`. `preciseMathWgsl(names)`
returns the WGSL of the named functions with each helper once; nothing is built at import.

#### 3.15.2 Error-free transforms that exist

```wgsl
// packages/shared/precise-math.js @ 67ca53a5 (the pmBits piece, cut to the transforms)
fn pmSplit(v: f32) -> vec2f { let h = bitcast<f32>(bitcast<u32>(v) & 0xfffff000u); return vec2f(h, v - h); }
fn pmHide(v: f32) -> f32 {
 let b = bitcast<u32>(v);
 let e = (b >> 23u) & 0xffu;
 let m = i32((b & 0x7fffffu) | select(0x800000u, 0u, e == 0u));
 return ldexp(f32(select(m, -m, (b >> 31u) == 1u)), max(i32(e), 1) - 150);
}
fn pmFastTwoSum(a: f32, b: f32) -> vec2f { let s = a + b; return vec2f(s, pmHide(b - pmHide(pmHide(s) - a))); }
fn pmProductError(a: f32, b: f32, p: f32) -> f32 {
 let x = pmSplit(a); let y = pmSplit(b);
 return pmHide((((pmHide(x.x * y.x) - p) + pmHide(x.x * y.y)) + pmHide(x.y * y.x)) + x.y * y.y);
}
```

| Transform | Implemented as | Note |
| --- | --- | --- |
| Fast two-sum (Dekker) | `pmFastTwoSum(a, b)` | requires \|a\| >= \|b\| or a = 0 |
| Two-sum (Knuth, branch-free) | not implemented | Note: only the Dekker fast two-sum exists |
| Two-product | `pmProductError(a, b, p)` returns `a*b - p` exactly for `p = fl(a*b)` | halves cut from the bits (mask `0xfffff000`), so no FMA can change them |
| FMA emulation | not implemented | Note: the code tolerates fused or unfused rounding anywhere instead |
| Corrected division | `preciseDiv`: residual `a - q b` from exact products, one correction | about half an ulp |
| Corrected sqrt | `pmSqrt2`/`preciseSqrt`: residual `a - s s`, one correction, returned as hi + lo | about half an ulp |

```wgsl
// packages/shared/precise-math.js @ 67ca53a5
fn preciseDiv(a: f32, b: f32) -> f32 {
 let q = a / b;
 if (pmExponent(a) == 255u || pmExponent(b) == 255u || pmExponent(q) == 255u || pmExponent(q) == 0u) { return q; }
 let p = pmHide(q * b);
 let r = (a - p) - pmProductError(q, b, p);
 return q + pmHide(r / b);
}
```

#### 3.15.3 `pmHide`: why it works

- WGSL 15.7.5 allows reassociation. The classic error-free tricks compute a quantity that is zero in exact arithmetic,
  for example `(s - a) - b` after `s = a + b`. A compiler that treats floats as reals folds it to 0 and the error term
  disappears.
- A `bitcast` round trip does not stop this: the comment says the compilers see through it.
- `pmHide(v)` rebuilds `v` from its integer bits: sign, exponent and mantissa are extracted with integer operations, the
  mantissa is converted to f32 and scaled with `ldexp`. The result equals `v` exactly (for subnormals too, by the
  `max(e, 1)` and the hidden-bit select), but the compiler cannot prove that, so it cannot cancel the expression it came
  from. "The step is one operation it can only commute."
- Error terms are hidden on the way out too, so they are not regrouped with the large terms they came from.
- What remains for the compiler to regroup: the polynomials and small correction terms, where a regrouping moves a
  result by a small fraction of an ulp.

Symptom before the fix (`perf-history.md` entry 37): Radeon 680M (D3D12, Edge and Chrome 156) gave
`preciseLog1p(5.963922e-8) = 2^-23`, 8,383,741 ulp off (bound 2). Intel UHD (ADL-N, Mesa Vulkan, Linux): 14 of 17
functions out of bound. NVIDIA RTX A6000 and Intel Arc 140V passed the same code. Fix commit `b6bea3e9`; the factoring
case found later fixed in `baa66526`.

#### 3.15.4 The reassociation stand-in: `reassociateMath` in `scripts/browser.js`

A page init script that rewrites every shader module the page creates the way a reassociating compiler would, so the
GPU check fails on any GPU if the guard is missing.

```js
// scripts/browser.js @ 67ca53a5 (doc comment)
/**
 * Page init script for a compiler that reassociates floating-point sums, which WGSL allows ("An implementation may
 * reassociate operations", 15.7.5): every shader module's code has each sum that one of its own operands cancels
 * folded, as AMD's D3D12 compiler (Radeon 680M) does with (1.0 + x) - 1.0 and Mesa's Intel compiler with (a + b) - a.
 * After `let u = 1.0 + x;` `u - 1.0` becomes `x`; after `let s = a + b;` `s - a` becomes `b`; after `let t = 1.0 - h;`
 * `1.0 - t` becomes `h`; an inline `(1.0 + x) - 1.0` becomes `x`. An error-free transform written that way loses its
 * error term here as on those GPUs. Each sum is also factored by a term of its own, as Mesa's Intel compiler does:
 * `h + (l * c + (h * w) * p)` becomes `h * (1.0 + w * p) + l * c`. Comments are dropped.
 * `openBrowser({ reassociate: true })`, MARGO_REASSOCIATE_MATH=1 or `--reassociate-math` (the `:reassociate` scripts).
 */
```

How it hooks in: it replaces `GPUDevice.prototype.createShaderModule` with a wrapper that passes rewritten `code`.
`openBrowser` adds it with `page.addInitScript(reassociateMath)` when `MARGO_REASSOCIATE_MATH=1` or
`--reassociate-math` is set, and records `hardware.reassociateMath = true` in the result.

The first version only folded self-cancelling sums; an Intel UHD run then showed Mesa factoring the sine kernel
`h + (l (1 - w/2) + (h w) p)` into `h (1 + w p)`. `baa66526` added factoring to the stand-in; with it the old code
fails on NVIDIA too (sin 7,280 inputs over bound).

Host-side twin: `tests/precise-math.test.js` has "no sum in the precise maths is cancelled by its own operand, which
WGSL lets a compiler fold (bug 22)" and "no sum in the precise maths can be factored by a term of its own, as Mesa
factors h + h w p (bug 29)", so the WGSL text is checked without a GPU.

#### 3.15.5 The spec-math stand-in: `perturbBuiltinMath`

```js
// scripts/browser.js @ 67ca53a5 (cut)
/**
 * Page init script for a GPU whose builtin maths is as far off as WGSL allows: every shader module's calls of the
 * builtins below are rewritten to return a value off by `scale` times the specification's error bound (WGSL 15.8,
 * "Floating point accuracy"), deterministically: sin and cos 2^-11 absolute, tan the same relatively (within the bound
 * it inherits from sin / cos), asin and acos 6.77e-5 absolute, atan and atan2 4095 ulp, exp and exp2 3 ulp, log and
 * log2 2^-23 absolute, sqrt and inverseSqrt 4 and 2 ulp. ...
 */
export function perturbBuiltinMath(scale) {
  // ...
  const u = 2 ** -24,
    // name -> [factor, absolute term]: the result becomes builtin * factor + absolute.
    rules = {
      sin: [1 - scale * 2 ** -11, 0],
      cos: [1 - scale * 2 ** -11, 0],
      tan: [1 + scale * 2 ** -11, 0],
      asin: [1 - (scale * 6.77e-5) / (Math.PI / 2), 0],
      acos: [1 - (scale * 6.77e-5) / Math.PI, 0],
      atan: [1 + scale * 4095 * u, 0],
      atan2: [1 + scale * 4095 * u, 0],
      exp: [1 + scale * 3 * u, 0],
      exp2: [1 + scale * 3 * u, 0],
      // 2^-23 absolute: inside 2^-21 on [0.5, 2] and inside 3 ulp elsewhere (|log x| >= 0.69 there).
      log: [1, scale * 2 ** -23],
      log2: [1, scale * 2 ** -23],
      sqrt: [1 + scale * 4 * u, 0],
      inverseSqrt: [1 + scale * 2 * u, 0],
    };
  // ...
}
```

What is bounded and how: `pow` is not in the rule list (WGSL leaves it unbounded). A check that leans on one GPU's
good builtins passes on that GPU and fails on another; with `--spec-math-error=1` it fails on every GPU. The host test
"the spec-math stand-in moves each builtin result by the WGSL bound and leaves everything else alone" checks the
rewriter.

Scripts (`packages/compute/package.json` @ 67ca53a5):

```json
"test:browser": "npm run build && node tests/compute-browser.mjs",
"test:browser:spec-math": "npm run build && node tests/compute-browser.mjs --spec-math-error=1",
"test:browser:reassociate": "npm run build && node tests/compute-browser.mjs --reassociate-math",
"test:browser:sweep": "npm run build && node tests/compute-precise-sweep.mjs",
```

All four match `isGpuScript` in `scripts/gpu-package-tests.mjs` (`/^test:/` and a `browser` or `gpu` segment), so
`check:gpu-packages` runs them when `@margoengine/compute` is affected, and on every full run. The voxel path tracer has
its own `test:gpu:spec-math` (DOCUMENTED in `docs/known-bugs.md`).

#### 3.15.6 The sweep and the GPU check

- `packages/compute/tests/compute-precise-browser.js`: every precise function over the dense input sets of
  `tests/precise-math-reference.js`. Throws when the GPU result is over its ulp bound, or more than 2 ulp from the host
  mirror ("keep the two in step"). It reports the share of inputs equal to the mirror bit for bit (unfused and fused);
  that share is not asserted.
- `packages/compute/tests/compute-precise-sweep.mjs`: `preciseSin`, `preciseCos`, `preciseTan` over every binade from
  2^-12 to 2^127 and `precisePow` at extreme exponents, against double precision; "N over bound" per function, fails
  when N > 0; writes `test-results/compute-precise-sweep.json`.
- After `baa66526` (`perf-history.md` 37): 573,720 inputs for sin, cos and tan and 298,646 for pow, 0 over bound on the
  Intel UHD and the RTX A6000. Pre-fix on the Intel UHD: sin 1,791, cos 1,785, tan 642, pow 147,647 over bound.
- Host side, `tests/precise-math.test.js`: constants re-derived; the pi/2 reduction against BigInt for every exponent;
  every function within its bound over dense inputs unfused, fused, and with division and sqrt off by WGSL's limits;
  special values against `Math.*`. `tests/precise-math-reference.js` mirrors the WGSL operation for operation with
  `Math.fround` after every step.

#### 3.15.7 Cross-vendor matrix

| GPU, API, OS | Precise maths after fix | What is asserted | Source |
| --- | --- | --- | --- |
| NVIDIA RTX A6000, Dawn D3D12, Windows | all 17 in bound; sweep 0 over bound | within ulp bound; within 2 ulp of the mirror; mirror share reported (bit for bit there, per known-bugs) | perf-history 37, known-bugs "Intel Arc 140V" |
| AMD Radeon 680M, D3D12, Windows (Edge and Chrome 156) | all 17 in bound; sweep 0 over bound at `650291de` (worst sin 0.743 of the bound, pow 0.716) | within ulp bound | perf-history 37 (sweep marked "not committed") |
| Intel UHD (ADL-N, N100), Mesa Vulkan, Ubuntu | all 17 in bound; sweep 0 over bound | within ulp bound | perf-history 37 |
| Intel Arc 140V, Windows | NOT verified after the fix | the precise bounds "on its compiler" are listed as not verified | known-bugs "Intel Arc 140V" |

Bit-exact across vendors is not claimed for the precise maths. What is claimed is the ulp bound on each GPU.
Bit-exact claims are within one GPU: incremental vs full kernel ticks, compat layer vs native WebGPU, and the host
mirror on the A6000.

Other suites on the Intel UHD Linux server: 42 of 43 package GPU suites started, 38 passed; voxel, voxel path tracer and
the root browser suite stopped by a heat watchdog at 82 C (`docs/known-bugs.md`).

#### 3.15.8 Node 22 vs Node 26 `pow` and the pinned proof

From `perf-history.md` entry 38 and `claims.md` "Host-rounded maths (bug 17)":

- Symptom: the `math-consolidation` proof passed on Node 26.12 (V8 14.6) and failed on Node 22.22.1 (V8 12.4) on
  Ubuntu and Windows: 21 of 24 tape digests differed.
- Cause: ECMAScript leaves `**`, `Math.pow`, `Math.sin`, `Math.cos`, `Math.hypot` and the other approximated functions
  to the engine. V8 14.6 uses the C library's pow (`--use-std-math-pow`, on by default); V8 12.4 uses its own.
  `10 ** -5` is `0.00001` on one and `0.000009999999999999999` on the other; 48 of the 256 sRGB bytes differ in the
  last bit. The proof built its inputs with `10 ** x`.
- Fix `ab27353f`: inputs from exact operations only; during the proof `Math.sin`, `Math.cos` and `Math.hypot` are exact
  stand-ins built from `+ - * /`, `%` and `Math.sqrt` (`golden.js` `exactMath`); a taped call using another
  approximated function fails; results through `**` are stored in a canonical form.
- Guard: `tests/proofs-golden.test.js` replays the proof under the other pow (`--no-use-std-math-pow` on Node 26); CI
  `node-compat` runs it on Node 22.12.0, 22 and 26.
- Policy recorded in `claims.md`: the engine does not promise the same last bit across JavaScript engines for these
  functions; the GPU-call proofs were not affected (they still include V8's own sin, cos and tan for cameras, the same
  on every host checked; ARM not checked).

#### 3.15.9 Not measured

- The GPU cost of the precise functions against the builtins (`createCompute({ fastMath: true })`). Listed in
  `docs/known-bugs.md` "Precise maths: cost against the WGSL builtins not measured": four hides in the precise divide
  where the old code had one, more work in `pow`. Needed: a measured GPU time for both, recorded as an accepted
  difference in work with a like-for-like `fastMath` row.
- The cost of one `kernel_sync_rotation` call from JS.
- Cross-machine bit equality of the kernel output.

### 3.16 How to replicate the kernel and precise maths from scratch

Build in this order:

1. **Decide the layout on paper first.** List every per-entity input, output, staging and snapshot lane. Pick SoA for
   lanes you stream or SIMD over, per-entity blocks for records you copy whole. Put a fixed-size head (frustum planes)
   in a tail region. Write the index formula for every lane.
2. **One static kernel per Wasm instance.** `no_std` on wasm32, a `static mut` slot, an "initialized" flag, carve the
   regions from `__heap_base`, call `memory.grow` yourself, return null on failure. Keep an `rlib` build with `Vec`
   storage for native tests.
3. **Exports:** `new(capacity)`, `data(handle)`, `flags(handle)`, `tick(handle, flags)`, `drop(handle)`, plus any
   per-entity helper you cannot avoid. Return integer error codes (0 ok, `id + 1` bad entity).
4. **Validate everything the kernel reads.** Non-finite floats, zero scale, zero quaternion, parent id range, active
   parent, cycles, depth limit. Then drop slice bounds checks only where the layout proves the index.
5. **Atomic publish.** Compute into scratch, publish only after the whole hierarchy validated, set a "full" flag on
   failure.
6. **Snapshot change tracking.** Store the bits of every input the output depends on; compare bitwise (so `-0` and NaN
   payloads count); recompute on difference or when the parent was recomputed; memoise per tick with a state byte that
   also detects cycles.
7. **A sticky "changed" byte** the host clears after it copies the output.
8. **JS store class.** Compile once (cached promise, clear on error), instantiate per store, build views from the
   returned offsets, document that views are stale after growth.
9. **Growth by doubling.** Copy every view out, drop, re-create at the same address, rebind, copy back as prefixes,
   restore on failure. Rebind every object that holds a subarray.
10. **Slot allocator.** Free-list stack first, then `next++`, double on overflow, reset every lane on reuse.
11. **Setters write into the views directly**, validate first, build no arrays.
12. **Frame loop.** One tick call per view, then patch only changed records into GPU instance arrays.
13. **Embed the Wasm** (raw deflate + base64) so consumers need no toolchain; assert a size limit and lossless round
    trip at every build.
14. **Tests in this order:** native unit tests per invariant; an oracle test (fresh kernel full recompute equals
    incremental, bit for bit) at small and at production scale; growth keeps values; a no-arrays or no-heap test for
    hot setters; a gate that the embedded Wasm matches the source (Margo lacks this one).
15. **Precise maths, only if results are compared across GPUs or with the CPU.** Write the functions from public papers,
    keep a host mirror that rounds every step, prove ulp bounds on the host with fused, unfused and worst-case
    division and sqrt, then run the same inputs on the GPU. Add a reassociation stand-in and a spec-error stand-in
    before you trust any GPU result.

Generic reference version, not from the repo: a minimal kernel shell.

```rust
// Generic reference version, not from the repo.
#![cfg_attr(target_arch = "wasm32", no_std)]
const LANES: usize = 4; // example: x, y, z, out
static mut DATA: *mut f32 = core::ptr::null_mut();
static mut CAP: usize = 0;
#[cfg(target_arch = "wasm32")]
unsafe extern "C" { static __heap_base: u8; }

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn store_new(capacity: usize) -> *mut f32 {
    unsafe {
        if CAP != 0 || capacity == 0 || capacity > 1 << 24 { return core::ptr::null_mut(); }
        let start = (core::ptr::addr_of!(__heap_base) as usize + 3) & !3;
        let end = start + capacity * LANES * 4;
        let need = end.div_ceil(65536);
        let have = core::arch::wasm32::memory_size::<0>();
        if need > have && core::arch::wasm32::memory_grow::<0>(need - have) == usize::MAX {
            return core::ptr::null_mut();
        }
        DATA = start as *mut f32;
        core::slice::from_raw_parts_mut(DATA, capacity * LANES).fill(0.0);
        CAP = capacity;
        DATA
    }
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn store_drop() { unsafe { CAP = 0; } }

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }
```

Generic reference version, not from the repo: the JS side of growth.

```js
// Generic reference version, not from the repo.
export class Store {
  static async create(bytes, capacity = 1024) {
    const { instance } = await WebAssembly.instantiate(bytes);
    return new Store(instance.exports, capacity);
  }
  constructor(api, capacity) {
    this.api = api;
    this.bind(capacity);
  }
  bind(capacity) {
    const at = this.api.store_new(capacity);
    if (!at) throw new RangeError(`Store allocation failed at capacity ${capacity}; use a smaller capacity`);
    const buffer = this.api.memory.buffer;
    this.capacity = capacity;
    this.x = new Float32Array(buffer, at, capacity);
    this.y = new Float32Array(buffer, at + 4 * capacity, capacity);
  }
  grow(capacity) {
    if (!(capacity > this.capacity)) throw new RangeError('grow needs a larger capacity');
    const views = () => [this.x, this.y];
    const copies = views().map((v) => v.slice()), previous = this.capacity;
    this.api.store_drop();
    try {
      this.bind(capacity);
    } catch (error) {
      this.bind(previous);
      throw error;
    } finally {
      views().forEach((v, i) => v.set(copies[i]));
    }
  }
}
```

Generic reference version, not from the repo: an oracle test.

```js
// Generic reference version, not from the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
const bits = (a) => Array.from(new Uint32Array(a.buffer, a.byteOffset, a.length));
test('incremental equals a fresh full recompute, bit for bit', async () => {
  const live = await makeStore(64);
  randomEdits(live, 1000, (step) => {
    const fresh = cloneInputsIntoFreshStore(live);
    live.tick();
    fresh.tick();
    assert.deepEqual(bits(live.matrices), bits(fresh.matrices), `step ${step}`);
  });
});
```

Generic reference version, not from the repo: hiding a value from a reassociating shader compiler (the same idea as
`pmHide`; write and prove your own).

```wgsl
// Generic reference version, not from the repo.
fn hide(v: f32) -> f32 {
  let b = bitcast<u32>(v);
  let e = (b >> 23u) & 0xffu;
  let m = i32((b & 0x7fffffu) | select(0x800000u, 0u, e == 0u));
  return ldexp(f32(select(m, -m, (b >> 31u) == 1u)), max(i32(e), 1) - 150);
}
// Fast two-sum with the error term protected (|a| >= |b|).
fn fastTwoSum(a: f32, b: f32) -> vec2f {
  let s = a + b;
  return vec2f(s, hide(b - hide(hide(s) - a)));
}
```

Generic reference version, not from the repo: a reassociation stand-in for a browser test harness (fold one pattern).

```js
// Generic reference version, not from the repo. Install as a page init script before any shader is created.
export function foldSelfCancellingSums() {
  if (typeof GPUDevice === 'undefined') return;
  const original = GPUDevice.prototype.createShaderModule;
  const fold = (code) =>
    code.replace(/\(\s*1\.0\s*\+\s*([A-Za-z_]\w*)\s*\)\s*-\s*1\.0/g, '($1)'); // (1.0 + x) - 1.0 -> x
  GPUDevice.prototype.createShaderModule = function (descriptor) {
    return original.call(this, { ...descriptor, code: fold(descriptor.code) });
  };
}
```

### 3.17 Failure modes and what we saw

| Failure | What was seen | Cause | Fix and guard |
| --- | --- | --- | --- |
| Kept a view across `createMesh` | Stale or zero-length arrays after growth | `memory.grow` detaches the buffer; no grow aliases the new layout | Documented contract; `views(mesh)` rebinds; growth test asserts views are replaced |
| Changed-bit missed for `-0.0` or a NaN payload | (Design risk) | Float compare treats `-0 == 0` and NaN != NaN | Snapshot compares bits; `layout_edges_preserve_validation_and_bitwise_change_tracking`, `snapshots_keep_every_lane_bitwise_at_both_allocation_edges` |
| Snapshot SIMD short-circuit | Only the first changed group stored (design risk named in the code) | `||` would skip later groups | Bitwise `|` over all four groups; test "All four vector groups must be visited" |
| Partial publish on bad input | Half-updated matrices (design risk) | Publishing while computing | Scratch then publish; atomic tests |
| A clamped rotation is different from a direct write | Different quaternion bits | Two expansions of XYZ | One `sync_rotation` used by both paths; test |
| Precise log1p wrong on AMD | 8,383,741 ulp | D3D12 compiler folded `(1 + x) - 1` | `pmHide` (`b6bea3e9`); reassociation stand-in; host fold tests |
| Precise sin wrong on Mesa | 1.46 ulp (bound 1) | Mesa factored `h + h w p` | `baa66526`; stand-in factors too; host factoring test |
| Compute random uniform is different per device | Different bits | Mesa fused `a + (b - a) * u` | product through `pmHide` (`baa66526`) |
| CPU/GPU parity failed on Intel Arc | 1.13e-5 off (tolerance 1e-5) | WGSL builtin `sin`/`cos` accuracy | Precise functions; parity 1e-6 plus ulp; `test:browser:spec-math` |
| Pinned proof failed on Node 22 | 21 of 24 digests | V8 pow is different between 12.4 and 14.6 | exact inputs and stand-ins (`ab27353f`); `tests/proofs-golden.test.js` on both pows |
| NaN payload flakes in a proof | Random failure on degenerate input | V8 may store either NaN encoding in a typed array | `canonicalNaN` in the proof comparisons (`claims.md`) |
| Experiment script rot | `kernel-opt-experiment.js` cannot run (found while writing this) | Layout and compression changed after it was written | Not fixed; reported |

---

## 4. Hardware fallback and rendering tiers

### 4.1 The tier ladder

| Rung | What runs | Loaded when | Cost for WebGPU users | Status |
| --- | --- | --- | --- | --- |
| 1. Native WebGPU | core `GPURenderer` and every package | always tried first by `Engine.create` (`backend: 'auto'` or `'webgpu'`) | n/a | VERIFIED |
| 2. `@margoengine/webgl` preview | a second, small WebGL2 renderer: core meshes with constant-colour PBR, one directional light plus ambient, no textures, effects or picking | the app passes `fallback: webglRenderer`, usually behind `import()` | 0 B (separate chunk); 3,127 B gzip itself at 777bca5b | VERIFIED |
| 3. `@margoengine/webgl2-compat` | a WebGPU-shaped device on WebGL2; core's WebGPU renderer and the packages run unchanged | the app calls `install()` when WebGPU is missing, behind `import()` | 0 B; isolation test | VERIFIED; status "in development, M0 to M5" |
| 4. "needs WebGPU" message | site demos show a message and a link; demo code is never downloaded | `examples/needs-webgpu.js` | n/a | DOCUMENTED |

Inside rung 1 and rung 3, `@margoengine/quality` picks a render tier (phone, light, high), 4.9.

### 4.2 Native WebGPU device creation in core

```ts
// packages/core/src/renderer.ts @ 67ca53a5 (GPURenderer.create, cut)
  static async create(
    canvas: HTMLCanvasElement,
    features: GPUFeatureName[] = [],
    samples: number = sceneSamples(),
  ): Promise<GPURenderer> {
    const adapter = await navigator.gpu?.requestAdapter(
      /Win/.test(navigator.userAgent) ? {} : { powerPreference: 'high-performance' },
    );
    if (!adapter) throw fault('unsupported', 'WebGPU adapter unavailable', 'webgpu');
    const device = await adapter.requestDevice({
      requiredLimits: { maxTextureArrayLayers: adapter.limits?.maxTextureArrayLayers },
      requiredFeatures: ['depth32float-stencil8' as GPUFeatureName, ...features].filter((feature) =>
        adapter.features.has(feature),
      ),
    });
    // ... two pipelines (back-face culled and not), reversed-Z depth (greater-equal), multisample: { count: samples }
```

- On Windows the adapter request passes no `powerPreference`; elsewhere `'high-performance'`. The reason is not in the
  code comment (NOT VERIFIED). For test machines with two GPUs, the harness picks the adapter itself with
  `--use-adapter-luid` (`docs/benchmarking.md`, "Choosing the browser"; commit `85c96a55`).
- Requested features are filtered to what the adapter has.
- `samples` is 4 on desktop and 1 on phones, the light tier and `exactSize` (`packages/core/src/quality.ts`
  `sceneSamples`).

```ts
// packages/core/src/quality.ts @ 67ca53a5
export function sceneSamples(engine?: { exact?: 1 }): 1 | 4 {
  return engine?.exact || (globalThis.margoLow || /Mobi|Android/.test(globalThis.navigator?.userAgent) ? 1 : 4);
}
```

`Engine.create` (VERIFIED, `engine.ts`):

1. `backend` is `'auto'` (default), `'webgpu'` or `'webgl2'`.
2. Not `'webgl2'`: try `GPURenderer.create`. On failure with `'webgpu'`, rethrow; with `'auto'`, keep the reason as
   `engine.fallbackReason`.
3. No renderer yet: call `options.fallback(canvas)`, or reject with `unsupported` ("WebGPU unavailable", or "webgl2
   needs fallback: webglRenderer").
4. `exactSize: [w, h]` sets the canvas size, disables resize and forces 1 sample.

### 4.3 The `@margoengine/webgl` preview

```ts
// packages/webgl/README.md @ 67ca53a5 (examples)
import {Engine} from 'margoengine/core';
import {webglRenderer} from 'margoengine/webgl';

// WebGPU when available, otherwise WebGL2.
const engine = await Engine.create(canvas, {backend: 'auto', fallback: webglRenderer});
```

```ts
// packages/webgl/README.md @ 67ca53a5
import {Engine} from 'margoengine/core';

const fallback = navigator.gpu ? undefined : (await import('margoengine/webgl')).webglRenderer;
const engine = await Engine.create(canvas, {fallback});
```

React uses `loadFallback={() => import('margoengine/webgl')}` and `fallbackContent` on `Canvas` (DOCUMENTED). The
roadmap's decision 1 keeps the preview until the compat layer replaces it (it draws on WebGL2 below the layer's
minimum tier).

Size inconsistency found while reading: README says 3,021 B, `claims.md` LIM-022 says 2,156 B,
`entry-sizes.json` at 777bca5b says 3,127 B, the sizes baseline budget is 3,277 B.

### 4.4 The compatibility layer: install, detection and zero cost

Conditions recorded when the work was activated (`docs/webgl2-compat-roadmap.md`, 2026-10-27): zero core bytes;
browsers with WebGPU download nothing; the WebGPU path of core and every package byte-identical with and without the
layer; exact-pixel mode honoured.

#### Detection is the app's job

```ts
// packages/webgl2-compat/README.md @ 67ca53a5
import { Engine } from 'margoengine/core';

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const webgpu = 'gpu' in navigator && (await navigator.gpu.requestAdapter()) !== null;
if (!webgpu) await (await import('margoengine/webgl2-compat')).install();
const engine = await Engine.create(canvas);
engine.render();
```

Why core needs no change: core finds its GPU with `navigator.gpu?.requestAdapter()` and the canvas with
`canvas.getContext('webgpu')`; both are replaced by `install()`.

#### What `install()` does (VERIFIED, `src/index.ts` and `src/device.ts`)

```ts
// packages/webgl2-compat/src/index.ts @ 67ca53a5
let device: typeof import('./device.js') | undefined;
// ...
export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  device ??= await import('./device.js');
  return device.installCompat(options);
}
```

```ts
// packages/webgl2-compat/src/device.ts @ 67ca53a5 (installCompat, cut)
export async function installCompat(options: InstallOptions = {}): Promise<InstallResult> {
  if (installed) return { installed: true, reason: 'already', gpu: installed.gpu };
  const nav = (globalThis as { navigator?: Navigator & { gpu?: GPU } }).navigator;
  if (!nav) throw new TypeError('install() runs in a browser page: there is no navigator here');
  if (!options.force && nav.gpu) {
    const adapter = await nav.gpu.requestAdapter().catch(() => null);
    if (adapter) return { installed: false, reason: 'webgpu' };
  }
  const caps = probeWebGL2();
  if (!caps) throw fault('unsupported', 'This browser has neither WebGPU nor WebGL2', 'compatibility-layer');
  if (!caps.supported)
    throw fault(
      'unsupported',
      `This browser's WebGL2 is below the compatibility minimum: missing ${caps.missing.join(', ')}`,
      'compatibility-layer',
    );
  const gpu = new CompatGPU(options);
  const restore: Restore[] = [];
  const own = Object.getOwnPropertyDescriptor(nav, 'gpu');
  Object.defineProperty(nav, 'gpu', { value: gpu, configurable: true, enumerable: true, writable: false });
  // ... restore entry; then HTMLCanvasElement and OffscreenCanvas getContext patched for 'webgpu' only
  // ... GPUBufferUsage, GPUTextureUsage, GPUShaderStage, GPUMapMode, GPUColorWrite defined where missing
  installed = { gpu, restore };
  return { installed: true, reason: 'installed', gpu };
}
```

1. Already installed: return `already`.
2. Real WebGPU has an adapter and `force` is not set: do nothing, return `webgpu`.
3. Probe WebGL2 with a throwaway `antialias: false` context; below `full`, reject with `unsupported` naming what is
   missing.
4. Define `navigator.gpu` as `CompatGPU`, patch `getContext('webgpu')` on `HTMLCanvasElement` and `OffscreenCanvas`
   (other context types go to the original), define the flag objects that are missing.
5. `uninstall()` runs the restore list in reverse.

#### Minimum tier (VERIFIED, `webgl2Capabilities`)

```ts
// packages/webgl2-compat/src/index.ts @ 67ca53a5 (cut)
  const float = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT),
    int = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_INT),
    // highp: a 23-bit mantissa, and ints over [-2^31, 2^31) (reported as rangeMin 31, rangeMax 30).
    highpFragment = (float?.precision ?? 0) >= 23 && (int?.rangeMin ?? 0) >= 31 && (int?.rangeMax ?? 0) >= 30;
  const missing: string[] = REQUIRED_EXTENSIONS.filter((name) => !extensions[name]);
  if (!highpFragment) missing.push('highp-fragment');
  const tier: CompatTier = !missing.length
    ? 'full'
    : highpFragment && extensions.EXT_color_buffer_half_float
      ? 'half-float'
      : 'ldr';
```

`REQUIRED_EXTENSIONS = ['EXT_color_buffer_float']`. Only `full` renders. Reason (roadmap decision 2): the HDR path
renders to `rgba16float` (91 mentions in the packages) and float data targets, so a lower tier would need a second
render path. Measured 2026-10-27 on this PC's browsers: Chrome and Edge 156 on ANGLE D3D11, OpenGL and Vulkan, and
SwiftShader, all `full`. Not measured: Safari without WebGPU, Firefox, phones.

#### Zero bytes for WebGPU users

- The root entry holds only the probe and `install()`; the device, GLSL back end and WGSL front end load inside
  `install()`; the compute entry loads at the first compute pipeline.
- `packages/webgl2-compat/test/isolation.test.js`: no other package source names the layer, no package depends on it
  except the umbrella's alias entry, the built core, stage, React and umbrella root entries reach none of its modules,
  and importing it changes no global.
- Roadmap: `npm run measure:size` reports the same core + stage bytes before and after each milestone.

#### Exact-pixel mode and the context the layer owns

```ts
// packages/webgl2-compat/src/device/device.ts @ 67ca53a5
const ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  failIfMajorPerformanceCaveat: false,
};
```

- Each device owns one WebGL2 context on an `OffscreenCanvas` (a detached canvas where OffscreenCanvas is missing) with
  `antialias: false`. The page canvas is not the GL context.
- Why: WebGPU decides multisampling per pipeline and per attachment. A browser-antialiased default framebuffer would
  smooth everything, which breaks exact-pixel mode (`exactSize`, 1 sample) and would not match WebGPU's per-pipeline
  choice. So the layer multisamples itself (multisample renderbuffers plus `blitFramebuffer` resolve) only when a
  pipeline asks for 4 samples.
- Present: the canvas texture is an offscreen texture; each submit presents it through an `ImageBitmap` with a y-flip
  (bug 53 moved present to the end of each submit so same-task canvas reads see the current frame).
- No depth or stencil on the context: the layer allocates its own.

### 4.5 Translation pipeline step by step

```text
app -- install() --> navigator.gpu (CompatGPU) --> CompatAdapter --> CompatDevice --> WebGL2RenderingContext
                     canvas.getContext('webgpu') --> CompatCanvasContext (owns the WebGL2 context)

core GPURenderer + packages (unchanged)
   | createShaderModule(WGSL) --> WGSL front end --> IR --> GLSL ES 3.00 back end --> gl.compileShader
   | createRenderPipeline -----> program + state block + vertex layout (VAO cache)
   | createComputePipeline ----> compute plan: fragment | scatter | CPU (WGSL to JS) | refuse
   | command encoder ----------> recorded command list --> replayed on queue.submit()
   + getCurrentTexture() ------> offscreen texture --> flipped blit at present
```

(Adapted from the roadmap's architecture diagram; its "transform feedback" box became "scatter" in M5.)

| Step | Module (`packages/webgl2-compat/src/...`) | What it does |
| --- | --- | --- |
| 1. Lex | `wgsl/tokens.ts` | WGSL textual structure: nested comments, every line break, Unicode identifiers, reserved words, numeric literal forms, template-list discovery |
| 2. Parse | `wgsl/parser.ts`, `wgsl/ast.ts` | the whole grammar, including the operator rules (no mixed bitwise chains, no chained comparisons) |
| 3. Check and fold | `wgsl/check.ts`, `wgsl/types.ts`, `wgsl/builtins.ts`, `wgsl/constant.ts` | resolves declarations in any order with cycle detection, Load Rule, pointer rules, abstract numbers, overloads, constant folding with the errors the spec requires, statement rules, struct layout with `@align`/`@size`, entry-point interfaces and builtin stages |
| 4. Typed IR | `wgsl/ir.ts` | every expression typed with folded value and span; each entry point lists the globals it reaches |
| 5. Errors | `wgsl/errors.ts` | `WGSLError` with `syntax`, `type` or `limit`, line and column in code points, help link; `WGSL_LIMITS`: 4 MiB source, 255 nesting levels, 65,536 values in one constant |
| 6. GLSL emit | `glsl/emit.ts`, `glsl/helpers.ts`, entry `glsl.ts` | `#version 300 es`; uniform blocks as `uvec4` rows read in WGSL's layout; one combined sampler per (texture, sampler); storage reads from RGBA32UI data textures; WGSL semantics for integer division, shifts, conversions and clamped indexes; helpers for builtins GLSL ES 3.00 lacks; gather by hand |
| 7. Device | `device/device.ts`, `device/resources.ts`, `device/render.ts`, `device/gl.ts`, `device/formats.ts`, `device/canvas.ts`, `device/compute.ts` | adapter limits from real WebGL2 limits, resources, render pipelines, recorded command lists replayed against a GL state cache, canvas context and present |
| 8. Compute | `compute/analyze.ts` (plan), `compute/glsl.ts` (GPU tiers), `compute/js.ts` and `compute/cpu.ts` (CPU tier), `compute/runtime.ts`, entry `compute.ts` | tier choice from the IR, then fragment draws, point draws or JavaScript |

Uniformity analysis is left out on purpose (every corpus shader passes it in the browsers' own compilers).

Key mapping decisions (roadmap "WebGPU to WebGL2 mapping"; VERIFIED in part by the README):

- Clip space: `EXT_clip_control` keeps WebGPU's z range (all measured configurations have it); rendering is flipped in
  y so every texture keeps WebGPU's top-left origin, and only the present flips back.
- Bind groups: a per-pipeline table from (group, binding) to uniform block or texture unit.
- Storage buffers read in render stages: an RGBA32UI data texture, one 16-byte row per texel, up to 2,048 texels wide;
  reads clamped into the binding; `arrayLength` from a per-draw uniform. Storage bindings of one bind group share one
  texture, so a pipeline spends one texture unit per group (the glTF PBR shaders with clustered lights read 14 textures
  plus 3 or 4 storage buffers, which would not fit 16 units otherwise).
- Base vertex and instance: no measured configuration has `WEBGL_draw_instanced_base_vertex_base_instance`, so the
  uniform path is the main path.
- Per-target blend without `OES_draw_buffers_indexed`: one draw per group of targets with the same state; refused with
  depth or stencil writes.

### 4.6 Compute emulation tiers

```ts
// packages/webgl2-compat/src/compute/analyze.ts @ 67ca53a5 (tier choice, cut)
    const unbounded = targets.find((t) => !Number.isFinite(t.stores));
    let tier: ComputeTier, reason: string;
    if (this.cpu) [tier, reason] = ['cpu', this.cpu];
    else if (unbounded) [tier, reason] = ['cpu', `it stores to '${unbounded.name}' inside a loop of unknown length`];
    else if (this.hazard) [tier, reason] = ['cpu', this.hazard];
    else if (this.fragment || !targets.length) [tier, reason] = ['scatter', this.fragment || 'it writes nothing'];
    else [tier, reason] = ['fragment', ''];
    if (tier !== 'cpu') {
      const bad = targets.find((t) => t.kind === 'texture' && !RENDERABLE.has(t.format as string));
      if (bad) [tier, reason] = ['cpu', `WebGL2 cannot draw into its ${bad.format} storage texture '${bad.name}'`];
      const big = targets.find((t) => t.stores > 1024);
      if (tier === 'scatter' && big) [tier, reason] = ['cpu', `it stores ${big.stores} words to '${big.name}'`];
    }
    return { tier, entryPoint: this.entry.name, workgroupSize, targets, reason };
```

| Tier | Applies when | Runs as | Limits |
| --- | --- | --- | --- |
| fragment (A1) | every `textureStore` writes the invocation's own texel (id tracked through lets, conversions, constructors, parameters) and no buffer is written | one full-target draw per written texture and z slice, scissored; id from `gl_FragCoord`; a fragment that stores nothing is discarded | target format must be renderable |
| scatter (A2) | a bounded number of stores anywhere, never read back by the same invocation | one instanced point draw per target; instance k draws the k-th store; buffers drawn as an R32UI "word texture" and copied back on the GPU | at most 1,024 stores per invocation per target, else CPU; runs the shader once per store (more GPU time, not measured) |
| cpu (B) | atomics, workgroup memory, barriers, unbounded store loops, an own store read back, f16 in uniforms, or a non-renderable target | the IR emitted as JavaScript, compiled once per pipeline with `new Function`; one invocation at a time; generators between barriers; f32 via `Math.fround`; WGSL integer rules | needs CSP `unsafe-eval`; cannot read cube, multisampled or external textures; GPU-written inputs read back synchronously (counted in `device.stalls`) |
| C (package paths) | planned for large dispatches with atomics, sorting or GPU-driven culling | the package takes another route | no recorded shader needs it yet (M6) |

```ts
// packages/webgl2-compat/src/compute/js.ts @ 67ca53a5 (lines 67 to 77, cut)
    factory = new Function('H', 'R', source) as typeof factory;
    // ...
    // A Content-Security-Policy without 'unsafe-eval' forbids new Function.
    // ... throws MargoError 'unsupported':
    //   `'${entry.name}': the page forbids JavaScript compiled at run time (its Content-Security-Policy lacks 'unsafe-eval')`
```

Inconsistency found while reading: `docs/limits.md` row "Content Security Policy" and `claims.md` LIM-023 say "Nothing
needs `'unsafe-eval'`", while the row above it ("Compute on the WebGL2 compatibility layer") says CPU kernels need it.
Both are true for different scopes (shipped engine path vs the opt-in layer), but the CSP row does not say so.

Lazy loading of compute (DOCUMENTED, roadmap M5): the device keeps only what `getBindGroupLayout` needs; planning,
translation and the CPU tier load with the compute entry at the first compute pipeline; command buffers with compute
passes wait in the queue until it loads and later queue operations wait behind them.

Tier-B budget measured (`docs/limits.md`, A6000, Edge 156, ANGLE D3D11): clustered binning over 3,456 clusters 1.5 ms
with 16 lights, 2.8 ms with 64, 9.4 ms with 256; a 64-wide reduction with 7 barriers 4.4 million invocations a second.
Nothing is refused by size.

### 4.7 Accepted differences (roadmap and README)

- Render shaders that write storage buffers or textures: refused (`unsupported`).
- CPU-tier transcendental functions differ from the GPU in the last bits; CPU texture filtering uses exact weights
  where GPUs use 8-bit fixed point (within 4/255 in the check).
- `pack4x8snorm(-0.5)`: -63 on the layer (spec's `floor(0.5 + v)`), -64 natively (Chrome rounds the tie); the probe
  stays off exact ties.
- Per-sample shading (`sample_index`): not possible; points' 4x eye-dome lighting reads the resolved texel.
- Compressed textures cannot be read back or attached; copies and sRGB views of them are refused.
- rgb9e5ufloat reads back in canonical encoding; an snorm byte of -128 reads back as -127.
- 4x multisampled integer textures refused where the context has no 4-sample support for the format.
- Timestamp queries unavailable; zero-copy video unavailable (each frame copied).
- Out-of-bounds reads clamp into the resource (allowed by WGSL).

### 4.8 Corpus and sizes

Corpus (roadmap decision 5, M1, M2, M4, M5; DOCUMENTED):

- 786 distinct modules with entry points (3,405,543 bytes of WGSL) from 41 packages plus bundled site pages, recorded
  from `check:wgsl`, every package GPU test, `check:views`, `check:depth` and the visual check.
- Stored as `packages/webgl2-compat/test/corpus/corpus.json.br` (Brotli, about 166 KB) plus a plain manifest (about
  226 KB) that pins the SHA-256 of the data. Rebuilt with `npm run record:wgsl-corpus`.
- The corpus test fails when a package with WGSL in its source has no module in the corpus. Worker-created shaders are
  not recorded (none today).
- Results: all 786 parse and check (about 0.5 s); all 1,049 vertex and fragment entry points compile; all 459 stage
  pairs link; all 624 recorded render pipelines draw once; 443 compute entry points plan in Node (37 fragment, 308
  scatter, 98 CPU); in the browser 397 of 417 compute pipelines dispatch (34 fragment, 278 scatter, 82 CPU, 3 refused);
  the other 20 are the voxel path tracer's, out of scope (ANGLE D3D11 takes 20 s to minutes per kernel).

Sizes (gzip, the sizes gate's method):

| Entry | `entry-sizes.json` at 777bca5b | Sizes baseline budget |
| --- | --- | --- |
| `@margoengine/webgl2-compat` (root, counts the lazy chunks) | 92,467 | 93,801 |
| `/device` | 92,286 | 93,629 |
| `/glsl` | 42,394 | 43,666 |
| `/compute` | 41,489 | 42,734 |
| `/wgsl` | 26,528 | 27,240 |

The roadmap target was 60 KB for the root with install; it is over by about 31 KB, recorded as "nothing was cut".

### 4.9 Runtime tiering in `@margoengine/quality`

Note: there is no runtime probe of adapter features, limits or GPU
name. VERIFIED in `packages/quality/src/index.ts`:

```ts
// packages/quality/src/index.ts @ 67ca53a5 (cut)
/** Below this many frames per second, a one-second window on the full tier counts as slow. */
export const SLOW_FPS = 55;
/** Light-tier GPU milliseconds per submission (90th percentile) below which the next page load gets the full tier.
 * 4x MSAA with desktop detail measured about 2-3x the light tier's GPU work on an Intel Arc 140V. */
export const FAST_GPU_MS = 5;
const KEY = 'margoQuality';
// ...
export function applyQualityTier({
  search = globalThis.location?.search,
  storage = local(),
  userAgent = globalThis.navigator?.userAgent ?? '',
}: QualityOptions = {}): QualityTier {
  const params = new URLSearchParams(search),
    forced = params.get('quality') ?? undefined;
  let stored: string | undefined;
  try {
    stored = storage?.getItem(KEY) ?? (storage?.getItem('margoLow') ? 'low' : undefined);
  } catch {}
  const choice = forced === 'high' || forced === 'low' ? forced : stored;
  const tier: QualityTier = /Mobi|Android|iPhone/.test(userAgent) ? 'phone' : choice === 'high' ? 'high' : 'light';
  if (tier === 'high') delete globalThis.margoLow;
  else globalThis.margoLow = tier === 'phone' ? 1 : Math.min(2, Math.max(1, Number(params.get('scale')) || 1));
  globalThis.margoPreset = QUALITY_PRESETS[tier];
  state = { tier, stored: choice, forced: forced === 'high' || forced === 'low' ? forced : undefined, storage };
  return tier;
}
```

| Input | Effect |
| --- | --- |
| User agent matches `/Mobi\|Android\|iPhone/` | `phone`: 1 sample, `margoLow = 1` (DPR 1), phone preset, even with `?quality=high` |
| `?quality=high` or `?quality=low` | forces the tier, never stored |
| `localStorage['margoQuality:' + location.pathname] === 'high'` | `high`: core's 4x MSAA desktop path, `margoLow` deleted |
| otherwise | `light`: 1 sample, `margoLow` = `?scale` clamped to 1..2, default 1 |

Measurement (`watchQuality`), VERIFIED:

1. Phone or forced: does nothing.
2. Light tier, unless the full tier already ran slow here (`'held'`): `applyQualityTier` added `timestamp-query` to the page's devices until the watcher starts; the watcher
   wraps `GPUQueue.prototype.submit` and `GPUDevice.prototype.createCommandEncoder`; after skipping 2 s of startup, adds timestamp writes to every pass and sums each frame's passes for 120 frames; gives up after 10 s; then puts everything back and destroys its GPU objects. p90 under `FAST_GPU_MS` (8 ms, from Plaza at spawn; the 5 ms on submit to done above is the old rule, which read a floor of about 4.4 ms from presenting and other work on the machine) stores `high` for this page; a slower reading, or no `timestamp-query`, stores nothing, so the next load measures again. Takes
   effect on the next page load; no reload, so no PC is first shown 4x.
3. High tier: counts frames per one-second window; a gap over 250 ms restarts the window; five consecutive windows
   under 55 FPS store `held` and reload once; stops after 30 seconds.

Override: `?quality=`, `?scale=`, `localStorage.removeItem('margoQuality:' + location.pathname)`, or inject `search`, `page`, `storage`, `userAgent`,
`request`, `queue`, `device`, `store`, `reload` (tests do).

Pacing: `paceEngine(engine)` caps the light tier at about 60 FPS through `engine.pace`; `capFrameRate(engine, rate)`
skips a refresh that comes sooner than 4 ms before the next frame is due.

Presets (`QUALITY_PRESETS`, published as `globalThis.margoPreset`): packages read their key when an effect is
constructed and use it only for options the app left undefined. Light: shadows 1024 + PCF, SSAO 16 samples, SSR off
(32 steps), volumetric grid [80, 45, 32], local shadows 256, VFX capacity 100,000. Phone: light plus 2 cascades, SSAO
off, volumetric off, scatter `lodFade: 0`. High: package defaults. Feature packages never import `@margoengine/quality`;
the global is the contract. Proof: `quality-presets.proof.js` (5.10).

### 4.10 Dynamic resolution

```ts
// packages/quality/src/resolution.ts @ 67ca53a5 (ResolutionScaler.push, cut)
    if (average > this.budget) {
      this.calm = 0;
      let next = round(this.scale * Math.max(0.7, Math.sqrt((this.budget * 0.95) / average)));
      if (next >= this.scale) next = Math.max(this.min, this.scale - this.granularity);
      // A drop soon after a rise means the rise was too eager: wait longer before trying again.
      if (this.sinceRise <= 3) this.holdOff = Math.min(32, this.holdOff * 2);
      return this.change(next);
    }
    if (average < this.budget * 0.7 && this.scale < this.max) {
      if (++this.calm >= this.holdOff) {
        this.calm = 0;
        this.sinceRise = 0;
        return this.change(round(this.scale * 1.05 + this.granularity / 2));
      }
    } else if (average < this.budget) {
      this.calm = Math.max(0, this.calm - 1);
    }
```

| Option | Default |
| --- | --- |
| `budget` (ms per frame) | 12 |
| `min` scale | 0.5 |
| `max` scale | 1 |
| `window` (samples per decision) | 30 |
| `granularity` | 0.05 |
| after a change, samples ignored | 8 |
| rise threshold | average under 70% of budget for `holdOff` decisions (starts 2, doubles to at most 32 after an undone rise) |
| drop size | `max(0.7, sqrt(0.95 * budget / average))`, because cost grows with pixel count (scale squared) |

`watchResolution` times GPU work per submit and moves `globalThis.margoLow` (core reads it every frame to size the
canvas). On the high tier it does nothing (changing the cap there would also switch off multisampling) unless the app
passes its own `apply(scale)`. Disposable with `using`. Core's own resize: `dpr = min(devicePixelRatio, margoLow || 2,
4 / sceneSamples())`, canvas at most 4096 per side, skipped with `exactSize`.

### 4.11 Warm-up and restore helpers

- `warmUp(engine)` (`@margoengine/quality/warm`): renders offscreen warm frames (delta 0) so every attached feature's
  pipelines are created with the async APIs before the first visible frame; a frame that reaches a missing pipeline is
  stopped, submitted, compiled asynchronously and rerun until two complete; a feature that fails the retry triggers
  `engine.rebootDevice()` and synchronous creation (`report.rebooted`). Options `frames: 2`, `maxRounds: 256`,
  `signal`. DOCUMENTED in the README.
- `redrawAfterRestore(engine, render)`: for apps that render on demand; runs `render` on the two animation frames after
  every device restoration (VERIFIED: it registers a plugin whose `onDeviceRestored` schedules them).

### 4.12 Device-loss recovery in core

Detection (VERIFIED, `renderer.ts`):

```ts
// packages/core/src/renderer.ts @ 67ca53a5 (cut)
    device.lost.then((info) => {
      this.deviceLost = true;
      if (!this.disposed) this.onLost?.(fault('failed', `GPU lost: ${info.message}`, 'gpu-lost'));
    });
    // ...
  render(/* ... */): void {
    if (this.deviceLost || this.disposed) return;
    try {
      this.renderFrame(camera, lighting, batches, graph, delta, view);
    } catch (error) {
      if (error instanceof DOMException && ['InvalidStateError', 'OperationError'].includes(error.name)) {
        this.deviceLost = true;
        this.onLost?.(error);
        return;
      }
      throw error;
    }
  }
```

Recovery (VERIFIED, `engine.ts`):

```ts
// packages/core/src/engine.ts @ 67ca53a5
  private watchDevice(): void {
    this.renderer.onLost = () => {
      if (!this.disposed && !this.disposing) void this.rebootDevice().catch((error) => this.onError(error));
    };
  }
  rebootDevice(): Promise<void> {
    if (this.disposed || this.disposing) return Promise.reject(fault('disposed', DISPOSED));
    if (this.backend !== 'webgpu') return Promise.reject(fault('unsupported', WEBGPU, 'webgpu'));
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      const previous = this.renderer,
        next = await GPURenderer.create(this.canvas, this.features, this.exact);
      if (this.disposed || this.disposing) {
        next.dispose();
        return;
      }
      try {
        for (const batch of this.batches.values()) next.add(batch.geometry, batch.instances.length / 24);
      } catch (error) {
        next.dispose(false);
        throw error;
      }
      this.renderer = next;
      this.watchDevice();
      previous.dispose(false);
      for (const scene of this.scenes) {
        const outer = this.enter(scene);
        try {
          for (const plugin of scene.plugins.values()) plugin.onDeviceRestored?.(this);
        } finally {
          this.enter(outer);
        }
      }
    })().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }
```

1. Loss is reported by `device.lost` or by a `DOMException` (`InvalidStateError`, `OperationError`) during a frame.
   After that the old renderer draws nothing.
2. `rebootDevice` runs once at a time (`this.recovery` is shared by concurrent callers).
3. A new adapter, device and pipelines are created with the same features and sample mode.
4. Every geometry batch is re-added with its instance capacity (vertex and index buffers re-uploaded from the CPU copy
   in `Geometry`).
5. Swap the renderer, re-arm the loss watcher, dispose the old one without unconfiguring the canvas.
6. Every plugin of every scene gets `onDeviceRestored(engine)` inside its own scene.
7. State that needs no restore: transforms, hierarchy, visibility and bounds live in Wasm memory on the CPU. Instance
   data is on the CPU (`batch.instances`); the new GPU resource starts with `frame = -1`, which makes the next upload copy
   the whole range (`renderer.ts`, `upload`).
8. During recovery the frame loop skips `renderer.render`, and `geometryBuffers` throws code `device-restore`.
9. The WebGL2 backend rejects `rebootDevice` (`unsupported`). On the compat layer, `webglcontextlost` resolves
   `device.lost` and core's normal path runs (DOCUMENTED; the compat check restores a destroyed device with max d 0).

Tests for it:

| Test | Where | What |
| --- | --- | --- |
| Lifecycle scenario C | `scripts/lifecycle-browser-tests.mjs` (run by `check:gpu-packages` as root `test:lifecycle:browser`) | `device.destroy()` and a GPU process crash: the engine replaces the device and keeps drawing, no uncaught error |
| `visual:device-loss` | `scripts/visual-regression.js --device-loss` | every site demo: each `GPUDevice` destroyed at the start of its next render pass; passes when a new device submitted work and the capture matches the pre-loss capture within the view's tolerance |
| `check:views` "scenes" and "water" sections | `scripts/test-views-browser.mjs` | device restore with separate scenes and multi-view water |
| Compat device restore | `packages/webgl2-compat/test/compat-browser-check.mjs` | a destroyed compat device restored by core draws within the parity gate |
| Proof stories | e.g. `selection-xray-off.proof.js` calls `onDeviceRestored` at frame 22 | identical GPU calls through a restore |
| Unit tests naming the API | `tests/core-errors.test.js`, `tests/core-scenes.test.js` (contain `rebootDevice` or `onLost`; content not traced) | NOT VERIFIED in detail |

### 4.13 How the tiers are tested

| Check | Command | Runs in | What it proves |
| --- | --- | --- | --- |
| WebGL2 capability tier | `npm run test:browser --workspace @margoengine/webgl2-compat` (`browser-check.mjs`) | check:gpu-packages | the default test browser reaches `full` |
| Corpus compile and link | same script: `glsl-corpus-browser.mjs`, `corpus-draw-browser.mjs` | check:gpu-packages | every recorded entry point compiles, every stage pair links, every recorded pipeline draws once, compute pipelines dispatch |
| Front end over the corpus, fuzz | `npm test --workspace @margoengine/webgl2-compat` (`wgsl-corpus-check.test.js`, `wgsl-fuzz.test.js`, `wgsl-front-end.test.js`, `corpus.test.js`) | verify | parse and check of every module; random token soup, random typed expressions, mutated corpus, nesting bombs, 4 MiB input end quickly with only `WGSLError` |
| Pixel parity with native | `test:gpu` -> `compat-browser-check.mjs` | check:gpu-packages | same scene natively and on the layer, same GPU: share of pixels with d > 2 at most 0.1% and mean d at most 0.25 (d = largest RGB channel difference); 4x MSAA, exact-pixel, two views, picking at 100 grid points, device restore |
| Features vs native | `features-browser.mjs` | same | views, readbacks of 16 format and aspect cases, queries, bundles, gather, external texture, storage reads: bit-identical |
| Compute vs native | `compute-browser.mjs` | same | 11 cases over the three tiers |
| Package checks in forced compat | `--compat` on materials, gltf-pro shader review, lod, post-effects (tonemap and the rest), shadows lit faces, voxel render, environment, lines, points, text | `test:gpu` of the compat package | the package's normal check passes on the layer |
| Isolation | `isolation.test.js` | verify | zero bytes and no globals for everyone else |
| No WebGPU at all | `npm run check:no-webgpu` (`scripts/test-no-webgpu-browser.mjs`) | check:merge when affected | every module page of `site/dist` shows the "needs WebGPU" message or none, no uncaught error, both with `navigator.gpu` deleted and with `requestAdapter()` returning null; the webgl preview draws two boxes, read back |
| Multi-view and restore | `npm run check:views` | check:merge when affected | views, scenes, temporal effects, device restore |

Pixel parity constants:

```js
// packages/webgl2-compat/test/compat-browser-check.mjs @ 67ca53a5
const MAX_SHARE = 0.001,
  MAX_MEAN = 0.25;
```

Measured at M2 (roadmap): 0.000% over 2, mean 0.000, max 0 in all three scenes on the A6000 under ANGLE D3D11.

#### Forced compatibility on any check

```js
// scripts/support/compat-shim.js @ 67ca53a5 (cut)
/** True when this run is a forced-compatibility run (`--compat` on the command line, or MARGO_COMPAT=1). */
export const compatRun = () => process.env.MARGO_COMPAT === '1' || process.argv.includes('--compat');
// ...
export function compatShim(url = '/packages/webgl2-compat/dist/device.js') {
  if (globalThis.__margoCompat) return;
  globalThis.__margoCompat = true;
  let loading;
  const load = () =>
    (loading ??= import(url).then(async (m) => {
      const result = await m.installCompat({ force: true });
      if (!result.installed) throw new Error(`the WebGL2 compatibility layer did not install: ${result.reason}`);
      // ... counts createRenderPipelineAsync calls for waitForPipelines
      return navigator.gpu;
    }));
  const stub = {
    requestAdapter: (options) => load().then((gpu) => gpu.requestAdapter(options)),
    getPreferredCanvasFormat: () => 'rgba8unorm',
    wgslLanguageFeatures: new Set(),
  };
  Object.defineProperty(navigator, 'gpu', { value: stub, configurable: true, enumerable: true });
}
```

`scripts/browser.js` `openBrowser` adds `compatShim` as an init script when `compatRun()` is true and records
`hardware.compat = true`. Any check that opens its pages through `openBrowser` can run on the layer with no page edit.

The "30 pages" count for check:no-webgpu is NOT VERIFIED (the script finds the pages at run time).

### 4.14 How to replicate tiering and fallback from scratch

1. **Keep the core's GPU entry points replaceable.** Find the GPU only through `navigator.gpu.requestAdapter()` and the
   canvas through `getContext('webgpu')`. Never cache them at import.
2. **Put the backend behind a small interface** (`add`, `remove`, `render`, `dispose`, `onLost`) so a second renderer
   can plug in without touching core.
3. **Write the smallest useful fallback renderer first** (plain meshes on WebGL2) as its own package, loaded with
   `import()` only when WebGPU is missing. Measure its size into your size record.
4. **Detection in the app**, not the library: `'gpu' in navigator && await requestAdapter() !== null`. Test both
   failure modes (no `navigator.gpu`; adapter `null`).
5. **A friendly page when nothing works**: show a message without downloading the app code. Test every page that way.
6. **Device loss from day one.** Watch `device.lost` and frame-time `DOMException`s, recreate the renderer, re-add
   resources from CPU copies, call a restore hook on every plugin, keep transforms on the CPU so they need no restore.
   Add a test that destroys the device mid-frame on every demo.
7. **Tiers without device sniffing.** Start every desktop on a light tier, read real GPU time by timestamp queries for a
   short window only (submit to `onSubmittedWorkDone` also counts presenting and other work on the machine), per page, promote on the next page load only. Make URL overrides and an injectable storage for tests.
   Publish presets through one global that packages read at construction; explicit options win.
8. **Dynamic resolution** as a pure decision class (feed it frame costs) plus a thin watcher; skip a few frames after
   each change; back off after an undone rise.
9. **Only then a translation layer**, as its own package with lazy entries: front end (lexer, parser, checker, typed
   IR), back end, device, compute planner. Record a corpus of every shader your project creates at runtime and test
   the translator against all of it. Add a forced mode so the same machine can render both paths and compare pixels
   with a fixed metric (share over a threshold plus mean).
10. **Isolation test**: nothing else imports the layer, nothing changes at import, core bytes unchanged.

Generic reference version, not from the repo: app-side detection with three rungs.

```ts
// Generic reference version, not from the repo.
export async function createEngineWithFallback(canvas: HTMLCanvasElement) {
  const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  if (!adapter) {
    try {
      await (await import('your-engine/webgl2-compat')).install(); // rung 3: full layer
    } catch (error) {
      // Below the layer's minimum: rung 2, the small preview renderer.
      const { webglRenderer } = await import('your-engine/webgl');
      return Engine.create(canvas, { backend: 'webgl2', fallback: webglRenderer });
    }
  }
  return Engine.create(canvas); // rung 1, or the layer's WebGPU-shaped device
}
```

Generic reference version, not from the repo: GPU-time tier probe.

```ts
// Generic reference version, not from the repo.
export function measureGpu(queue: GPUQueue, onResult: (p90Ms: number) => void, samples = 120, skipMs = 2000) {
  const submit = queue.submit.bind(queue), times: number[] = [], start = performance.now();
  queue.submit = (buffers) => {
    const t0 = performance.now();
    submit(buffers);
    if (performance.now() - start > skipMs && times.length < samples)
      void queue.onSubmittedWorkDone().then(() => {
        if (times.push(performance.now() - t0) === samples) {
          queue.submit = submit;
          times.sort((a, b) => a - b);
          onResult(times[Math.floor(samples * 0.9)]);
        }
      });
  };
}
```

Generic reference version, not from the repo: the restore loop.

```ts
// Generic reference version, not from the repo.
let recovering: Promise<void> | undefined;
function restore(engine: EngineLike) {
  return (recovering ??= (async () => {
    const next = await createRenderer(engine.canvas, engine.features);
    for (const geometry of engine.geometries) next.add(geometry, engine.capacityOf(geometry));
    const previous = engine.renderer;
    engine.renderer = next;
    next.onLost = () => void restore(engine);
    previous.dispose();
    for (const plugin of engine.plugins) plugin.onDeviceRestored?.(engine);
  })().finally(() => (recovering = undefined)));
}
```

### 4.15 Failure modes and what we saw

| Failure | What was seen | Cause | Fix and guard |
| --- | --- | --- | --- |
| Shader links but fails at first draw on ANGLE D3D | lost context on large shaders | FXC compiles at first draw; dynamic vector indexes emulated per read | read 16-byte rows with static components; `corpus-draw-browser.mjs` catches the class |
| Discarding call inside an expression | compile failure (selection pick shader) | ANGLE D3D compiler limitation | evaluate into a temporary when WGSL order allows |
| Front end accepted `insertBits`/`extractBits` past 32 bits | accepted invalid WGSL | missing constant check | fixed with a regression test |
| Upload went to the wrong texture | old image in the materials check | `GLState.scratch` selected unit 0 only on binding change | fixed; `features-browser.mjs` |
| Depth written with depth writes off | wrong depth | resolve blit reset masks after pipeline state | bindings applied before pipeline state |
| Every fragment discarded (bug 51) | blank output | FXC miscompiles `if (!flag) discard;` after a texelFetch behind an early return | fragment tier ends `if (flag) return; discard;` |
| Mip view size wrong (bug 52) | 2 texels instead of 8 | ANGLE D3D11 applies `TEXTURE_BASE_LEVEL` twice in `textureSize` | sizes from a per-texture uniform |
| Canvas read one frame late (bug 53) | same-task `drawImage` saw the previous frame | present a microtask after submit | present at the end of each submit |
| 4x integer MSAA | incomplete framebuffer | ANGLE lacks multisample integer renderbuffers | refused with `unsupported` |
| Path tracer kernels on compat | 20 s to minutes per kernel | ANGLE D3D11 compiler time | out of scope, only planned |
| Wrong adapter on a two-GPU PC | visual check found no baseline | Windows lists the display GPU first; Remote Desktop changes it | `--use-adapter-luid` for the largest GPU (`85c96a55`, bug 33), `MARGO_GPU` |
| On-demand app blank after restore | empty canvas | nothing rendered after recovery | `redrawAfterRestore` |
| Tier check waited a fixed number of frames | failed on slower GPUs | timing assumptions | `scripts/check-fixed-waits.mjs` gate (`tests/check-fixed-waits.test.js` in verify) and `waitForPipelines` |
| Unit test limited one biomes tile to 400 ms of wall time | a landing stopped at 714.8 ms beside GPU jobs (about 30 ms alone) | a wall clock counts waiting for a CPU | `cpuTimer()` reads this thread's CPU time; `scripts/check-wall-budgets.mjs` gate |

---

## 5. Quality gates, pinned proofs and verification guardrails

### 5.1 Gate map

| Gate | Command | Script | Runs in | Fails when |
| --- | --- | --- | --- | --- |
| Core + stage size | `npm run build:packages`, `npm run measure:size` | `scripts/core-budget.js`, `scripts/measure-size.js` | every build, verify, CI | gzip of core + stage >= 25,000 B |
| Kernel Wasm size | every build | `scripts/build-modern.js` | every build | raw Wasm >= 30 KiB, invalid, lossy round trip |
| Quality ratchets (sizes, duplicates, tests, api, clean-room) | `npm run quality` | `scripts/quality-gate.mjs` | verify, CI | a new or worse item |
| Hygiene | `npm run hygiene` | `scripts/hygiene.js` | verify runs `--verify` (format and lint only, never fails) | only with `--strict` (5.5) |
| API reports | `npm run api:check` | `scripts/api-report.js` (NOT read in detail) | verify, CI | report drift (NOT VERIFIED in detail) |
| Parity table | `npm run check:parity` | `scripts/check-parity-table.mjs` (NOT read) | verify | NOT VERIFIED |
| Unit tests | `node --experimental-test-module-mocks --test ...` | `tests/*.test.js`, `packages/*/test(s)/*.test.js` | verify, CI | any failure |
| Doc links | `npm run docs:links` | NOT read | verify | NOT VERIFIED |
| Current proofs | `npm run proofs -- --current` | `examples/package-benchmarks/proofs/run.mjs` | verify | a golden output is different |
| Pinned proofs | `npm run proofs` | same | nightly only | a claim no longer reproduces (HISTORICAL passes) |
| Fresh clone | `npm run check:fresh-clone` | `scripts/fresh-clone-check.mjs` | check:merge | verify or a current proof fails in a history-free clone |
| Site build | `npm run build:site` | `scripts/build-site.js` | check:merge | build error |
| Visual regression | `npm run visual:check` | `scripts/visual-regression.js` | check:merge (affected demos) | `changed` or `hot` share over tolerance; no baseline for this hardware |
| Multi-view | `npm run check:views` | `scripts/test-views-browser.mjs` | check:merge when affected | pixels, picks, validation errors |
| Package GPU tests | `npm run check:gpu-packages` | `scripts/gpu-package-tests.mjs` | check:merge (affected ids) | any `test:*browser*`/`test:*gpu*` script fails |
| Depth | `npm run check:depth` | `scripts/test-depth-browser.mjs` (NOT read) | check:merge when affected | NOT VERIFIED |
| WGSL compile | `npm run check:wgsl` | `scripts/check-wgsl.mjs` | check:merge (affected packages) | any package WGSL fails to compile on the browser's WebGPU (fragments counted, not failed) |
| Packed packages | `npm run modern:test:packages` | `scripts/modern-package-tests.js` | check:merge (scoped), CI node-compat (`--consumer`) | licence and notice files, consumer declarations, README examples type-check, React docs and tests, packed browser |
| No WebGPU | `npm run check:no-webgpu` | `scripts/test-no-webgpu-browser.mjs` | check:merge when affected | missing message, uncaught error, preview pixels |
| Bundler matrix | `npm run modern:test:bundlers` | `scripts/bundler-matrix.mjs` | check:merge when a matrix package is affected, CI | a bundle misses an imported package or contains one not imported |
| Quickstart | `npm run check:quickstart` | `scripts/quickstart-timing.mjs` | check:merge | the README quickstart, followed line by line in a temp folder, does not render a textured, shadowed, pickable scene |
| Public truth | `node --test tests/public-truth.test.js` | `scripts/support/public-truth.mjs` | verify (unit tests) | licence statement or package count mismatch |
| Fixed waits | `tests/check-fixed-waits.test.js` | `scripts/check-fixed-waits.mjs` | verify | a new fixed frame count or sleep without `// fixed-wait: <reason>` |
| Wall-clock budgets | `tests/check-wall-budgets.test.js` | `scripts/check-wall-budgets.mjs` | verify | a new assert of elapsed wall time against a number: code speed reads `cpuTimer()` from `scripts/support/cpu-budget.mjs`, a bound on a wait says `// wall-clock: <reason>` |
| Dropped promises | `tests/support-async-calls.test.js` | the test itself | verify | an async test or script helper is called without `await` or `return` (a dropped promise; added after a React extras test failed this way) |
| Node versions | `node --test tests/proofs-golden.test.js tests/node-apis.test.js` | | CI node-compat | digests differ on a Node; API not on the minimum Node |
| Kernel | `npm run test:kernel` | cargo | CI kernel job | any Rust test |

### 5.2 The core + stage size gate

```js
// scripts/core-budget.js @ 67ca53a5
import assert from 'node:assert/strict';
export const CORE_STAGE_GZIP_LIMIT = 25_000;
export function checkCoreBudget(bytes) {
  assert.ok(Number.isSafeInteger(bytes) && bytes >= 0, 'Invalid core + stage gzip size');
  assert.ok(bytes < CORE_STAGE_GZIP_LIMIT, `Core + stage must be below ${CORE_STAGE_GZIP_LIMIT} bytes gzip: ${bytes}`);
}
```

```js
// scripts/measure-size.js @ 67ca53a5 (measureCoreStage, cut)
export async function measureCoreStage() {
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry: 'packages/stage/dist/index.js', formats: ['es'] },
      rollupOptions: {
        external: external.filter((name) => typeof name !== 'string' || !name.startsWith('@margoengine/core')),
        output: compactOutput,
      },
    },
  });
  const chunks = output[0].output.filter((item) => item.type === 'chunk');
  const code = chunks.map((chunk) => chunk.code).join('\n');
  const gzip = gzipSync(code).length;
  checkCoreBudget(gzip);
  return { raw: Buffer.byteLength(code), gzip, modules: chunks.flatMap((chunk) => Object.keys(chunk.modules)) };
}
```

Method: Vite library build of the stage entry with core bundled in (every other bare import external), minified for
ES2022, all chunks joined, default gzip level. The embedded kernel is inside core, so it counts.

AGENTS.md @ 67ca53a5, "v1.0.0 core freeze":

> CI must automatically fail any pull request that pushes the combined core + stage gzip size to **25,000 bytes or
> above**. A measured result from 22,000 through 24,999 bytes is inside the allowed band.

What exists: only the upper bound. The "band" is wording; no code checks 22,000. `measure:size` prints `baseline:
19_999` and a `delta` (informational). At 777bca5b core + stage is 21,974 B gzip, 54,876 B raw.

Core freeze in `docs/conventions.md` @ 67ca53a5: frozen against features, not bug fixes; a core bug fix goes in core
with a test inside the 25,000-byte gate and records the bytes it costs. A single recorded exception lifted the stage
facade for one restructuring (optional-package methods moved into feature entries; core + stage 22,781 -> 21,910 B).

### 5.3 `entry-sizes.json`

Shape at 67ca53a5 (values real, lists shortened):

```json
{
  "commit": "777bca5b",
  "dirty": false,
  "method": "vite minify es2022 + compactOutput (as build-modern), bare imports external, gzip default level",
  "coreStage": { "raw": 54876, "gzip": 21974, "limit": 25000 },
  "packages": {
    "@margoengine/core": { ".": { "raw": 51055, "gzip": 20547 }, "./extension": { "raw": 47902, "gzip": 19638 } },
    "@margoengine/quality": { ".": { "raw": 5256, "gzip": 2449 }, "./warm": { "raw": 2705, "gzip": 1308 } },
    "@margoengine/webgl": { ".": { "raw": 7003, "gzip": 3127 } }
  },
  "lazyFiles": ["packages/<pkg>/dist/<file>.js"]
}
```

- Written by `node examples/package-benchmarks/entry-sizes.mjs`, called from `node scripts/land-records.mjs` inside the
  landing lock (`AGENTS.md`). Not by `measure:size`, which only prints.
- Must name the same commit as `basic-scene-network.json` or `scripts/build-sizes.js` fails ("the records must name one
  commit").
- Registered as a generated record with a merge driver that keeps main's copy on rebase
  (`scripts/setup-merge-drivers.mjs`, `scripts/worktree-node-modules.mjs`; NOT read in detail).

### 5.4 The quality gate and its baselines

```js
// scripts/quality-gate.mjs @ 67ca53a5 (header)
// Quality gate (`npm run quality`, part of `npm run verify` and CI): five ratchets over packages/, each against a
// checked-in baseline in scripts/quality/baselines/<gate>.json. A gate passes on what the baseline records and fails on
// anything new or worse, with the fix in the message. See docs/conventions.md, "Quality gate".
//   sizes        gzip budget per package entry and worker; static imports of another package's heavy entry (leaks)
//   duplicates   code blocks copied between packages; value re-exports of another package's API
//   tests        every package tested in verify; every public entry imported by a test
//   api          TSDoc on public exports; throws follow docs/conventions.md (via npm run hygiene)
//   clean-room   no three.js / Babylon / other engines in packages/**; no unlisted third-party dependency
// Needs `npm run build:packages` and current api/ reports (sizes and api read dist/).
// Options: --gate=a,b (run some), --update (write shrunk baselines), --update --reason="..." (accept growth, logged),
// --summary (print the biggest offenders), --details (write test-results/quality.json with every item and block).
```

Baseline file shape (real keys and values, shortened):

```json
{
  "gate": "sizes",
  "about": "gzip budget per entry/worker (measured + max(3%, 256 B)); leak items: static loads of another package heavy entry",
  "total": 3997776,
  "history": [
    {
      "date": "2026-10-24",
      "commit": "5c34c002",
      "reason": "Initial baseline: what main held at 5c34c002 when the quality gate landed",
      "grew": 341
    },
    {
      "date": "2026-10-24",
      "commit": "63df28b9",
      "reason": "shadows: instanced batch path for 8+ core casters sharing a geometry (1,000 casters 7.2 -> 0.9 ms CPU/frame)",
      "grew": 1
    }
  ],
  "items": {
    "@margoengine/core": 20932,
    "@margoengine/quality": 2705,
    "@margoengine/webgl": 3277,
    "@margoengine/webgl2-compat": 93801
  }
}
```

At 67ca53a5: 419 items, 133 history entries. An item is a key and a limit. The reason for a growth is in `history`, not
on the item (there is no per-item reason field).

Ratchet rules:

```js
// scripts/quality/ratchet.js @ 67ca53a5 (header)
// Baselines for the quality gate (scripts/quality-gate.mjs). One JSON per gate in scripts/quality/baselines/:
//   { gate, about, history: [{ date, commit, reason }], items: { key: limit } }
// An item is one known violation (a count or a byte budget). The gate fails when a key is new or its measured value is
// over its limit. Shrinking is free (`--update`); growing a limit or adding a key needs `--update --reason="..."`, which
// appends the reason to `history`, so every growth is explained in the file.
```

```js
// scripts/quality/sizes.js @ 67ca53a5
/** Budget headroom: 3% or 256 bytes, whichever is larger. */
export const headroom = (bytes) => bytes + Math.max(256, Math.ceil(bytes * 0.03));
// ...
export const HEAVY = 10_000;
// ...
    allowance: (value, key) => (key.startsWith('leak ') ? value : headroom(value)),
```

Gates in detail (`docs/conventions.md` "Quality gate"):

| Gate | Items | Fails when |
| --- | --- | --- |
| sizes | gzip budget per entry and worker (budget = size + max(3%, 256 B)); `leak` = an entry that statically loads another package's entry of 10,000 B or more (core and math excepted) | over budget, new entry, new leak |
| duplicates | duplicated lines per package pair (6-line normalised windows of at least 200 characters, `WINDOW = 6`, `MIN_CHARS = 200`); known algorithm families; value re-exports across packages | more copied lines, a new copy, a new re-export |
| tests | a package without a verify test; an entry no test imports | new untested package or entry |
| api | undocumented public export, `throw new Error(`, a throw message with no fix | a new one |
| clean-room | mentions of other graphics libraries in `packages/**`; third-party dependencies | a new mention or dependency |

Note: the header of `quality-gate.mjs` says "8-line normalised windows" while `duplicates.js` has `WINDOW = 6` and the
conventions say 6. The code is 6.

Commands:

```sh
npm run quality                                       # all five gates
npm run quality -- --gate=sizes                       # one gate
npm run quality -- --gate=sizes --update              # lock in a shrink
npm run quality -- --gate=sizes --update --reason="why this growth is accepted"
npm run quality -- --summary                          # biggest offenders
npm run quality -- --details                          # test-results/quality.json
```

`node scripts/land-records.mjs` runs `--update` shrink-only inside the landing lock; a baseline that would grow stops it.

### 5.5 Hygiene

```js
// scripts/hygiene.js @ 67ca53a5 (header, cut)
// Code hygiene scorecard: `npm run hygiene` measures each 5k gate per package and overall,
// prints a table and writes test-results/hygiene.json. Needs `npm run build:packages` and current api/ reports (gates
// 3, 5 and 6 read the built dist/*.d.ts and api/*.api.md). `node scripts/hygiene.js --verify` runs only gates 1-2
// (Biome format check + lint, about 2 s, no build needed) and never fails: the gates are in warn mode until phase 2
// lands, then `--strict` makes any violation exit 1.
// ...
// Score per gate: max(0, 10 - 100 * violations / units): each 1% of units in violation costs one point, so 10 means
// none and 9 means at most 1%. Overall gate scores use repo-wide totals; a package's score is the mean of its gates;
// the hygiene score is the mean of the 8 measured gates. `met` is true only at 0 violations (the 5k target).
```

Gates: 1 format (Biome), 2 lint (Biome), 3 `any` in public API and src (allowlist with reasons in
`scripts/hygiene-allowlist.json`), 4 strict tsconfig flags, 5 duplicate or clashing type names across packages, 6
TSDoc on exports, 7 bare `Error` throws, 8 API rough edges (by hand), 9 dead files and exports.

Reality vs AGENTS.md: AGENTS.md says "`npm run hygiene`: no gate gets worse for the packages you touched". The
hygiene script itself does not fail in verify. The "no worse" part is enforced for TSDoc and throws through the
quality gate's `api` ratchet; for the other hygiene gates it is a rule for the agent, not a check (NOT VERIFIED that
anything else enforces it).

### 5.6 `npm run verify`

```js
// scripts/verify.mjs @ 67ca53a5 (cut)
/** Stage 1: in order. */
export const SERIAL = ['node scripts/hygiene.js --verify', 'npm run build:packages'];

/** Half the machine's threads for the unit tests (the no-burn rule), at least the 4 they always had and at most 8. */
export const TEST_CONCURRENCY = Math.min(8, Math.max(4, availableParallelism() >> 1));

/** Stage 2: each entry is a chain of commands run one after another; the chains run side by side. */
export const PARALLEL = [
  ['npm run api:check'],
  ['npm run quality'],
  ['npm run check:parity'],
  ['npm run build --workspace examples/gameplay-sandbox', 'npm run test --workspace examples/gameplay-sandbox'],
  ['npm run build --workspace examples/voxel-sandbox', 'npm run test --workspace examples/voxel-sandbox'],
  [
    `node --experimental-test-module-mocks --test --test-concurrency=${TEST_CONCURRENCY} tests/*.test.js packages/*/tests/*.test.js packages/*/test/*.test.js`,
  ],
  ['npm run docs:links'],
  ['npm run measure:size'],
  ['npm run proofs -- --current'],
];
```

- Stage 1 runs in order and stops at the first failure.
- Stage 2 chains run side by side; the first failure kills the rest (whole process tree, `taskkill /T /F` on Windows)
  and prints its output.
- `--serial` runs one step at a time.
- `MARGOENGINE_PLANT_STALE=1` (set by check:merge) plants a stale file in two `dist` folders before the build; the
  tarball test later proves no pack contains it.

### 5.7 `npm run check:merge`

```json
"check:merge:steps": "npm run verify && npm run check:fresh-clone && npm run build:site && npm run visual:check -- --no-build && npm run visual:compat -- --no-build && npm run visual:compat:budget -- --chunk=8 && npm run check:views && npm run check:gpu-packages -- --no-build && npm run check:depth && npm run check:wgsl && npm run modern:test:packages && npm run check:no-webgpu && npm run modern:test:bundlers && npm run check:quickstart"
```

(`package.json` @ 67ca53a5.)

How it narrows (`scripts/check-merge.mjs`, `scripts/support/affected-gpu.mjs`, `scripts/support/affected-packages.mjs`):

1. Changed files = diff from the merge base with `origin/main`, committed or not, untracked included.
2. Each file maps to a workspace package; dependents are added transitively.
3. Full run when: a file under `packages/core`, `packages/stage`, `packages/shared` or `packages/margoengine`; build
   or check scripts, `package.json` or lock files; WGSL outside a package; a file nothing classifies; more than 12
   affected packages (`MAX_AFFECTED = 12`); `MARGO_FULL=1`; `--full`; or no diff possible.
4. Otherwise each GPU step runs only if its footprint (the packages and files it exercises, read from its sources)
   meets the affected set: `visual:check --only=<demos>`, `check:gpu-packages --select=<ids>`, `check:wgsl --
   --packages=<dirs>`, `check:views`, `check:depth`, `check:no-webgpu` on or off.
5. `verify`, `check:fresh-clone`, `build:site` and `check:quickstart` always run. `modern:test:packages` always runs,
   scoped to affected packages' README examples plus the umbrella smoke test. `modern:test:bundlers` runs when a matrix
   package is affected.
6. The mode and reason print first and go to `test-results/check-merge.json`. `--plan` prints and runs nothing;
   `--files=a,b` pretends.
7. A step classified in neither `GPU_STEPS`, `PLAIN_STEPS` nor `SCOPED_STEPS` fails a unit test, so someone decides.

Driver-reset retry (VERIFIED in the header): "A step that fails while the Windows event log shows a GPU driver reset
(scripts/support/driver-resets.mjs, bug 25) runs once more; the reset is printed and recorded with the step, and a
second failure fails the run. A run that passed only that way says so: a 'PASSED WITH A DRIVER RESET' line per step or
GPU test, and `passedAfterDriverReset: true` in check-merge.json." This is the one place a step is rerun
automatically, and only on a logged driver reset.

```sh
npm run check:merge                 # affected GPU work
npm run check:merge:full            # everything (also MARGO_FULL=1)
node scripts/check-merge.mjs --plan                  # print the plan only
node scripts/check-merge.mjs --plan --files=packages/dof/src/index.ts
node scripts/nightly-full.mjs       # check:merge:full, then pinned proofs, dated log in test-results/nightly/
```

### 5.8 CI workflows

`.github/workflows/ci.yml` @ 67ca53a5, on push and pull request:

| Job | Node | Steps |
| --- | --- | --- |
| lint | 24 | `npm ci`, `npm run lint`, `npm run typecheck` |
| test | 24.18.0 (minimum from root engines) | build:packages (size budget), `check-engines --run=repo`, `api:check`, `quality`, unit tests at concurrency 4 |
| node-compat | 22.12.0, 22, 26 | build, `check-engines --run=packages`, `tests/proofs-golden.test.js tests/node-apis.test.js`, Playwright chromium, `modern:test:packages -- --consumer` with `MARGO_SOFTWARE_GPU=1`, `modern:test:bundlers`, `npm test` on 26 |
| node22-tests | 22.12.0, 22 | `node scripts/node22-tests.mjs` |
| kernel | toolchain from `rust-toolchain.toml` | `cargo test --locked --manifest-path packages/kernel/Cargo.toml` |

`.github/workflows/browser.yml` is `workflow_dispatch` only (on demand): kernel tests, a Windows packages job (build,
api, quality, typecheck, sandboxes, `test:all`, React and USDZ suites, and more). `publish.yml` was not read.

The proofs (`--current`), check:merge and every GPU step are not in CI; they run on the developer machines. Whether
Actions run for this repository is NOT VERIFIED.

### 5.9 Proofs

#### What a proof is

```text
examples/package-benchmarks/proofs/<name>.proof.js
```

A Node script that runs a scripted "story" of a package against a recording stand-in GPU (`gpu-recorder.js`
`mockGPU`), once with the package at a baseline ref and once with the candidate, and asserts that every GPU call,
descriptor and buffer byte is identical (or, for a one-time claim, that the claimed change happened and timings beat
the baseline). A proof also asserts the feature-on path is different, so the comparison can see the feature.

```js
// examples/package-benchmarks/proofs/selection-xray-off.proof.js @ 67ca53a5 (cut)
// Proof that x-ray outlines (hidden lines) leave selection unchanged while x-ray is off: every GPU call, descriptor and
// buffer write of a 30-frame story (core meshes, a gltf-pro-shaped model and its nodes, width, color, both algorithms,
// resize, hidden nodes, depth and color format changes, an empty selection, model rescans, device restore, dispose)
// matches the package at `ref`, byte for byte, at 1x and 4x MSAA, with `xray` absent, false and deleted mid-story.
// The same story with x-ray on must differ (so the comparison can see the feature).
// Run: node examples/package-benchmarks/proofs/selection-xray-off.proof.js [ref] [pin] [--current]
// Pinned: 46f9484 against 80d4cfb, the commit that made this claim. --current: b3ed8ac against the working tree;
// 6a57389 added the approved ambient uniform and 95b4eae added back-side-only model culling (claims.md).
import assert from 'node:assert/strict';
import { refs, versions, current, golden } from './compare.js';
import { mockGPU, passes, context } from './gpu-recorder.js';

const { ref, pin } = refs('46f9484', '80d4cfb', 'b3ed8ac'),
  { baseline, candidate } = await versions('selection', ref, undefined, pin);

function story(module, samples, xray) {
  const gpu = mockGPU();
  // ... a stand-in engine: meshes, store, frame graph, plugins
  return gpu.record(() => {
    const selection = new module.Selection(xray === undefined ? {} : { xray });
    selection.setup(engine);
    const run = passes(selection);
    for (let i = 0; i < 30; i++) {
      // ... scripted edits at fixed frames, including selection.onDeviceRestored(engine) at frame 22
      view.begin(i);
      run(view.c);
      view.end();
    }
    selection.dispose();
  });
}
let entries = 0;
for (const samples of [1, 4])
  for (const xray of [undefined, false]) {
    const expected = await golden(`${samples}x xray ${xray}`, () => story(baseline, samples, xray)),
      actual = story(candidate, samples, xray);
    // ... assert identical
  }
```

`refs(baseline, pin, currentRef)` gives three refs: the pinned baseline, the claim commit, and the reference for
`--current`.

#### Pinned and current

```js
// examples/package-benchmarks/proofs/run.mjs @ 67ca53a5 (header)
// Runs every *.proof.js, two at a time, and prints one row per proof. Results files are left alone (PROOFS_NO_WRITE).
//   npm run proofs                      every proof, pinned: its baseline ref against the commit where its claim was made
//   npm run proofs -- --current         the proofs of an ongoing guarantee, against the working tree
//   npm run proofs -- --only=post-ssr,splats
// --current compares the working tree with golden outputs stored in baselines/ (golden.js, PROOFS_GOLDEN=1) and reads
// nothing from Git, so every clone, shallow or fresh, runs exactly what this checkout runs (it is part of verify); a
// value the store lacks fails its proof by name, and a --current proof is never HISTORICAL.
// Pinned runs rebuild old commits from Git. A proof that cannot run prints `HISTORICAL: <commit and reason>` and exits
// 0; it is reported, not failed: a clone without the pre-rewrite commits (history.js), or procedural-deps' npm packages
// that a fresh install lacks.
// Run after `npm run build:packages` (proofs import @margoengine/core and some package builds from dist).
```

- **Pinned** (`npm run proofs`): rebuild the package at the baseline ref and at the claim commit (the pin) from Git and
  compare. Later code cannot change the result. Nine proofs call `coreAt(pin)` so both sides also run the core of the
  claim commit (bug 6). Runs nightly only: about 40 pinned proofs time speed-ups with margins near 5% (loaders 1.05x,
  bvh 1.07x, creative 1.08x on 2026-10-27), which a busy landing machine can erase.
- **Current** (`npm run proofs -- --current`, in verify): the 20 proofs in the `ongoing` list compare the working tree
  with stored golden outputs. Ongoing at 67ca53a5: clustered-area-lights, clustered-light-hooks,
  clustered-local-shadows, color-output, deformed-shadows, environment-hemisphere, environment-volumetric,
  gltf-pro-lighting-hooks, lines-perspective, materials-uv-transform, math-consolidation, oit-detached, post-ssr,
  post-ssr-models, post-stack, quality-presets, selection-xray-off, taa-velocity, terrain-ssr, water-ssr.
- **Golden outputs**: `proofs/baselines/<proof>.json` (meta and SHA-256 per output) plus `<proof>.json.gz` (the
  values, lossless). Captured once by `proofs/capture.mjs` on a checkout holding the reference commit, only after the
  proof passed against it. No old source is stored, only output. Introduced 2026-10-27 because 14 of 20 current proofs
  rebuilt baselines from commits that existed only in one checkout's pre-rewrite history.

Baseline meta shape (real, outputs shortened):

```json
{
 "proof": "quality-presets",
 "ref": "667d1a26",
 "revision": "667d1a26fd14e26605ed80579774a3f4592a9450",
 "capturedAt": "a66d73c206b97428c28b0329b36d14a4723b6919",
 "facts": {},
 "outputs": {
  "shadows 1x": "cd8e98cee82ad82d4fe8c2bb4e1eae82e9aadf12b795702c7435e0154beb5b69",
  "shadows 4x": "29ddee7831e0bddf6e895b8b1d12a178f0e8d02a11b5fae4955e0e13126090fa"
 }
}
```

#### Advancing a proof's reference after a deliberate change

From AGENTS.md "Before every push to main" @ 67ca53a5:

> `npm run proofs -- --current` passes. If a deliberate change alters what a feature-off path emits, advance that
> proof's current reference to your commit and say why in `docs/whitepaper/claims.md`; never leave a proof failing.

From `claims.md` @ 67ca53a5: advance the reference, then run `node examples/package-benchmarks/proofs/capture.mjs
--only=<proof>` on a checkout with that commit; it stores the new values and replays them from the store.

Procedure:

1. Confirm the change is intended and audit every changed call (claims.md entries list exactly which calls, bytes and
   shader characters changed, for example "exactly one of the 1,321 calls is different ... by the one character `-b*scale`
   -> `b*scale`").
2. Change the third argument of `refs(...)` in the proof to the new commit.
3. Run `capture.mjs --only=<proof>` on a checkout holding that commit; it re-captures only after the proof passes.
4. Add a dated paragraph to `docs/whitepaper/claims.md` under "Optimization proofs" naming the old ref, the new ref,
   the commits that changed the output on purpose and what changed. Update the reference column of its table.
5. Never touch the pinned baseline and claim commits, or the assertions.

#### Other proof rules recorded in claims.md

- NaN payloads compare as one value (`canonicalNaN`); every other bit, `-0` included, counts.
- `ignoreAgx(calls, ref)` is the only normalisation: it blanks the `agx()` body only when the baseline predates
  `eaddd64`.
- A HISTORICAL row passes in pinned mode and fails in `--current`.
- `check:fresh-clone` builds a history-free shallow clone and runs verify and the proofs in it.

### 5.10 Visual regression

```js
// scripts/visual-regression.js @ 67ca53a5 (header, cut)
// Visual regression for the site demos. Needs a real GPU, so it is not part of `npm run verify`.
//   npm run visual:check  [-- --only=earth,dof-high] [--runs=N] [--no-build]   compare against matching hardware baselines
//   npm run visual:update [-- --only=...] [--runs=3] [--no-build]             re-capture baselines and noise tolerances
//   npm run visual:device-loss [-- --only=...] [--no-build]                     device loss in every site demo (5i.d)
// Run `npm run build:packages` first; the script builds the site (scripts/build-site.js) and serves site/dist.
// Refuses on battery, takes a shared slot of test-results/gpu.lock in the main checkout (scripts/gpu-lock.mjs: up to 3
// correctness checks at once, waits behind a benchmark), and discards the run if AC power is lost.
// ...
// Determinism: every capture runs in a fresh browser context with prefers-reduced-motion: reduce, which every demo
// honours as its pause (still frame at t = 0: delta 0 / animation paused / rotation paused), and a forced tier
// (`?quality=high|low`; phones are picked by user agent). The demo's own readiness signal (submitPrincipalScene /
// data-ready / full-detail upgrade) gates the screenshot. Dynamic text (FPS, telemetry) is masked.
// Comparison: images are box-downsampled (`factor`) to cut storage and pixel-level noise; per pixel d = max RGB
// difference (0-255). Gated: `changed` = share of pixels with d > 0 (catches small wide shifts such as a light colour;
// sparse particle noise barely moves it) and `hot` = share with d > HOT (local changes). `mean` and `max` are reported.
```

```js
// scripts/visual-regression.js @ 67ca53a5
const HOT = 24; // a pixel off by more than ~10% in some channel
// Tolerance = noise floor x MARGIN + a floor-independent allowance (so a bit-exact demo still tolerates a stray pixel).
const MARGIN = 3,
  ALLOWANCE = { changed: 0.0005, hot: 0.0002 },
  GATED = Object.keys(ALLOWANCE);
```

- Views per demo: `high` (1280x720, `?quality=high`), `light` (`?quality=low`), `phone` (an iPhone user agent, small
  viewport).
- `visual:update` captures each view 4 times (default) in separate browser launches; the worst pairwise noise sets
  the tolerance. A capture is retaken until two in a row match (mid-raster frames under load).
- Manifest `tests/visual/manifest.json`: per view `url`, `size`, `runs`, `noise`, `tolerance`, and `environment`
  (browser, GPU, AC power before and after, date, commit, `packagesDirty`, `renderedInputsDirty`).

Baselines per GPU profile (`scripts/support/visual-baselines.js`):

- A profile id is `<gpu slug>-<browser family>-<browser major>`. The legacy root set is used only when GPU, browser
  family and major version all match its environment; otherwise `tests/visual/profiles/<id>/`.
- Creating a profile needs a full view set from a clean tree (no uncommitted rendered inputs).
- Every capture of one noise floor must come from the same GPU and exact browser version.
- A run on hardware with no profile fails with a message naming the GPU, the committed profiles and the fix
  (`MARGO_GPU=nvidia`, or `npm run visual:update` only if this hardware should have its own baseline).

Committed at 67ca53a5:

| Set | GPU | Browser |
| --- | --- | --- |
| `tests/visual/*.png` (legacy, 57 files including the manifest) | `intel xe-2lpg` (Intel Arc 140V) | msedge 155 |
| `tests/visual/profiles/nvidia-ampere-msedge-155` | NVIDIA RTX A6000 | Edge 155 |
| `tests/visual/profiles/nvidia-ampere-msedge-156` | NVIDIA RTX A6000 | Edge 156 (62 views, 4 runs each) |

The gap: no profile for Intel on Edge 156 (so the Intel laptop fails "no baseline" once its Edge updates), none for
Intel UHD, AMD (Radeon 680M) or any Linux machine. Each needs a full `visual:update` on that hardware from a clean tree.

### 5.11 Public truth

```js
// scripts/support/public-truth.mjs @ 67ca53a5 (cut to the package-count part)
// Public statements that must match their source: the licence in the site's structured data (package.json and LICENSE
// are the source) and every stated count of packages (docs/catalog.json is the source: one entry per package under
// packages/). `node scripts/support/public-truth.mjs` prints problems and exits 1; tests/public-truth.test.js runs the
// same functions on the repo (so `npm run verify` and `check:merge` fail on a mismatch) and on planted mismatches.
// ...
/** Phrases that state how many packages there are in all; the number is the first capture group. */
const COUNT_PHRASES = [
  /\b(\d[\d,]*) packages in \d+ layers/g,
  /\b(?:Search all|all|includes|lists|has) (\d[\d,]*) (?:optional )?packages\b/gi,
  /\b(\d[\d,]*) (?:optional )?packages \(none published/g,
  /^(\d[\d,]*) packages, \d[\d,]* entries/gm,
  /<b>(\d[\d,]*)<\/b><span>(?:optional )?packages/g,
];
// ...
/** Files that state a package count in public (the HTML pages under site/whitepaper are added by name). */
export const COUNT_FILES = [
  'README.md',
  'docs/README.md',
  'docs/limits.md',
  'docs/releasing.md',
  'docs/api-surface.md',
  'docs/whitepaper/claims.md',
  'site/index.html',
  'site/llms.txt',
  'site/llms-full.txt',
];
```

Two checks:

1. Licence statement: every JSON-LD `license` value in `site/index.html` and `site/whitepaper/*.html` must be one of
   the URLs mapped to `package.json`'s `license` id, and `LICENSE` must contain that licence's text. A page with
   JSON-LD but no licence fails with the fix.
2. Package counts: every phrase above in the count files and white-paper pages must equal the length of
   `docs/catalog.json`.

What it does not check: sizes, timings, test counts or any other number. Those depend on "Public numbers stay true"
in AGENTS.md (by hand against `npm run measure:size`) and on `claims.md` statuses. Found while reading: the webgl
preview size is different across README (3,021), `claims.md` LIM-022 (2,156) and `entry-sizes.json` (3,127), which no
check caught.

### 5.12 The rules as they appear in AGENTS.md (67ca53a5)

"Before every push to main" (quoted in part):

> Several agents push to `main`. Each push must leave it at least as clean as it found it:
>
> - `npm run verify` passes. For changes to shaders, anything a demo draws, a package README or package exports, run
>   `npm run check:merge` ...
> - `npm run hygiene`: no gate gets worse for the packages you touched. New public exports carry TSDoc; new throws
>   follow `docs/conventions.md` ...
> - `npm run proofs -- --current` passes. ...
> - Public numbers stay true: `site/index.html`, `README.md` and `docs/limits.md` must match `npm run measure:size`.
> - `git pull --rebase` before pushing (no merge commits of `main` into itself), one commit per change, and no repeated
>   record-only commits.
> - ... Inside the landing lock, right after the rebase and from a clean tree, run `node scripts/land-records.mjs` ...
> - GPU tests share 3 slots; benchmarks take the GPU exclusively; every lock hold has a time limit.

"Bugs: fix the cause, properly":

> - Find and fix the root cause in the package that owns it, core included (the freeze blocks features, not bug
>   fixes). No band-aids: no try/catch that hides an error, no retry loops, no special cases for one input, no
>   loosened tests or tolerances, no skipped tests, no "left as is" notes.
> - Every fix ships with a regression test that fails without it. When a whole class of bug slipped through, add a
>   check to `check:merge` that catches the class.
> - A bug you cannot fix now goes into `docs/known-bugs.md` with a repro and its cause. That list must be empty
>   before release.

### 5.13 "Never land dirty" and "rule 10"

- **Never land a dirty merge check** is in the maintainer's global agent instructions (outside the repository), section
  "Landing and parallel-agent limits": nothing goes to main unless every step of the full pre-merge check passes; an
  "unrelated" or "already on main" failure is still yours; never dismiss it, land anyway, skip a step, retry until
  green, or loosen a check. The repository's nearest wording is AGENTS.md "Before every push to main" (each push
  leaves main at least as clean as it found it) and "Bugs: fix the cause, properly" (no retry loops, no loosened
  tests). The global instructions also allow rerunning one failed step alone under stated conditions (every other
  step passed, only a confined fix or a rebase onto fully checked commits since, and the report names the step).
- **"Rule 10"**: the repository has no rule numbered 10 at 67ca53a5 (AGENTS.md has no numbered rules;
  `docs/conventions.md` has none). Rule 10 of the helper rules file (`handoffs/session-rules.txt`, outside the repository)
  is the one that allows rerunning a single failed check:merge step under stated conditions (section 2.11).

### 5.14 Reproducible benchmarking protocol

From `docs/benchmarking.md` @ 67ca53a5 (DOCUMENTED; the bench scripts under `bench/` were not read line by line).

Defaults:

| Option | Default |
| --- | --- |
| `--runs` | 5 measured runs per case (smoke 3) |
| `--warmup` | 1 discarded run per case |
| `--frames` | 300 per browser run after 60 warm-up frames (smoke 120) |
| `--noise` | 0.1: a primary metric with spread over 10% makes the run invalid |
| `--threshold` | 0.05 (bytes 1%) |
| gate | `--quiet-max` 20% CPU held `--quiet-hold` 20 s; `--gpu-max` 20% (NVIDIA, three samples); `--timeout` 1800 s |

Summary per metric: `median` (the number to quote), `p95` (nearest rank; with 5 runs the slowest run), `spread =
(max - min) / median`, `noisy`. Note: p90 is not used by the benchmark tool; it appears in `@margoengine/quality` (light-tier promotion).

Quiet-machine rules (quoted in part):

> 1. **AC power.** On battery the run refuses to start. `BENCH_ALLOW_BATTERY=1` runs anyway and marks it invalid.
> 2. **GPU lock.** Any suite that uses the GPU holds `test-results/gpu.lock` in the main checkout ...
> 3. **Idle baseline.** Whole-machine CPU must stay at or under `--quiet-max` (20%) for `--quiet-hold` (20 s) ...
> 4. **Between cases.** The CPU load is checked again before each case. ...
> 5. **Repetition.** Each case gets 1 warm-up run and 5 measured runs. ...
> 6. **Noise.** If a primary metric's spread over runs is over 10%, the run is invalid.
> 7. **Fixed conditions.** Browser runs use headless Edge, a 1280 x 720 canvas at DPR 1, vsync and the frame cap off,
>    and cross-origin isolation (fine timers). ...

A number is official only with `--label=official`, defaults, a valid run and `--record`. Everything else is smoke or
dev "and must say so wherever it is quoted".

Regression rule: worse by more than the threshold and by more than either run's spread. Bytes and counts fail on any
machine; timings only against a baseline from the same machine id (hash of CPU, threads, memory, GPU, OS).

Like-for-like rules for comparing engines:

- Every scene is plain data in `bench/scenes/catalog.js`; each engine implements `create(canvas, {scene, params,
  data}, marks)` returning `render(t)`, `idle()`, optional `info()`.
- Other engines' code never lives in the repository (clean room); it lives in a sibling `engine-bench/` folder.
- Interleaved runs with a random first engine; identical recorded settings; one result file per comparison.
- GPU time comes from timestamp queries the harness adds to every pass, not from any engine's profiler.

Publishing losses (`docs/whitepaper/perf-vs-threejs.md` @ 67ca53a5): the ledger keeps every first-run result, losses
included, and never overwrites one; a fixed row shows before and after with cause, trade-off, fix commit and rerun
command; rows still slower link to their known-bugs entry. That page is marked "Diagnostic, busy machine, not for
publication" until a quiet-machine run.

Speed matrix files:

| File | Role |
| --- | --- |
| `bench/scenes/catalog.js`, `bench/scenes/margo.js`, `bench/scenes/parity/` | scenes and Margo's side |
| `bench/parity-report.mjs` | builds the report and the ledger |
| `bench/parity-causes.json` | per-row cause, known bug, fixes with commit, trade-off and rerun |
| `docs/whitepaper/perf-vs-threejs.json` | the ledger (append-only) |
| `docs/whitepaper/perf-vs-threejs.md` | rendered from the ledger |
| `docs/three-parity-matrix.md` | feature parity (NOT read) |
| `benchmarks/baselines/<machine>.json`, `benchmarks/records/` | committed machine baselines and official records |

Accepted differences in work appear as row notes in the ledger (for example the STL row: "an accepted difference in
work"). The "never skip work to match speed" rule is in the global agent instructions (section 1.13), not in the repository docs.

### 5.15 Banned-pattern merge check: generic design, not implemented

Status at 67ca53a5: the repository has no banned-pattern check script, list file or test. What follows is a generic
design, written for reuse; it names no terms.

Design (generic):

1. **Input**: every tracked file (`git ls-files -z`), text only (skip a file with a NUL byte in its first 8 KB),
   including lock files, generated records, `llms` files and the site.
2. **Tokenise**: split each file into words with a fixed regex (for example `/[a-z0-9]+(?:-[a-z0-9]+)*/gi`); lowercase;
   consider each word as written and with hyphens removed, so spelling variants hit.
3. **Hashed list**: the list file stores `sha256("<salt>:" + word)` truncated (for example 24 hex digits) for single
   words, and base64 of each regex with flags for multi-word phrases and path patterns. The list itself therefore
   contains none of the terms in plain text, and the check excludes the list file by path.
4. **Package-specific patterns**: patterns can be scoped to paths (for example only under `packages/<name>/`), so a
   word that is legitimate in one package is still banned elsewhere.
5. **Allowlist**: `{ path or glob, id, reason }` entries; every entry needs a reason and review. Nothing else.
6. **Output**: `path:line: banned pattern <id> (<reason>)`, exit 1 on any hit; the message names the fix (remove it, or
   add an allow entry with a reason).
7. **Placement**: no GPU, a few seconds, so it belongs in `verify` (and thus `check:merge`).
8. **Regression test**: a temporary file with each banned form is reported (the test types the plain word through
   `String.fromCharCode` so the test file itself is clean); an allowlisted file is not; the list file decodes and
   contains no plain term; a binary file is skipped.

Generic reference version, not from the repo:

```js
// Generic reference version, not from the repo.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SALT = 'project-banned:';
const hash = (word) => createHash('sha256').update(SALT + word).digest('hex').slice(0, 24);

export function bannedHits(root, list) {
  const tokens = new Map(list.tokens.map((t) => [t.hash, t]));
  const patterns = list.patterns.map((p) => ({ ...p, re: new RegExp(Buffer.from(p.base64, 'base64').toString('utf8'), p.flags) }));
  const allowed = (path, id) => list.allow.some((a) => a.id === id && path.startsWith(a.path));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = [];
  for (const path of files) {
    if (path === list.self) continue;
    const bytes = readFileSync(`${root}/${path}`);
    if (bytes.subarray(0, 8192).includes(0)) continue; // binary
    const lines = bytes.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      for (const word of line.match(/[a-z0-9]+(?:-[a-z0-9]+)*/gi) ?? [])
        for (const form of new Set([word.toLowerCase(), word.toLowerCase().replaceAll('-', '')])) {
          const t = tokens.get(hash(form));
          if (t && !allowed(path, t.id)) hits.push(`${path}:${i + 1}: banned pattern ${t.id} (${t.reason})`);
        }
      for (const p of patterns)
        if ((!p.scope || path.startsWith(p.scope)) && p.re.test(line) && !allowed(path, p.id))
          hits.push(`${path}:${i + 1}: banned pattern ${p.id} (${p.reason})`);
    });
  }
  return hits;
}
```

### 5.16 How to replicate the gates from scratch

Build in this order, each with its own test before the next:

1. **Size records first.** One script that bundles every public entry the way consumers will (minified, bare imports
   external, gzip) and writes `entry-sizes.json` with the commit and a `dirty` flag. A hard budget for the core path
   that fails the build (`bytes < limit`).
2. **A ratchet library** (`compare`, `updateBaseline`): baselines `{gate, about, total, history, items}`; new or worse
   fails; shrinking is free; growth needs a reason appended to history. Use it for sizes (with headroom), duplicates,
   untested entries, API docs and clean-room mentions.
3. **verify**: fast format and lint first, one build, then everything that reads the build in parallel; kill the tree
   on the first failure; print timings.
4. **Golden-output proofs** for every "feature off changes nothing" claim: a recording stand-in GPU, a scripted story
   with every edge (resize, format change, device restore, dispose), outputs stored with their hash, captured only
   after the proof passes against the reference. Keep a `--current` mode in verify and a pinned mode nightly.
5. **A fresh-clone check** that runs verify and the proofs in a parentless shallow clone, so nothing depends on local
   history.
6. **Affected-only merge check**: map changed files to packages and dependents; give each GPU step a footprint; fall
   back to the full run when unsure; print the mode and reason; nightly full run with a dated log.
7. **Visual regression** with per-hardware profiles keyed by GPU, browser family and major version; tolerance from
   measured noise; refuse to compare across profiles; full capture from a clean tree to create one.
8. **Public-truth checks** for every number or statement that has a single source (counts, licence statement); extend
   to sizes when the site quotes them.
9. **Benchmark tool** with a quiet-machine gate, warm-up, repetition, spread validity, interleaved engines, machine id
   for timing comparisons, and an append-only ledger that keeps losses.
10. **Banned-terms check** if the project has words that must never appear (5.15).
11. **Timeouts on every step** and a single, logged automatic rerun only for a proven external cause (Margo: a logged
    GPU driver reset).

Generic reference version, not from the repo: a ratchet.

```js
// Generic reference version, not from the repo.
export function ratchet(measured, baseline, allowance = (v) => v) {
  const worse = [], better = [];
  for (const [key, value] of Object.entries(measured)) {
    const limit = baseline.items[key];
    if (limit === undefined || value > limit) worse.push({ key, value, limit: limit ?? null });
    else if (allowance(value) < limit) better.push({ key, value, limit });
  }
  for (const key of Object.keys(baseline.items)) if (!(key in measured)) better.push({ key, value: 0 });
  return { worse, better };
}
export function update(baseline, measured, { reason, allowance = (v) => v, commit, date }) {
  const items = {}, grown = [];
  for (const key of Object.keys(measured).sort()) {
    const value = measured[key], limit = baseline.items[key];
    if (limit === undefined || value > limit) grown.push(key);
    items[key] = limit === undefined || value > limit ? allowance(value) : Math.min(limit, allowance(value));
  }
  if (grown.length && !reason) throw new Error(`${grown.length} item(s) would grow; pass --reason="why"`);
  const history = [...baseline.history];
  if (grown.length || !history.length) history.push({ date, commit, reason: reason ?? 'Shrink only', grew: grown.length });
  return { ...baseline, items, history, total: Object.values(items).reduce((a, b) => a + b, 0) };
}
```

Generic reference version, not from the repo: a golden-output proof skeleton.

```js
// Generic reference version, not from the repo.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function proveIdentical(name, story, candidate, store = `proofs/baselines/${name}.json`) {
  const golden = JSON.parse(readFileSync(store, 'utf8'));
  for (const [label, expected] of Object.entries(golden.outputs)) {
    const calls = story(candidate, label); // every GPU call, descriptor and buffer byte, in order
    assert.equal(sha(calls), expected, `${name} ${label}: output is different from ${golden.ref}`);
  }
}
```

Generic reference version, not from the repo: an affected-only decision.

```js
// Generic reference version, not from the repo.
export function decide({ files, packageOf, dependentsOf, fullTriggers, max = 12 }) {
  const changed = new Set();
  for (const file of files) {
    if (fullTriggers.some((t) => file.startsWith(t))) return { mode: 'full', reason: `shared file ${file}` };
    const pkg = packageOf(file);
    if (pkg) changed.add(pkg);
    else if (!/\.(md|txt)$/.test(file)) return { mode: 'full', reason: `cannot classify ${file}` };
  }
  const affected = dependentsOf(changed);
  if (affected.size > max) return { mode: 'full', reason: `${affected.size} packages affected` };
  return { mode: 'affected', affected: [...affected] };
}
```

### 5.17 Failure modes and what we saw

| Failure | What was seen | Cause | Fix and guard |
| --- | --- | --- | --- |
| Fresh clone failed verify | 14 of 20 current proofs could not find their baseline commits | baselines rebuilt from commits only in one checkout's pre-rewrite history | golden outputs in `proofs/baselines/`; `check:fresh-clone` in check:merge |
| Pinned proofs failed for days unnoticed | 9 proofs failed | only `--current` ran in any check; pinned runs gave both sides today's core | `coreAt(pin)`; nightly pinned run; `tests/proofs-pinned-core.test.js` |
| Proof stand-in made timing vanish | splats pinned speed-up 0.99x vs recorded 2.34x | `gpu-recorder.js` made 15 closures per pass (about 19 µs a frame) | shared methods; test |
| Proof digests differ per Node | 21 of 24 | V8 pow | 3.15.8 |
| Packed packages failed type-check | 112 README type errors | 17 builds skipped `packageDeclarations`, .d.ts pointed into `../../shared` | all builds call it; `tests/package-declarations.test.js` |
| Visual check had no baseline | after Edge 155 -> 156 | profiles are per browser major version | new profile captured from a clean tree |
| Visual check on the wrong GPU | "no visual baseline for hardware profile" | adapter order changes with Remote Desktop | adapter by LUID; message names the fix |
| Browser suites timed out intermittently (bug 26) | `waitForFunction` 30 s timeout | worktrees shared one Vite dependency cache; 504 "Outdated Optimize Dep" | per-worktree caches; dev-server 5xx printed at close |
| GPU resets during check:merge | steps failed during driver resets (nvlddmkm event 153) | hardware or driver under load | logged single rerun on a proven reset; known-bugs entry stays open |
| Records conflicted on rebase | conflicts in generated files | every landing rewrote them | merge drivers; `land-records.mjs` once in the lock |
| Paired size records named different commits | build-sizes failed | entry-sizes and network record from different commits | both regenerated together; build-sizes asserts one commit |
| Stale public numbers | webgl size three different values (found while writing this) | no public-truth check for sizes | not fixed; reported |
| Doc says 8-line windows | `quality-gate.mjs` header vs code `WINDOW = 6` (found while writing this) | comment drift | not fixed; reported |


### 5.18 A check that passes on the dev GPU is not enough

Performance and concurrency checks that landed on the dev GPU caught real bugs only when run on a slower second
machine (an AMD 680M integrated GPU in a small PC). Rule: run such a check on a slower machine before landing.

- A worker cap that looked fine on the dev GPU cost late tiles and failed on the slower machine. Measured there: p99
  0.1 to 0.2 ms against a limit of 0.3 ms, and worst frame 0.3 to 0.9 ms against a limit of 1 ms.
- A negative p99 difference passed only because the baseline got slower. Never accept a pass whose baseline moved:
  compare the baseline of this run with its recorded value first.

---

## Known gaps

These are plain facts about what does not exist or does not work yet, as of the commits named in
[Sources and commits](#sources-and-commits).

Coordination and process:

1. The helper rules file still describes the older landing order (full check before taking the landing lock); the
   current landing scripts run the full `check:merge` inside the lock after the rebase (1.4.2, 2.6).
2. `check:merge` has no option to start at a given step. A failed step is rerun by hand with its own npm command
   (2.11).
3. The main-checkout lookup in `scripts/gpu-lock.mjs` strips only a `.claude/worktrees/<name>` suffix. A fix that reads
   the worktree `.git` file is on a branch and was not on `origin/main` at `67ca53a5`; until it lands, worktrees outside
   that folder set `MARGO_GPU_LOCK` explicitly (2.2.10).
4. `openBrowser().close()` in `scripts/browser.js` does not use the bounded `closeAll` teardown. The bounded teardown
   covers the modern browser tests only (2.14.1).
5. The nightly wrapper has no failure notice and no overall timeout of its own; the per-lock limits bound it (2.12).
6. `worktree-node-modules.mjs` still links each `node_modules` entry; linking only the root folder is a recorded
   mitigation idea and is not done (2.15.7).
7. No minute-level logger of running Node and browser processes and lock holders runs; the GPU logger samples GPU state
   only (2.15.7).
8. The bug queue file has duplicate numbers for different bugs; numbers should come from one counter (1.12.2).

Kernel and rendering:

9. There is no test that the kernel produces the same bits on every machine (3.14). The ulp bound on each GPU is what is
   claimed for the precise maths, not bit equality across vendors (3.15).
10. There is no Rust test step in `npm run verify` or `check:merge`. `cargo test` runs only in the CI `kernel` job and the
    on-demand browser workflow; `verify` uses the precompiled Wasm in `packages/core/src/wasm.ts` (3.12).
11. No gate checks that the embedded `packages/core/src/wasm.ts` was built from the current
    `packages/kernel/src/lib.rs` (3.12).
12. `scripts/kernel-opt-experiment.js` cannot run as written: it gunzips a raw-deflate blob and uses the old 70-lane,
    5-flag layout (now 86 and 7) (3.11).
13. The native and Wasm kernel `sin` round `value / TAU` ties differently (`round` versus `nearest`); this is untested and
    its impact is unknown (3.8).
14. The `@margoengine/webgl` size is stated three ways: 3,021 B in the README, 2,156 B in `claims.md` LIM-022 and 3,127 B
    in `entry-sizes.json`. No public-truth check covers it (5.11).
15. `docs/limits.md` (CSP row) and `claims.md` LIM-023 say nothing needs `'unsafe-eval'`; the compatibility layer's CPU
    compute tier does, as stated one row above in `docs/limits.md` (4.6).
16. There are no visual baselines for Intel on Edge 156, Intel UHD, AMD, or any Linux machine (5.10).

Quality gates:

17. The banned-pattern merge check exists only as a generic design (5.15); the repository has no script, list file or
    test for it.
18. `scripts/quality-gate.mjs` documents 8-line duplicate windows in its header while the code and the conventions use 6
    (5.4).
19. Only the upper bound of the core + stage size gate is enforced (`bytes < 25_000`); nothing checks a lower bound
    (5.2).

---

## Sources and commits

Everything in this document was read on 2026-10-29. Repository files were read with `git show <commit>:<path>` at the
commit named, because the main checkout was 91 commits behind `origin/main` at the time (main checkout HEAD `56812419`,
`origin/main` `67ca53a5`). That gap is itself a lesson: see section 1.8.

- Systems 3 to 5 quote files from `origin/main` at commit `67ca53a53149221f0ba1940f77ac349295c568af` (short
  `67ca53a5`, 2026-10-29 00:52 -0400, "records: entry sizes, API reports and baselines at 777bca5b"), read with
  `git show 67ca53a5:<path>` and `git grep ... 67ca53a5`. For these systems nothing was run against the repository except
  reads: no build, test, benchmark, lock or GPU job was started.
- Numbers come from the files named next to them. One number was computed from a committed file and is marked
  "measured while writing this": the decoded size of the embedded kernel.

| Source | Where | Read at |
| --- | --- | --- |
| Global agent rules | the maintainer's global rules file, outside the repository | file as of 2026-10-29 |
| Repo rules | `AGENTS.md` | `56812419` (identical at `67ca53a5`) |
| Resume notes | `handoffs/RESUME.md` (git-excluded) | file as of 2026-10-29 |
| Coordinator handoff | `handoffs/coordinator-handoff-2026-10-29.md` | file as of 2026-10-29 |
| Bug queue | `handoffs/bug-queue.md` | file as of 2026-10-29 |
| Helper rules | `handoffs/session-rules.txt` | file as of 2026-10-29 |
| Lock script | `scripts/gpu-lock.mjs` | `67ca53a5` |
| Pre-merge check | `scripts/check-merge.mjs`, `scripts/support/affected-gpu.mjs`, `scripts/support/affected-packages.mjs` | `67ca53a5` |
| Records | `scripts/land-records.mjs`, `scripts/merge-driver.mjs`, `scripts/setup-merge-drivers.mjs`, `.gitattributes` | `67ca53a5` |
| Worktree setup | `scripts/worktree-node-modules.mjs` | `67ca53a5` |
| Nightly | `scripts/nightly-full.mjs`, Task Scheduler wrapper `nightly.cmd` (outside the repo) | `67ca53a5`, file as of 2026-10-29 |
| Teardown | `scripts/support/shutdown.mjs`, `scripts/browser.js` | `67ca53a5` |
| GPU protections | `scripts/support/driver-resets.mjs`, `scripts/support/device-loss.js`, `scripts/lib/gpu-adapter.mjs`, `scripts/lib/browser.mjs`, `scripts/support/run-limited.mjs` | `67ca53a5` |
| Known bugs | `docs/known-bugs.md` | `67ca53a5` |
| Live lock files | `test-results/land.lock/`, `test-results/gpu.lock/` (git-ignored) | snapshot 2026-10-29 about 00:57 local |
| Landing scripts | `<repo>-wt-nbreq/test-results/land-full.sh`, `<repo>-wt-bug61/test-results/land-bug61.sh`, older `.claude/worktrees/agent-*/.tmp/land.sh` | files as of 2026-10-29 |
| Kernel, rendering and gates | files named in sections 3 to 5, each labelled `<path> @ 67ca53a5` | `67ca53a5` |

---

## Appendix: Claims not verified

From systems 1 and 2:

1. The notification usage figure on the host: whether it is a running total or the live context size (1.6.3).
2. "About 40 min of lock per landing" as an average (1.3.2); only one live holder was observed.
3. The exact background invocation helpers used for landing scripts (2.6.3); the notes give only the lock command line.
4. Whether `rmSync(..., {recursive, force})` on a folder of junctions never follows them on every Node version
   (2.7.1); relied on, not tested.
5. Whether the LUID flag was proven with the Remote Desktop session disconnected (2.15.6).
6. The hard reset of 2026-10-28 13:43 with no bugcheck, and that "the crash zeroed uncommitted files" (2.15.8); both
   only from the coordinator handoff.
7. The bindflt junction-churn hypothesis (2.15.7); untested by design.
8. Whether a minute-level process and lock-holder logger was ever run (2.15.7).
9. All thermal thresholds and the 10 W cap on the other machines (2.15.9); the guard scripts are on those machines.
10. Who created the skip flag that skipped the 2026-10-28 nightly run despite the recorded ruling (2.12).
11. Whether any helper scripted a "resume check:merge from step N" mode (2.11); none exists in the repo.

From systems 3 to 5:

12. Whether GitHub Actions run at all for this repository.
13. The "30 pages" of `check:no-webgpu` (4.13).
14. `test-results/wasm-opt-bench.mjs` (cited by the build comment; not in the tree read).
15. The reason core omits `powerPreference` on Windows.
16. Cross-machine bit equality of the kernel.
17. Any cost number for `kernel_sync_rotation` or for growth.
18. What `api:check`, `check:parity`, `docs:links`, `check:depth` check in detail (scripts not read).
19. The content of `tests/core-errors.test.js` and `tests/core-scenes.test.js` around device restore.
20. `site/whitepaper/engine.html` (not read).
21. The Radeon 680M sweep numbers (marked "not committed" in the repo).
22. Intel Arc 140V precise-maths bounds after the fix (listed as not verified in `docs/known-bugs.md`).
