# Charts You Can Hear

A sonified tide record from the Golden Gate gauge in San Francisco. Listen to a day or inspect an individual hour using the slider, chart, or accessible table. The chart and both renderers use the same set of water level observations. Changing the day changes the data, low and high readings, graph, and audio. No sound begins until the visitor presses Listen.

The 168 observed measurements are verified hourly levels for December 1–7, 2025, UTC, measured in meters relative to mean lower low water (MLLW). The chart readout rounds to two decimals while the underlying table preserves millimeters. The raw NOAA response had no flagged values in this window. The replay is an educational rendering of recorded measurements, and NOAA publishes official tide predictions separately.

Margo Sciviz provides the numerical description and the pitch schedule. Margo Lines draws the chart with native WebGPU first and the engine’s WebGL2 compatibility renderer. A 24-note, 5.28-second sequence scales logarithmically from 162 to 715 Hz over the fixed −0.75 to 2.5 meter chart range across all seven days. A short interpolation connects adjacent notes and the selected point tracks the playback clock. Each date can be compared on the same time, height, and pitch scales.

## Sources

- NOAA Center for Operational Oceanographic Products and Services, [San Francisco station 9414290](https://tidesandcurrents.noaa.gov/stationhome.html?id=9414290) and [hourly-height source response](https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9414290&begin_date=20251201&end_date=20251207&product=hourly_height&datum=MLLW&time_zone=gmt&units=metric&application=MargoDemos&format=json). Source SHA-256 `baf9ac884ec4376e7ce6d64db7d69bcf2cbf2be18aadf61ff6b0d975ab332b8f`.
- Gaël Dubus and Roberto Bresin, [A systematic review of mapping strategies for the sonification of physical quantities](https://doi.org/10.1371/journal.pone.0082491), PLOS ONE, 2013.
- W3C Audio Working Group, [Web Audio API](https://www.w3.org/TR/webaudio/), timing and oscillator API.

Rebuild the data fixture using `node tools/pack.mjs` from this directory. Pass a saved copy of the original JSON as an argument to avoid fetching it again.
