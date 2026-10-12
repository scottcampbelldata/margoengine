# Earth demo textures

The demo serves these files locally; it makes no external texture requests at runtime.
All maps are equirectangular, 2048 × 1024 pixels. These assets depict static composites,
not live weather or current city-light data.

| File | Creator / source | Changes |
| --- | --- | --- |
| `earth-day.jpg` | NASA Earth Observatory, Blue Marble: Next Generation, July 2004 | NASA 5400 × 2700 JPEG resized to 2048 × 1024 using Lanczos; JPEG quality 90. |
| `2k_earth_nightmap.jpg` | Solar System Scope / INOVE | Original 2k JPEG, unchanged. |
| `2k_earth_clouds.jpg` | Solar System Scope / INOVE | Original 2k JPEG, unchanged. |
| `earth-normal.png` | Solar System Scope / INOVE | Original 2k RGB TIFF converted losslessly to PNG. |
| `earth-specular-roughness.png` | Solar System Scope / INOVE | Original 2k TIFF repacked: R retains the ocean/specular mask, G is `round(255 − 0.85 × R)` (ocean roughness ≈ 0.15, land roughness 1), B is zero. |

Solar System Scope's texture pack is based on NASA imagery/elevation data and is
licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
Credit: **Solar System Scope (INOVE), https://www.solarsystemscope.com/textures/, CC BY 4.0**.
The derivatives retain this license. Source page and license checked October 11, 2026.

Original Solar System Scope downloads:

- https://www.solarsystemscope.com/textures/download/2k_earth_nightmap.jpg
- https://www.solarsystemscope.com/textures/download/2k_earth_clouds.jpg
- https://www.solarsystemscope.com/textures/download/2k_earth_normal_map.tif
- https://www.solarsystemscope.com/textures/download/2k_earth_specular_map.tif

NASA source: [Blue Marble: Next Generation, Base Map](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/).
Original July JPEG: https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x5400x2700.jpg.
Credit: **NASA Earth Observatory, Blue Marble: Next Generation**.
NASA permits educational/informational graphical simulations under its
[Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/).
No endorsement by NASA is implied.

The procedural stars contain no external image assets.
