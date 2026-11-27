# Night Storm Sky

Brief 76. The view looks across a fictional rocky inlet to an offshore strike. The headland, faceted sea, light station, practical lantern and scattered flash reflections are original scene geometry. No external imagery or models are used.

Press **Trigger a strike** to see one brief pulse. **Hold for inspection** keeps the illuminated frame visible until **Return to night** is pressed. Reduced-motion preferences select hold by default. The sequence is silent and never flashes automatically.

The live branching channel is Margo Sky’s `LightningBolt`. Margo `Weather` supplies the deterministic strike and channel positions. The two storm exposure layers are camera-matched renders of the real Margo night sky and volumetric hurricane storm field. On the exhibit page, both graphics paths project those same layers at sky depth and blend them with the strike pulse. The visible channel, sea lighting and specular marks update in the live 3D scene. This finite exposure pair avoids translating the complex volume shader during first load and preserves the cloud shapes and lighting on both paths.

This is a rendered illustration of lightning and a storm. It represents a fictional place, uses a stationary cloud field, and makes no prediction of lightning, atmospheric electrical discharge or storm evolution. The flash timing, colours and light levels are chosen for display. The sea response is a stylized specular cue.

## Reproduce the storm layers

Use the exhibit’s build with the pinned Margo packages. Open `?authoring=storm-field` to inspect the full live Margo volume alongside the same coastline and bolt. Use `?authoring=sky-plates` in a native WebGPU browser at a 1680 × 1080 viewport with device pixel ratio 1 and reduced motion enabled. This mode draws the original night and storm at a fixed 64-degree vertical field of view. It omits coastline geometry and the visible bolt but keeps the same channel source for the local cloud lighting.

Capture the image after the scene has `data-ready` and before the strike. Then call `document.querySelector('#strike').click()` in the browser console and capture after the `strike-frame` performance mark. Stack the dark image above the illuminated image in a 1680 × 2160 RGB atlas. Export it as `storm-plates.webp` at quality 93 with Pillow’s WebP `method=6` encoder. The page maps rays from the live fixed camera to that wider capture, preserving moon and cloud positions across aspect ratios. The scene data, shader settings, and projection are all in the source.

## References

- National Weather Service, [Lightning Science: Slow Motion Flashes](https://www.weather.gov/safety/lightning-science-slow-motion-flashes), [Stepped Leader](https://www.weather.gov/safety/lightning-science-initiation-stepped-leader), and [Return Stroke](https://www.weather.gov/safety/lightning-science-return-stroke). Observed channel branching, short flash and local illumination.
- National Park Service, [Point Reyes Lighthouse](https://www.nps.gov/places/point-reyes-lighthouse.htm). Reference for the layout of a rocky headland, lantern room and keepers’ building.
- Sébastien Hillaire, [Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf), SIGGRAPH 2016. Background reference for volumetric extinction and distinct skylight, shadow and scattering components.
- Andrew Schneider and Nathan Vos, [The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn), SIGGRAPH 2015. Background reference for procedural volumetric cloud composition and light.
- [Margo Sky package source](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/sky), exact pinned public build.
