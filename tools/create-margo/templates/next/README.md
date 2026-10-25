# Margo app

A Next.js app: a rotating cube in a client component with `margoengine/react`. Needs a browser with WebGPU.

```sh
npm install
npm run dev        # http://localhost:3000
npm run build      # production build in .next/
npm start          # serve the build
```

The app is `app/page.tsx`. `margoengine` is the only engine dependency: every package is a subpath
(`margoengine/shadows`, `margoengine/controls/orbit`), and the build keeps only what you import. The engine's imports guide
(`docs/guides/imports.md`) lists which import does what.
