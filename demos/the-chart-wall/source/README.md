# The Chart Wall

Read the NASA Exoplanet Archive through a chosen discovery year. **Discovery by year** counts confirmed planets in the archive, and **Orbits and sizes** plots the period and radius values available for a subset of those same records. Move **Archive through** to update both charts and the totals. Each **SVG** button downloads the current chart with its legend, axes, source and cutoff.

## Data

The source is the NASA Exoplanet Archive’s **Planetary Systems Composite Parameters** table, downloaded directly from the archive’s TAP service on 27 November 2026. The snapshot has 5,844 confirmed exoplanets with a discovery year from 1992 through 2024. The archive assigns discovery years and methods. Transit and Radial Velocity are shown separately. Other methods sums the remaining nine mutually exclusive method categories. A method with no recorded discoveries in a plotted year contributes zero to that year’s line.

The scatter includes rows with both values in the plotted domain. Orbital periods span 0.1 through 10,000 days on a base-10 log axis. Radii greater than zero through 24 Earth radii are shown on a linear axis. 5,436 planets meet that display scope through 2024. With the cutoff at 2017, there are 3,594 confirmed planets and 3,462 scatter marks. Detection biases and catalogue coverage shape these counts. Some composite parameters are estimates assembled from the source references. Hover for the named row and published asymmetric errors when both bounds are provided.

NASA funds the archive through the Exoplanet Exploration Program. Caltech operates it under contract. [Archive acknowledgments](https://exoplanetarchive.ipac.caltech.edu/docs/acknowledge.html)

The exact ADQL, query endpoint, snapshot and file hashes are in `tools/source.json`. Run the recorded query with `format=csv`, then run the following from this demo’s source folder to recreate the two compressed assets.

    python tools/prepare-planets.py path/to/nasa-tap.csv

The first plot starts from a roughly half-kilobyte annual summary generated from the same NASA rows. It uses Margo Lines with the Sciviz UTC date scale. Its vector export uses the same layout and line vertices as the live plot. The orbit plot reads the 47,886-byte numeric grid when its canvas enters the viewport. Its vectors come from Sciviz’s exporter. Names, individual discovery methods and uncertainty values load on demand when the pointer enters the orbit plot. The orbit renderer checks both totals against the year summary before it publishes the frame.

## Rendering and tests

The chart layers and physical data-to-plot mappings use Margo Lines and Margo Sciviz at the verified public engine revision `0efd9cff8230507a32deb49907ecd499d46925f5`. The date scale maps to UTC year starts. Both layouts open the orbit plot when its canvas reaches the viewport and apply the current year before it renders. Both layouts use the same materials, marks and scale domains. WebGPU is preferred, with Margo’s full WebGL2 compatibility renderer available as fallback.

Publication SVG includes the visible chart at its current size. The outline and marks stay vector, with source attribution and the chosen cutoff. Other-method marks retain their square shape. On a phone the SVG keeps the phone chart’s proportions.

In `qa-output/the-chart-wall`, `data-proof.py` checks every packed row against the downloaded source and reconciles the chart totals. `check.mjs` applies a trusted cutoff gesture, checks the actual date and log labels, scrolls the second plot into view, downloads both SVGs, and inspects their vector marks. The same tests run with native, forced WebGL2 and automatic WebGL2 mobile profiles, and both desktop renderers.

With the standard compatibility startup hints, cold 390 px Chrome at 150 ms latency, 1.6 Mbps and fourfold CPU slowdown completed the first trusted year change at 1.231 s on WebGPU, 2.288 s on forced WebGL2 and 2.113 s on automatic WebGL2. The desktop figures were 0.380 s native and 0.203 s forced. All profiles opened the orbit plot after the first chart, checked both actual vector downloads and restored the full snapshot.

## Sources

- NASA Exoplanet Archive. *Planetary Systems Composite Parameters*. [Dataset DOI](https://doi.org/10.26133/NEA13) · [Field definitions](https://exoplanetarchive.ipac.caltech.edu/docs/API_TD_columns.html) · [TAP service](https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html)
- Jessie L. Christiansen and colleagues, 2025. *The NASA Exoplanet Archive and Exoplanet Follow-up Observing Program: Data, Tools, and Usage*. [Archive publication](https://doi.org/10.3847/PSJ/ade3c2)
- NASA Science. *How We Find and Characterize*. [Discovery-method guide](https://science.nasa.gov/exoplanets/how-we-find-and-characterize/)
- William S. Cleveland and Robert McGill, 1984. *Graphical Perception: Theory, Experimentation, and Application to the Development of Graphical Methods*. [Original paper](https://doi.org/10.1080/01621459.1984.10478080)
