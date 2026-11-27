//! Which operators may see the element types ONNX only stores, moves or converts.
use crate::attrs::Attrs;
use crate::tensor::{is_complex, Result, Tensor};

/// Operators that copy elements without reading their values.
fn moves(op: &str) -> bool {
    matches!(
        op,
        "Compress"
            | "Concat"
            | "Constant"
            | "DepthToSpace"
            | "Expand"
            | "Flatten"
            | "Gather"
            | "GatherElements"
            | "GatherND"
            | "Identity"
            | "Reshape"
            | "ReverseSequence"
            | "Scatter"
            | "ScatterElements"
            | "ScatterND"
            | "Shape"
            | "Size"
            | "Slice"
            | "SpaceToDepth"
            | "Split"
            | "Squeeze"
            | "TensorScatter"
            | "Tile"
            | "Transpose"
            | "Unsqueeze"
            | "Where"
    )
}

pub fn check(op: &str, inputs: &[Option<Tensor>], a: &Attrs) -> Result<()> {
    for t in inputs.iter().flatten() {
        if is_complex(t.kind) {
            if !moves(op) || a.string("reduction", "none")? != "none" {
                return Err(format!(
                    "{op} takes no complex input here; ONNX complex tensors are only stored and moved"
                ));
            }
        } else if matches!(t.kind, 17..=20 | 23..=26)
            && !(moves(op)
                || matches!(
                    op,
                    "Cast"
                        | "CastLike"
                        | "CenterCropPad"
                        | "ConstantOfShape"
                        | "DequantizeLinear"
                        | "Pad"
                        | "QLinearMatMul"
                        | "QuantizeLinear"
                        | "Trilu"
                ))
        {
            return Err(format!(
                "{op} takes no 8-bit float, 4-bit float or 2-bit integer input; Cast or DequantizeLinear it first"
            ));
        }
    }
    Ok(())
}
