# Margo app

A small physics game: a ball you roll with WASD or the arrow keys, crates to knock over, shadows. It uses
the `margoengine/game` kit and Rapier physics (`@dimforge/rapier3d-compat`). Needs a browser with WebGPU.

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check, then a production build in dist/
npm run preview   # serve dist/
```

The app is `src/main.ts`. `margoengine` is the only engine dependency: every package is a subpath
(`margoengine/shadows`, `margoengine/controls/orbit`), and the build keeps only what you import. The engine's imports guide
(`docs/guides/imports.md`) lists which import does what.
