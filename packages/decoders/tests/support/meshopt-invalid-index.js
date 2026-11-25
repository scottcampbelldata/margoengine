// Shared by meshopt.test.js and meshopt-simd.test.js.
/** Index streams that KHR_meshopt_compression Appendix A makes invalid, each with what the decoder must say. */
export const invalidIndexStreams = [
  // The edge FIFO is empty before the first triangle.
  ['TRIANGLES', 3, [0xe1, 0x00, ...new Uint8Array(16)], /edge FIFO entry that was never written/],
  // Three vertices are in the vertex FIFO; 0x03 reads the fourth.
  ['TRIANGLES', 6, [0xe1, 0xfe, 0x03, 0x00, ...new Uint8Array(16)], /vertex FIFO entry that was never written/],
  // codeaux 0x40 asks for vertex FIFO slot 3 when only `a` has been pushed.
  ['TRIANGLES', 3, [0xe1, 0xf0, 0x40, ...new Uint8Array(15)], /vertex FIFO entry that was never written/],
  // A codeaux nibble of 0xf, and a non-zero byte in the last two codeaux places.
  ['TRIANGLES', 3, [0xe1, 0xfe, 0x00, 0x0f, ...new Uint8Array(15)], /invalid codeaux table/],
  ['TRIANGLES', 3, [0xe1, 0xfe, 0x00, 0xf0, ...new Uint8Array(15)], /invalid codeaux table/],
  ['TRIANGLES', 3, [0xe1, 0xfe, 0x00, ...new Uint8Array(15), 0x01], /invalid codeaux table/],
  // A varint of six bytes: the fifth still has its high bit set.
  [
    'TRIANGLES',
    3,
    [0xe1, 0xff, 0x00, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00, ...new Uint8Array(16)],
    /longer than 5 bytes/,
  ],
  ['INDICES', 1, [0xd1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00, 0, 0, 0, 0], /longer than 5 bytes/],
];
