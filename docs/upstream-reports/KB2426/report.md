# NVIDIA RTX A6000 (Windows 11): driver reset, nvlddmkm event 153 "Error occurred on GPUID: 100", under concurrent WebGPU load (draft)

Draft for NVIDIA (driver feedback / developer forums). Not filed. Margo row: KB2426. There is no standalone repro that triggers it on demand.

## Environment

- NVIDIA RTX A6000, driver 32.0.16.1742 (617.42, 2026-09-29), Windows 11 Pro 10.0.26300, AMD Ryzen 9 9950X, a second GPU (AMD Radeon iGPU) in the same PC.
- Microsoft Edge 156 and 157, headless, WebGPU (Dawn D3D12) and WebGL2 (ANGLE D3D11).
- Hardware-accelerated GPU scheduling: the registry value `HwSchMode` is not set on this PC (setting not queried from the registry; it was reported "on" in Margo's notes of 2026-10-28).

## What happens

During busy test runs (two to three browsers sharing the GPU with compute and draw submissions of 0.4 to 1.4 s, plus CPU load) the System log gets
`nvlddmkm` event 153, "Error occurred on GPUID: 100". Margo recorded nine on 2026-10-27 and 28, and the log on this PC (2026-11-11) still holds ten
(3 on 11-11 at 00:09:58, 00:12:09 and 00:24:41; 7 on 11-09 between 15:13 and 16:21). Effects: one page's WebGPU device is lost, and a page asking for a device
at that moment is refused (`requestDevice` fails with "D3D12 create command queue failed with E_OUTOFMEMORY (0x8007000E)" with 2 of 48 GB in use).
No Windows watchdog report accompanies event 153 (a deliberate 3 s compute dispatch gives the Windows kind, LiveKernelEvent 141, and no 153), so it is the driver's
own reset, not the 2 s TDR.

## Steps

There is no known trigger. What was ruled out (Margo, 2026-10-28): killing the browser's GPU process mid-dispatch (15 times) or the whole tree (15 times);
CDP crashGpuProcess beside a second busy browser (12); 300 device create/destroy cycles; six browsers with back-to-back dispatches for 90 s; single
submissions of 0.4 to 1.4 s beside two or three other browsers; two whole check:gpu-packages runs. Eight of the first nine came while a Remote Desktop
session was connected (the A6000 then also draws that session's desktop); with it disconnected there were 0 resets in about 90 minutes of heavier load.
`collect-evidence.ps1` prints the event times, adapters and the 141 reports for a report.

## Expected

No driver reset while the GPU is shared by several processes.

## Result on this PC (2026-11-11)

Evidence only: `collect-evidence.ps1` lists the ten event 153 entries above. The events of 11-11 (00:09 to 00:24) predate this session; this session's repro runs
(about an hour of WebGPU and WebGL2 pages, up to 12 browsers on the GPU for the teardown loop) produced no new event, so the trigger is not reproduced on demand.
Not tested: Remote Desktop disconnected for a full day; driver update; hardware GPU scheduling off (both are the suggested next steps from Margo's notes).

## Files

`collect-evidence.ps1`.
