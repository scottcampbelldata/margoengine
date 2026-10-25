# Margo app

A studio scene: a gold torus knot, a jade sphere and a white box under image-based lighting, on a slow turntable with
orbit controls, the stats overlay and quality tiers that keep it at a steady 60 FPS. Needs a browser with WebGPU.

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check, then a production build in dist/
npm run preview   # serve dist/
```

The whole scene is `src/main.ts`. `margoengine` is the only engine dependency: every package is a subpath
(`margoengine/environment`, `margoengine/controls/orbit`), and the build keeps only what you import.

`public/_headers` (copied into `dist/`) gives Cloudflare Pages and Netlify a Content Security Policy that Margo works
under and a year-long cache for fingerprinted assets. The same policy covers Draco/KTX2 decoding and STEP import: no
file needs `'unsafe-eval'`.

## Three things to try next

1. **Your model.** `const model = await loadGLTF(engine, '/model.glb')` with `loadGLTF` from `margoengine/gltf-pro`;
   put the file in `public/`.
2. **Your HDR.** Replace `studio()` with `await loadEnvironmentImage('/studio.hdr')` from `margoengine/environment`.
3. **Glow.** `Bloom.attach(engine, { strength: 0.5 })` with `Bloom` from `margoengine/post/bloom`.
