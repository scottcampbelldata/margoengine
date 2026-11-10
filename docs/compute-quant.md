# Signed int8 inference

Batch 274 job 6 adds the optional `@margoengine/compute/quant` entry. Importing the
compute root does not load it. Core and stage are unchanged.

`quantize(context, values, shape, parameters)` rounds finite real values to signed
bytes. `quantizedTensor(context, Int8Array, shape, parameters)` uploads existing
quantized data. Both copy input data and parameters. The returned `QuantizedTensor`
owns packed u32 storage, four signed bytes per word, and supports `dispose` and
`Symbol.dispose`. `read({ signal })` returns an Int8Array and
`dequantize({ signal })` returns a Float32Array. The real representation is
`scale * (byte - zeroPoint)`. Scales are canonicalized to positive finite f32;
zero points default to zero. Vector parameters require an axis and one entry per
coordinate; negative axes are accepted. Quantization uses nearest-even rounding
before adding the zero point, followed by saturation to [-128,127].

`quantizedMatmul(a, b, { output, bias?, signal? })` follows NumPy vector promotion
and leading-dimension broadcasting. Activation quantization may be per tensor or
per output row; weights may be per tensor or per output column. Channel parameters
are shared across batches. `quantizedConv2d(input, weights, options)` uses NCHW
activations and OIHW weights, per-tensor activations and per-output-channel weights.
It supports groups and depthwise multipliers, stride, dilation, symmetric padding,
explicit [top,left,bottom,right] padding and valid/same/same-lower padding. Default
stride and dilation are 1, groups is 1 and padding is 0. Same puts an odd extra pad
at the end; same-lower puts it at the start. Padding contributes real zero, not a
literal byte zero. Both operations return promises and packed output tensors that
can feed the next operation without GPU readback.

Output quantization is required and per tensor. Bias defaults to none and is an
Int32Array with one element per output channel, zero point zero and scale equal to
input scale times weight scale. Options are snapshotted before asynchronous CPU
reads. Signals cancel pending reads and pre-submission work; submitted GPU commands
run to completion. Tensors must share a live context.

CPU contractions run in TypeScript with exact integer sums within the checked
int32 range. WebGPU contractions unpack signed bytes, multiply and accumulate as
i32, then rescale once in f32 and pack the output. One invocation owns each output
word, so tail bytes and adjacent outputs do not race. The existing WebGL2 compute
layer executes the same WGSL. There is no floating-point contraction fallback,
expanded integer tensor or host float mirror. Dispatch uses a two-dimensional
grid. Int32 overflow is rejected conservatively before execution using reduction
length, zero-point-dependent maximum operand magnitudes and maximum absolute bias.

## Numerical contract and evidence

Let sx, sw and sy be the canonical scales and u = 2^-24. For each output let R be
the float64 dot product of the reconstructed quantized inputs, including bias,
and S be the sum of absolute real product terms plus absolute bias. Against the
continuous output-range-clamped R, the tested absolute error bound is
`sy/2 + 8*u*(S + abs(R) + sy*abs(outputZeroPoint))`. The bound includes final f32
readback and rescaling, and assumes finite normal intermediates and reconstructed
outputs. Quantization is lossy; exact integer MACs do not imply exact float-model
results. Saturation uses the same output interval on the reference.

For unclipped original inputs x and w, add
`sum(abs(x)*sw/2 + abs(w)*sx/2 + sx*sw/4)` to bound error against the original
float model. The tests independently contract in float64, assert both bounds,
and assert exact bytes for small dyadic scales. No universal model accuracy or
latency claim is made. Underflow/overflow in the f32 rescale multiplier is rejected;
applications must choose scales whose reconstructed Float32 outputs fit that type.

`packages/compute/tests/quant.test.js` covers the TS path, validation, overflow,
cancellation, ownership and immutable uploads. `quant-browser.mjs` runs the same
1,574 checks on real WebGPU and the forced WebGL2 layer, including signed bytes,
odd packing tails, nearest-even ties, nonzero zero points, output saturation,
broadcast batches, vectors, per-channel weights, grouped/depthwise convolution,
asymmetric/dilated padding, empty outputs, packed chaining and sums beyond 2^24.
The browser guard reports zero WGSL compilation errors. These are correctness
checks, with no speed assertion. A new Wasm implementation is not claimed: no
deterministic gain over the TS contractions has been established.

The job matches the signed int8 matmul/convolution row against the published ONNX
linear-quantization contract on supported layouts. This entry does not claim an
ONNX importer, uint8, training, arbitrary-rank spatial convolution or fixed-point
integer-only requantization. ONNX import is a separate entry owned by job 5.
