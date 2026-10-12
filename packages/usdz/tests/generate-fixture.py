"""Regenerate the synthetic crate with OpenUSD; no Python/OpenUSD runtime dependency."""
from pathlib import Path
from pxr import Sdf

root = Path(__file__).parent / "fixtures"
layer = Sdf.Layer.FindOrOpen(str(root / "triangle.usda"))
assert layer is not None
assert layer.Export(str(root / "triangle.usdc"))
