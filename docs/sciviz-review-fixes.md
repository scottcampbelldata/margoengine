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

## H2: physical grid orientation

Grid bounds retain first and last sample coordinates in storage index order,
including descending FITS CDELT axes. Every sample coordinate is checked against
the axis-aligned uniform box, with a 32-ulp-scale allowance for floating point
transform arithmetic. Rotation, shear, axis permutation and nonlinear spacing
reject with code `unsupported` before a volume is allocated. Source `world()`
transforms remain usable independently; resample into physical axes before using
the grid/volume helpers for those transforms. Validation is linear in sample count
and uses constant extra storage beyond the existing Float32 copy.

scientific-image.test.js first reproduced reversed bounds and silent unsupported
transforms. It verifies negative x/y/z axes, unchanged data order, volume argument
propagation, and rejection before allocation. astronomy.test.js retains independent
WCS and triclinic coordinate checks and now checks explicit grid rejection for
those unsupported sources. astronomy-browser.mjs checks the directed volume model
and matching physical endpoints on WebGPU and WebGL2 compatibility.

Clean-room sources compared: Eric W. Greisen and Mark R. Calabretta,
*Representations of world coordinates in FITS* (2002),
https://arxiv.org/abs/astro-ph/0207407; Mark R. Calabretta and Eric W. Greisen,
*Representations of celestial coordinates in FITS* (2002),
https://arxiv.org/abs/astro-ph/0207413. The former defines the signed linear
transformation; the latter distinguishes the nonlinear celestial projection.

H2 optional-entry size: sciviz/mrc is 2,949 to 3,171 bytes minified gzip.
Its ceiling is 3,162 to 3,427 bytes, retaining the standard 256-byte headroom.
The additional validation prevents incorrect physical placement; splitting the shared
helper would add loading/API complexity and allow divergent bounds behaviour.
Core plus stage remains 24,209 bytes. Measured by equivalent parent-source and
current builds with the repository's bundleBytes/gzip method.

## L1: caller SSE Accept headers

eventSource now constructs one Headers object from the caller's request and adds
text/event-stream only when Accept is absent. This preserves case-insensitive
overrides, including an explicitly empty value, without mutating borrowed inputs
or combining the caller's value with a second default. stream-headers.test.js
first reproduced the combined header, then verifies record, tuple-list and
Headers inputs, the default, casing, empty values, other headers and parsed events.
No API or GPU code changed.

Clean-room sources compared: WHATWG editors, *Fetch Standard*, Headers and header
lists (living standard, 2026), https://fetch.spec.whatwg.org/#headers-class;
WHATWG editors, *HTML Standard*, Server-sent events (2026),
https://html.spec.whatwg.org/multipage/server-sent-events.html. Fetch defines
case-insensitive header lookup and combination; HTML defines the SSE media type.
