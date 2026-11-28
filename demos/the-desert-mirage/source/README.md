# The Desert Mirage

Heat the air at the surface of a desert highway or cool it back to the 26 °C ambient temperature. The road view shows the light arriving at an eye 50 cm above the surface. The section traces three rays backward from that same eye. The amber ray is the one used for the live turning-height reading.

## Model

The temperature profile is `T(h) = T∞ + (Tₛ − T∞) exp(−h/d)`, with a decay length `d = 0.020 m`. Siebren van der Werf used a 20 °C temperature difference, this decay length, and a 50 cm viewing height in his ray-tracing study. He reports that road measurements supported this temperature difference and decay length. The exhibit’s 26–74 °C control includes that 20 °C reference difference. The higher temperatures are illustrative. The model uses dry air at 101.325 kPa and 550 nm. At fixed pressure, refractivity is proportional to density, so `n(h) = 1 + (n₁₅ − 1) × 288.15 K / T(h)`, where Ciddor’s dry-air dispersion gives the standard index `n₁₅`.

Ray elevation `θ` is measured from the horizontal. The index is constant in each horizontal plane, so `n(h) cos(θ)` is invariant. With slope `s = dh/dx`, the integrator advances `h′ = s` and `s′ = (1 + s²) n′(h) / n(h)` by fourth-order Runge–Kutta, with `heatedAirLayer` and `traceGradedRay` from `@margoengine/optics/refraction`. The integrator takes shorter steps near the surface, within a 640 m range. The invariant gives the outgoing direction in ambient air and the height where a ray turns. A ground-striking ray samples its point of impact. A turning ray samples the same angular sky and far ridgeline as the direct image, which produces an inverted image. Rays still descending at the range bound sample distant dust.

The road view uses a telephoto angular crop with vertical magnification. The 640 m × 1 m section uses separate distance and height scales. The idealized atmosphere assumes level asphalt, still air, uniform composition and constant pressure. The rendering uses a straight sightline approximation for the two nearby survey posts and the shoulder banks. At 26 °C, the −0.32° ray hits level asphalt at 89.52 m. At 62 °C, it turns 1.33 cm above the surface at about 92.33 m. The critical grazing angle at that temperature is 0.434°.

WebGPU is tried first. The WebGL2 compatibility path uses the same rendering and ray model. Add `?backend=webgl2` to select it directly.

## Reference record

- Siebren Y. van der Werf, **Fragmented road mirages** (2011). Road experiment, photographs and a measured-scale near-surface temperature profile. [Author’s paper](https://siebrenvanderwerf.nl/docs/2011_AsphaltMirage_AO.pdf)
- Philip E. Ciddor, **Refractive index of air: new equations for the visible and near infrared** (1996). Standard dry-air phase refractivity and density scaling. [Applied Optics](https://doi.org/10.1364/AO.35.001566)
- Andrew T. Young, **Inferior mirages: an improved model** (2015). Quantitative treatment of the surface layer and the optical effects of surface roughness. [Applied Optics](https://doi.org/10.1364/AO.54.00B170)

Margo Engine renders all artwork. The landscape shader, meshes and materials are original code. The paper photographs informed the optical behavior and are recorded above.
