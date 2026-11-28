# The Print Shop

Choose one of three original Kite jig variants. A hotend (brass nozzle, silicone sock, heat break and cooling fins, built with the B-rep kernel and shipped as one small GLB) rests its tip on the last bead of the active layer. The finished solid and the printer bed show the same geometry. A full set of deposition lines builds beneath the active layer, while amber highlights its extrusion moves. Blue travel lines can be displayed separately. Each scrub follows the positions in the downloadable G-code. The 3MF is a millimetre-scale closed solid for a slicer. The G-code has the original scene’s paths and needs printer-specific preparation.

The public Margo B-rep kernel constructs and checks each exact part. The public 3MF and G-code exporters produce the files, and the public G-code loader derives the layer preview from the actual written commands. Production verifies all 30 layers for every variant, equality of exported and imported 3MF triangle counts, and parsed filament against the exporter’s amount. The slicer writes one perimeter and alternating line infill, with no support material or additional skin passes.

References: [3MF Consortium Core Specification](https://3mf.io/spec/) and [Marlin G0–G1 linear motion documentation](https://marlinfw.org/docs/gcode/G000-G001).
