# Host-owned notebook and offline backends

Sciviz's notebook and share entries previously imported the compatibility device
and declared its package as a dependency. That violated the existing isolation
contract and made backend installation a library responsibility. The owning
application now supplies prepareBackend to render or startStandalone.
It receives force (true for webgl2, false for auto) and the load's AbortSignal.
The webgpu choice never invokes it. Without a callback, these library functions
use the backend already installed by the application. Setup failures propagate;
cancelled notebook views retain their existing disposal semantics.

The Python AFM and the locally bundled standalone application provide this
callback themselves. They lazily import the compatibility root and call its
abortable install, preserving automatic fallback and forced webgl2 in the
shipped applications. The public sciviz source graph and dependency manifest no
longer reach the compatibility package. No root, core, stage, backend or shader
code moves or changes; importing an unused feature installs nothing.

Clean-room comparison: TC39, ECMAScript Language Specification, 2026,
https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-import-calls
defines deferred module loading; WHATWG contributors, HTML Living Standard,
2026, https://html.spec.whatwg.org/multipage/webappapis.html#resolve-a-module-specifier
places resolution with the host; Trevor Manz and anywidget contributors,
Anywidget Front-End Module, 2026, https://anywidget.dev/en/afm/ assigns view
creation and disposal to the host adapter. Combining those contracts keeps
dependency selection in the application and cancellation in the individual view.
No external source implementation was read or copied.

After npm run build:packages, run the sciviz CPU suite with experimental module
mocks and a 120000 ms per-test limit, and compatibility's isolation.test.js.
The unchanged isolation tests reproduce the original imports and dependency
failures. backend-isolation.test.js additionally checks setup ordering, all
three backend selections, omitted callbacks, thrown setup errors, cancellation
during setup and pre-abort. Build Python's AFM with python/build-notebook.mjs,
prepare python/tests/notebook-fixtures.py in the documented notebook environment,
then run sciviz's share and notebook browser scripts under the GPU lock. They
exercise native and compatibility rendering, file/data documents and offline
operation. This is not certification of every notebook host or physical GPU.
