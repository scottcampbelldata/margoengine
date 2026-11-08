# Timing tests to rerun on a quiet machine

Scott, 2026-11-07: every PC is busy with the batches. A test that fails only on time while its machine is loaded goes here and the work moves on. Rules are in `AGENTS.md` (Working rules, busy machines). Budgets are never raised and tests are never skipped or edited. Every row is rerun on a quiet machine before release; this list must be empty then. A miss of more than 2 times its budget, or one that a side-by-side run against the parent commit shows as a real slowdown, is a bug to fix now and never goes here.

| Test | Commit | Machine | Measured against budget | CPU load | Date | Rerun result |
| --- | --- | --- | --- | --- | --- | --- |
