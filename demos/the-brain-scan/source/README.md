# The Brain Scan

Move the axial, coronal and sagittal sliders to see three views of the same T1-weighted head MRI. **Cutaway** removes part of the volume, and the individual plane buttons square the camera to each slice. **CT bone** shows a surface extracted from the paired CT at the selected Hounsfield-unit threshold. The scale and orientation are shared by both scans.

## Scan provenance

Shun Yao, Yiheng Tan and Jiaming Wang, *A Paired Head CT-MRI Dataset for Cross-Modality Image Synthesis* (2025), version 1, [Zenodo DOI 10.5281/zenodo.17486320](https://doi.org/10.5281/zenodo.17486320). The dataset is distributed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This exhibit uses the two de-identified public scans at `cerebrovascular-disease/sub-18/CE-T1W.nii.gz` and `cerebrovascular-disease/sub-18/CT-BONE.nii.gz`. Registration and the facial mask come from the released pair.

Yiheng Tan, Jing Zhao, Jiaming Wang et al., *A Paired Head CT-MRI Dataset for Cross-Modality Image Synthesis*, Scientific Data (2026). [Dataset paper](https://doi.org/10.1038/s41597-026-08901-w).

## Display processing

The original scans share a 384 × 384 × 376 grid at 0.5 mm spacing. The exhibit reorders them to right, anterior and superior axes and resamples both over the same 191.5 × 191.5 × 187.5 mm extent. The browser opens a 49 × 49 × 48 MRI grid first, then loads the 129 × 129 × 126 grid without changing the slice coordinates. The MRI uses normalized relative intensity, a teal transfer function and an opacity curve for the volume. The CT uses a 97 × 97 × 95 grid, signed values in 4 HU increments and a default 460 HU contour. Defacing and thresholding change the outer contours. The CT surface is a thresholded reconstruction for visual exploration.

Margo draws three linked slices from the opening 3D scan texture while the larger grid and volume renderer load. Margo Sciviz draws the full MRI volume and slices and enables the cutaway once ready. Its marching cubes implementation extracts the bone surface on native WebGPU. Margo Sciviz computes the same threshold surface on the CPU for WebGL2 and displays it with the compatibility renderer. The in-page renderer caption identifies how extraction ran.

To reproduce the assets, put both original NIfTI files in one directory and run `python tools/prepare.py PATH_TO_PAIR assets` from this exhibit source directory with NumPy and SciPy installed. The tool validates the original grid and SHA-256 hashes. `assets/pair.json` records the original affine and the derived asset checksums.

The startup renderer uses trilinear sampling from a normalized volume texture. Its 3D texture bindings follow the [W3C WebGPU Shading Language specification](https://www.w3.org/TR/WGSL/). The detailed volume and CT code load in a separate module following [Jeremy Wagner and Philip Walton, Script evaluation and long tasks](https://web.dev/articles/script-evaluation-and-long-tasks).
