# Scene Transitions

Dune Station is a copper listening array above a sandstone valley. Glacier Relay crosses a frozen channel to a lit transmission spire beneath an aurora. The two original geometry sets have independent Margo scenes, cameras, and depth. Each composite frame re-renders both, including changes to dust, aurora and light while playing.

- **Wipe** uses the stock left-to-right live Margo wipe.
- **Noise dissolve** uses the stock live per-pixel PCG threshold. Pixel order stays stable as the slider moves.
- **Chromatic swipe** uses the public custom live transition. A moving diagonal edge separates the RGB reveal thresholds and offsets the red and blue samples near the edge. The effect reaches a clean source image at each end.

Scrubbing is reversible and holds the two scenes' shared clock while inspecting a blend. Play moves the clock and progress. Pause leaves the current frames in place. Playback is user-initiated. The emitters, air and sky are authored stylized lighting models.

`@margoengine/transitions/live` draws each scene into its own resolved RGBA8 view and composites the pair. Native WebGPU is preferred. The full Margo WebGL2 compatibility layer runs the same two worlds and all three effects. Append `?backend=webgl2` to select it. Phone and desktop fit their camera crop to the same artwork.

## References

- SMPTE. *Television — Transfer of Edit Decision Lists*, ST 258:2004. Wipe-pattern notation reference. [Standard](https://pub.smpte.org/latest/st258/st0258-2004_stable2011.pdf)
- Mark Jarzynski and Marc Olano. *Hash Functions for GPU Rendering*, 2020. Fixed position hash underlying the stock Margo dissolve. [Paper](https://jcgt.org/published/0009/03/02/)
- NASA Jet Propulsion Laboratory. *70m Antenna at Goldstone, California*, 2008. Reference for the shape and structural support of a desert listening array. [Image record](https://www.jpl.nasa.gov/images/pia10953-70m-antenna-at-goldstone-california/)
- NASA Earth Observatory. *IceBridge Blues*, 2017. Reference for fracture planes, dark blue ice and glacier silhouette. [Image record](https://science.nasa.gov/earth/earth-observatory/icebridge-blues-91396/)

All geometry and lighting are authored here. No reference imagery is shipped.
