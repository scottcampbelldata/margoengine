# The Marble Maze

Exhibit 147 of the numbered Margo Web Demos. The original maze has a maple playfield, lacquered rails, brass pinheads and a glazed teal base. Its geometry and marble inlay are generated locally. The public Margo Engine checkout is pinned to `0efd9cff8230507a32deb49907ecd499d46925f5`. The same model, lighting and materials render on phone and desktop. Margo uses WebGPU first and the direct Margo WebGL2 renderer when needed. Add `?backend=webgl2` to force the latter.

## Play

Drag the board in the direction you want the marble to roll. Drag farther for a steeper slope. You can hold the on-screen arrows or the keyboard arrow keys. Roll from the teal and brass diamond to the opening at the back right. Reset returns the sphere and board to their starting pose.

On a sensor-equipped phone, tap **Tilt with phone**, hold the device nearly face up, and then tip it. The initial reading establishes a comfortable neutral position. Reset also recalibrates the neutral. The absolute orientation path projects world-up onto both screen axes. Devices that supply only angular rates use the screen-relative pitch and yaw deltas from Margo's `Gyro`. Both share Margo's opt-in motion permission. Drag and arrow input remain available, including when permission is denied.

## Physical model

The 954 × 795 mm floor is split into four boxes around a 121 mm square opening. The same 30-cell graph creates the structural rails and their collider locations. A kinematic board follows a continuously damped tilt target up to 11°. Margo's 90 Hz Rust/Wasm rigid-body world rolls a free dynamic 66 mm sphere under gravity with collision detection, friction and angular inertia. The game completes when the center crosses the board plane into the opening. The sphere physically lands in a fixed retention tray.

Rail render geometry has a shallow bevel. The colliders use the nominal rectangular rail profile. Friction and damping are chosen for tabletop play. Visual contact and pedestal shadows are modeled marks in the Margo scene.

The first tap can enter a short buffer after the static board renders. The solver replays up to 300 ms once loaded, and the first-interaction mark waits for a downhill displacement over 3 mm with collider contact and a completed renderer submission.

## References

- [Device Orientation and Motion, W3C](https://www.w3.org/TR/orientation-event/) documents device axes, gravity projection inputs and motion permission.
- [DeviceOrientationEvent, Apple Developer](https://developer.apple.com/documentation/webkitjs/deviceorientationevent) documents WebKit orientation input.
- [University Physics Volume 1, 11.1 Rolling Motion, OpenStax](https://openstax.org/books/university-physics-volume-1/pages/11-1-rolling-motion) derives sphere rolling, static friction and rotational inertia.
- [Japanese Writing Boxes, The Metropolitan Museum of Art](https://www.metmuseum.org/ja/essays/japanese-writing-boxes) informed the lacquered wood, compact tray silhouette and metal inlay. The exhibit uses original designs and geometry.

## Verification

The ignored local QA directory is `qa-output/the-marble-maze/`. Run `mechanics.mjs` with `MARGO_ENGINE_CHECKOUT` set to the built pin. It checks all 30 cells, 29 passages, sphere mass, perimeter containment, a nine-leg solution, penetration through the opening and physical retention in the tray.

Run `check.mjs` with `MARBLE_MAZE_PRELOAD=1` and `MARBLE_MAZE_SOLVE=1` for the local build. The browser check uses a new 390 × 844 Chrome context, DPR 2, 150 ms network latency, 1.6 Mbps download and 4× CPU throttling. It sends a trusted arrow tap and verifies the completed first roll on native WebGPU, automatic WebGL2 and forced WebGL2. Desktop tests use trusted mouse drag and keyboard events. The optional full route sends mouse input to solve the actual puzzle. Browser sensor inputs are emulated. Handheld sensor feel and device-specific permission prompts require hardware review.
