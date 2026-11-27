# The Solid Modeller

The exhibit presents four exact states of a 132 mm wide aluminium bracket. Extrude a six-edge L-shaped section, add a 4.6 mm fillet to the heel and lip, hollow the open end to make 3.5 mm walls, then subtract two 12.4 mm drill cylinders.

The Margo B-rep kernel constructs and checks each solid in `generate.mjs`. The published browser switches among those exact feature results. Volume comes from the kernel's boundary integral. Mass is volume multiplied by 2,700 kg/m³. The viewport displays the separate tessellation, so changing the viewing angle leaves the measurements alone.

Regenerate with `MARGO_ENGINE_CHECKOUT` pointing to the gallery's pinned, built checkout, then run `node src/the-solid-modeller/generate.mjs` from the gallery. The generator checks that every feature removes volume and that the measured drill loss matches the analytic cylinder volume.

- [Aristides A. G. Requicha, Representations for Rigid Solids, 1980](https://doi.org/10.1145/356827.356833).
- [ISO 10303-42:2021, Geometric and topological representation](https://www.iso.org/standard/78579.html).
