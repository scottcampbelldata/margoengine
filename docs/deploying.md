# Deploying a Margo app

A Margo app is static files: HTML, JavaScript, CSS, a few `.wasm` files and your assets. Any static host works. Three
things decide whether it keeps working once real headers are in front of it: the Content Security Policy (CSP), caching,
and the MIME type of `.wasm`. This page gives configs that were tested against the packages, not guessed.

`npm create margo` already ships the Cloudflare Pages / Netlify version as `public/_headers` (Vite copies it into
`dist/`).

## The short version

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
```

- `'wasm-unsafe-eval'` is the one directive Margo itself needs. Without it the engine does not start.
- Draco or KTX2 decoding (`@margoengine/decoders`) and STEP/IGES import (`@margoengine/machinery/cad-async`) also need
  `'unsafe-eval'`, but only for their worker files: see [Workers that need `'unsafe-eval'`](#workers-that-need-unsafe-eval).
- You do **not** need cross-origin isolation (COOP/COEP).
- Fingerprinted files in `assets/` can be cached for a year; HTML must revalidate.

`node scripts/csp-check.mjs` serves the create-margo app, a page with every feature below and the margoengine.com build
with these headers and fails on any CSP violation in a real browser.

## What Margo needs, and why

### No cross-origin isolation

WebGPU, module workers and Wasm work without `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`. No package
requires `SharedArrayBuffer` or checks `crossOriginIsolated`: the core and machinery Wasm kernels use ordinary
(non-shared) memory, and `@margoengine/bvh` only checks whether *your* buffer is a `SharedArrayBuffer` so it does not try
to transfer it. Skipping COEP also means cross-origin images, fonts and CDNs keep working without
`Cross-Origin-Resource-Policy` headers.

Turn isolation on only if you want it for your own reasons. The one Margo-related one is profiling: Chromium gives
isolated pages finer `performance.now()` and GPU timestamp resolution, which is why the repository's benchmark pages run
isolated.

### `script-src 'wasm-unsafe-eval'`

The core kernel (vertex transforms, culling) is Wasm embedded in the JavaScript as base64. It is inflated with
`DecompressionStream` and compiled with `WebAssembly.compile` / `WebAssembly.instantiate`. A CSP without
`'wasm-unsafe-eval'` (or the much broader `'unsafe-eval'`) blocks every Wasm compile, so `Engine.create` rejects
("Compiling or instantiating WebAssembly module violates the following Content Security policy directive"). The same directive covers the machinery kernel (also embedded), the OCCT STEP/IGES importer and the
Draco and Basis decoders. `'wasm-unsafe-eval'` allows compiling Wasm only; it does not allow `eval` or `new Function`.

No package calls `eval` or `new Function` on the page, injects inline `<script>`, or loads code from a CDN.

### `worker-src 'self'`

Workers are separate files next to your bundle, created with the bundler-friendly
`new Worker(new URL('./x.js', import.meta.url))` pattern. None uses `blob:` or `data:` URLs.

| Worker | Package | Type |
| --- | --- | --- |
| `bvh.worker-*.js` | `@margoengine/bvh` (`buildAsync`) | module |
| `decoder.worker-*.js` | `@margoengine/decoders` (Draco, KTX2) | module |
| `gltf-*.js` | `@margoengine/gltf-pro/worker` (`loadGLTFInWorker`, `parseGLTFInWorker`) | classic |
| `fbx-*.js`, `usdz-*.js`, `usd-*.js` | `@margoengine/fbx`, `usdz`, `loaders` worker parsers | classic |
| `cad-runtime-*.js` | `@margoengine/machinery/cad-async` (`parseCADAsync`) | classic, `importScripts` for OCCT |

`worker-src` falls back to `script-src`, then `default-src`, so `'self'` in either is enough; listing it keeps the
intent obvious.

A worker gets its **own** CSP from the headers on the worker script's response, not from the page. A host config that
sets the CSP on every path (`/*`, as below) therefore also restricts what each worker may fetch and compile; that is
what you want, and it is why two workers need their own rule.

### Workers that need `'unsafe-eval'`

Two workers run third-party Emscripten code that needs JavaScript `eval`:

- `decoder.worker-*.js` (`@margoengine/decoders`: Draco, KTX2) runs Google's Draco wrapper and Binomial's Basis
  transcoder, both classic scripts, through an indirect `eval` (a module worker cannot `importScripts`).
- `cad-runtime-*.js` (`@margoengine/machinery/cad-async`, STEP and IGES only; STL and OBJ do not load OCCT) loads
  `occt-import-js`, whose embind bindings build their call wrappers with `new Function`.

Under the policy above both are refused inside the worker and decoding or import fails ("Evaluating a string as
JavaScript violates the following Content Security Policy directive"). Give those two files a policy with
`'unsafe-eval'`; the page and every other file keep the strict one:

```
/assets/decoder.worker-*.js
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'

/assets/cad-runtime-*.js
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'
```

(Cloudflare Pages syntax; the Vercel and Nginx versions are below.) `'unsafe-eval'` here reaches only code running in
that worker: the page cannot `eval`. The decoder worker fetches the wrapper scripts and `.wasm` files with `fetch`, so if
you point `decoderPath` at another origin (for example Google's Draco CDN), add that origin to this rule's
`connect-src`.

### `style-src 'self' 'unsafe-inline'`

Strict `style-src 'self'` breaks three things, so the default keeps `'unsafe-inline'` for styles (not for scripts):

- Vite keeps `<style>` blocks from `index.html` inline in the built page (the create-margo template and every
  margoengine.com demo have one).
- `@margoengine/viewcube` and `@margoengine/inspector` insert a `<style>` element for their widgets.
- Inline `style="..."` attributes in your own HTML.

Overlays that only set `element.style` from script (stats, labels, html, input's on-screen stick, machinery overlays,
the `margoengine` stage) are not affected: CSP does not restrict the CSSOM. If you use none of the above, move your
styles into a CSS file and drop `'unsafe-inline'`.

### `img-src`, `connect-src`, `media-src`

- Models, textures, HDRs, KTX2 files and audio are downloaded with `fetch` (in the page or in a parser worker), so their
  origins go in **`connect-src`**, not `img-src`. Images are decoded from the downloaded bytes with
  `createImageBitmap(blob)`; no `blob:` URL is created.
- `img-src data: blob:` covers `<link rel="icon" href="data:,">` (the template uses it) and any `<img>` you add.
- Vite inlines imported assets under 4 KB as `data:` URLs. `fetch` on a `data:` URL is a `connect-src` request, so
  either add `data:` to `connect-src` or set `build.assetsInlineLimit: 0`.
- `@margoengine/machinery/telemetry` takes a `WebSocket` you open: add its `wss://` origin to `connect-src`.
- `@margoengine/video` plays `<video>` elements you create: a cross-origin video needs its origin in `media-src`.

### `.wasm` MIME type

The core and machinery kernels are embedded, so a plain core app downloads no `.wasm` at all. Separate `.wasm` files:

| File | Package | Size (raw / brotli) | Loaded by |
| --- | --- | --- | --- |
| `occt-import-js-*.wasm` | machinery (`parseCADAsync`, STEP and IGES only) | 7.6 MB / 2.3 MB | `WebAssembly.instantiateStreaming` |
| `draco_decoder-*.wasm` | decoders (Draco) | 192 KB / 49 KB | `fetch` + `WebAssembly.instantiate` |
| `basis_transcoder-*.wasm` | decoders (KTX2) | 527 KB / 204 KB | `fetch` + `WebAssembly.instantiate` |

Serve `.wasm` as `application/wasm`. The OCCT loader compiles while downloading only with that type; with another type
it logs `wasm streaming compile failed` and falls back to downloading the whole file first. Cloudflare Pages, Netlify
and Vercel use the right type already; check older Nginx `mime.types` files.

### Assets on another origin (CORS)

Margo downloads assets with `fetch`, so a file on another origin (a CDN, an S3 bucket) must answer with
`Access-Control-Allow-Origin` for your app's origin (or `*` for public assets). Without it the browser hides the
response and the load fails; there is no "tainted" fallback. This also keeps every image origin-clean, which WebGPU
requires before `copyExternalImageToTexture` will upload it. Add the asset origin to `connect-src` as well:

```
Access-Control-Allow-Origin: https://app.example.com
```

If you set COEP anyway, cross-origin assets also need `Cross-Origin-Resource-Policy: cross-origin`.

## Caching

Vite names every file in `dist/assets/` after a hash of its contents (`index-B7j0oayJ.js`), so a changed file always
gets a new URL:

- `assets/*`: `Cache-Control: public, max-age=31536000, immutable`.
- HTML (and anything else with a fixed URL: `public/` files, `robots.txt`): revalidate, `Cache-Control: no-cache`.
  Cloudflare Pages, Netlify and Vercel already revalidate HTML by default.
- Big files you reference by a fixed URL from `public/` (models, HDRs) cannot be immutable. Import them with `?url`
  (`import helmet from './helmet.glb?url'`) to get a fingerprinted name, or give them a short `max-age` with ETag
  revalidation.

## Compression

Brotli (or gzip) pays off for JavaScript, CSS, HTML, JSON, `.gltf` and `.wasm` (the OCCT, Draco and Basis files shrink
to 30%, 25% and 39% with brotli). For `.glb` it depends on what is inside, measured on the demo assets:

| File | Content | brotli |
| --- | --- | --- |
| `robot-expressive.glb` (464 KB) | raw geometry and animation, no textures | 22% of raw |
| `damaged-helmet-mobile.glb` (601 KB) | JPEG textures | 71% |
| `damaged-helmet.glb` (3.8 MB) | JPEG textures | 87% |

JPEG, PNG, WebP and KTX2 images are already compressed, and so is Draco geometry. Meshopt
(`EXT_meshopt_compression`) is the exception: its output is designed to be compressed again with gzip or brotli, so
always serve meshopt `.glb` files compressed. Hosts only compress content types on their list; if `.glb`
(`model/gltf-binary`) is not on yours, upload pre-compressed copies or accept raw transfer for texture-heavy models.

## Configs

All four configs set the same policy. The two eval-worker rules are only for Draco/KTX2 and STEP/IGES; drop them if
you use neither, and adjust the file patterns if your bundler names workers differently (check `dist/assets/`).

### Cloudflare Pages and Netlify (`_headers`)

Put the file in `public/` so Vite copies it to `dist/_headers`.

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/assets/*
  Cache-Control: public, max-age=31536000, immutable

# Only with @margoengine/decoders (Draco, KTX2):
/assets/decoder.worker-*.js
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'

# Only with STEP/IGES import (@margoengine/machinery/cad-async):
/assets/cad-runtime-*.js
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'
```

Cloudflare applies every matching block in order and `! Name` removes a header an earlier block set. Netlify reads the
same file, but `!` is Cloudflare syntax: on Netlify, check in the browser console that Draco/KTX2 decoding and STEP
import work before relying on those rules (two CSP headers on one response are both enforced, so the strict one would
win).

### Vercel (`vercel.json`)

The first rule's negative lookahead keeps the two eval workers out of the global policy, so no rule has to override
another.

```json
{
  "headers": [
    {
      "source": "/((?!assets/(?:decoder\\.worker|cad-runtime)-).*)",
      "headers": [
        {"key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"},
        {"key": "X-Content-Type-Options", "value": "nosniff"},
        {"key": "Referrer-Policy", "value": "strict-origin-when-cross-origin"}
      ]
    },
    {
      "source": "/assets/(decoder\\.worker|cad-runtime)-(.*)",
      "headers": [
        {"key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'"},
        {"key": "X-Content-Type-Options", "value": "nosniff"}
      ]
    },
    {
      "source": "/assets/(.*)",
      "headers": [{"key": "Cache-Control", "value": "public, max-age=31536000, immutable"}]
    }
  ]
}
```

### Nginx

`add_header` in a `location` replaces every `add_header` inherited from `server`, so the security headers live in a
snippet that each location includes.

```nginx
# /etc/nginx/snippets/margo-headers.conf
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'" always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
```

```nginx
server {
    listen 443 ssl;
    server_name app.example.com;
    root /var/www/margo-app/dist;
    include mime.types;   # needs "application/wasm wasm;" (older copies lack it); "model/gltf-binary glb;" helps compression

    gzip on;
    gzip_types text/css text/javascript application/javascript application/json application/wasm model/gltf+json model/gltf-binary image/svg+xml;
    # brotli on; brotli_types ...;   # with the ngx_brotli module

    location / {
        include snippets/margo-headers.conf;
        add_header Cache-Control "no-cache" always;
        try_files $uri $uri/ /index.html;
    }

    location /assets/ {
        include snippets/margo-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    # Only with @margoengine/decoders (Draco, KTX2) or STEP/IGES import:
    location ~ ^/assets/(decoder\.worker|cad-runtime)-.*\.js$ {
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }
}
```

## Each directive

| Directive | Value | Why |
| --- | --- | --- |
| `default-src` | `'self'` | Anything not listed below comes only from your origin. |
| `script-src` | `'self' 'wasm-unsafe-eval'` | Your bundle, plus Wasm compilation (core kernel, machinery, OCCT, Draco, Basis). No inline scripts, no `eval`. |
| `style-src` | `'self' 'unsafe-inline'` | Vite's inline `<style>`, the ViewCube and Inspector `<style>` elements, `style=""` attributes. |
| `img-src` | `'self' data: blob:` | `<img>`, the `data:,` favicon. Textures do not use it (they are fetched). |
| `connect-src` | `'self'` | `fetch` of models, textures, HDRs, decoder scripts and Wasm. Add asset CDNs, `wss://` telemetry, `data:` for tiny Vite-inlined assets. |
| `worker-src` | `'self'` | The parser, BVH, decoder and CAD workers (all same-origin files). |
| `object-src` | `'none'` | No plugins. |
| `base-uri` | `'self'` | Stops an injected `<base>` from redirecting relative URLs (workers and Wasm resolve against the module URL, but your own code may not). |
| `form-action` | `'self'` | Forms post only to your origin. |
| `frame-ancestors` | `'self'` | Who may embed the app in an `<iframe>`; set the embedding origins if you need them. Header only, ignored in `<meta>`. |

A `<meta http-equiv="Content-Security-Policy">` tag works for everything except `frame-ancestors`, but it applies only to
the page: workers get no policy from it.

## Unpublished-package CDN pages

The catalog examples on margoengine.com load packages from jsDelivr (and React from esm.sh) through an inline import map
and inline module script. A CSP for pages like that needs the CDN origins and either `'unsafe-inline'` or a hash for
each inline script:

```
script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' https://cdn.jsdelivr.net https://esm.sh; connect-src 'self' https://cdn.jsdelivr.net https://esm.sh
```

Workers cannot start from another origin, so packages that use workers must be served from your own origin, not a CDN.
margoengine.com's `site/_headers` leaves those example pages without a CSP and gives every other page the policy above.
