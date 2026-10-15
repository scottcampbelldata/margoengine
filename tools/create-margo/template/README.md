# Margo app

A [Margo Engine](https://margoengine.com) scene: image-based lighting, orbit controls, a stats overlay and quality
tiers that keep it at a steady 60 FPS. Needs a browser with WebGPU.

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check, then a production build in dist/
npm run preview   # serve dist/
```

The whole scene is `src/main.ts`. Each `@margoengine/*` package is optional: install only what you import.

`public/_headers` (copied into `dist/`) gives Cloudflare Pages and Netlify a Content Security Policy that Margo works
under and a year-long cache for fingerprinted assets. [Deploying](https://github.com/scottcampbelldata/margoengine/blob/main/docs/deploying.md)
explains each directive and has the Vercel and Nginx versions; Draco/KTX2 decoding and STEP import each need one
extra rule.

## Where to go next

- [Coming from three.js](https://github.com/scottcampbelldata/margoengine/blob/main/docs/from-threejs.md): three.js
  code side by side with Margo code (models, textures, shadows, post-processing, picking).
- [margoengine.com](https://margoengine.com): demos and every package.
