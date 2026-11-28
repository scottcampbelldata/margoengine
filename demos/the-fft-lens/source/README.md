# The FFT Lens

The same Webb image is shown beside its reconstructed pixels. Move the split to compare them or drop frequency groups to reveal different scales. The spectrum is shifted so zero frequency is in the center. The contour shows the nominal cutoff for a smooth filter. The two band-pass contours bound its transition scales.

The source is the Southern Ring Nebula (NGC 3132), ESA/Webb release `weic2207b`, resampled to 256 × 256 for real-time comparison. Decode the optimized image to linear RGB and process all three channels with Margo Compute’s `fft2` and `ifft2` on the last two dimensions. A radial mask multiplies both real and imaginary components before inversion. Low pass uses half amplitude at its displayed cutoff. High pass takes its complementary response, while band pass subtracts two low-pass responses with cutoffs one half and twice the selected scale. High-pass and band-pass output is shown on a neutral-gray baseline for signed detail. The filter assumes periodic image edges.

Original credit **NASA, ESA, CSA, STScI, and the Webb ERO Production Team**. The photograph was cropped, resampled, and filtered for this exhibit. [ESA/Webb image](https://esawebb.org/images/weic2207b/) · [Image-use and credits](https://esawebb.org/copyright/) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Source JPEG SHA-256 `3b6356f483e3e90c6da9fae8f408e41ed9e0a00baa301a047e5fe55cb423ce80`. Reproduce the runtime image with FFmpeg and the original [large JPEG](https://cdn.esawebb.org/archives/images/large/weic2207b.jpg).

    ffmpeg -i weic2207b.jpg -vf crop=4501:4501,scale=256:256:flags=lanczos -frames:v 1 -c:v libwebp -quality 89 -compression_level 6 assets/ngc-3132.webp

## References

- James W. Cooley and John W. Tukey, [An Algorithm for the Machine Calculation of Complex Fourier Series](https://doi.org/10.1090/S0025-5718-1965-0178586-1), Mathematics of Computation, 1965.
- Rafael C. Gonzalez and Richard E. Woods, [Digital Image Processing, fourth edition](https://www.imageprocessingplace.com/DIP-4E/dip4e_main_page.htm), 2018, frequency-domain image filtering.
