# The Sky Survey

Turn a celestial globe populated from the Fermi Large Area Telescope's 14-year gamma-ray source catalog. The 7,195 marks use the catalog's actual Galactic longitude and latitude, with the direction toward the Galactic centre at $l=0°, b=0°$. The globe uses a common radius for all entries and therefore encodes direction on the sky. Marker size and color follow catalog detection significance on a logarithmic scale. The one entry without a published significance uses the quietest mark.

**Galactic plane** selects the 2,124 catalog entries with $|b|\leq10°$. **Pulsars** selects the 320 catalog entries in the pulsar and millisecond pulsar classes, including case variants of `PSR` and `MSP`. The count uses the whole catalog. The globe's body hides the far hemisphere from the current view.

Drag to turn the globe or use the arrow keys while it has focus. Tap a source to read its catalog identifier, known association where available, coordinates and detection significance. The displayed energy flux covers 100 MeV to 100 GeV in erg cm⁻² s⁻¹. The full survey analysis uses observations from 50 MeV to 1 TeV. [Fermi Science Support Center](https://fermi.gsfc.nasa.gov/ssc/data/access/lat/14yr_catalog/), [NASA HEASARC field definitions](https://heasarc.gsfc.nasa.gov/W3Browse/fermi/fermilpsc.html).

The source asset is the Fermi Science Support Center's v35 FITS release. Two small FITS binary tables retain the original row order and original values for the seven fields used here. Margo Sciviz opens both tables through its FITS reader. The identification table loads when a source is probed. The catalog SHA-256 is `e3b3ea278412b7bda4c259ab558f00b76605be59eb84e44086a862a179ffc3e6`.

To reproduce the assets, set `MARGO_ENGINE_CHECKOUT` to a build of the pinned public Margo Engine revision and run `node tools/pack-survey.mjs gll_psc_v35.fit assets` after downloading the source.

## Sources

- NASA Fermi Science Support Center and the Fermi-LAT Collaboration (2024 data update). *4FGL-DR4 point source catalog, v35*. [Original FITS](https://fermi.gsfc.nasa.gov/ssc/data/access/lat/14yr_catalog/gll_psc_v35.fit), [NASA open science data license, CC0](https://science.data.nasa.gov/about/license).
- Jean Ballet, Philippe Bruel, Toby H. Burnett, Benoît Lott and the Fermi-LAT Collaboration (2023). *Fermi Large Area Telescope Fourth Source Catalog Data Release 4 (4FGL-DR4)*. [Paper](https://arxiv.org/abs/2307.12546).
- William D. Pence, Lucio Chiappetti, Clive G. Page, Richard A. Shaw and Elizabeth Stobie (2010). *Definition of the Flexible Image Transport System (FITS), version 3.0*. The exhibit uses standard FITS binary tables. [Paper](https://doi.org/10.1051/0004-6361/201015362).
