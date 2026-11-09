# Retained API test pages

These pages preserve Gemini's sciviz exercises and their original synthetic data generators. They are package
test fixtures, not public demos or scientific models. `sciviz-showcase.html` links the three exercise pages.
The official real-data pages live at `examples/sciviz-head.html`, `sciviz-stars.html`, `sciviz-wind.html`.

`sciviz-aeroflow` keeps the serial, latest-request update loop; each trace now uses `Figure.replace()` when
its successor exists, so neither an empty frame nor a duplicate frame is shown while the next trace is built.
`sciviz-astrometrics` keeps its latest-only queues and replaces scatter and histogram layers through the same API.
`sciviz-medical` serialises dataset loads and first isosurface creation, replaces the volume after fetching it,
shows the signed NIfTI statistic map with a clear interval around zero, and exercises the official multi-slice
MRI asset instead of attempting to render one DICOM image as a 3D volume. The package's decoder tests retain
the single-slice DICOM coverage. The synthetic phantom starts with a cutaway so its inside is visible.

After building packages, open these through `npm run dev:examples`, or run the bounded browser check from the root:

```sh
node scripts/gpu-lock.mjs run --owner=sciviz-pages --max=12 --wait-max=5 -- node packages/sciviz/tests/demos-browser.mjs
```

It checks the real demos and these pages at 1440 x 900 and 390 x 844, on native WebGPU and forced WebGL2,
without external data requests. `demo-data.test.js` also type-checks the retained pages. The pages, datasets and
browser runner are excluded from the published sciviz package by its `files` list.
