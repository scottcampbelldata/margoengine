# DICOM JPEG test files

Two unmodified files of the NEMA DICOM WG04 compressed sample set (`compsamples`, 2004,
ftp://medical.nema.org/MEDICAL/Dicom/DataSets/WG04/; the images hold no patient identifying information), taken from the
pydicom projects, which distribute them under the MIT licence (Copyright Dicom in Python and the pydicom authors). Each
is byte for byte the set's own file. Test-only, never shipped.

| File | In the set | Source | SHA-256 |
| --- | --- | --- | --- |
| `JPEG-LL.dcm` (118,986 B, lossless, 16 bits) | `NM1_JPLL` | https://github.com/pydicom/pydicom-data/raw/39a2eb31815eec435dc26c322c27aec5cfcbddb6/data/JPEG-LL.dcm | `c9d000c75d92b143ce1c0421471a7e9a69c8996d98b2589e533e311615a10079` |
| `JPEG-lossy.dcm` (9,844 B, lossy, 12 bits) | `NM1_JPLY` | https://raw.githubusercontent.com/pydicom/pydicom/5eecada40460/src/pydicom/data/test_files/JPEG-lossy.dcm | `c425608e2fcda8332c75d33f890bfe3bae32700608b719046b3d9e789374c292` |

The expected output of `JPEG-LL.dcm` is the SHA-256 of the pixel data of the set's uncompressed `NM1_UNC`.
