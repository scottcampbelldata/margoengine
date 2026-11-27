# The Eclipse

Queue entry 73. Scrub 12:15–15:15 CDT on April 8, 2024 or jump to the calculated contacts and greatest eclipse. The Sun-tracking optical view shares its clock and measured geometry with an original 3D interpretation of the Dallas skyline from the Trinity River.

## Geometry and light

The local apparent positions are 61 airless, topocentric NASA JPL Horizons DE441 samples at three-minute intervals for 32.7767° N, 96.7970° W, elevation 130 m. Azimuth is measured east from north. The app interpolates each body's azimuth, elevation and apparent diameter, converts positions to unit vectors and determines their angular separation. The close-up measures the Sun and Moon against those vectors in a Sun-centered frame. The dark lunar limb covers the solar disc at the same radii used on the readout.

Coverage uses the intersecting area of the two apparent discs in the small-angle approximation. Direct photospheric light integrates 192 annuli with linear limb darkening, using a constant illustrative coefficient of 0.60. Direct light reaches exactly zero when the photosphere is completely covered. Residual scattered light remains in the sky. The scene drives the Margo sky exposure and direct and diffuse surface lighting from the computed flux, then blends a warm horizon during totality. This clear-sky atmospheric reconstruction does not simulate Dallas weather or eclipse-specific three-dimensional radiative transfer, and the corona and prominences are procedural illustrations.

Representative contact times from the model, rounded to the nearest second in CDT:

| Stage | Local time |
| --- | --- |
| Partial phase starts | 12:23:20 |
| Totality starts | 13:40:40 |
| Greatest eclipse | 13:42:40 |
| Totality ends | 13:44:37 |
| Partial phase ends | 15:02:40 |

NASA My NASA Data gives about 12:23 and 13:40 for partial and total onset in Dallas. Bemporad's Table 2 gives 12:23:24, 13:40:43, 13:44:52 and 15:02:52 at Balch Springs, a different site about 16 km away. Contact seconds here are predictions for the stated coordinates using smooth circular limbs. Lunar topography and differential atmospheric refraction are omitted.

## Data and references

- [NASA JPL Horizons](https://ssd.jpl.nasa.gov/horizons/manual.html) and [Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html). Query body IDs 10 and 301 for observer `coord@399`, geodetic site `-96.7970,32.7767,0.130`, quantities 4 and 13, `APPARENT=AIRLESS`, times 17:15–20:15 UTC in three-minute steps. Raw response SHA-256, Sun `c25a0f47858523ec69f66f5f3fd223ddec0347d5bf8627b6771c3f21246e2164`; Moon `de76b4dfa3e56c01f10dcf5618da624f60a8595310463db130558b2a62d78fdc`. Only the tabulated numeric observations are distributed in `ephemeris.mjs`.
- [NASA, 2024 Total Solar Eclipse](https://science.nasa.gov/eclipses/future-eclipses/eclipse-2024/) and [Fred Espenak, NASA GSFC, 2024 April 08 path prediction](https://eclipse.gsfc.nasa.gov/SEhistory/SEpath/SE2024Apr08Tpath.html) for the event and path.
- [Alessandro Bemporad, The 2024 Great American Eclipse: first report on the observational campaign, INAF, 2024](https://doi.org/10.20371/INAF/TechRep/312) for a nearby contact comparison and optical reference.
- [Heinz Neckel and Dietrich Labs, Solar limb darkening 1986–1990, Solar Physics, 1994](https://articles.adsabs.harvard.edu/pdf/1994SoPh..153...91N) for weakening photospheric intensity toward the limb.
- [Donald and Ronald Bruns, Sky brightness and color measurements during the 21 August 2017 total solar eclipse, Applied Optics, 2018](https://doi.org/10.1364/AO.57.004590) for the observed relationship between partial-phase integrated intensity and sky luminance.
- [Claudia Emde and Bernhard Mayer, Simulation of solar radiation during a total eclipse, Atmospheric Chemistry and Physics, 2007](https://doi.org/10.5194/acp-7-2259-2007) for the limitations of simple irradiance scaling during totality.
- [NWS Fort Worth April 8 field report](https://www.weather.gov/fwd/eclipse2024), including Nestor Flecha's Dallas skyline photo. Used as lighting reference only. The demo ships no photograph.
- [Margo Engine sky, public revision 0efd9cff8230507a32deb49907ecd499d46925f5](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/sky) provides the analytic atmosphere, twilight palette and directional sky. The two views, geometry and optical pass render in Margo Engine in both browser modes.

## Verification

Use the project gallery resolver with `the-eclipse` added to the existing conditional compatibility-preload set. In the local source checkout, run `qa-output/the-eclipse/check.mjs` with `MARGO_ENGINE_CHECKOUT` set and `ECLIPSE_HINTS=1`. It exercises native WebGPU, automatic fallback without `navigator.gpu`, forced compatibility, narrow-device touch and desktop click. It changes the actual time slider first, verifies the presented timestamp, then checks rendered totality, unobscured sunlight and contact controls. It emits screenshots and timing reports, and accepts `ECLIPSE_URL` after central publishing. With Pillow installed, `python qa-output/the-eclipse/measure.py` compares screenshot luminance for the sky and skyline in all five profiles. Timing measures completed Margo work after trusted input on a 390-CSS-pixel mobile profile with a cold cache, 150 ms latency, 1.6 Mbps transfer and 4× CPU throttling.
