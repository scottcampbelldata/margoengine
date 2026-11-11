// Small Wasm modules for the load tests: valid binaries that are not Rapier's build.

const bytes = (...parts) => Uint8Array.from(parts.flat());
const name = (text) => [text.length, ...new TextEncoder().encode(text)];
const section = (id, ...content) => [id, content.flat().length, ...content.flat()];

/** The 8 byte empty module: valid Wasm, no exports at all. */
export const emptyWasm = bytes([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/**
 * A module that exports a memory and functions under the names Rapier's glue calls first (`version`,
 * `__wbindgen_add_to_stack_pointer`), so only calling into it shows it is not Rapier.
 */
export const lookAlikeWasm = bytes(
  [...emptyWasm],
  section(0x01, [2], [0x60, 1, 0x7f, 0], [0x60, 1, 0x7f, 1, 0x7f]), // types: (i32) -> (), (i32) -> i32
  section(0x03, [2, 0, 1]), // two functions
  section(0x05, [1, 0x00, 1]), // one memory of one page
  section(
    0x07,
    [3],
    [...name('memory'), 0x02, 0],
    [...name('version'), 0x00, 0],
    [...name('__wbindgen_add_to_stack_pointer'), 0x00, 1],
  ),
  section(0x0a, [2], [2, 0, 0x0b], [5, 0, 0x41, 0x80, 0x08, 0x0b]), // version() does nothing; the pointer is 1024
);
