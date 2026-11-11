# Upstream report drafts

One folder per known-bugs row whose cause is in a browser, driver or library. Each has `report.md` (a draft in that project's bug-report format:
environment, steps, expected, actual, the result on the dev PC) and the smallest page or script that shows it, written without Margo code. Nothing here has been filed or sent;
the owner files them.

`run-page.mjs` is an optional Playwright driver for the pages: `node docs/upstream-reports/run-page.mjs docs/upstream-reports/<id>/<page>.html --browser=edge|chrome|firefox|webkit [--query=...] [--luid=high,low]`.

| Row | Folder | Goes to | Still reproduces (2026-11-11) |
|---|---|---|---|
| KB0003 | `KB0003` | Mozilla (Firefox WebGPU) | yes, Firefox 157 |
| KB0171 | `KB0171` | AMD, Dawn, ANGLE | yes, on the AMD RDNA2 iGPU of the dev PC; not on the RTX A6000 |
| KB0401 | `KB0401` | WebKit | not run here (no MediaRecorder in Playwright WebKit for Windows); Mac record only |
| KB0425 | `KB0425` | WebKit | not run here (no WebGPU in Playwright WebKit for Windows); Mac record only |
| KB1703 | `KB1703` | Microsoft, Chromium | multi-second case not reproduced on a quiet PC; latency grows with load |
| KB2224c | `KB2224c` | Playwright, WebKit | draft only, no repro |
| KB2426 | `KB2426` | NVIDIA | evidence only, no trigger |
| KB2481 | `KB2481` | Intel, NVIDIA | NVIDIA half yes; Intel half needs an Arc |
| KB3497 | `KB3497` | NVIDIA (via KB3508) | link to KB3508 not proven |
| KB3508 | `KB3508` | NVIDIA, Dawn, ANGLE | yes, RTX A6000 (WebGPU and WebGL2 on ANGLE D3D11) |
| KB5185b | `KB5185b` | ANGLE, NVIDIA | draft only, no standalone repro |
| KB5247d | `KB5247d` | ANGLE, NVIDIA | draft only, no standalone repro |
| KB6171a | `KB6171a` | ANGLE, Apple | draft only, needs a Mac |
