# The Game Menu

*Lantern Descent* is a playable, original ocean survey built from the public Margo `ui-game` example. The title menu, instrument HUD, equipment slots, settings, confirmations, and records use Margo UI widgets drawn directly into the scene. The ship, tether, lava shelves and vent field are original procedural 3D geometry.

## Try the controls

1. Select **Launch dive**. Survey the shelf edge and **Record sample** to add a specimen to Equipment and spend 18% battery.
2. Open **Equipment**. Tap or press Enter on a power cell to pick it up, then choose an empty slot to move it. Activate the cell twice to consume it and restore up to 28% battery. Drag and drop also moves items. The notebook opens the dive log.
3. Continue through the basalt ridge and vent field. The rendered setting follows the station. Record all three samples, check **Dive log**, then select **Surface**.
4. Open **Settings** from the title or pause menu. High contrast, text size, reduced UI motion and Arabic are available on desktop and phone. Arabic changes text shaping, numerals, reading direction, slot layout, and the placement of panels.
5. Use arrow keys, Tab and Enter with a keyboard. On a standard gamepad, move with the D-pad or left stick, select with A, cancel with B and step through controls with the shoulder buttons. Escape and B close an active dialog before returning to a previous screen.

The canvas uses Margo's native HTML accessibility mirror, with real controls, value announcements and modal focus. The dive and battery numbers are game rules. The uncrewed submersible is a fictional design informed by scientific survey vehicles.

## Sources

- Scott Campbell and Margo Engine contributors. *ui-game*, *UI* and *Input*, public Margo revision `0efd9cff8230507a32deb49907ecd499d46925f5` (2026). [Upstream example](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/examples/ui-game.ts)
- Woods Hole Oceanographic Institution. *Human Occupied Vehicle Alvin*. Visual and operational design reference, accessed 2026-11-27. [Research submersible](https://www.whoi.edu/what-we-do/explore/underwater-vehicles/hov-alvin/)
- W3C. *Gamepad*. Standard Gamepad layout, accessed 2026-11-27. [Button and axis mapping](https://www.w3.org/TR/gamepad/)
- W3C WAI. *Dialog (Modal) Pattern*. Focus and modality, accessed 2026-11-27. [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- W3C Internationalization. *Structural markup and right-to-left text in HTML*. Accessed 2026-11-27. [Direction and language reference](https://www.w3.org/International/questions/qa-html-dir)

All artworks are original Margo geometry or interface graphics. There are no remote assets, sign-in requirements, or downloads.

## Browser verification

The gallery starts on WebGPU when an adapter is available. Otherwise it uses the official direct Margo WebGL2 renderer and its UI pass. Both routes use the same scene geometry, materials, fonts, screen controls, and accessible mirror. The browser test runs signed out, cold, with gallery startup preloads. It records the first trusted activation of **Launch dive** and the frame that presents its actual HUD. The 390 × 844 CSS handset profile uses 2× device pixels, 4× CPU slowdown and 150 ms / 1.6 Mb/s network emulation.

The interaction test completes the three stations in order, checks the exact battery and inventory state, and uses touch or pointer drag to move a power cell. It verifies keyboard operation, modal focus and recovery, current values in the accessibility tree, the language and RTL geometry of the Arabic controls, and a standard Gamepad API input sequence through Margo Input. Test input uses browser emulation. A physical phone, physical controller and a standalone screen reader app were outside this local browser check.

From the gallery folder, set `MARGO_ENGINE_CHECKOUT` to the verified build, then run the isolated QA.

```powershell
node "$env:MARGO_ENGINE_CHECKOUT/scripts/run-with-timeout.mjs" --max=3 -- node qa-output/the-game-menu/check.mjs
py qa-output/the-game-menu/render-review.py
```

The output includes `final.log`, `summary.json`, `pixels.txt`, individual screenshots, and `render-review.png`.
