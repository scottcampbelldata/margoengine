# GPU lock repair report (jobs 0 through 5)

Jobs 0 through 3b landed at `f13245ca3` after rebasing onto `acaf27d66`.
The coordinator authorized the prior full verify plus the focused stale-LLM
repair proof. This report makes no claim that the old full run passed: it had
13,558 passes out of 13,559, no skips, and only generated llms files failed.
After regeneration, the focused checks passed. Rebase proof also passed.

The repaired admission policy rejects exclusive correctness requests, preserves
live mutex ownership, keeps ordered detached tickets, defaults gate waits to
60 minutes and defers all speed work during the build phase. Worktrees must
rebase: clients still running old scripts retain their old admission behavior.

## Deterministic admission replay

This is a logical scheduling replay, not a benchmark, paired wall-clock run,
real GPU run or prediction of future lane durations. The fixture has 11 distinct
correctness lanes arriving together, each occupying a slot for five logical
minutes. Identical arrival order and hold durations are used on both sides.
Before uses the old incorrect exclusive requests (one holder); after uses three
shared correctness slots. FIFO is unchanged. Wait limits are evaluated against
the complete unlimited-wait trace, so the threshold count means jobs whose
place could not be reached by that deadline, not a replay with cancellations.

| Quantity | Old exclusive correctness | Three shared correctness slots |
| --- | ---: | ---: |
| Waits, logical minutes | 0,5,10,15,20,25,30,35,40,45,50 | 0,0,0,5,5,5,10,10,10,15,15 |
| Mean wait, logical minutes | 25 | 75/11 (6.81818...) |
| Maximum wait, logical minutes | 50 | 15 |
| Jobs beyond the former 10-minute wait | 8/11 | 2/11 |
| Jobs beyond the new 60-minute wait | 0/11 | 0/11 |

Reproduce with Node in any checkout; the code uses no clock, filesystem, child
process, GPU, external library or network:

```js
const jobs = Array.from({ length: 11 }, (_, lane) => ({ lane, arrival: 0, duration: 5 }));
function replay(slots) {
  const free = Array(slots).fill(0);
  return jobs.map(({ arrival, duration }) => {
    const slot = free.indexOf(Math.min(...free));
    const start = Math.max(arrival, free[slot]);
    free[slot] = start + duration;
    return start - arrival;
  });
}
for (const slots of [1, 3]) {
  const waits = replay(slots);
  console.log({ slots, waits, mean: waits.reduce((a, b) => a + b, 0) / waits.length,
    maximum: Math.max(...waits), beyond10: waits.filter((w) => w > 10).length,
    beyond60: waits.filter((w) => w > 60).length });
}
```

This replay isolates the scheduling cause. The real CPU-only filesystem tests
prove that the implementation shares slots, preserves FIFO through detached
queue observers, handles old lock formats, and refuses incorrect requests before
creating a holder or ticket. Scheduler research and source limitations are in
`docs/architecture/operational-playbook.md`, sections on GPU mutex ownership,
queueing, exclusive policy and the class check. No engine speed is measured.

## Changed files and commits

| Job | Landed commit | Main changes |
| --- | --- | --- |
| 0 | b6d0219f4 | `scripts/gpu-lock.mjs`, mutex heartbeat worker, owner/integration regression tests, known-bug removal and playbook |
| 1 | e09e1fffa | Runtime exclusive classification/cap/logging, correctness caller audit, policy tests and limits |
| 2 | 8ed296055 | `scripts/gpu-queue.mjs`, detached queue/observer CLI, queue regression tests and playbook |
| 3 | 76ae92418 | Timing/correctness separation, retained speed budgets, biomes drivers, browser/visual/benchmark entry deferral |
| 3b | f13245ca3 | Single speed-phase switch, complete manifests/inventory, release enforcement, empty exclusive allowlist, phase tests and generated LLM docs |
| 4 | b7af6646a | `scripts/check-gpu-policy.mjs`, verify serial step, planted policy regressions, merge-plan test, immutable queue status race repair and regression, playbook/limits/LLM docs |

The exact owned file lists are reproducible with
`git diff --name-status acaf27d66 f13245ca3` (jobs 0 to 3b) and
`git diff --name-status 7289abf3b b7af6646a` (job 4), excluding intervening
work by other lanes. `git show --name-status HEAD` at this report commit lists
the UTF-8 correction, encoding regression and report itself.
Private helper instructions were updated in the excluded author workspace;
they are not part of a clone. No engine/core/stage implementation changed.
Combined core + stage remains 23,924 bytes gzip, below the unchanged 25,000-byte
ceiling. Job 6 adds real GPU-use classification, one lane per slot, sampled
activity, idle termination and status metrics, as recorded below.

## Validation and correction

Job 4 ran lint and hygiene (7.7), then one full verify: 13,584/13,585
tests passed, no skips. The only failure was the Windows queue status replacement
race. Diagnostic reproduction under the read recorder captured EPERM. Immutable
status revisions fix that root cause. The pinned-name regression was seen failing
on the previous writer; recorded real queue tests and the new regression pass.
After rebase, 38 focused lock, queue, policy, phase and llms checks passed. No
second full verify was run. Log: test-results/gpu-lock-job4-verify.log; repair
and rebase logs use the gpu-lock-job4-queue-recorded-proof and rebase-lock-proof
prefixes.

A conflict-resolution encoding error in b7af6646a was then caught by reviewing
the complete diff: Windows PowerShell had decoded existing UTF-8 text as a
single-byte encoding. The correction restores every pre-existing limits byte
from 7289abf3b, retains only the intended GPU paragraphs, and regenerates llms.
The new tests/docs-encoding.test.js detects this class of corruption in the
limits guide and generated copy, including a red proof against b7af6646a.
The correction and this report land together after focused docs checks.

## Urgent queue follow-up and job 6

Urgent follow-up d2e8310ef landed on its own before job 6. Lane-C's failing
7289abf3b run predates b7af6646a's immutable publication root repair. Detached
owner stdout/stderr now persists separately from command output, including
bootstrap errors before the first ticket read. An early exit reports the actual
error and exit/signal, rather than a fictitious startup timeout. The new test
fails on the preceding code; six queue regressions pass with verify's recorder.

Job 6's files are `scripts/gpu-lock.mjs`, `scripts/gpu-queue.mjs`, five new
support files (`gpu-command.mjs`, `gpu-admission.mjs`, `gpu-activity.mjs`,
`gpu-activity.ps1`, `gpu-terminate.ps1`), three new CPU regression files
(`gpu-admission`, `gpu-activity`, `gpu-monitor-edges`), and the existing lock,
queue, policy and publication regressions. Playbook, limits, generated LLM docs,
this report and the untracked coordinator helper brief document the change.
No package, core or stage implementation or export changed.

CLI/queue GPU-leaf classification refuses CPU aggregators before artifacts.
One slot per canonical worktree or lane prefix and FIFO among eligible lanes
allow unrelated work to fill all three slots. Status reports admitted leases
separately from sampled GPU busy/idle/unknown, plus observed free-slot wait.
The complete read-only Windows counter probe returned 923 processes and 933
engine rows, with every raw counter preserved as a string. That is provider
evidence, not a GPU load or speed measurement. Three-minute idle reclamation
uses complete process-tree counter deltas and a confirming sample; native
handles pin birth identities through tree termination. Unknown data resets idle.
Sampling can miss short-lived children between snapshots; no continuous tracing
or physical GPU-saturation claim is made. Research and method are in the playbook.

One full job 6 verify ran: 13,624/13,625 tests passed, zero skips/cancellations;
the sole failure was the earlier report's private-path pointer, now reworded.
All other verify steps passed, including quality, API, size and README types.
Lint and hygiene (7.7) passed. Focused repairs cover the failed pointer and three
review regressions: failed confirmation resets/publishes unknown, withdrawal
closes wait accounting under the mutex, and an initial incomplete append is not
parsed as a published record. Their red proofs are retained in test-results.
No second full verify was run. The original native sleeper test hit its hard
limit because CIM truncates birth times to microseconds; owned fixture trees
were killed, native timestamps were canonicalized to that same representation,
and its unchanged regression passes. Heartbeat cwd and owner handle draining
also fix temporary-worktree cleanup; no tolerance or budget was raised.

Reproduce policy without GPU work: `node --test tests/gpu-admission.test.js
tests/gpu-activity.test.js tests/gpu-monitor-edges.test.js`. Native Windows
termination uses owned CPU sleeper stand-ins. Logs use the gpu-lock-job6 prefix;
the one full run is gpu-lock-job6-verify.log. Core + stage stays 23,924 B gzip.
