# The Boolean Bench

Union keeps both solids, subtraction removes the second from the first, and intersection keeps the volume they share. Switch to exact edges to see the same boundary-representation topology without internal tessellation edges.

Margo builds the two operands and validates all three Boolean results in generate.mjs. Each operand and all three results are closed solids. The generator independently checks both Boolean volume identities. The web exhibit switches among exact kernel results and draws either their certified tessellation or their original geometric edge segments.

- [Aristides A. G. Requicha, Representations for Rigid Solids, 1980](https://doi.org/10.1145/356827.356833).

generate.mjs writes the solids as one GLB (glTF 2.0 with EXT_meshopt_compression and KHR_mesh_quantization) through `@margoengine/exporters`; the page loads it with `@margoengine/gltf`, opens the studio with `@margoengine/studio/bench` and shows each step on a granite surface plate with `@margoengine/machinery/bench` (measured metal finishes and feature edges).
