# The Sound Landscape

Exhibit 71 in the Margo Web Demos brief. Choose a sound and press **Play sound** to hear it and follow the lit time slice across its 3D spectrogram. The time control also moves the slice while playback is paused. **Overhead view** shows the same surface and logarithmic frequency axis from directly above.

## Signal and drawing

- **Bells**, **Sweep** and **Pulses** are original synthesized 6.24-second mono clips. Their sources are a score of damped bell modes, an exponential chirp with two harmonics, and deterministic filtered noise and damped tones. Each plays the exact 16 kHz PCM that is analyzed. The exhibit requires a deliberate user gesture to start sound.
- Margo Audio's offline `stft` analyzes 1,024-sample centered Hann windows at a 416-sample hop, with zero padding. Every other frame is displayed. The amplitude scale compensates for the window and single-sided transform. The logarithmic bands take the maximum where several FFT bins apply and interpolate where a band is narrower than a bin. The peak readout interpolates the local maximum in log magnitude. It represents the strongest measured frequency in that slice.
- Margo SciViz's surface uses the resulting 121 × 70 grid over 125 Hz to 5.2 kHz. It clips display levels to −62 through −11 dBFS, with the cabinet visible outside the above-floor regions. Margo renders the cabinet, inlaid ticks and moving slice in the same scene. The grid and materials are identical on phone and desktop.
- Margo Audio handles buffering, playback, seeking, pause and live waveform analysis. Browser verification checks that the voice is playing with a nonzero live waveform and that the 3D playhead advances before recording `landscape-play-applied`.

## References

- Allen, J. B., and L. R. Rabiner. 1977. [A Unified Approach to Short-Time Fourier Analysis and Synthesis](https://doi.org/10.1109/PROC.1977.10770). *Proceedings of the IEEE* 65(11), 1558–1564.
- Harris, Fredric J. 1978. [On the Use of Windows for Harmonic Analysis with the Discrete Fourier Transform](https://doi.org/10.1109/PROC.1978.10837). *Proceedings of the IEEE* 66(1), 51–83.
- W3C Audio Working Group. [Web Audio API 1.1](https://www.w3.org/TR/webaudio/). Browser transport and live signal analysis.
- [Margo Engine verified public pin 0efd9cff](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5). Uses the published Audio, Audio Spectrogram, SciViz Surface and Core interfaces.
