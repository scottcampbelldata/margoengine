# The Murmuration

A dusk salt marsh hosts 16,384 live instanced starlings. Drag or touch the flock to place a short-lived disturbance in its flight plane. **Send a disturbance** does the same from the keyboard. Pause holds the rendered formation, and Reset restores the same two seeded ribbons.

Each bird moves under local separation, alignment and cohesion, plus soft bounds and two gently changing attractors. The disturbance is a repulsive region in this same solve, so the birds locally turn away and the grouping responds. This is a Reynolds-style model with a maximum of 16 neighbors in the spatial hash, while field observations describe approximately topological neighborhoods in real starlings.

## Rendering

The starlings use an original pointed-wing mesh with separate deformation weights on their wings. Margo banks, orients and flaps each bird over the original marsh geometry. The sky is a 1536 × 1536 still of the original Margo Preetham dusk with its sun and cloud layer. Both renderers sample that 28,898-byte texture through the actual scene camera, at the far plane of the Margo frame graph. This keeps the full clouded view visible from the first frame. The sky stays fixed while the starlings move and respond live.

WebGPU runs Margo’s eight-pass compute flocking solver. WebGL2 runs the corresponding published Margo CPU solver in a worker and transfers each solved state back to the same full-count bird draw. The worker warms the actual simulation once and restores its seeded scene before accepting user input. Both render the same marsh and the same 16,384 birds. The compatibility path updates less frequently.

`sky-look.js` records the bake recipe. To regenerate the backdrop from the verified checkout, run `node qa-output/the-murmuration/bake-sky.mjs` from the gallery root with `MARGO_ENGINE_CHECKOUT` set to the public Margo revision `0efd9cff8230507a32deb49907ecd499d46925f5`. Browser QA captures the actual corresponding phone and desktop scenes in both renderer modes.

## Browser verification

The regression checks a trusted touch or click and confirms that the rendered simulation step includes the actual disturbance. It also checks that all 16,384 birds have finite positions, pause holds the simulation, reset brings it back to zero integration steps, and the accessible disturbance button restarts it. Cold phone emulation used 150 ms latency, 1.6 Mbps download and fourfold CPU slowdown in Chrome.

| Renderer | First visible disturbance | Frame interval p95 | Worst measured interval |
| --- | ---: | ---: | ---: |
| Phone, WebGPU | 1.527 s | 18 ms | 24 ms |
| Phone, forced WebGL2 | 2.223 s | 33 ms | 48 ms |
| Phone, automatic WebGL2 | 2.307 s | 35 ms | 49 ms |
| Desktop, WebGPU | 0.477 s | 17 ms | 18 ms |
| Desktop, forced WebGL2 | 0.396 s | 28 ms | 52 ms |

Each profile used a fresh network context. The first forced WebGL2 case ran first in the browser. The 1.65 s one-time frame interval from starting the full cloud shader in the earlier phone build was absent in all five runs. The mean RGB difference between the original live-sky screenshot and the new one in the sky-only phone reference crop was less than 1.1 of 255 per channel. QA captures and JSON reports are in `qa-output/the-murmuration`.

## Sources

- Craig W. Reynolds, *Flocks, Herds and Schools: A Distributed Behavioral Model* (SIGGRAPH, 1987). [Original paper](https://www.cs.toronto.edu/~dt/siggraph97-course/cwr87/)
- Michele Ballerini et al., *Interaction ruling animal collective behavior depends on topological rather than metric distance* (PNAS, 2008). [Field study](https://doi.org/10.1073/pnas.0711437105)
- Michele Ballerini et al., *An empirical study of large, naturally occurring starling flocks* (Animal Behaviour, 2008). [Flock size, density and spatial structure](https://arxiv.org/abs/0802.1667)
- Scott Campbell, *Margo Engine* (2026). [GPU flocking and its CPU twin at the verified public revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/vfx)
