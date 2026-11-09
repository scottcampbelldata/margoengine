# Recorded data in @margoengine/sciviz

The colormap shared dist chunk (from `src/tables.ts`) holds five standard colour-map tables as plain numeric data,
preserving every published decimal
(six places for the viridis family, four for cividis). No code from these sources is included.

- **viridis, magma, inferno, plasma**: mpl-colormaps by Nathaniel Smith and Stéfan van der Walt, dedicated to the
  public domain under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/).
  Source: https://github.com/BIDS/colormap/blob/master/colormaps.py
- **cividis**: J. R. Nuñez, C. R. Anderton and R. S. Renslow, "Optimizing colormaps with consideration for color vision
  deficiency to enable accurate interpretation of scientific data", PLOS ONE 13(7): e0199239 (2018), supporting file
  S2, dedicated to the public domain under CC0 1.0 by the publication
  (https://creativecommons.org/publicdomain/zero/1.0/).
  Changed: represented as numeric rows in TypeScript; no channel quantization.
  Source: https://doi.org/10.1371/journal.pone.0199239.s002
