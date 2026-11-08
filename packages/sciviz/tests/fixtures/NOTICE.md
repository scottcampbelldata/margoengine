# Test files of `@margoengine/sciviz`

None of these files is in the npm tarball. Each is byte for byte as downloaded on 2026-11-07.

| File | Source | Licence | sha256 |
| --- | --- | --- | --- |
| `CT_small.dcm` | pydicom test data, https://github.com/pydicom/pydicom/tree/5eecada40460/src/pydicom/data/test_files (explicit VR little endian CT slice) | pydicom's test files, distributed with the MIT-licensed project; its test_files/README.txt states no restriction on their use | `3dd31e5cc835b3f2cdd46c9da1982f59251e78518fefa8163d914631c66437d6` |
| `MR_small.dcm` | same folder (explicit VR little endian MR slice) | same | `3f27d1c22f1a66e80d7bb7c911e8610fd0bb70325a76746a7adb1c0ddefcf2bb` |
| `MR_small_implicit.dcm` | same folder (the same MR image, implicit VR little endian) | same | `6077442c42a56fc7fcc7db8411a657dded9fc109e6d3275765c4de358292b299` |
| `MR_small_bigendian.dcm` | same folder (the same MR image, explicit VR big endian) | same | `3e4c8c9fe70de4f3be149bbd673fa56f211c8e8e2ff9bac63f70f9dc31b5d108` |
| `MR_small_RLE.dcm` | same folder (the same MR image, RLE lossless; read only to check the refusal) | same | `2e5cb60878dc0acc494298ccdad28fce2cf14c51096e5d8cedab40248ea02e6c` |
| `zstat1.nii.gz` | NIfTI-1 sample data of the NIfTI Data Format Working Group, https://nifti.nimh.nih.gov/nifti-1/data/zstat1.nii.gz (an FSL z-statistic map, big endian, 64 x 64 x 21) | United States government work (NIMH), public domain | `518447c30014d0ff3cd6b7a21907871ea3f7f28a736aa7918f7006a8f3d72441` |
