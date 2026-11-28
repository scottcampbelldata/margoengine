# Cutscene Studio

Entry 173 in Scott Campbell’s Margo showcase brief. **Bring the Light Around** is an original short scene at a fictional lighthouse, with a brass dioptric lens, keeper dialogue and the departing beacon. Play the cut, jump to a shot, edit the two cut points, or scrub the sequence frame by frame. The cut list, speech shapes, subtitles, lighting and export use the same time state.

The picture uses Margo Cutscene tracks and a Margo Physical Lens for the three shot fields of view. The lighthouse and every video frame are rendered by Margo. The mouth follows the real audio through Margo's speech analysis and viseme track. Margo Text reads the timed captions. Render video evaluates the edited film at 24 frames per second, burns in the captions and uses the Margo video encoder to download a 960 × 540 WebM file. The mixed audio is included when Sound is enabled.

The keeper is an original fitted character built from CC0 MakeHuman/MPFB assets. The scene, surface modeling, film direction and sound bed are original. The dialogue is generated offline using the Apache-licensed Kokoro voice model and ships as a small audio file. The portrait pack contains material-assigned geometry and facial deltas. Native WebGPU and direct Margo WebGL2 use the same film files and renderable geometry.

- [National Park Service Fresnel lens description and reference](https://www.nps.gov/articles/fresnel-lens.htm)
- [U.S. Coast Guard Cape Hatteras historical lighting record](https://www.history.uscg.mil/Browse-by-Topic/Assets/Land/Lighthouses-Light-Stations/Article/1944529/cape-hatteras-lighthouse/)
- [MakeHuman asset licensing](https://static.makehumancommunity.org/about/license.html)
- [Kokoro-82M model card and licensing](https://huggingface.co/hexgrad/Kokoro-82M)

`tools/author-keeper.py` exports the fitted portrait with MPFB and Blender. `tools/pack-keeper.py` bakes the GLB geometry and color layers using NumPy and Pillow. Use Kokoro ONNX 0.6.1 with the v1.0 INT8 weights, matching voice bank and SoundFile to run `tools/author-voice.py`. `tools/analyse-voice.mjs` samples the resulting mono WAV and its caption timing using public Margo main at `0efd9cff8230507a32deb49907ecd499d46925f5`; encode the same wave as mono Opus at 32 kbit/s.
