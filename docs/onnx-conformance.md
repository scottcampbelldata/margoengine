# ONNX conformance reviews (`@margoengine/compute/onnx`)

What the loader accepts, checked against the public ONNX specification (ONNX 1.24.0 documentation,
https://onnx.ai/onnx/ , and the field comments of
https://raw.githubusercontent.com/onnx/onnx/main/onnx/onnx.proto , read 2026-11-27). The proof is hand-worked tests
in `packages/compute/tests/onnx-quant.test.js` and the Rust unit tests in `packages/compute/onnx-kernel/src`. No other
runtime's output stands behind these rows.

## Element types (reviewed 2026-11-27)

"Moves" means the operators that copy elements without reading them: Compress, Concat, Constant, DepthToSpace, Expand,
Flatten, Gather, GatherElements, GatherND, Identity, Reshape, ReverseSequence, Scatter, ScatterElements, ScatterND
(without a reduction), Shape, Size, Slice, SpaceToDepth, Split, Squeeze, Tile, Transpose, Unsqueeze, Where and the
sequence operators.

| Value | TensorProto type | Storage | Accepted by |
| --- | --- | --- | --- |
| 1, 10, 11, 16 | float32, float16, float64, bfloat16 | IEEE bits | every operator that lists them |
| 2-7, 12, 13 | 8 to 64-bit integers | two's complement | every operator that lists them |
| 8, 9 | string, bool | length-delimited bytes, 0 or 1 | string, logic and moving operators |
| 14, 15 | complex64, complex128 | real then imaginary, interleaved | Moves only; Cast rejects them, as ONNX defines no complex conversion |
| 17-20 | float8e4m3fn, float8e4m3fnuz, float8e5m2, float8e5m2fnuz | one bit pattern a byte | Moves, Pad, ConstantOfShape, Trilu, CenterCropPad, Cast, CastLike, QuantizeLinear, DequantizeLinear, QLinearMatMul |
| 21, 22 | uint4, int4 | two a byte, first in the low bits | as before this review: also the integer arithmetic operators, which is wider than ONNX allows |
| 23 | float4e2m1 | two a byte | as 17-20 (QuantizeLinear from opset 23) |
| 24 | float8e8m0 | one exponent byte | as 17-20 (a quantization scale from opset 24) |
| 25, 26 | uint2, int2 | four a byte, first in bits 0-1 | as 17-20 (QuantizeLinear from opset 25) |
| 27, 28 | float6e2m3, float6e3m2 | little-endian bit stream, four values in three bytes | as 17-20 (QuantizeLinear from opset 28) |

Conversion rules:

- Cast to an 8-bit float rounds ties to even. `saturate` (default 1) clamps values past the largest finite magnitude,
  infinities included, to that magnitude; `saturate=0` gives infinity for float8e5m2 and NaN for the others.
- Cast to float8e8m0 follows `round_mode` (`up` default, `down`, `nearest` with ties up). ONNX leaves -0 and negative
  input unspecified: Margo writes the smallest value for -0 when saturating and NaN for negative input.
- Cast to float4e2m1, float6e2m3 and float6e3m2 saturates at 6, 7.5 and 28, `saturate` or not. ONNX leaves NaN
  unspecified: Margo writes +0.
- Cast from a float to a 4-bit or 2-bit integer rounds ties to even, then keeps the low bits.
- Typed protobuf payloads follow onnx.proto: one bit pattern per `int32_data` entry for the 8-bit floats, one packed
  byte per entry for the 4-bit and 2-bit types, one 6-bit code per entry for the 6-bit floats, and interleaved `float_data` or `double_data` for complex tensors.

## Quantized operators (built 2026-11-27)

| Operator | Opsets | Notes |
| --- | --- | --- |
| QuantizeLinear | 10, 13, 19, 21, 23, 24, 25, 28 | per-tensor, per-axis (13), blocked and `output_dtype` (21), `precision` (23), 6-bit float outputs (28) |
| DequantizeLinear | 10, 13, 19, 21, 23, 24, 25, 28 | same layouts; `output_dtype` (23) |
| DynamicQuantizeLinear | 11 | uint8, float32 arithmetic |
| ConvInteger, QLinearConv | 10 | int8 and uint8; an accumulator past int32 is an error, not a wrap |
| MatMulInteger | 10 | int8 and uint8; per-row left and per-column right zero points |
| QLinearMatMul | 10, 21 | 8-bit floats from 21; per-line scales |

QLinearConv and QLinearMatMul requantize in float64. A runtime that carries the multiplier in float32 can differ by one
step on values that land near a tie.

## Sequence-model operators (built 2026-11-27)

| Operator | Opsets | Notes |
| --- | --- | --- |
| Attention | 23, 24, 25 (and 26-28, which keep 25) | bool, float and integer masks; a shorter last mask axis from 24; `nonpad_kv_seqlen` from 24; windows from 25; all four `qk_matmul_output_mode` values; a query with no visible key gives a zero row |
| RotaryEmbedding | 23 | both layouts, with and without `position_ids` |
| TensorScatter | 24 | linear and circular writes, every element type |
| CausalConvWithState | 27 | the opset 29 `dilation` is not built |
| LinearAttention | 27 | the four update rules; the recurrence runs in float32; the opset 29 `v_num_heads` and `states` are not built |

## ImageDecoder (built 2026-11-27)

Opset 20, from https://onnx.ai/onnx/operators/onnx__ImageDecoder.html . The stream's signature picks the reader of
`@margoengine/decoders`. Proof: `packages/compute/tests/onnx-image.test.js` writes PNG, BMP, TIFF, PPM and lossless
JPEG files with known pixels and compares RGB, BGR and Grayscale exactly; the WebP case compares with the decoders
reader, which has its own proof.

| Point of the specification | Margo |
| --- | --- |
| BMP, JPEG, TIFF, PNG, WebP, PNM | read (classic TIFF only; PBM, PGM, PPM) |
| JPEG 2000 | not built: rejects with code `unsupported` |
| Lossless JPEG (optional) | read |
| A stream that cannot be decoded | empty matrix `[0, 0, channels]` |
| Grayscale weights | none given; Rec. ITU-R BT.601 luma, https://www.itu.int/rec/R-REC-BT.601 |
| Fancy chroma upsampling | linear filter at the stated positions; the alternating rounding is not reproduced |

## Old operator versions (reviewed 2026-11-27)

The attribute and input forms of default-domain operator versions 1 to 8 were compared with
https://github.com/onnx/onnx/blob/main/docs/Changelog.md (read 2026-11-27). Each row below was rejected or computed
wrongly before the review; `packages/compute/tests/onnx-old-opsets.test.js` holds the hand-worked cases. The review
compared forms and the semantics named here. It is not a numeric test of every operator at every old version.

| Operator versions | Old form, now read |
| --- | --- |
| most element-wise and variadic operators 1, Reshape 1 | the `consumed_inputs` hint (accepted, no effect) |
| Add, Sub, Mul, Div, Pow, And, Or, Xor, Equal, Greater, Less 1-6 | B matches A unless `broadcast=1` (one element, or a run of A's axes from `axis`, suffix by default); numpy broadcasting no longer applies |
| Gemm 1, 6 | `broadcast` (C is then broadcast to the result) |
| PRelu 1, 6 | a slope vector holds one value per channel (axis 1) |
| Cast 1 | `to` names the type in text |
| Pad 1 | `paddings` |
| Reshape 1 | the `shape` attribute, one input |
| Tile 1 | inputs data, count and axis |
| Split 1 | the optional lengths input |
| LpPool 1, GlobalLpPool 1 | float `p` |
| BatchNormalization 1, 6, 7 | `spatial=0` keeps one statistic per feature |
| RNN, GRU, LSTM 1, 3 | `output_sequence` (accepted; the listed outputs decide) |
| Scan 8 | batched form with `sequence_lens` and `directions` |

## ai.onnx.ml single-score binary classifiers and calibration (reviewed 2026-11-27)

`packages/compute/tests/onnx-ml-calibration.test.js` covers these. The ai.onnx.ml specification does not say how one
stored score becomes two class scores, so the rows state what Margo does.

| Case | Margo |
| --- | --- |
| SVM pair probability at any finite margin | clamped to 1e-7 .. 1 - 1e-7, then coupled; scores stay in 0..1 and sum to 1 within float32 rounding. 300 seeded trials of 3 to 16 classes with saturated and contradicting pairs converged |
| A margin that is not a number | the run is refused |
| LinearClassifier, one coefficient row, two labels | label by `score > 0`; `NONE` gives `[1 - s, s]`, `multi_class` gives `[-s, s]` then the transform, `LOGISTIC` gives `[1 - p, p]`, `PROBIT` transforms `[1 - s, s]` |
| TreeEnsembleClassifier, every weight on class 0, two labels | weights all nonnegative: `[1 - s, s]`, split at 0.5; otherwise `[-s, s]`, split at 0; one base value joins `s`, two join the expanded scores |
| `SOFTMAX` and `SOFTMAX_ZERO` on the two cases above (LinearClassifier without `multi_class`) | not applied |
