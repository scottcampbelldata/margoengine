# Playground

The playground (`site/playground/`, served at `/playground/` on margoengine.com) is a live code editor beside a running
canvas: write Margo Engine code, run it, read its console and errors, then share it by link, keep versions or download
it as one HTML file.

## Use it

- **Run**: the Run button or Ctrl+Enter (Cmd+Enter on a Mac). Each run starts a new frame, so nothing from the last
  run is left behind.
- **Editor**: a code font, line numbers, Tab and Shift+Tab indent and outdent the line or the selected lines. Esc, then
  Tab, moves focus out of the editor (so the keyboard is never trapped).
- **Console**: `console.log`, `info`, `warn`, `error` and `debug` from the code appear under the canvas. An uncaught
  error or rejected promise shows its message and its line in your code (a button that selects that line). An error
  with a MargoError `code` links to its entry on the [error help page](https://margoengine.com/errors).
- **Templates**: hello cube, a glTF loader, lights and shadows, particles, and an errors-and-console example, from the
  [stage README](../packages/stage/README.md) examples. Loading one runs it; the code it replaces is saved as a
  version first.
- **Share link**: copies a link whose `#code=` holds the code. Opening it loads and runs that code; what was in the
  editor is saved as a version first.
- **Versions**: each run and each Save version (Ctrl+S) keeps a snapshot in this browser's `localStorage`, the newest
  first. Restore puts one back, saving the current code as a version first. The editor's code is saved as you type.
- **Download HTML**: one HTML file with the import map, the scene container and the code, which runs when served from
  a local server or HTTPS.

The page loads margoengine's import map (`margoengine/dist/importmap.json`, see [the imports guide](guides/imports.md)),
so code imports any `margoengine` or `@margoengine/*` entry by name.

## Run it against this checkout

```sh
npm run build:packages
npm run playground
# open http://127.0.0.1:5180/site/playground/?packages=/node_modules/
```

`?packages=/node_modules/` points the import map at the packages this origin serves (it must be a path on the same
site ending in `/`); without it the page uses jsDelivr. `scripts/serve-playground.mjs` serves the repository read-only on
127.0.0.1 and answers with `Access-Control-Allow-Origin: *`, because the sandboxed frame has an opaque origin and loads
the modules cross-origin.

## Security

The visitor's code, and any code a share link carries, runs only inside an `<iframe sandbox="allow-scripts">` whose
document is `srcdoc`. Without `allow-same-origin` the frame gets an opaque origin: it cannot read the page, its
`localStorage` (the saved versions) or its cookies, and it cannot open pop-ups, submit forms or navigate the page.

- **Messages**: the page accepts a message only when `event.source` is the current frame's window, then only when it
  matches the schema (`parseFrameMessage` in `site/playground/share.js`: a known `kind` and `level`, text capped at
  4,000 characters, a line that is a positive integer, an error code of lowercase letters, digits and dashes). Text is
  shown with `textContent`, never as HTML.
- **Share links are untrusted input**: the `#code=` value is capped (64 KiB of text), must be base64url, must
  decompress (deflate-raw) within 256 KiB and must be UTF-8. Anything else is refused with a message that says why
  (`MargoError` code `playground-link`), and the editor keeps its code.
- **Content Security Policy**: a `srcdoc` frame inherits its page's policy, so `/playground/*` has its own in
  `site/_headers`: inline scripts and jsDelivr for the code and the packages, `https:` for the models and textures the
  code fetches, `object-src 'none'`, `form-action 'none'` and `frame-ancestors 'self'`.

## Tests

- `node --test tests/playground.test.js`: share links round-trip, the size caps, bad input (not base64url, truncated,
  a decompression bomb, not UTF-8), the version history and full or blocked storage, the frame document (escaping and
  line offsets), the message schema, and that every template imports only entries in the import map.
- `npm run test:playground:browser` (after `npm run build:packages`): in Chromium, a template runs and draws, the frame
  has an opaque origin and cannot reach its parent, a forged message is ignored, an error shows its line and its
  error-help link, a version restores, a share link opens in a fresh browser and a damaged link says so.

## Not yet

Multiple files or tabs, type hints from the packages' `.d.ts`, and an embed mode (`?embed`) are the next piece of this
row in [the rival parity list](rival-parity-gaps.md). The limits are in [docs/limits.md](limits.md#playground).

## Sources

- WHATWG, *HTML Living Standard*, "The iframe element: the `sandbox` attribute" and "`srcdoc`" (2026):
  https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox. Without `allow-same-origin`
  the content is treated as being from a unique opaque origin.
- WHATWG, *HTML Living Standard*, "Import maps" (2026): https://html.spec.whatwg.org/multipage/webappapis.html#import-maps.
- WHATWG, *Compression Standard* (`CompressionStream`, `DecompressionStream`, format `deflate-raw`) (2026):
  https://compression.spec.whatwg.org/.
- P. Deutsch, *DEFLATE Compressed Data Format Specification version 1.3*, RFC 1951 (1996):
  https://www.rfc-editor.org/rfc/rfc1951.
- S. Josefsson, *The Base16, Base32, and Base64 Data Encodings*, RFC 4648, section 5, base64url (2006):
  https://www.rfc-editor.org/rfc/rfc4648#section-5.
- W3C, *Content Security Policy Level 3*, policy inheritance for `srcdoc` and local-scheme documents (2026 draft):
  https://www.w3.org/TR/CSP3/.
- W3C, *HTML5 Web Messaging* / WHATWG HTML "Cross-document messaging": check `event.source` and the data of every
  message: https://html.spec.whatwg.org/multipage/web-messaging.html#authors.
- S. L. Tanimoto, "A perspective on the evolution of live programming", *LIVE 2013, 1st International Workshop on
  Live Programming*, IEEE (2013): https://doi.org/10.1109/LIVE.2013.6617346. Its levels of liveness: the playground
  sits at level 3 (run on demand with immediate feedback), with a full restart per run so no stale state survives.
- B. Victor, "Learnable Programming" (2012): http://worrydream.com/LearnableProgramming/. Show the result beside the
  code and make errors point back at the line that caused them.

Built clean room from these public specifications and papers; no other playground's source was read.
