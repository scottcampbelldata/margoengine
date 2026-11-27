# The Glass Bench

A 60-second Margo Engine film of an original optical test station. The rotary cell, micrometer, calibration grid, hardware, finish maps and studio lighting are built into the scene. The soundtrack is synthesized for the cut.

| Time | Shot |
| --- | --- |
| 0:00 | The inspection strip crosses the brass bevel and index marks |
| 0:07.5 | Wide view of the bench, carrier, lamp and target |
| 0:15.5 | Focus pulls through the glass to the etched ceramic target |
| 0:26.25 | The micrometer knob drives the reticle carriage |
| 0:34.5 | The focused light lands on the calibration grid |
| 0:45 | Three-quarter view of the glass and finished hardware |
| 0:52.5 | The bench and closing title |

The element is a 50 mm biconvex lens, 10 mm thick at the center, with spherical surface radii of 101.63 mm. Scene units are metres. The dimensions follow the [Edmund Optics technical specification](https://www.edmundoptics.com/p/50mm-dia-x-100mm-fl-uncoated-double-convex-lens/2747/). The glass uses the d-line index of 1.51680 and Abbe number of 64.17 from the [SCHOTT N-BK7 data sheet](https://media.schott.com/api/public/content/41e799d0bf874807a0bb8e702fbb75b5?v=54856406).

Margo Materials renders screen-space transmission and dispersion from the opaque scene. The Studio caustics pass traces photons through both physical surfaces of the tessellated lens and deposits light on the receiver. It uses one refractive index for the projected spot. Margo DOF uses scene depth to animate the focal plane. The whole scene renders on WebGPU. The optical setup is illustrative and the etched grid is a visual target.

## Preview and render

From this worktree, build the packages and run the examples server. Open `/examples/glass-bench/` at the printed local address. The controls seek through the camera timeline.

```sh
npm run build:packages
npm run dev:examples
```

With FFmpeg available, capture and export the 1080p cut at 24 fps with 180° shutter sampling.

```sh
node scripts/run-with-timeout.mjs --max=32 -- node tools/shot/cli.mjs examples/glass-bench/shot.json --once --out test-results/glass-bench-master
node scripts/run-with-timeout.mjs --max=8 -- node tools/shot/encode.mjs test-results/glass-bench-master --out test-results/glass-bench-picture.mp4
node examples/glass-bench/sound.mjs test-results/glass-bench.wav
ffmpeg -i test-results/glass-bench-picture.mp4 -i test-results/glass-bench.wav -map 0:v:0 -map 1:a:0 -c:v copy -af 'loudnorm=I=-14:TP=-1.4:LRA=9' -ar 48000 -c:a aac -b:a 384k -movflags +faststart test-results/the-glass-bench.mp4
```

The separate `captions.srt` file describes the audible cues.
