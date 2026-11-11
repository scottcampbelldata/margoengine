# Windows 11: a terminated Chromium process is signalled late while the GPU is busy (draft)

Draft for Microsoft (Feedback Hub, Windows kernel / graphics) with a copy for Chromium (crbug, Internals>GPU). Not filed. Margo row: KB1703.

## Environment

- Windows 11 Pro 10.0.26300, RTX A6000 (driver 32.0.16.1742, 617.42), AMD Ryzen 9 9950X; Microsoft Edge 157.0.4341.42 (headless, WebGPU on).
- Margo's failures (2026-11-09 and 11-10): on the dev PC with 8 to 12 agent lanes and 3 GPU test slots busy, every browser check passed and then the
  process object of the ended browser was signalled only 8.7 s to over 30 s after `TerminateProcess`. Never on a quiet machine.

## Steps

`node teardown-latency.mjs --parallel=12 --cycles=3` (no dependencies; Windows; `--browser=<path>` for Chrome). Each cycle starts N headless
browsers that run back-to-back GPU compute dispatches (`load.html`), ends each main process with `TerminateProcess` and measures the time to Node's `exit`
event (the process object being signalled) and `close` event, and counts leftover processes of that browser after 5 s.

## Expected

The process object is signalled within about 100 ms of `TerminateProcess`.

## Actual

Measured in Margo's loop earlier (40 cycles beside the running lanes): the browser's exit code is set 50 to 65 ms after the kill and every owned pipe closes
within 1 ms of its destroy, but the process object is signalled 65 to 1,172 ms later, 8.7 s once beside a full verify run and over 30 s in the failures. The gap is the
kernel's teardown after the threads are gone (handle table, address space, and the GPU driver's cleanup is part of that). The caller's event loop was never blocked.

## Result on this PC (2026-11-11)

Does not reproduce the multi-second case on an otherwise quiet machine; the latency does grow with the number of busy browsers:

| browsers at once | runs | median exit | max exit | over 1 s | leftover processes |
|---|---|---|---|---|---|
| 4 | 12 | 104 ms | 124 ms | 0 | 0 |
| 12 | 36 | 253 ms | 470 ms | 0 | 0 |

The slow cases need the machine state of the dev PC under full load (many CPU lanes plus GPU slots), which this script does not recreate on its own.
A report to Microsoft would carry this script plus an ETW trace (Microsoft-Windows-Kernel-Process, GPU video memory manager) from a run that does take over 10 s; that trace has not been recorded.
Margo's workaround (a separate host process that owns the browser and waits on the kernel; `scripts/support/browser-host.mjs`) is in place, so the suite no longer waits on it.

## Files

`teardown-latency.mjs`, `load.html`.
