# The Sky Clock

Set the observation date and UTC time, choose a site, or supply latitude and longitude. Drag the sky or use its arrow-key controls. The object table reports compass bearings clockwise from true north and apparent elevations above the observer’s level horizon. Positive longitude is east. The generic ridge is original display geometry. The sky’s computed directions use coordinates and time directly.

The date range is January 1, 1800, to December 31, 2049. It stays within the fit used by Margo’s planetary ephemerides. The Sun and Moon run through Margo Sky’s astronomical equations, published JPL planetary elements supply planet directions, and the catalogue star renderer advances positions using their measured proper motions. The lunar illumination and limb orientation use the Sun–Moon geometry. Standard near-horizon refraction and extinction are included. This is an observation exhibit with approximate ephemerides and a level reference horizon.

The selection includes all 2,717 position-bearing catalogue entries at visual magnitude 5.45 and brighter. The original CDS file was processed with Margo’s public parser. The compressed browser packet uses quantized J2000 unit vectors (component step 1/32767), proper motion in 10 nanoradians per year, hundredths of a magnitude, and catalogue numbers. Named labels help locate bright Solar System objects. The same measured positions are rendered by native WebGPU and Margo’s WebGL2 compatibility mode.

## Sources and checks

- Dorrit Hoffleit and Wayne H. Warren Jr., *The Bright Star Catalogue, Fifth Revised Edition*, 1991. [CDS V/50 catalogue](https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50) · [Archived source](https://vizier.cfa.harvard.edu/ftp/cats/V/50/catalog.gz). The catalogue is used with acknowledgement of the authors and CDS. Source SHA-256 `3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed`.
- Jean Meeus, *Astronomical Algorithms*, 2nd edition, 1998, Sun and lunar apparent positions and illumination. [Publisher edition](https://www.willbell.com/math/mc1.htm).
- E. Myles Standish and the JPL Solar System Dynamics Group, [Approximate Positions of the Planets](https://ssd.jpl.nasa.gov/planets/approx_pos.html). Margo applies the fit for 1800–2050.
- NASA JPL, [Horizons system and documentation](https://ssd.jpl.nasa.gov/horizons/). At the opening instant, 2026-05-20 05:48 UTC, Horizons gives solar elevation −12.772°, lunar elevation 33.920°, and 16.220% lunar illumination for the Mauna Kea coordinates. The exhibit model gives −12.766°, 33.945°, and 16.743%. The small differences reflect the respective model and refraction assumptions.

To rebuild the star packet, run `node tools/pack-catalog.mjs` with `MARGO_ENGINE_CHECKOUT` pointing to the verified public revision. An optional argument names the archived source `catalog.gz`.
