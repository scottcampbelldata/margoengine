# Yale Bright Star Catalogue, 5th Revised Ed. (test fixture)

`catalog.gz` and `ReadMe` are catalogue V/50 of the CDS (Centre de Donnees astronomiques de Strasbourg), byte for byte as
the archive serves them: Hoffleit D. and Warren Jr W.H., "The Bright Star Catalogue, 5th Revised Ed. (Preliminary
Version)", Astronomical Data Center, NSSDC/ADC, 1991 (=1991bsc..book.....H).

- Downloaded 2026-11-07 from the CDS VizieR mirror at the Harvard-Smithsonian Center for Astrophysics,
  https://vizier.cfa.harvard.edu/ftp/cats/V/50/ (cdsarc.cds.unistra.fr did not answer that day).
- `catalog.gz`: 573,921 bytes, SHA-256 3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed
  (gzip of the 1,704,879 byte `catalog`, 9,110 records).
- `ReadMe`: 11,571 bytes, SHA-256 44fd9c73e2eecad0beb47bdfa3f01c60fd43f93d6964198e31fcd48732de5b33.
- Checked against NASA HEASARC's copy of the same catalogue (table `bsc5p`,
  https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_bsc5p.tdat.gz, SHA-256
  122628cde2d8bedf7e16ddf5f888167ac58c04b5592d6155408ce297f3073931): all 9,096 stars with J2000 places agree within
  0.00005 degree (the catalogues' rounding) and in V magnitude exactly.
- Terms: CDS data are free to use with acknowledgement of the CDS and the catalogue's authors (above). Used only by the
  tests of `@margoengine/sky/astro`; not shipped in any package.
