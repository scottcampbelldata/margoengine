# margoengine (Python)

GPU plots of NumPy arrays and pandas DataFrames in Jupyter. Margo Engine draws them in the browser with WebGPU:

- millions of points;
- volumes with transfer functions;
- surfaces with contours;
- isosurfaces extracted on the GPU.

Arrays travel to the browser as binary float32 buffers over the Jupyter widget protocol, never as JSON.

```python
import numpy as np
import pandas as pd
import margoengine as margo

df = pd.DataFrame({"x": np.random.randn(1_000_000), "y": np.random.randn(1_000_000), "z": np.random.randn(1_000_000)})
df["r"] = np.sqrt(df.x**2 + df.y**2 + df.z**2)
margo.scatter(df, x="x", y="y", z="z", color="r", colormap="ember")   # shows as the cell's result
```

```python
grid = np.linspace(-3, 3, 96, dtype=np.float32)
X, Y, Z = np.meshgrid(grid, grid, grid, indexing="xy")
gyroid = np.sin(X) * np.cos(Y) + np.sin(Y) * np.cos(Z) + np.sin(Z) * np.cos(X)   # shape (z, y, x)

margo.volume(gyroid, colormap="aurora", opacity=[(0, 0), (0.6, 0), (0.8, 0.6), (1, 1)])
margo.isosurface(gyroid, 0.0)
margo.surface(np.sin(grid)[None, :] * np.cos(grid)[:, None], x=(-3, 3), y=(-3, 3))
```

Combine layers in one figure and save a standalone page that opens in any WebGPU browser:

```python
fig = margo.figure(theme="light", titles={"x": "lon", "y": "lat", "z": "depth (km)"})
fig.scatter(quakes, x="lon", y="lat", z="depth", color="mag", colorbar="magnitude")
fig.line(x=path_lon, y=path_lat, z=path_depth, width=3)
fig.save_html("quakes.html")
```

## API

| Function | What it does |
| --- | --- |
| `margo.scatter(data, x=, y=, z=, color=, size=, colormap=, range=, point_size=, edl=)` | scatter plot; columns may be names in a DataFrame or dict, or arrays |
| `margo.line(data, x=, y=, z=, color=, width=)` | a line through the points |
| `margo.surface(z, x=(min, max), y=(min, max), colormap=, range=, contours=10)` | surface plot of a 2D array `z[row][column]`; NaN leaves holes |
| `margo.volume(values, bounds=, colormap=, range=, opacity=[(t, a), ...], density=1, mode="composite" or "mip")` | volume rendering of `values[z][y][x]` |
| `margo.isosurface(values, level, bounds=, color=)` | an isosurface extracted by GPU marching cubes |
| `margo.figure(theme="dark", height=480, aspect=(1, 1, 0.75), titles=, axes=True, point_budget=2_000_000)` | an empty figure; its methods have the names above plus `colorbar(colormap, range, label=)`, and they chain |
| `fig.save_html(path)` / `fig.to_html()` | a self-contained page with the figure |
| `fig.show()` | display the figure from anywhere in a cell |

Colour maps: `aurora` (default), `ember`, `glacier`, `gray`, `cubehelix`, `coolwarm`, `phase`, `viridis`, `magma`,
`inferno`, `plasma`, `cividis`, or a list of `"#rrggbb"` stops.

## Install (from the Margo Engine repository)

The package is not on PyPI. Build the browser bundle, then install the package into the environment that runs
JupyterLab 4 (Notebook 7 included) with ipywidgets 8:

```bash
npm run build:packages
```

```bash
node python/build-frontend.mjs
```

```bash
pip install ./python
```

The package needs only `comm` (already present in Jupyter kernels). NumPy and pandas inputs are used when installed.
Plain lists and `array.array` also work.

## How it works

1. A figure is a widget speaking the Jupyter widget messaging protocol 2.1. Its state is a plot specification:
   theme, axes, and layers whose arrays are float32 bytes plus a shape. The bytes go in the comm message's binary
   buffers, with their `buffer_paths`.
2. In JupyterLab, the prebuilt extension `@margoengine/jupyter` is a hand-written federated container
   (`remoteEntry.js`). It registers `MargoFigureModel` and `MargoFigureView` with the widget manager.
3. The view rebuilds the specification as a `@margoengine/sciviz` figure.

Run the tests with `python -m unittest discover -s python/tests` or `pytest python/tests`.
