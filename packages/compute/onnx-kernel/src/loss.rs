use crate::attrs::{floating, input, optional, same_type, Attrs};
use crate::tensor::{product, Number, Result, Tensor};
pub fn supports(op: &str) -> bool {
    matches!(op, "NegativeLogLikelihoodLoss" | "SoftmaxCrossEntropyLoss")
}
pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs, nout: usize) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    floating(x)?;
    let target = input(inputs, 1)?;
    if x.shape.len() < 2 || x.shape[1] == 0 {
        return Err(
            "loss input needs [N,C,...] with a positive class count; repair input shape".into(),
        );
    }
    let mut shape = x.shape.clone();
    let classes = shape.remove(1);
    let inner = product(&x.shape[2..])?;
    if !matches!(target.kind, 6 | 7) || target.shape != shape {
        return Err("loss targets must be integer[N,...] matching the input without its class axis; repair targets".into());
    }
    let weight = optional(inputs, 2);
    if let Some(w) = weight {
        same_type(x, w)?;
        if w.shape != [classes] {
            return Err("loss class weights must be [C]; repair weights".into());
        }
    }
    let reduction = a.string("reduction", "mean")?;
    if !matches!(reduction, "none" | "sum" | "mean") {
        return Err("loss reduction must be none, sum or mean; repair attribute".into());
    }
    let ignore = if a.has("ignore_index") {
        Some(a.int("ignore_index", 0)?)
    } else {
        None
    };
    let mut log = x.clone();
    if op == "SoftmaxCrossEntropyLoss" {
        log = Tensor::zeros(x.kind, x.shape.clone())?;
        for batch in 0..x.shape[0] {
            for p in 0..inner {
                let mut max = f64::NEG_INFINITY;
                for c in 0..classes {
                    max = crate::element::maximum(
                        Number::F(max),
                        x.get((batch * classes + c) * inner + p),
                    )
                    .f();
                }
                let total: f64 = (0..classes)
                    .map(|c| (x.get((batch * classes + c) * inner + p).f() - max).exp())
                    .sum();
                let normalizer = total.ln();
                for c in 0..classes {
                    log.set(
                        (batch * classes + c) * inner + p,
                        Number::F(
                            (x.get((batch * classes + c) * inner + p).f() - max) - normalizer,
                        ),
                    );
                }
            }
        }
    }
    let mut losses = Tensor::zeros(x.kind, shape)?;
    let mut total = 0.;
    let mut denominator = 0.;
    for i in 0..target.size() {
        let c = target.get(i).i();
        if Some(c) == ignore {
            continue;
        }
        if c < 0 || c as usize >= classes {
            return Err(
                "loss target class is out of range; repair labels or declare ignore_index".into(),
            );
        }
        let w = weight.map_or(1., |w| w.get(c as usize).f());
        let value = -log
            .get(((i / inner) * classes + c as usize) * inner + i % inner)
            .f()
            * w;
        losses.set(i, Number::F(value));
        total += losses.get(i).f();
        denominator += w;
    }
    if reduction != "none" {
        losses = Tensor::zeros(x.kind, vec![])?;
        losses.set(
            0,
            Number::F(if reduction == "sum" {
                total
            } else {
                total / denominator
            }),
        );
    }
    Ok(if nout > 1 {
        vec![losses, log]
    } else {
        vec![losses]
    })
}
