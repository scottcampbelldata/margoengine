# Margo Engine module catalog

[Browse the searchable catalog](https://scottcampbelldata.github.io/margoengine/).

Coming from three.js: [from-threejs.md](from-threejs.md) maps three.js code to Margo packages side by side.

Design envelope: [limits.md](limits.md) lists every hard limit (entity count, textures per shader, float32 coordinates, STEP size, browsers and tested hardware), where it starts, and the package or tool that takes you past it.

Deploying: [deploying.md](deploying.md) gives the Content Security Policy, caching and compression headers for Cloudflare Pages, Netlify, Vercel and Nginx.

Making a game with Blender: [guides/blender-game.md](guides/blender-game.md) builds a small interactive game from glTF exports, step by step.

Search all 71 packages by task, package name or public runtime export. Copy installation commands and imports, open each package guide, and try the five standalone HTML examples. The catalog marks exact versions available on npm; packages marked Source can be built from the repository until publication.

To preview a checkout, use Node.js 22.12+ and run this command from the repository root:

```sh
npm run catalog
```

Open [localhost:5184](http://127.0.0.1:5184). No dependency installation or package build is needed for the catalog. Stop the preview with Ctrl+C.

The catalog uses plain HTML, CSS, JavaScript and `catalog.json`. It loads no engine packages. Examples fetch pinned distribution files from jsDelivr; React also uses esm.sh. Serve copied examples over localhost or HTTPS rather than opening them with `file://`. Examples include pause/play controls, respect reduced-motion preferences and dispose resources when the page closes. Creative rendering requires WebGPU. CDN examples need their Margo packages to be published first.

GitHub Pages serves this directory from `main` at `/margoengine/`; the website build also copies it into `/catalog/`. `npm run build:packages` refreshes it (or `npm run catalog:build` after an existing build): it regenerates package names, versions, runtime exports and exact-version registry availability. Add runnable examples to the matching `catalog.json` entry; the generator retains that metadata. TypeScript-only types and the advanced core `/extension` entry are covered in the [API guide](../MODERN-ENGINE.md).

Run the catalog checks after installing workspace development dependencies:

```sh
node --test tests/catalog.test.js
npm run test:catalog:browser   # real Edge: layout and clipboard (not part of verify)
```
