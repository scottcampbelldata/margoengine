# LZ4 reference payloads

All files were produced with python-lz4 4.4.5 (prebuilt native tool only, no
implementation source read or included) from the existing Avocado.bin fixture,
repeated 40 times to cross the 64 KiB history boundary. Avocado is by Microsoft,
CC0 1.0, from Khronos glTF-Sample-Assets. Its original source and licence are
recorded in the parent fixtures/NOTICE.md. There is no new artwork or demo.

The manifest records the frame variants: block size IDs 4 through 7, compression
levels 0, 9 and 16, independent/linked blocks and present/absent content sizes.
All frames enable block and content checksums. raw.lz4 has no frame or stored-size
prefix. dict.lz4 encodes the first 30,000 decoded bytes with the last 65,536 bytes
of the repeated input as its external dictionary. Tests reconstruct both from
the existing CC0 file and compare every byte. No runtime codec dependency ships.

Additional native files cover empty data, frames without checksums, and stored
blocks. Stored bytes are the first 200,003 bytes of the concatenation of SHA-256
digests of UTF-8 "margo LZ4 stored " followed by each decimal integer from 0 up.
dictionary-frame.lz4 frames the native dictionary block with dictionary ID 203;
its descriptor, compressed-block and output checksums were independently produced
with the xxhash 4.1.0 native wheel. All framing is from the public specification.
