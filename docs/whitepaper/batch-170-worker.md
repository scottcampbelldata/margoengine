# Batch 170 worker work counts (2026-11-10)

`transferCanvas` sends the canvas size, position and pixel ratio in the message that moves the canvas, then watches
the page canvas with a `ResizeObserver`. The Resize Observer specification fires an observation when observation
starts on a rendered element of non-zero size, so every transfer posted that same size a second time, and each
observer call or pixel ratio change with nothing new posted one more message. The page end now remembers what the
worker holds (the last size message, plus the position each forwarded event carries) and posts a size only when it
differs. The worker's size, position and pixel ratio are the same either way.

Counted in Node with both ends on one `MessageChannel` (`packages/worker/tests/worker.test.js`, test
`work count: ...`, fails on the parent):

| Work | Parent | After | Output |
| --- | --- | --- | --- |
| Start, then 100 observer calls with no change | 100 size messages | 0 | worker size and rectangle identical |
| One width change, observer called twice | 2 size messages | 1 | worker width 640 either way |
| Event moves the position, then a size call at the old position | 1 size message | 1 | worker position follows the page |

Per frame the page end does nothing: the frame loop runs in the worker. Input events still cost one message each,
only for the types the worker listens for.

## three.js comparison

three.js 0.186.1 has no worker canvas helper: its OffscreenCanvas example is page code the user writes, which moves
the canvas and sends sizes itself and forwards no input. No library work sits on that path to count against Margo's,
and Margo's extra work (position, pixel ratio, visibility, input forwarding, pointer lock) is the feature itself.
Frame time of a worker scene is timing pending the quiet rerun.

Reproduce: `npm test --workspace @margoengine/worker`.

Research: W3C *Resize Observer* (Editor's Draft, accessed 2026-11-10), https://drafts.csswg.org/resize-observer/ ,
section 3 (an observation fires when observation starts), and the WHATWG *HTML Living Standard* channel messaging and
`transferControlToOffscreen` (accessed 2026-11-10), https://html.spec.whatwg.org/multipage/web-messaging.html and
https://html.spec.whatwg.org/multipage/canvas.html . No other implementation was read or copied.
