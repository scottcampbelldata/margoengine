# Margo visualization

300,000 points in a turning three-armed galaxy, coloured by radius, glowing with bloom, over a grid with HTML labels.
Drag to orbit, scroll to zoom; it turns on its own until you do. Built with the `margoengine/viz` kit. Needs a browser
with WebGPU.

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check, then a production build in dist/
```

The scene is `src/main.ts`. `margoengine` is the only engine dependency: every package is a subpath
(`margoengine/points`, `margoengine/post/bloom`), and the build keeps only what you import.

## Three things to try next

1. **More points.** Set `count` to `2_000_000`: the points package culls and subsamples by screen area, so the frame
   rate holds (`pointBudget` caps what is drawn).
2. **Your data.** Replace the loop with your own `positions` and `colors` (or parse a PLY, PCD or XYZ file with
   `margoengine/loaders`).
3. **Lines between points.** `lines.add(new Line({ positions: [x1, y1, z1, x2, y2, z2], width: 2 }))` with `Line`
   from `margoengine/viz`.
