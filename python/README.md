# margoengine (Python)

GPU plots of NumPy arrays, pandas and Polars DataFrames and xarray DataArrays in Jupyter. Margo Engine draws them in the browser with WebGPU:

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
fig.to_png("quakes.png", width=1200, scale=2)   # 2400 x 960 pixels
```

`to_png` draws the figure with WebGPU in a headless Chrome, Edge or Chromium that it starts and closes itself (no
Python packages needed). It finds an installed browser; set `browser=` or the `MARGO_BROWSER` environment variable to
choose one.

Polars DataFrames and LazyFrames work like pandas ones (a LazyFrame reads only the columns you name; nulls draw as
gaps). An xarray DataArray brings its own grid: a volume's bounds and a surface's ranges come from the coordinates,
and the axis titles and colour bar label from the names and units:

```python
import polars as pl
import xarray as xr

stars = pl.DataFrame({"ra": np.random.rand(100_000), "dec": np.random.rand(100_000), "mag": np.random.rand(100_000)})
margo.scatter(stars.lazy(), x="ra", y="dec", color="mag")

lat = np.linspace(40, 50, 64)
lon = np.linspace(-10, 0, 80)
depth = np.linspace(0, 500, 32)
temperature = xr.DataArray(
    np.random.rand(32, 64, 80).astype(np.float32),
    dims=("depth", "lat", "lon"),
    coords={"depth": depth, "lat": lat, "lon": lon},
    name="temperature",
    attrs={"units": "degC"},
)
margo.volume(temperature)   # bounds (-10, 0, 40, 50, 0, 500); titles lon, lat, depth; colour bar "temperature (degC)"
```

A DataArray's dimensions are read in `(z, y, x)` order for volumes and `(y, x)` for surfaces. The coordinates must
be evenly spaced; a decreasing one (latitude stored north to south, say) is flipped for you. Pass `bounds=` or
`x=` / `y=` to override them.

## Camera, clicks and selections

A figure is a [traitlets](https://traitlets.readthedocs.io) object, like every ipywidget. Its `camera` trait follows the
view as you orbit, pan and zoom (reported at most ten times a second), and setting it moves the view:

```python
fig = margo.scatter(df, x="x", y="y", z="z", color="r")
fig.camera = {"position": [0.5, 2.5, 1.5], "target": [0, 0, 0]}   # any of position, target, up, fov
fig.observe(lambda change: print(change["new"]["position"]), names="camera")
fig   # drag in the view: the new camera prints in the kernel
```

Clicks and box or lasso selections come back too. `on_click` gets the point under the pointer; set `drag_mode` to
`"box"` or `"lasso"` and a drag selects points, which arrive in the `selection` trait and `on_select` as point indices
per layer (sent as binary buffers, NumPy `uint32` arrays in Python):

```python
fig = margo.scatter(df, x="x", y="y", z="z", color="r")
fig.on_click(lambda event: print(event["hit"]))   # {"layer": 0, "index": 4711, "point": [x, y, z], "value": r} or None
fig.drag_mode = "lasso"
fig.on_select(lambda selection: print(df.iloc[selection[0]].describe()))
fig
```

The camera is in scene units (the plot box spans about -1 to 1 on its longest side). `save_html` and `to_png` start
from it.

## API

| Function | What it does |
| --- | --- |
| `margo.scatter(data, x=, y=, z=, color=, size=, colormap=, range=, point_size=, edl=)` | scatter plot; columns may be names in a pandas or Polars DataFrame, an xarray Dataset or a dict, or arrays |
| `margo.line(data, x=, y=, z=, color=, width=)` | a line through the points |
| `margo.surface(z, x=(min, max), y=(min, max), colormap=, range=, contours=10)` | surface plot of a 2D array `z[row][column]`; NaN leaves holes |
| `margo.volume(values, bounds=, colormap=, range=, opacity=[(t, a), ...], density=1, mode="composite" or "mip")` | volume rendering of `values[z][y][x]` |
| `margo.isosurface(values, level, bounds=, color=)` | an isosurface extracted by GPU marching cubes |
| `margo.figure(theme="dark", height=480, aspect=(1, 1, 0.75), titles=, axes=True, point_budget=2_000_000)` | an empty figure; its methods have the names above plus `colorbar(colormap, range, label=)`, and they chain |
| `fig.save_html(path)` / `fig.to_html()` | a self-contained page with the figure |
| `fig.to_png(path, width=960, height=None, scale=1, browser=None, timeout=60)` | a PNG image, drawn in a headless Chrome, Edge or Chromium; `height` defaults to the figure's |
| `fig.show()` | display the figure from anywhere in a cell |
| `fig.camera` | trait: the view's camera (`position`, `target`, `up`, `fov`); follows the view, and setting it moves the view |
| `fig.drag_mode` | trait: `"orbit"` (default), `"box"` or `"lasso"` |
| `fig.selection` | trait: the last selection, `{layer index: point indices}`, or `None` |
| `fig.on_click(callback, remove=False)` / `fig.on_select(callback, remove=False)` | call `callback(event)` on a click / `callback(selection)` when a selection ends |

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

The package needs only `comm` and `traitlets` (both present in every Jupyter kernel). NumPy, pandas, Polars and xarray inputs are used when installed.
Plain lists and `array.array` also work.

## Where it runs

| Notebook | How the figure loads | Checked |
| --- | --- | --- |
| JupyterLab 4 | prebuilt extension `@margoengine/jupyter` (installed with the package) | automatically: `npm run test:python:browser` draws three figures and checks the camera both ways |
| Notebook 7 | the same prebuilt extension | automatically, by the same test |
| VS Code notebooks | the classic AMD module `share/jupyter/nbextensions/@margoengine/jupyter/index.js` in the kernel's environment (installed with the package) | by hand, below |
| Google Colab | an inline page instead of the widget: Colab's custom widget manager loads widget code only from npm, and `@margoengine/jupyter` is not published there. The figure draws and orbits; `camera` events do not reach Python | by hand, below |

Checks done by hand (no automated VS Code or Colab session here):

1. VS Code: install the package into the kernel's environment (`pip install ./python`), open a notebook with that
   kernel, run `margo.scatter(x=np.random.rand(1000), y=np.random.rand(1000))`. The figure draws; drag it, then
   run `fig.camera` in the next cell and see the position change.
2. Colab: upload a wheel built with `pip wheel ./python`, `pip install` it in the notebook and run the same cell. The
   figure draws and orbits (WebGPU needs Chrome or Edge).

## How it works

1. A figure is a widget speaking the Jupyter widget messaging protocol 2.1. Its state is a plot specification:
   theme, axes, and layers whose arrays are float32 bytes plus a shape. The bytes go in the comm message's binary
   buffers, with their `buffer_paths`.
2. In JupyterLab, the prebuilt extension `@margoengine/jupyter` is a hand-written federated container
   (`remoteEntry.js`). It registers `MargoFigureModel` and `MargoFigureView` with the widget manager. VS Code loads the
   same classes from the AMD module in `nbextensions`.
3. The view rebuilds the specification as a `@margoengine/sciviz` figure. Its `camera` attribute syncs both ways
   like the specification.

Run the tests with `python -m unittest discover -s python/tests` or `pytest python/tests`, and the notebook check
(JupyterLab, Notebook 7, camera, `to_png`; GPU lock) with `npm run test:python:browser`.
