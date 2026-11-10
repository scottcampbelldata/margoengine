# Batch 170 stats work counts (2026-11-10)

`Stats` and `StatsPanels` refreshed their text and graphs from a 150 ms timer whether or not anything had changed.
On a page with no frames (a demand-rendered scene at rest) every refresh rewrote the same text and redrew the same
graphs. The timers now redraw only when an input of the drawing changed: a new sample, a counter written through a
public field, the GPU timing state, or the memory label. `refresh()` still redraws on every call.

Counted with a recording 2D context in jsdom (`packages/stats/test/workcount.test.js`, fails on the parent):

| Work | Parent | After | Output |
| --- | --- | --- | --- |
| `Stats`, 1,000 idle timer refreshes | 1,000 text writes | 0 | an explicit refresh repeats the last draw command for command |
| `StatsPanels`, 1,000 idle timer refreshes | 220,000 canvas commands | 0 | the redraw after a new sample equals an explicit refresh |
| `Stats`, 10 s at 60 Hz, 150 ms timer | 7,617 canvas commands | 7,617 | unchanged |
| `Stats`, then 10 s idle | 8,580 canvas commands | 0 | unchanged |

## stats.js comparison

The rival is stats.js 0.17.0, installed outside this repository in `engine-bench/batch-170` and run as a black box
through its public API (`new Stats()`, `dom`, `update()`) with the same recording context
(`engine-bench/batch-170/stats-rival.mjs`); its source was never read. Over 10 s at 60 Hz it issues 6,090 canvas
commands and none while idle, since it draws only when a frame calls it. Margo now also does nothing while idle.
While busy Margo issues 7,617 commands: it redraws a 120-sample frame-time line, a 60 Hz reference line and four
text rows each 150 ms, where stats.js scrolls its bar graph with one image copy per frame. The command counts are
not a cost comparison (an image copy moves every pixel of the panel); this is an accepted difference in drawing,
recorded in `docs/limits.md`. Timing pending the quiet rerun.

Reproduce: `npm run build --workspace @margoengine/stats`, then
`node --test --test-timeout=60000 packages/stats/test/workcount.test.js`; the rival count is
`node engine-bench/batch-170/stats-rival.mjs <path to node_modules/jsdom>`.

Research: compared the WHATWG *HTML Living Standard*, timers (`setInterval`) and the 2D canvas path API
(accessed 2026-11-10), https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html and
https://html.spec.whatwg.org/multipage/canvas.html, with the W3C *Page Visibility Level 2* recommendation (2022),
https://www.w3.org/TR/page-visibility-2/ : a timer callback
runs whether or not the page produced frames, so an unchanged redraw is pure overhead. No other implementation was
read or copied.
