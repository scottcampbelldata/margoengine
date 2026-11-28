# The Pixel Platformer

Numbered exhibit 151 is **Signal Coast**, an original one-level game. Guide the keeper across four tidal cuts, collect three prisms and light the cliff beacon. The flag saves progress through falls. Touch players can hold a direction with one finger and jump with another. On a keyboard, use the arrow keys and Space. Restart clears the prisms and checkpoint.

## Rendering

The environment, 24-tile basalt atlas, hand-authored keeper poses and lighthouse are original pixel art generated in `art.js`. Margo's PixelCamera and LayerCompositor keep a 320 × 180 art grid with five parallax backgrounds. TileMap draws the basalt. SpriteLayer writes the keeper's curved hood and fixture relief to a normal target generated from finite differences of relief data. The foreground layers and lights use the same snapped camera.

SoftLighting2D lights a moving keeper lamp, the wayposts, prisms and final moving beacon beam. The cliff and post edges block light. The **Lighting** chooser changes the actual emitter radius or disconnects the normal texture to make both effects inspectable. Signal Coast uses artistic light values and a thin 2D occluder model. The renderer runs the same shaders and art on native WebGPU and full Margo WebGL2 compatibility, which translates WGSL to GLSL. Add `?backend=webgl2` to force it.

## Physics

Margo Physics2D builds the five collision outlines from the same solid tile map used by the renderer. The keeper is a rotation-locked 11 × 18 pixel capsule in a 90 Hz gravity world. Ground ray queries permit brief jump buffering and ledge grace. Continuous collision and the round feet allow the keeper to walk off the mapped ledges. There are four feasible physical jumps in the intended route.

The packed assets are gzip copies of the stock SIMD and scalar Wasm from the [verified public engine pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5). The browser fetches the applicable copy and streams its lossless unpacking into the engine loader. Browsers without DecompressionStream use the engine's built-in Wasm loader.

- SIMD SHA-256 `d921119b281178f8b624dffabdb2a3fdbaf1810aa20bace5f53fa248987e1a33`
- Scalar SHA-256 `c8aaf4cffc5c847dac18e852501c6a6998a7e0fd58070a2535bc63295a808dd8`

## Verification

Set `MARGO_ENGINE_CHECKOUT` to the verified built checkout. Under the gallery root, `node qa-output/the-pixel-platformer/mechanics.mjs` checks the packed digests, collision outlines, jump, landing, ledge fall, prism retention and completion of the four jumps on the actual kernel.

`PIXEL_PLATFORMER_PRELOAD=1` and `PIXEL_PLATFORMER_SOLVE=1` enable the production-style local browser build and full playthrough checks in `qa-output/the-pixel-platformer/check.mjs`. The cold mobile check uses a fresh 390 × 844 Chrome context, DPR 2, 150 ms network delay, 1.6 Mbps down and 4× CPU throttling. The first-Jump mark requires a trusted input, more than 2.5 pixels of actual upward body motion, and a completed renderer submission. The same check exercises a sustained direction press and compares the actual full soft, hard-shadow and flat-normal outputs. Route proof includes native desktop keys and emulated multi-touch on mobile WebGL2. Mobile figures come from desktop Chrome emulation.

## References

- [Anacapa Island Fresnel lens, National Park Service](https://www.nps.gov/chis/learn/historyculture/fresnellens.htm) informed the original light tower and its lamp housing.
- [Fixed-step simulation, Erin Catto](https://box2d.org/documentation/md_simulation.html) documents fixed timesteps and collision-query conventions. Signal Coast executes Margo's own Physics2D kernel.
- [Percentage-Closer Soft Shadows, Randima Fernando, 2005](https://developer.download.nvidia.com/shaderlibrary/docs/shadow_PCSS.pdf) describes contact hardening from finite light emitters. Margo's own 2D lighting uses angular occluder rays over the source extent.
