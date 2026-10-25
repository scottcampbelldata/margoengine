# Margo app

A React app: a rotating cube with orbit controls, written as JSX with `margoengine/react`. Needs a browser with WebGPU.

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check, then a production build in dist/
npm run preview   # serve dist/
```

The app is `src/main.tsx`. `margoengine` is the only engine dependency: every package is a subpath
(`margoengine/shadows`, `margoengine/controls/orbit`), and the build keeps only what you import. The engine's imports guide
(`docs/guides/imports.md`) lists which import does what.
