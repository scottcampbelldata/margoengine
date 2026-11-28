# Live examples

The site page at `/examples/` is a searchable grid. Choosing a film runs it, and View source shows the files named in `films.js`.

The pages are built with Vite against the published `@margoengine/*` packages at version 0.1.0 (`package.json` in this folder). They do not bundle the workspace copies. None of the players start audio.

Files over about 5 MB, and the scans, splats, meteorite volume and harbor models that are not in git, load from `ASSET_BASE` in `asset-base.js`:

```js
export const ASSET_BASE = 'https://assets.margoengine.com/examples/';
```

`ASSET_FALLBACK` is `/examples/assets/` with the same keys. A direct fetch tries the bucket, then that path. Set `globalThis.MARGO_EXAMPLES_ASSET_BASE` before the page modules load to point a whole film at another host. glTF loads use the bucket URL so relative buffers stay next to the model.

`assets-manifest.json` lists every heavy file, where it lived on commit `05c0eb827d`, and the key to upload. The build does not upload anything.

Smaller files that are already in git are copied to `/examples/packed/` at site build time.

```sh
node scripts/build-examples.mjs
```

`npm run build:site` runs the same step after the rest of the site.
