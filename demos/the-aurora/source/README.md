# The Aurora

Scrub from 00:00 to 03:00 UTC at an imagined northern-fells overlook. The date and coordinates anchor the Moon and stars. The luminous curtain varies with the night scrub in an illustrative sequence. Play advances the same timeline and can be paused. The scene opens on a still frame.

## Land and sky

The camera is set on a snowy shore above solid lake ice. The layered terrain, tree silhouettes, ice and frost geometry are original and procedural. Coordinates select a sightline for the sky calculation. The land is an invented Arctic landscape. A directional light follows the computed Moon and soft ambient fill keeps the ice legible. Ice is opaque geometry with shallow relief, wind-raked frost and thermal cracks.

Margo's astronomical model positions the Moon and the catalogue stars for 69.72° N, 23.59° E on 15 February 2027. The Moon's illuminated fraction and elevation are the model's topocentric readouts. The lunar texture is turned north-up in the sky layer, without libration. The display enlarges the angular diameter by 2.9× so its textured surface can be seen. The solar direction toward the Moon defines the lit limb. [U.S. Naval Observatory Sun and Moon service](https://aa.usno.navy.mil/data/AltAz).

The aurora pass models ribbons and folds over a curved atmospheric shell, with green oxygen emission at 557.7 nm, red oxygen at 630.0 nm and nitrogen emission near 427.8 nm. The demo controls the layer's clock and illustrative intensity. It carries no space-weather observations or forecast. [NOAA Space Weather Prediction Center](https://www.spaceweather.gov/phenomena/aurora), [NOAA calibration center](https://ncc.nesdis.noaa.gov/VIIRS/SWX/Aurora.php).

The textured Moon, aurora and terrain open together. The star catalogue, Milky Way and bloom follow after the night controls become available. Both renderers and screen sizes use the same opening and full-detail scenes, including the same assets using public Margo Engine at `0efd9cff8230507a32deb49907ecd499d46925f5`. Sky, terrain, bloom and core supply the visuals. The app uses WebGPU first and Margo's automatic full WebGL2 compatibility path. `?backend=webgl2` forces a compatibility check. The app shows the engine's own reason when the required tier is unavailable.

## Visual sources

- **Moon** — Ernie Wright and Noah Petro, *CGI Moon Kit*, NASA Scientific Visualization Studio, 2019. The 192 × 96 grayscale WebP is reduced from the public engine's 1024 × 512 LROC WAC Hapke-normalized lunar albedo fixture with LOLA polar fill. [NASA SVS](https://svs.gsfc.nasa.gov/4720/), [NASA imagery guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/).
- **Stars** — Dorrit Hoffleit and W. H. Warren Jr., *The Bright Star Catalogue, Fifth Revised Edition*, 1991. The included record keeps the useful fields for stars to visual magnitude 5.6 from the Centre de Données astronomiques de Strasbourg CDS V/50 catalogue. [CDS catalogue](https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50).
- **Milky Way** — Axel Mellinger, *A Color All-Sky Panorama Image of the Milky Way*, PASP 121, 2009, supplies photometry and a visual reference for Margo's procedural Milky Way. [Paper](https://arxiv.org/abs/0908.4360).
- **Landscape and curtains** — NASA's photographed aurora colors and NOAA's observed folded arcs informed the composition. The terrain, lake, vegetation and ice surface are original. [NASA Science aurora photographs](https://science.nasa.gov/sun/auroras/).
