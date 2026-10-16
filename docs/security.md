# Security model

What Margo trusts, what it does not, what it guarantees and what your app still has to do. Findings and their tests are
in HANDOFF.md, launch gate 11 (b); parser fuzzing is gate 11 (a).

Report vulnerabilities privately through GitHub private vulnerability reporting or to security@margoengine.com; see
[SECURITY.md](../SECURITY.md). Dependencies and licences: [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).
Release integrity: [releasing.md](releasing.md).

## Trusted and untrusted

**Trusted: your app's code and the options it passes.** URLs you hand to `loadGLTF`, `app.load`, `loadFBX`,
`EnvironmentLighting.load`, `loadAudio` and the like; `decoderPath` / `transcoderPath` (the scripts the decoder worker
runs); the `fetch` you inject; DOM elements you give to `@margoengine/labels` / `@margoengine/html`; names, labels and
option objects you set. Margo does not sanitise these. If your app passes a URL or a string that came from a user, it
is your app's input to check.

**Untrusted: everything inside an asset file and everything from the network.** glTF/GLB JSON (names, `extras`,
extensions, URIs), .margo, OBJ/STL/PLY/3MF/PCD/XYZ/OFF/VTK, FBX, USD/USDA/USDC/USDZ, IFC, STEP/IGES, KTX2/Basis,
Draco, meshopt, EXR/HDR/UltraHDR, audio/video metadata, `@margoengine/net` snapshots and replies from Margo's own
workers.

## What Margo guarantees for untrusted input

- **No script injection.** No package source uses `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
  `DOMParser`, `srcdoc` or inline event-handler attributes (`tests/security.test.js` fails if one appears). The
  inspector tree, the frame debugger panel, the stats HUD and the view cube write node names, GPU labels and numbers
  with `textContent`. No Margo API takes an HTML string; the label/html overlays take an element your app built, so
  its content is yours.
- **No prototype pollution.** JSON from glTF/GLB and .margo is parsed with `__proto__`, `constructor` and `prototype`
  keys removed at every depth, so `extras` and extensions you get back are safe to `Object.assign` or merge. Objects
  keyed by names from a file (3MF `metadata`, VTK `attributes`, USD fields, Draco attributes, XML attributes) have a
  null prototype. Lookup tables indexed by file values (accessor types, PLY/VTK data types, 3MF units, MIME types,
  XML entities) use own keys only.
- **URIs inside a model stay inside its directory.** glTF buffer and image URIs and FBX texture file names resolve
  against the model's URL (after redirects) and must stay in its directory on the same origin. Absolute,
  protocol-relative and cross-origin URIs, `../` (also `%2e%2e/`, `..%2F`, `..\`) past the base, and every non-HTTP(S)
  scheme (`javascript:`, `file:`, `blob:`) throw a `TypeError` before anything is fetched. Opt in per load with
  `allowedURLs: ['https://cdn.example.com/models/']` (URL prefixes; end them with `/`). `data:` URIs are decoded within
  the load's byte budget (`maxDownloadBytes` in gltf-pro, 64 MiB in gltf). USDZ and 3MF only read entries of their own
  archive (paths that escape it are rejected); .margo images are embedded; OBJ `mtllib` is ignored.
- **Fetches carry no cookies cross-origin.** Margo calls `fetch(url, { signal })`: the browser default
  `credentials: 'same-origin'`. Pass your own `fetch` to change it.
- **Worker messages are checked at the boundary.** Margo's workers are dedicated (only the page that created them can
  post to them). They ignore messages that are not job objects; the main thread rejects a load with an `Error` on a
  malformed reply instead of hanging. No package listens to `window` `message` events or posts with `'*'`.
- **Budgets hold for hostile files.** Model downloads and the files they reference stop at their byte budget while
  streaming (also in progressive glTF); environment maps, audio and decoder `.wasm` are read whole from the URL you
  chose.
  Text parsers have no regex with super-linear backtracking on file input (the STL facet scan and the 3MF attribute
  regex were quadratic). Parser fuzzing is gate 11 (a).
- **No `eval`.** No package source uses `eval`, `new Function` or string timers, and every dynamic `import()` names a
  fixed module. The shipped Basis and OCCT glue is rewritten so the decoder and CAD workers run without
  `'unsafe-eval'` (`tests/no-eval-workers.test.js`; see [deploying.md](deploying.md)).

## What your app must do

- Serve a strict CSP. The one in [deploying.md](deploying.md) is tested with every package:
  `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`, `worker-src 'self'`, `object-src 'none'`. It also
  limits which origins a model can reach even if you widen `allowedURLs`.
- Treat URLs and names from users as input: if a user can choose the model URL, check it before calling a loader (the
  loader trusts the URL you give it, and resolves the model's own URIs against it).
- If you render file strings yourself (node names, `extras`, 3MF metadata), use `textContent`, not `innerHTML`.
- Keep `allowedURLs` to the prefixes you serve models from. A cross-origin prefix also needs CORS on that server.
- `@margoengine/cache` stores responses in IndexedDB keyed by URL, without `Vary` or credentials in the key: do not
  route authenticated, per-user responses through it.
