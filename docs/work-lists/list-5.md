# Work list 5

For the Beelink, now that list 3 is done (Scott, 2026-11-10: "what can beelink do its idle, bug hunt? ... make sure
all the apps work together"). Start now. Read `README.md` and `machines.md` first (Beelink section: 1 GPU job at a
time, leave the nightly folders alone); the prompts are in `list-5-prompts.md`.

Before starting: the Beelink shut down without warning 4 times since 2026-10-29, 3 of them during Modern Standby
(Kernel-Power 41, no bug check, no dump). Scott sets sleep to Never on AC first. If it still shuts down while a
stream runs, stop, write the stream's handoff, and tell Scott with the event times.

| Stream | Work | Batch | Package | Jobs | Status |
| --- | --- | --- | --- | --- | --- |
| N | AMD GPU bug hunt | R6 | every package with GPU tests, both backends | 4 | in progress (Beelink, stream N) |
| O | packages work together, part 1 | I1 | integration jobs J1 and J5 | 2 | in progress (Beelink stream O) |

Run both streams at once; only one GPU job at a time on this machine (stream N holds the GPU most; stream O's J5 is
CPU only, its J1 GPU runs queue on the lock). Why the Beelink: it is the only AMD GPU, so driver and vendor bugs that
the dev PC's NVIDIA card never shows surface here. Sciviz is still being built on the dev PC (batches 175, 176, 178):
leave sciviz out of stream O until those are `done` on the progress page, and before fixing a sciviz failure in
stream N check origin/main for a fix first. Physics stays on hold (control.json). When a batch is finished and pushed,
change its status to `done` in the same push as its last job. Only the account running this list edits this file.
