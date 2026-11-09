# README live-link fixture

The README runner executes Blender's live-link example unchanged. Its top-level
async loop intentionally waits for pagehide, so module completion alone cannot
drive this example. The runner redirects the documented local add-on address to
its own HTTP service, which announces one version through native EventSource
and serves the exact triangle.margo fixture exported by Blender. The SSE
connection stays open until the example closes it. No shared port is bound.

Before importing the example, observers delegate to the real PBRModel setup and
dispose methods, Camera fitting and native EventSource.close. After a real model
is attached and the loop frames it, the runner dispatches pagehide externally.
It still requires module completion, one model disposal, no remaining model
nodes, a closed event source, no unhandled errors and no GPU validation errors.
The existing 20 second whole-page deadline is unchanged. A finite fixture does
not make a continuing loop a known failure or detach it from module evaluation.

Research compared lifecycle and iteration standards, rather than another
project's implementation:

- WHATWG contributors, *HTML Living Standard*, 2026,
  [Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html):
  event framing, redirects, reconnection and explicit close. An open HTTP reply
  preserves the stream lifecycle; ending an SSE response would invite reconnects.
- WHATWG contributors, *HTML Living Standard*, 2026,
  [PageTransitionEvent](https://html.spec.whatwg.org/multipage/nav-history-apis.html#the-pagetransitionevent-interface):
  the pagehide event used by the documented cancellation listener. The harness
  dispatches that event without navigating away from the realm being inspected.
- Ecma International / TC39, *ECMAScript 2026 Language Specification*, 2026,
  [Async generator objects](https://tc39.es/ecma262/2026/multipage/control-abstraction-objects.html#sec-asyncgenerator-objects):
  completion and finally cleanup must be awaited, not inferred from a live handle.

Clean-room regression: tests/readme-live.test.js checks actual HTTP event/model
bytes and connection release, runner load-before-pagehide order, module
completion, and refusal of missing models, disposal, stream closure or node
cleanup. The runner regression fails against the old module-completion-only
harness. tests/run-readme-examples.test.js retains the unfinished-module and
whole-page deadline checks. The normal check:merge README step already covers
this fixture class; verify runs the CPU regressions without a GPU lease.

Validation: all 34 runner and fixture tests pass, including four live fixture/observer tests.
The old harness fails the load-before-pagehide runner regression with "module
waits for pagehide". The real live README example passes with one attached and
framed model, one completed outer disposal (plugin removal re-enters its
idempotent dispose), zero remaining nodes and one closed EventSource. The broad
eleven-package consumer run has 155 passes, 14 existing known failures and this
one fresh failure; rerunning only that repaired example adds its pass, leaving
zero fresh failures across the 170 examples. Existing known failures remain
visible in the report; no known-list entry was added or changed.

Reproduce after building packages:

```sh
node --test --test-timeout=30000 tests/readme-live.test.js tests/run-readme-examples.test.js
npm run check:readme-run -- --packages=blender
```

No package API, bundle size, rendering implementation or performance claim changes.
