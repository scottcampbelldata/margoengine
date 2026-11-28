# The Million Stars

One million real sources from the 2MASS All-Sky Point Source Catalog, placed on the sky around you in Galactic
coordinates, the Galactic centre straight ahead. Drag the sky to look around (or focus it and use the arrow keys), set
the field of view, and jump to the Galactic centre or the anticentre. Drag across the histogram's bars to pick a J - Ks
colour range: every source outside it fades. A focused bar also works with Enter or Space, the arrow keys move between
bars, and Shift with an arrow widens the range.

Everything on screen is drawn by Margo Engine packages; this folder holds only the wiring, the page and its data.

## What draws what

- **Sources.** `@margoengine/sky/milky-way` reads the packed catalogue (`fetchPointSources`), turns each J2000 right
  ascension and declination into a direction in the Galactic frame by the Hipparcos rotation (`galacticDirection`),
  and gives each source its light (`pointSourceLook`): a colour from its J - Ks index and a brightness and size from
  its Ks magnitude. `@margoengine/points` draws the nine chunks as point clouds with additive light.
- **Colour.** J - Ks is read as a B - V along the main sequence of Bessell and Brett (1988) and coloured by Planck's law;
  a J - Ks redder than an M5 dwarf is read as that star seen through dust, A_V = 5.9 E(J - K) after Rieke and Lebofsky
  (1985), so the dust lanes of the Galactic plane glow deep red. The colour is shown at 1.8 times its saturation.
  Brightness follows the Ks flux raised to the power 0.5, a display stretch. Both are presentation choices: 2MASS
  measured these stars in the near infrared, and every source sits at the same radius, as the catalogue extract
  carries no distances.
- **Brush.** `@margoengine/sciviz` counts the histogram in 0.1 mag bins (the two outer bars take the tails), and a
  `@margoengine/points/style` range filter on the J - Ks column sets each cloud's selection mask.
- **View and lens.** `@margoengine/controls/orbit` turns the view; `post/stack` adds bloom and the AgX tone curve of
  `@margoengine/tonemap`.

The page streams the brightest 8,192 sources first, then the rest in eight more parts. It runs on WebGPU and falls back
to Margo's WebGL2 compatibility layer; `?backend=webgl2` forces the fallback.

## Data

`assets/psc-00.bin.gz` to `psc-08.bin.gz`: one million entries of the 2MASS 2003 All-Sky Point Source Catalog with J
and Ks quality grade A and no extended-source key, picked by an integer sampling rule; 12 bytes each, float32 RA and
Dec, then int16 J - Ks and Ks in thousandths of a magnitude. Public-domain data of NASA/IPAC.
[IRSA 2MASS release](https://irsa.ipac.caltech.edu/data/2MASS/docs/releases/allsky/)

## Credit and sources

- M. F. Skrutskie et al., *The Two Micron All Sky Survey (2MASS)*, AJ 131, 1163, 2006.
  [doi:10.1086/498708](https://doi.org/10.1086/498708). 2MASS is a joint project of the University of Massachusetts
  and IPAC/Caltech, funded by NASA and the National Science Foundation.
- ESA, *The Hipparcos and Tycho Catalogues*, Vol. 1, section 1.5.3, 1997 (the Galactic frame).
- M. S. Bessell and J. M. Brett, *JHKLM photometry: standard systems, passbands, and intrinsic colors*, PASP 100,
  1134, 1988.
- G. H. Rieke and M. J. Lebofsky, *The interstellar extinction law from 1 to 13 microns*, ApJ 288, 618, 1985.
- J. A. Cardelli, G. C. Clayton and J. S. Mathis, *The relationship between infrared, optical, and ultraviolet
  extinction*, ApJ 345, 245, 1989.
