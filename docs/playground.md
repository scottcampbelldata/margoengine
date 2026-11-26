# Playground

The playground (`site/playground/`, served at `/playground/` on margoengine.com) is a live code editor beside a running
canvas: write Margo Engine code, run it, read its console and errors, then share it by link, keep versions or download
it as one HTML file.

## Use it

- **Run**: the Run button or Ctrl+Enter (Cmd+Enter on a Mac). Each run starts a new frame, so nothing from the last
  run is left behind.
- **Files**: a project is up to 12 files, one tab each. `main.js` runs first; the others are modules it (or each
  other) imports as `./name.js`, cycles included. **Add file** makes a tab (letters, digits, `-` and `_`, then `.js`);
  a tab's × removes it, keeping the project before it as a version. Left and right arrows move between tabs.
- **Editor**: a code font, line numbers, Tab and Shift+Tab indent and outdent the line or the selected lines. Esc, then
  Tab, moves focus out of the editor (so the keyboard is never trapped).
- **API panel**: after a run, "API of the imported entries" lists, for each `margoengine` or `@margoengine/*` entry
  the code imports, its top-level exports with their kind, declaration line and the first sentence of their doc
  comment. The filter narrows the names; clicking a name inserts it at the caret. **Ctrl+Space** completes the word
  before the caret when one name fits, and otherwise opens the panel filtered to that word.
- **Console**: `console.log`, `info`, `warn`, `error` and `debug` from the code appear under the canvas. An uncaught
  error or rejected promise shows its message, its file and its line (a button that opens that tab and selects the
  line). An error
  with a MargoError `code` links to its entry on the [error help page](https://margoengine.com/errors).
- **Templates**: hello cube, a glTF loader, lights and shadows, particles, and an errors-and-console example, from the
  [stage README](../packages/stage/README.md) examples. Loading one runs it; the code it replaces is saved as a
  version first.
- **Share link**: copies a link whose `#code=` holds every file (see [Link format](#link-format)). Opening it loads and runs that code in the sandboxed
  frame and says "Shared code loaded", with **Back to my code**. The visitor's own saved code is not touched until they
  edit, run or save the shared code; then their own code is kept as a version.
- **Versions**: each run and each Save version (Ctrl+S) keeps a snapshot of every file in this browser's `localStorage`, the newest
  first. Restore puts one back, saving the current code as a version first. The editor's code is saved as you type.
- **Download HTML**: one HTML file, the run frame with the code built in, which loads the import map and runs when
  served from a local server or HTTPS.

The page loads margoengine's import map (`margoengine/dist/importmap.json`, see [the imports guide](guides/imports.md)),
so code imports any `margoengine` or `@margoengine/*` entry by name.

## Link format

`#code=` is base64url without padding (RFC 4648 §5) of a version byte and a payload:

| Version | First byte | Payload |
| --- | --- | --- |
| 2 (now) | `0x07` | deflate-raw of the UTF-8 JSON `[[name, code], ...]`, `main.js` first |
| 1 (first playground) | none | deflate-raw of `main.js`'s code alone |

`0x07` is a final deflate block of the reserved type `11`, which no deflate stream may start with (RFC 1951 §3.2.3),
so a version 1 link is told apart without a byte of its own and still opens. Any other first byte of the reserved type
is a later version: the page says the link is from a newer playground instead of guessing. The decoded files are
checked like a project from the editor (names, `main.js` first, at most 12), and the caps below apply to the whole
payload.

## How files import each other

Each file runs as a blob module, and a blob URL cannot be the base of a relative URL, so the frame points every
`./name.js` in an `import`, `export ... from` or `import()` of the project at an import map entry `#tab/name.js` (the
blob URL of that file), added beside margoengine's entries before main.js loads. Through the map, files may import each
other in any order, cycles included; lines are not moved, so an error's line is the line in its own file. A
`./name.js` that names no file of the project is left as written and fails to load with the browser's own error.

## Embed

Put a project on another page with the embeddable playground, `/playground/embed/`, and a share link's `#code=`:

```html
<!-- The canvas alone; add ?code to show the code beside it. Paste the #code=... of your share link after the
     path: the src is the margoengine.com page /playground/embed/ followed by that hash. -->
<iframe src="https://margoengine.com/playground/embed/?code" width="800" height="500"
  title="Margo Engine example" loading="lazy"></iframe>
```

The embed shows Run, the canvas and **Open in Playground** (a new tab of the full playground with the same files in
its link, kept up to date as the code changes). With `?code` it shows the code, its tabs and the console too, and runs
edits; without it, the canvas alone. It has no templates, versions, sharing or download, and it saves nothing in the
browser: it shares the site's storage with the full playground, so a page that frames it can never change what a
visitor saved there. `?packages=` works as on the full page.

Only `/playground/embed/*` and its own run frame `/playground/embed/frame/*` send `frame-ancestors *`; the full
playground `/playground/*` and its run frame keep `frame-ancestors 'self'`, so no other site can frame the page that
holds a visitor's saved work. Otherwise the embed has the same strict page policy and the same sandboxed run frame as
the full page (`embed/index.html` is the full page's `<main>`, and `embed/frame/index.html` the same file as
`frame/index.html`; `tests/playground.test.js` keeps both equal).

## How the API panel reads the types

No TypeScript service and no new dependency: the run frame fetches the `.d.ts` beside each imported entry's `.js`
(through the same import map) and reads only its top-level `export` declarations (`function`, `class`, `interface`,
`type`, `const`, `let`, `enum`, `namespace`) with their doc comments, following `export * from` and
`export {a as b} from` into the files they name, bare specifiers through the import map. It is a list of names, not a
type checker: no members, no overloads beyond the first line, no inferred types, no errors. At most 120 declaration
files are read per run, 20 entries and 400 names each; the page checks the list's shape like every other message and
shows it as text. It loads beside the run and never delays it.

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

The visitor's code, and any code a share link carries, runs only inside `site/playground/frame/`, loaded as
`<iframe sandbox="allow-scripts" src="frame/">`. Without `allow-same-origin` the frame gets an opaque origin: it cannot
read the page, its `localStorage` (the saved versions) or its cookies, and it cannot open pop-ups, submit forms or
navigate the page. The frame is a separate document rather than `srcdoc`, because a `srcdoc` document inherits its
parent's Content Security Policy, which would force the page's policy open.

- **Messages, both ways**: the frame posts `ready`; the page answers with one run message (`runMessage`: the files
  and the packages base). The frame does nothing at all unless it is framed (`parent !== window`) by a page of the
  playground's origin (`location.ancestorOrigins[0]` equals the frame URL's origin, where the browser has
  `ancestorOrigins`), and it accepts a run message only when `event.source` is its parent and `event.origin` is the
  playground's origin, only in the run message's shape (at most 12 valid file names, `main.js` first, 256 KiB of code,
  the base null or an http(s) URL ending in `/`), and only once. Everything else is dropped silently. The frame's own
  origin is opaque (`'null'`), so the origin it expects is its URL's (`location.origin`). The page accepts a message
  only when `event.source` is the current frame's window, then only when it matches `parseFrameMessage`
  (`site/playground/share.js`: a known `kind` and `level`, text capped at 4,000 characters, a valid file name and a
  positive integer line, an error code of lowercase letters, digits and dashes). Text is shown with `textContent`,
  never as HTML.
- **Share links are untrusted input**: the `#code=` value is capped (64 KiB of text), must be base64url, must
  decompress (deflate-raw) within 256 KiB and must be UTF-8. Anything else is refused with a message that says why
  (`MargoError` code `playground-link`); the editor keeps the visitor's code and nothing runs until they press Run, so
  other output never hides why the link failed. Shared code runs at once, inside the sandbox
  (the sandbox is the boundary), but never replaces the visitor's saved code by itself.
- **Content Security Policy** (`site/_headers`): the page, `/playground/*`, allows its own scripts only
  (`script-src 'self'`, nothing inline), `connect-src 'self'` and `frame-src 'self'`; it talks to no other host. Only
  `/playground/frame/*` gets the loose policy the code needs: inline script (the import map), `blob:` modules,
  jsDelivr, and `https:` for the models and textures the code fetches. That policy starts with `sandbox
  allow-scripts`, so the frame is an opaque origin even when it is opened directly or framed without the attribute.
  The frame repeats its policy in a `<meta http-equiv="Content-Security-Policy">`, a backup for a host that ignores
  `_headers`; a meta policy cannot carry `sandbox` or `frame-ancestors` (CSP Level 3, section 3.3), so those two live
  in `_headers` only, and on such a host the frame's own parent and origin checks above are what stop a stranger page.
  Download HTML leaves the meta policy out: the saved file is the visitor's own page. `npm run playground` serves
  `site/` with these headers, so the browser test runs under the real policies.

## Tests

- `node --test tests/playground.test.js`: share links round-trip, the size caps, bad input (not base64url, truncated,
  a decompression bomb, not UTF-8), the version history and full or blocked storage, the run message and the download, the
  policies (no `unsafe-inline` and no `https:` on the page, the loose one on the frame only), the message schema, and
  that every template imports only entries in the import map.
- `npm run test:playground:browser` (after `npm run build:packages`): in Chromium, another origin frames the embed
  (canvas only and with the code), which runs the shared files, links to the full playground with the same files and
  saves nothing, while the full page refuses to be framed there; the run frame opened on its own is
  sandboxed and runs nothing; framed by a test page without the site's headers, it answers a parent of its own origin,
  stays silent in a parent of another origin and ignores a run message from a sibling frame; a template runs and draws, the frame
  has an opaque origin and cannot reach its parent, a forged message is ignored, an error shows its line and its
  error-help link, a version restores, the page's response policy is strict, a share link opens and runs while the
  saved code stays, Back to my code returns it, Run makes the shared code the saved one, and a damaged link says so.

## Status

Left on the row in [the rival parity list](rival-parity-gaps.md): real type checking and member completion in the
editor (errors as you type, members of a class, inferred types), which needs the TypeScript language service or an
editor that bundles it, a new dependency waiting on a decision. The API panel above is the part that needs none. The
limits are in [docs/limits.md](limits.md#playground).

## Sources

- WHATWG, *HTML Living Standard*, "The iframe element: the `sandbox` attribute" (2026):
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
