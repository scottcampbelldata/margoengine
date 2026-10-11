# Vexel module catalog

[Browse the searchable catalog](https://scottcampbelldata.github.io/vexel/).

Search by task, package name or public runtime export. Each of the five published `0.1.0` packages includes copy buttons for installation, imports and a complete runnable HTML example. Selecting an export name copies its individual import. The examples use the published npm packages, not workspace source.

To preview a checkout, use Node.js 22.12+ and run this command from the repository root:

```sh
npm run catalog
```

Open [localhost:5184](http://127.0.0.1:5184). No dependency installation or package build is needed for the catalog. Stop the preview with Ctrl+C.

The catalog uses plain HTML, CSS, JavaScript and `catalog.json`. It loads no engine packages. Examples fetch pinned distribution files from jsDelivr; React also uses esm.sh. Serve copied examples over localhost or HTTPS rather than opening them with `file://`. Examples include pause/play controls, respect reduced-motion preferences and dispose resources when the page closes. Creative rendering requires WebGPU.

GitHub Pages serves this directory from `main` at `/vexel/`; `.nojekyll` keeps it a static site. To add or update a package, update its `catalog.json` entry and example together. List APIs that exist in the named published version; TypeScript-only types and the advanced core `/extension` entry are covered in the [API guide](../MODERN-ENGINE.md).

Run the catalog checks after installing workspace development dependencies:

```sh
node --test tests/catalog.test.js
```
