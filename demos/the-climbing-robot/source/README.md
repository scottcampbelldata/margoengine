# The Climbing Robot

Choose a route and press **Climb**. The Light Keeper places each hand or foot while the other contacts support it. Pause holds the current reach. Reset restores the start of the selected route.

The wall follows the profile and holds from Margo’s published Boulder reference. The wall panels, fixtures, mat, colors, framing and Voronoi-cut hold geometry in this exhibit are original. The robot is Scott Campbell’s Boulder asset, licensed Apache-2.0. Both display stages use the same 18,110-vertex packed model, including its six materials. The standard full renderer retains the authored Float32 animation curves.

## Solvers and measurements

The exhibit uses the public Boulder controller at Margo commit **0efd9cff8230507a32deb49907ecd499d46925f5**. Five scene parts define the overhang and extra volumes. The controller chooses a reachable pelvis position and uses Animator CCD and the kinematics constraint solver to select an arm bend. It builds convex link hulls from the skinned model and checks the arm links against the wall, volumes, torso and head. The clearance readout is the smallest sampled gap between those hulls. The model demonstrates kinematics with authored grip contacts.

The opening streams 161 measured poses per route at 20 Hz. These samples use the same fixed-step Boulder controller and convex-hull checks as the live stage. The same robot mesh and captured wall geometry render immediately through native WebGPU or Margo’s small WebGL2 renderer. The original model bytes transfer to the live worker. The worker catches up to the opening’s selected route, tick and camera before presenting its first frame. Its full glTF renderer, collision solver and animation system continue the route. A browser without OffscreenCanvas initializes the full stage on the page thread after the opening.

## Browser verification

The red traverse reached all 28 holds on native WebGPU, automatic WebGL2 and forced WebGL2. The smallest sampled red-route gap on those three profiles was 11.2 mm. Desktop also verified all 20 Blue contacts and all 16 Green contacts. Pause held a stable pose, resume continued the course, and route selection and reset restored the start.

| Browser profile | First rendered reach | First full live frame |
| --- | ---: | ---: |
| 390 px phone, native WebGPU | 1.708 s | 3.216 s |
| 390 px phone, automatic WebGL2 | 1.751 s | 4.765 s |
| 390 px phone, forced WebGL2 | 1.778 s | 5.053 s |
| 1440 px desktop, native WebGPU | 0.340 s | 0.881 s |

Phone checks used cold Chrome emulation with 150 ms latency, 1.6 Mbps downstream and fourfold CPU slowdown. These first reaches rendered while the full stage streamed. If a browser refuses the full graphics tier, the authored eight-second opening remains available with a visible notice.

## Rebuild and provenance

The gallery build resolves **margo-boulder/climb**, **margo-boulder/climber** and **margo-boulder/wall** to the corresponding TypeScript examples from the verified checkout in the page and worker build. The original **light-keeper.mesh** is the gzip-compressed GLB with SHA-256 **7f50bc99cd655cd2d2647015bb687a9815adfac70fcc1244ce46c0a560d4f85e**.

To regenerate the model from the original GLB, use **gltfpack -i boulder-robot.glb -o reduced.glb -cc -kn -km -vpf -si 0.45** and restore its authored Float32 animation with the showcase’s **the-stepping-stones/pack-animation.mjs** before applying level-9 gzip. Run **node pack-opening.mjs <capture-directory>** to regenerate the three pose packs and wall snapshot. The capture directory contains the three route JSON files with pinned-solver camera, skin matrices, hull gaps, and contacts per frame, and the original test cell’s geometry, materials and instance transforms. The local release QA directory holds the capture script and its source data.

- Scott Campbell, *Boulder robot*, 2026. [Asset licence](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/examples/assets/boulder-robot-LICENSE.md)
- Scott Campbell, *Boulder*, 2026. [Published solver and source data](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/examples/boulder)
- Timothy Bretl, *Motion Planning of Multi-Limbed Robots*, 2006. [Contact changes in robotic climbing](https://robotics.stanford.edu/~latombe/papers/ijrr-bretl-06/paper.pdf)
- Khronos Group, glTF 2.0. [Meshopt buffer views](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md)
- WHATWG, HTML Living Standard. [Worker canvas rendering](https://html.spec.whatwg.org/multipage/canvas.html#the-offscreencanvas-interface)
