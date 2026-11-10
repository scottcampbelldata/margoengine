"""Extract numerical AV1 standard tables, never codec implementation source.

Usage: python packages/decoders/scripts/avif-spec-tables.py path/to/av1-spec.html
The input is the published https://aomediacodec.github.io/av1-spec/ document.
Only numeric constants are accepted. Syntax pseudocode is never emitted.
"""
import ast
import hashlib
import html
import pathlib
import re
import sys
import subprocess

source = pathlib.Path(sys.argv[1]).read_bytes()
text = html.unescape(re.sub(r"<[^>]*>", " ", source.decode("utf8")))
text = text.replace("\xa0", " ")


def numeric(node):
    if isinstance(node, ast.List):
        return [numeric(x) for x in node.elts]
    if isinstance(node, ast.Constant) and type(node.value) is int:
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return -numeric(node.operand)
    if isinstance(node, ast.BinOp):
        a, b = numeric(node.left), numeric(node.right)
        if isinstance(node.op, ast.Mult):
            return a * b
        if isinstance(node.op, ast.Add):
            return a + b
        if isinstance(node.op, ast.Sub):
            return a - b
    raise ValueError("AV1 table contains a non-numeric expression")


def shape(value):
    if type(value) is int:
        return []
    children = [shape(v) for v in value]
    if not children or any(v != children[0] for v in children):
        raise ValueError("AV1 table is empty or ragged")
    return [len(value)] + children[0]


def leaves(value):
    if type(value[0]) is int:
        return [value]
    return [row for child in value for row in leaves(child)]


prefixes = (
    "Intra_Frame_Y_Mode", "Uv_Mode", "Angle_Delta", "Intrabc", "Partition_",
    "Tx_", "Txfm_Split", "Filter_Intra", "Segment_Id_Cdf", "Mv_", "Skip_Cdf", "Palette_",
    "Delta_Q", "Delta_Lf", "Intra_Tx_Type", "Inter_Tx_Type", "Cfl_", "Use_Wiener", "Use_Sgrproj",
    "Restoration_Type", "Txb_Skip", "Eob_", "Dc_Sign", "Coeff_",
)
tables = []
for match in re.finditer(r"(Default_\w+_Cdf)\s*\[.*?=\s*\{", text):
    name = match[1]
    short = name.removeprefix("Default_")
    if not short.startswith(prefixes):
        continue
    start = match.end() - 1
    depth = 0
    for end in range(start, len(text)):
        if text[end] == "{":
            depth += 1
        elif text[end] == "}":
            depth -= 1
        if depth == 0:
            break
    data = text[start:end + 1].replace("{", "[").replace("}", "]")
    value = numeric(ast.parse(data, mode="eval").body)
    dims = shape(value)
    rows = leaves(value)
    for row in rows:
        if row[-2:] != [32768, 0] or not all(0 <= n <= 32768 for n in row):
            raise ValueError(f"{name}: invalid CDF sentinel or count")
        if row[:-1] != sorted(row[:-1]):
            raise ValueError(f"{name}: CDF is not cumulative")
    coefficients = bool(re.search(r"\[\s*COEFF_CDF_Q_CTXS\s*\]", match[0]))
    variant = "".join(word[0].upper() + word[1:].lower() for word in short.removesuffix("_Cdf").split("_"))
    tables.append((variant, dims, rows, coefficients))

out = [
    "// Generated numerical constants from the published AV1 specification, section 9.3.",
    "// Source: https://aomediacodec.github.io/av1-spec/ (de Rivaz and Haughton, 2023).",
    "// Input SHA-256: " + hashlib.sha256(source).hexdigest(),
    "// Regenerate with packages/decoders/scripts/avif-spec-tables.py; no implementation source.",
    "#[derive(Clone, Copy, Debug)]",
    "#[repr(usize)]",
    "pub enum Table {",
]
out += [f"    {name}," for name, *_ in tables]
out += [
    "}",
    "pub struct Model {",
    "    pub shape: &'static [usize],",
    "    pub symbols: usize,",
    "    pub quantized: bool,",
    "    pub values: &'static [u16],",
    "}",
    f"pub static MODELS: [Model; {len(tables)}] = [",
]
for name, dims, rows, coefficients in tables:
    out += [
        "    Model {",
        f"        shape: &{dims[:-1]}, symbols: {dims[-1] - 1}, quantized: {str(coefficients).lower()},",
        "        values: &[",
    ]
    out += ["            " + ", ".join(map(str, row[:-1])) + "," for row in rows]
    out += ["        ],", "    },"]
out += [
    "];", "", "#[cfg(test)]", "mod tests {", "    use super::*;",
    "    #[test]", "    fn all_standard_cdfs_have_valid_shape_and_probabilities() {",
    "        for model in &MODELS {",
    "            assert_eq!(model.values.len(), model.shape.iter().product::<usize>() * model.symbols);",
    "            for row in model.values.chunks_exact(model.symbols) {",
    "                assert!(crate::entropy::Cdf::new(row).is_ok());",
    "            }", "        }", "    }", "}", "",
]
destination = pathlib.Path(__file__).resolve().parent.parent / "native/avif/src/cdf_tables.rs"
destination.write_text("\n".join(out), encoding="utf8")
print(f"Generated {len(tables)} numeric standard tables ({sum(len(rows) for _, _, rows, _ in tables)} CDFs)")

# The transform/prediction constants are standard data as well. Keep them distinct
# from adaptive CDFs so none of the arithmetic pseudocode enters generated files.
names = [
    "Cos128_Lookup", "Intra_Filter_Taps", "Dr_Intra_Derivative", "Gaussian_Sequence",
    "Dc_Qlookup", "Ac_Qlookup",
    "Coeff_Base_Ctx_Offset", "Sig_Ref_Diff_Offset", "Qm_Offset", "Quantizer_Matrix",
    "Sgr_Params", "Upscale_Filter",
] + [f"Sm_Weights_Tx_{n}x{n}" for n in [4, 8, 16, 32, 64]]
names += list(dict.fromkeys(re.findall(r"\b((?:Default|Mrow|Mcol)_Scan_\d+x\d+)\s*\[", text)))
constants = out[:4]
for name in names:
    match = re.search(r"\b" + name + r"\s*\[.*?=\s*\{", text)
    if not match:
        raise ValueError(f"Missing standard data {name}")
    start = match.end() - 1
    depth = 0
    for end in range(start, len(text)):
        depth += (text[end] == "{") - (text[end] == "}")
        if depth == 0:
            break
    data = text[start:end + 1].replace("{", "[").replace("}", "]")
    data = re.sub(r"//[^\n]*", "", data)
    data = re.sub(r"/\*.*?\*/", "", data, flags=re.S)
    value = numeric(ast.parse(data, mode="eval").body)
    dims = shape(value)
    rust_type = "i32"
    for dimension in reversed(dims):
        rust_type = f"[{rust_type}; {dimension}]"
    constants.append(f"pub static {name.upper()}: {rust_type} = {value};")
destination.with_name("tables.rs").write_text("\n".join(constants) + "\n", encoding="utf8")
print(f"Generated {len(names)} reconstruction constant tables")
subprocess.run(["rustfmt", "--edition", "2024", str(destination), str(destination.with_name("tables.rs"))],
               check=True, timeout=30)
