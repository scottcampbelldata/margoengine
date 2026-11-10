# Sciviz review corrections, 2026-11-10

## H1: packed MRC rows

Mode 101 now addresses each row independently with ceil(NX/2) bytes and checks
the full padded payload before decoding. Padding nibbles never become samples,
including across section boundaries. astronomy.test.js first reproduced the
failure with widths 1, 3 and 5, then verifies decoded samples and truncated rows.
The existing packed test now uses even-width rows rather than an invalid odd-width
continuous payload. No API or GPU code changed.

Clean-room sources compared: IMOD maintainers, *The MRC file format used by IMOD*
(living specification, accessed 2026-11-10),
https://bio3d.colorado.edu/imod/doc/mrc_format.txt; Cheng et al., *MRC2014: Extensions
to the MRC format header for electron cryo-microscopy and tomography* (2015),
https://doi.org/10.1016/j.jsb.2015.04.002. The IMOD extension defines mode 101's
low-nibble-first ordering and row padding; MRC2014 supplies the base header.
