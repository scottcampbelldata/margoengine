# Sweep and Loft

The bottle blank joins seven circular profiles with a ruled B-rep loft. The duct uses two tangent-continuous sweeps of rectangular profiles. Subtracting the inner sweep produces a 4 mm wall through the straight runs and the 90° bend.

The Margo kernel validates both solids in generate.mjs. The duct has an independent volume check from its wall cross-section and path length. The exhibit switches accurately between the kernel's two results and reports exact volume and face counts. generate.mjs writes both solids as one GLB (glTF 2.0 with EXT_meshopt_compression and KHR_mesh_quantization) through `@margoengine/exporters`, and the page loads it with `@margoengine/gltf`. `@margoengine/studio/bench` opens the lit, shadowed studio; `@margoengine/machinery/bench` puts the solids on a granite surface plate with measured metal finishes (the bottle turned aluminium, the duct anodised) and draws their feature edges.

- [Aristides A. G. Requicha, Representations for Rigid Solids, 1980](https://doi.org/10.1145/356827.356833).
