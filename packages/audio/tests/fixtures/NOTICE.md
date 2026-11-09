# Ambisonic test audio

`rain-foa.wav` is derived from **RainSceneO7.wav**, Stefan Riedel,
*Ambisonic Stimuli Files and Binaural Renders* (2023),
[Zenodo DOI 10.5281/zenodo.10227483](https://doi.org/10.5281/zenodo.10227483).
The publisher's metadata specifies [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Credit Stefan Riedel and link that licence when redistributing this excerpt.
No endorsement is implied.

Changes: retain the first second and first four ACN channels of the 64-channel,
44,100 Hz, 24-bit PCM original. Sample bytes are unchanged; a standard four-channel
PCM WAV header replaces the original header. Higher-order channels and metadata are
omitted. No amplitude normalization. `rain-foa.json` pins original and excerpt hashes,
download URL, format and changes. This is an externally authored Ambisonic rain
stimulus, not a Margo-generated fixture or proof of a microphone/recording chain.
Its four retained channels are interpreted as first-order ACN/SN3D.

The test uses browser decoding/resampling and compares the stereo output to a
float64 matrix over those decoded samples. Generated independent-channel tones
separately test exact routing, looping and rotations. Neither test measures
perceptual quality, real XR headset tracking or binaural localization.
