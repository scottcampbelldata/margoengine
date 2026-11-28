# The Million Stars

Look around the Galactic center and brush the J − Kₛ histogram. Drag across one or several bars to darken the rest of the sky. A focused histogram bar also works with Enter or Space. Use the arrow keys to move between bins and Shift+Arrow to extend a range. Drag the sky to look around, or focus it and use the arrow keys. Field of view changes the viewing angle without changing the catalogued directions.

## What is measured

This exhibit uses one million distinct entries from the 2MASS 2003 All-Sky Point Source Catalog. The query keeps point sources with catalogued J and Kₛ quality grades of A and no extended-source key. An integer sampling rule picks a reproducible subset. The complete selection, packed fields, source and the nine checksums are in [manifest.json](assets/manifest.json).

The J2000 ICRS right ascension and declination define a unit vector. An orthogonal transform expresses it in Galactic coordinates with north upward and the Galactic center near longitude 0°. Every source sits at the same chosen display radius. The exhibit represents direction and angular density. The catalogue extract carries no distances. [IRSA release documentation](https://irsa.ipac.caltech.edu/data/2MASS/docs/releases/allsky/), [ESA Hipparcos reference-frame context](https://www.cosmos.esa.int/web/hipparcos/catalogues).

J − Kₛ is the difference between two near-infrared magnitudes. The palette assigns cooler display colors to smaller differences and warmer display colors to larger differences. Interstellar dust and the sources' spectra both affect this index. Point prominence uses a compressed display scale based on Kₛ magnitude. Both presentation choices are false-color encodings. [NASA/IPAC PSC field definitions](https://www.ipac.caltech.edu/2mass/releases/allsky/doc/ancillary/pscformat.html).

## Loading and selection

The first 8,192 records are the brightest in the sample by Kₛ. They provide a working sky and brush while the remaining records stream in nine catalog chunks in total. One worker reads the additional chunks and transforms the directions. Every loaded source contributes to both the histogram and the same real Margo point clouds. The 0.1-magnitude bins show loaded record counts. The two outer bars include the tails beyond the labeled axis. A brushed interval updates the shared Sciviz selection and Margo points mask. The `In brush` counter counts all matching loaded sources in the sky sphere.

The exhibit uses Margo Engine at `0efd9cff8230507a32deb49907ecd499d46925f5`: Points clouds, Sciviz histogram and linked selection, Orbit controls, core, Quality and renderer bootstrap. Desktop and mobile stream the same dataset and share the palette. Point diameter is scaled to the height of the optical frame so a higher device pixel ratio preserves the contrast of the Galactic dust lanes. WebGPU is preferred, with the Margo WebGL2 compatibility layer available when the native renderer is absent. Use `?backend=webgl2` to verify the compatibility layer directly. The Vite build aliases `margo-demo-status` to `examples/demo-status.ts` in the same engine checkout.

## Credit

The Two Micron All Sky Survey is a joint project of the University of Massachusetts and the Infrared Processing and Analysis Center / California Institute of Technology, funded by NASA and the National Science Foundation. NASA/IPAC Infrared Science Archive distributes the catalog. [M. F. Skrutskie et al., *The Two Micron All Sky Survey (2MASS)*, AJ 131, 1163–1183, 2006](https://doi.org/10.1086/498708).
