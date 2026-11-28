# Voxel World Light

Open the shutter. The crosshair tile at the front of the opening gains red light from the amber lamp in the rear court. The cyan lamp in the foreground keeps its contribution. Press again to close the shutter and check that the additional red level goes back to zero.

## Model

The original 28 × 23 cell display is a tabletop cutaway. Its terraces, ashlar, metal trim, grille faces and probe tile are authored as an actual voxel world with original tile textures. Both device sizes show the same world and textures.

The amber source is [9, 3, 7], the cyan source is [20, 3, 17], and the probe is [12, 3, 14], one cell above the crosshair tile. The amber-to-probe ray intersects permanent stone at [11, 3, 11] in both shutter states. The shortest open-air amber route drops from 22 neighbor steps to 10 when the 3 × 3 × 2-cell shutter is removed. The cyan route stays at 11 steps. The probe reads RGB (0, 1, 4) closed and (5, 1, 4) open. The examples use unitless 0–15 block-light levels and settle the discrete light flood before rendering each state. The levels describe propagation on this grid.

Margo [VoxelColorLight](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/voxel) owns the independent red, green and blue flood and its sampled 3D volume. The package's greedy mesher and VoxelRenderer rebuild and render the real solid shutter faces. Sky fill is provided by VoxelLighting. WebGPU opens first, with the full Margo WebGL2 compatibility path available where needed. All packages are built from public Margo main at `0efd9cff8230507a32deb49907ecd499d46925f5`. The scene needs zero external asset requests.

## QA

From the showcase root with `MARGO_ENGINE_CHECKOUT` pointing to the built public checkout and `VOXEL_WORLD_LIGHT_PRELOAD=1`, run the following. The Python pixel check needs Pillow.

```text
node qa-output/voxel-world-light/check-route.mjs
node qa-output/voxel-world-light/check.mjs
python qa-output/voxel-world-light/check-pixels.py
```

The browser check uses the gallery's startup preloads for this slug and can instead target a public route through `VOXEL_WORLD_LIGHT_URL`. Local Chrome test results through the first trusted touch and completed render were 1.721 s on native WebGPU, 2.304 s on automatic WebGL2 and 2.223 s on forced WebGL2. The cold mobile profile uses a 390 × 844 viewport at 2× device pixel ratio, 150 ms latency, 1.6 Mbps download and 4× CPU throttling. Desktop click-through took 0.835 s on native WebGPU and 0.894 s on forced WebGL2. All five tested profiles completed two open cycles and a close, with one drawn chunk and 1,343 closed or 1,352 open quads. Mean rendered red in the probe tile patch increased by 26.6 out of 255 on phone and 26.2 on desktop. The cyan fixture patch stayed steady.

## References

- A.J. Fairfield, 2026, discusses breadth-first propagation for block lighting in [Modernizing Minecraft, Evolving the Rendering Pipeline](https://media.gdcvault.com/gdc2026/Slides/Fairfield_AJ_ModernizingTheRenderingOfMinecraft.pdf).
- The archival presentation of exposed walls and pavements informed the original cutaway composition. [Historic England, The Roman Baths, Bath, Heritage Gateway Record](https://historicengland.org.uk/listing/heritage-gateway/results/record/f47f405f-d030-4528-9054-1126aee5bfb8/61600).
- Josef Albers, 1963, informed the side-by-side warm and cool color treatment. [Interaction of Color, National Gallery of Art](https://www.nga.gov/artworks/55903-interaction-color).
