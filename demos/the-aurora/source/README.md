# The Aurora

A winter night above a frozen lake in northern Norway, 69.72° N, 23.59° E, on 15 February 2027. Drag the night slider
from 00:00 to 03:00 UTC, or press Play night to run it at two minutes a second: the Moon and stars move to their
places for that minute and the aurora's curtains fold as the night passes. The readouts give the Moon's elevation
and how much of it is lit.

Everything on screen is drawn by Margo Engine packages; this folder holds only the wiring, the page and its data.

## What draws what

- **Night sky.** `@margoengine/sky` (`Sky` with the Preetham, night and lighting features) draws the sky and lights
  the land with the Moon it computes; `sky/astro` places the Moon, the planets and the catalogue stars for the date
  and place; `sky/milky-way` draws the galaxy band; `sky/moon` draws the textured lunar disc, lit from the Sun's side.
- **Aurora.** `sky/aurora` draws three arcs of curtains over a curved shell: oxygen green at 557.7 nm, oxygen red at
  630.0 nm and nitrogen blue near 427.8 nm. Its brightness and folds are illustrative, not a space-weather forecast.
- **Land.** `@margoengine/terrain` builds the 3.6 km fells and shore from `@margoengine/procedural/noise` heights;
  `procedural/conifers` grows the grand and Douglas firs; `@margoengine/weather/snow` lays snow on every surface by
  its slope.
- **Lake.** `environment/reflector-pbr` is the black ice: a planar mirror with contact-hardened blur that shows the
  fells, the Moon and the curtains. The page renders frames itself, so it asks the ice to capture before each one.
- **Light and lens.** `@margoengine/shadows` casts the Moon's shadows (cascades near the shore, and
  `shadows/distance` marching the height field for the fells), then `post/stack` applies bloom and the AgX tone curve
  from `@margoengine/tonemap`.

The Moon disc is drawn 2.9 times its true size so the maria read at this field of view. The page runs on WebGPU and
falls back to Margo's WebGL2 compatibility layer; `?backend=webgl2` forces the fallback.

## Data

- **Moon albedo** (`moon.jpg`): Ernie Wright and Noah Petro, *CGI Moon Kit*, NASA Scientific Visualization Studio,
  2019, LROC WAC albedo with LOLA polar fill. [NASA SVS 4720](https://svs.gsfc.nasa.gov/4720/)
- **Stars** (`bright-stars.gz`): Dorrit Hoffleit and W. H. Warren Jr., *The Bright Star Catalogue, 5th Revised
  Edition*, 1991, CDS V/50. [CDS V/50](https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50)
- **Aurora lines and forms**: [NOAA Space Weather Prediction Center](https://www.spaceweather.gov/phenomena/aurora).
- **Moon and star places**: compare with the [U.S. Naval Observatory's Sun and Moon service](https://aa.usno.navy.mil/data/AltAz)
  for the same place and times.
