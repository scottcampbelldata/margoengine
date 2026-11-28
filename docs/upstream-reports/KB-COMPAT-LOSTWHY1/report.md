# WebKit (Windows build): a WebGL call that waits 15 s for the GPU process loses the context

Draft for bugs.webkit.org, product WebKit, component WebGL. Not filed. Margo row: KB-COMPAT-LOSTWHY1.

## Environment

- Playwright WebKit build 2370 (Version/27.2) on Windows 11, NVIDIA RTX A6000. Edge 158 on the same PC (also ANGLE
  over Direct3D 11) is the control. Not run on WebKitGTK, WPE or Safari with this page.

## Steps

1. Serve this folder over `http://localhost` and open `sync-timeout.html` (or
   `node docs/upstream-reports/run-page.mjs docs/upstream-reports/KB-COMPAT-LOSTWHY1/sync-timeout.html --browser=webkit --timeout=200000`).
2. The page links a program whose fragment shader has 3,000 dependent statements and reads its `LINK_STATUS`, a call
   that waits for the compile. It first links a smaller program with four color outputs through
   `KHR_parallel_shader_compile`, waits for it without blocking, and times a framebuffer status query after its first
   and second draw.

## Expected

`LINK_STATUS` returns once the compile is done, however long that takes, and the context stays alive.

## Actual (2026-11-27)

| Browser | Long call | Context | First draw of the 4-output program |
| --- | --- | --- | --- |
| WebKit 27.2, Windows | returns after 15,001 ms, `false` | lost (`webglcontextlost` at 15,010 ms) | 1,209 ms (linked in 1,151 ms) |
| Edge 158 | returns after 30,151 ms, `true` | alive | 1,408 ms (linked in 1,189 ms) |

With 2,500, 3,000 and 3,500 statements WebKit returned after 15,000 to 15,001 ms every time and lost the context;
with 2,000 (9,629 ms) it did not. The limit is the call's wait, not the shader: any call that waits on the GPU process
that long loses the context. After a loss, the next context made on the page was lost within 2 ms.

The second column shows why real pages reach it: over Direct3D 11 a program with more than one color output compiles
again at its first draw (1 output: 1 ms; 2, 4 and 7 outputs: about the link time again), even after
`KHR_parallel_shader_compile` reported it complete and with the framebuffer bound before the link. That compile runs
inside the next call that waits on the GPU process, and polling a fence (`getSyncParameter`) waits just the same
(first poll 1,068 ms), so a page cannot wait it out without blocking.
