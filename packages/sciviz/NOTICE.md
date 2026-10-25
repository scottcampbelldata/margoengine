# Recorded data in @margoengine/sciviz

`dist/tables.js` (from `src/tables.ts`) holds five standard colour-map tables as data, each rounded to 8 bits per
channel. No code from these sources is included.

- **viridis, magma, inferno, plasma**: mpl-colormaps by Nathaniel Smith and Stéfan van der Walt, dedicated to the
  public domain under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/).
  Source: https://github.com/BIDS/colormap/blob/master/colormaps.py
- **cividis**: J. R. Nuñez, C. R. Anderton and R. S. Renslow, "Optimizing colormaps with consideration for color vision
  deficiency to enable accurate interpretation of scientific data", PLOS ONE 13(7): e0199239 (2018), supporting file
  S2, licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Changed: values rounded to 8 bits.
  Source: https://doi.org/10.1371/journal.pone.0199239.s002
