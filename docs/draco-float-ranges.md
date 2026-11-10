# Draco float quantization range safety

The clean-room encoder computes float32 attribute transforms in its optional Rust/Wasm kernel. A nonzero
range near 1e-36 with 14 bits previously overflowed the inverse and saturated quantized integers, changing
1e-36 to roughly 1.31e-31. Opposite values near 3e38 overflowed the stored range and produced an invalid stream.

The transform builder now refuses non-finite range, inverse or inverse-times-range, and a zero reconstruction
step. This covers computed ranges and explicit grids, for every quantized float attribute except octahedral
normals, which use their own transform. Wasm status 2 becomes MargoError `unsupported`, naming the unrepresentable
attribute range, recommending quantization bits 0 or rescaling, and linking error help. No stream is returned.
Other encoder failures retain their existing status. Raw float attributes (bits 0) keep their exact values.

`packages/exporters/tests/draco-native.test.js` reproduces both ranges through the public bulk Wasm ABI at
sequential and topology-selected speeds, requires the coded refusal and checks no output survives. Existing
clean-room and standard decoder comparisons retain the representable transform and raw-float round trips.
The rebuilt Wasm remains lazy, within the optional exporters entry. No core/stage work
or bytes are added and no speed result is claimed.

Clean-room research compared Frank Galligan (Google), *Draco Bitstream Specification*, version 2.2, 2017,
https://google.github.io/draco/spec/ (float32 transform fields and quantization reconstruction), with
David Goldberg, *What Every Computer Scientist Should Know About Floating-Point Arithmetic*, ACM Computing
Surveys, 1991, https://docs.oracle.com/cd/E19957-01/806-3568/ncg_goldberg.html (overflow and gradual underflow).
The format requires a representable float32 transform; refusing it preserves both decoder interoperability
and the requested quantization contract. No external encoder source or companion code was read or copied.
