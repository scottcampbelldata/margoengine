use crate::attrs::Attrs;
use crate::tensor::Result;
pub fn minimum(op: &str) -> u32 {
    match op {
        "Acos" | "Asin" | "Atan" | "Cos" | "Sin" | "Tan" => 7,
        "Acosh" | "Asinh" | "Atanh" | "Cosh" | "Sinh" | "Erf" | "Sign" | "IsNaN" | "Where"
        | "NonZero" | "OneHot" => 9,
        "Mod" | "IsInf" | "Resize" => 10,
        "BitShift" => 11,
        "Round" | "CumSum" | "GatherElements" | "GatherND" | "ScatterElements" | "ScatterND"
        | "Range" | "SequenceEmpty" | "SequenceConstruct" | "SequenceAt" | "SequenceErase"
        | "SequenceInsert" | "SequenceLength" | "SplitToSequence" | "ConcatFromSequence" => 11,
        "GreaterOrEqual" | "LessOrEqual" | "Einsum" => 12,
        "HardSwish" | "Trilu" => 14,
        "CastLike" | "Optional" | "OptionalHasElement" | "OptionalGetElement" => 15,
        "LayerNormalization" => 17,
        "Bernoulli" => 15,
        "Unique" | "Det" => 11,
        "ReverseSequence" => 10,
        "Shrink" => 9,
        "Celu" => 12,
        "CenterCropPad" => 18,
        "Swish" => 24,
        "CumProd" | "BitCast" => 26,
        "SwiGLU" => 28,
        "StringConcat" | "StringSplit" => 20,
        "NonMaxSuppression" | "RoiAlign" => 10,
        "GridSample" => 16,
        "AffineGrid" => 20,
        "Col2Im" => 18,
        "NegativeLogLikelihoodLoss" | "SoftmaxCrossEntropyLoss" => 12,
        "DFT" | "STFT" | "HannWindow" | "HammingWindow" | "BlackmanWindow" | "MelWeightMatrix" => {
            17
        }
        "Multinomial" => 7,
        "BitwiseAnd" | "BitwiseOr" | "BitwiseXor" | "BitwiseNot" | "Mish" => 18,
        "GroupNormalization" => 18,
        "Gelu" => 20,
        "RMSNormalization" => 23,
        _ => 1,
    }
}
pub fn validate(op: &str, version: u32, n: usize, nout: usize, a: &Attrs) -> Result<()> {
    if version < minimum(op) {
        return Err(format!(
            "{op} did not exist at opset {version}; repair the model's opset import"
        ));
    }
    let (lo, hi) = match op {
        "Constant" | "RandomUniform" | "RandomNormal" => (0, 0),
        "Dropout" => (1, if version < 12 { 1 } else { 3 }),
        "DFT" => (1, if version < 20 { 2 } else { 3 }),
        "STFT" => (2, 4),
        "StringConcat" => (2, 2),
        "MelWeightMatrix" => (5, 5),
        "NonMaxSuppression" => (2, 5),
        "GridSample" | "AffineGrid" | "MaxRoiPool" => (2, 2),
        "RoiAlign" | "Col2Im" => (3, 3),
        "NegativeLogLikelihoodLoss" | "SoftmaxCrossEntropyLoss" => (2, 3),
        "Resize" => {
            if version == 10 {
                (2, 2)
            } else {
                (1, 4)
            }
        }
        "Upsample" => {
            if version < 9 {
                (1, 1)
            } else {
                (2, 2)
            }
        }
        "Clip" => (1, if version < 11 { 1 } else { 3 }),
        "Where" => (3, 3),
        "SwiGLU" | "ReverseSequence" | "CenterCropPad" | "CumProd" => (2, 2),
        "Min" | "Max" | "Mean" | "Sum" | "Concat" | "Einsum" => (1, usize::MAX),
        "Reshape" | "Expand" | "Tile" | "Gather" | "GatherElements" | "GatherND" | "MatMul"
        | "CastLike" | "Add" | "Sub" | "Mul" | "Div" | "Pow" | "Mod" | "PRelu" | "Equal"
        | "Greater" | "GreaterOrEqual" | "Less" | "LessOrEqual" | "And" | "Or" | "Xor"
        | "BitwiseAnd" | "BitwiseOr" | "BitwiseXor" | "BitShift" | "Compress" | "CumSum" => (2, 2),
        "Scatter" | "ScatterElements" | "ScatterND" | "WhereUnused" | "Range" | "OneHot" => (3, 3),
        "Slice" => {
            if version < 10 {
                (1, 1)
            } else {
                (3, 5)
            }
        }
        "Pad" => {
            if version < 11 {
                (1, 1)
            } else {
                (2, 4)
            }
        }
        "Split" => {
            if version < 13 {
                (1, 1)
            } else {
                (1, 2)
            }
        }
        "Squeeze" | "Unsqueeze" => {
            if version < 13 {
                (1, 1)
            } else {
                (if op == "Unsqueeze" { 2 } else { 1 }, 2)
            }
        }
        "Gemm" | "Conv" | "ConvTranspose" | "LayerNormalization" => (2, 3),
        "InstanceNormalization" | "GroupNormalization" => (3, 3),
        "BatchNormalization" => (5, 5),
        "RNN" | "GRU" => (3, 6),
        "LSTM" => (3, 8),
        "RMSNormalization" => (2, 2),
        "Trilu" => (1, 2),
        "MaxUnpool" => (2, 3),
        "TopK" => {
            if version < 10 {
                (1, 1)
            } else {
                (2, 2)
            }
        }
        name if name.starts_with("Reduce") => {
            if (name == "ReduceSum" && version >= 13) || version >= 18 {
                (1, 2)
            } else {
                (1, 1)
            }
        }
        _ => (1, 1),
    };
    if n < lo || n > hi {
        return Err(format!(
            "{op} expects {lo}..{hi} inputs at opset {version}; repair its input list"
        ));
    }
    let (lo, hi) = match op {
        "TopK" => (2, 2),
        "Unique" => (1, 4),
        "SoftmaxCrossEntropyLoss" => (1, 2),
        "StringSplit" => (2, 2),
        "RNN" | "GRU" => (1, 2),
        "LSTM" => (1, 3),
        "MaxPool" | "Dropout" => (1, 2),
        "LayerNormalization" => (1, 3),
        "BatchNormalization" => (1, if version < 14 { 5 } else { 3 }),
        "Split" => (1, usize::MAX),
        _ => (1, 1),
    };
    if nout < lo || nout > hi {
        return Err(format!(
            "{op} expects {lo}..{hi} outputs; repair its output list"
        ));
    }
    let attrs: &[&str] = match op {
        "StringSplit" => &["delimiter", "maxsplit"],
        "DFT" if version < 20 => &["axis", "inverse", "onesided"],
        "DFT" => &["inverse", "onesided"],
        "STFT" => &["onesided"],
        "HannWindow" | "HammingWindow" | "BlackmanWindow" => &["periodic", "output_datatype"],
        "MelWeightMatrix" => &["output_datatype"],
        "NegativeLogLikelihoodLoss" | "SoftmaxCrossEntropyLoss" => &["reduction", "ignore_index"],
        "NonMaxSuppression" => &["center_point_box"],
        "GridSample" => &["mode", "padding_mode", "align_corners"],
        "AffineGrid" => &["align_corners"],
        "Col2Im" => &["dilations", "pads", "strides"],
        "MaxRoiPool" => &["pooled_shape", "spatial_scale"],
        "RoiAlign" => &[
            "coordinate_transformation_mode",
            "mode",
            "output_height",
            "output_width",
            "sampling_ratio",
            "spatial_scale",
        ],
        "Unique" => &["axis", "sorted"],
        "CenterCropPad" => &["axes"],
        "ReverseSequence" => &["batch_axis", "time_axis"],
        "BitCast" => &["to"],
        "Celu" | "Swish" | "SwiGLU" => &["alpha"],
        "Shrink" => &["bias", "lambd"],
        "RandomUniform" => &["dtype", "high", "low", "seed", "shape"],
        "RandomNormal" => &["dtype", "mean", "scale", "seed", "shape"],
        "RandomUniformLike" => &["dtype", "high", "low", "seed"],
        "RandomNormalLike" => &["dtype", "mean", "scale", "seed"],
        "Bernoulli" => &["dtype", "seed"],
        "Multinomial" => &["dtype", "sample_size", "seed"],
        "Dropout" if version < 7 => &["ratio", "is_test", "consumed_inputs"],
        "Dropout" if version < 12 => &["ratio"],
        "Dropout" => &["seed"],
        "LeakyRelu" | "Elu" | "ThresholdedRelu" => &["alpha"],
        "HardSigmoid" => &["alpha", "beta"],
        "Selu" => &["alpha", "gamma"],
        "Gelu" => &["approximate"],
        "IsInf" => &["detect_positive", "detect_negative"],
        "Mod" => &["fmod"],
        "BitShift" => &["direction"],
        "Add" | "Sub" | "Mul" | "Div" | "Pow" if version < 7 => &["axis", "broadcast"],
        "Clip" if version < 11 => &["min", "max"],
        "Reshape" => &["allowzero"],
        "Flatten" | "Concat" | "Gather" | "GatherElements" | "Softmax" | "LogSoftmax"
        | "Hardmax" => &["axis"],
        "Transpose" => &["perm"],
        "Squeeze" | "Unsqueeze" if version < 13 => &["axes"],
        "Shape" => &["start", "end"],
        "Constant" => &[
            "value",
            "sparse_value",
            "value_float",
            "value_int",
            "value_string",
            "value_floats",
            "value_ints",
            "value_strings",
        ],
        "ConstantOfShape" => &["value"],
        "Slice" if version < 10 => &["starts", "ends", "axes"],
        "Split" if version < 13 => &["axis", "split"],
        "Split" => &["axis", "num_outputs"],
        "GatherND" => &["batch_dims"],
        "Scatter" | "ScatterElements" => &["axis", "reduction"],
        "ScatterND" => &["reduction"],
        "Compress" => &["axis"],
        "EyeLike" => &["dtype", "k"],
        "Trilu" => &["upper"],
        "OneHot" => &["axis"],
        "DepthToSpace" => &["blocksize", "mode"],
        "SpaceToDepth" => &["blocksize"],
        "Pad" if version < 11 => &["pads", "value", "mode"],
        "Pad" => &["mode"],
        "Gemm" => &["alpha", "beta", "transA", "transB"],
        "Einsum" => &["equation"],
        name if name.starts_with("Reduce") => {
            if (name == "ReduceSum" && version >= 13) || version >= 18 {
                &["keepdims", "noop_with_empty_axes"]
            } else {
                &["keepdims", "axes"]
            }
        }
        "ArgMin" | "ArgMax" => &["axis", "keepdims", "select_last_index"],
        "TopK" if version < 10 => &["axis", "k"],
        "TopK" => &["axis", "largest", "sorted"],
        "CumSum" | "CumProd" => &["exclusive", "reverse"],
        "Conv" => &[
            "auto_pad",
            "dilations",
            "group",
            "kernel_shape",
            "pads",
            "strides",
        ],
        "ConvTranspose" => &[
            "auto_pad",
            "dilations",
            "group",
            "kernel_shape",
            "pads",
            "strides",
            "output_padding",
            "output_shape",
        ],
        "AveragePool" => &[
            "auto_pad",
            "ceil_mode",
            "count_include_pad",
            "dilations",
            "kernel_shape",
            "pads",
            "strides",
        ],
        "MaxPool" => &[
            "auto_pad",
            "ceil_mode",
            "dilations",
            "kernel_shape",
            "pads",
            "storage_order",
            "strides",
        ],
        "LpPool" => &[
            "auto_pad",
            "ceil_mode",
            "dilations",
            "kernel_shape",
            "p",
            "pads",
            "strides",
        ],
        "GlobalLpPool" => &["p"],
        "MaxUnpool" => &["kernel_shape", "pads", "strides"],
        "BatchNormalization" if version < 14 => &[
            "epsilon",
            "momentum",
            "spatial",
            "is_test",
            "consumed_inputs",
        ],
        "BatchNormalization" => &["epsilon", "momentum", "training_mode"],
        "RNN" => &[
            "activation_alpha",
            "activation_beta",
            "activations",
            "clip",
            "direction",
            "hidden_size",
            "layout",
        ],
        "GRU" => &[
            "activation_alpha",
            "activation_beta",
            "activations",
            "clip",
            "direction",
            "hidden_size",
            "layout",
            "linear_before_reset",
        ],
        "LSTM" => &[
            "activation_alpha",
            "activation_beta",
            "activations",
            "clip",
            "direction",
            "hidden_size",
            "layout",
            "input_forget",
        ],
        "InstanceNormalization" => &["epsilon"],
        "GroupNormalization" => &["epsilon", "num_groups", "stash_type"],
        "LayerNormalization" | "RMSNormalization" => &["axis", "epsilon", "stash_type"],
        "MeanVarianceNormalization" => &["axes"],
        "LRN" => &["alpha", "beta", "bias", "size"],
        "LpNormalization" => &["axis", "p"],
        "Cast" => &["to", "saturate", "round_mode"],
        "CastLike" => &["saturate", "round_mode"],
        "Resize" => &[
            "mode",
            "coordinate_transformation_mode",
            "cubic_coeff_a",
            "exclude_outside",
            "extrapolation_value",
            "nearest_mode",
            "antialias",
            "axes",
            "keep_aspect_ratio_policy",
        ],
        "Upsample" => &["mode", "scales", "height_scale", "width_scale"],
        _ => &[],
    };
    a.known(attrs)
}
