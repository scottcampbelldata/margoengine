"""Tests for the margoengine Python package: binary encoding, the widget protocol (against a stand-in comm), the plot
specification, and NumPy and pandas inputs (skipped when those are not installed). Run with
``python -m unittest discover -s python/tests`` or ``pytest python/tests``.
"""

import array
import base64
import json
import math
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import margoengine as margo  # noqa: E402
from margoengine import _arrays, _figure as figure_module, _widget  # noqa: E402

try:
    import numpy as np
except ImportError:  # pragma: no cover - depends on the environment
    np = None
try:
    import pandas as pd
except ImportError:  # pragma: no cover
    pd = None


class FakeComm:
    """Records what a kernel comm would send; `receive` plays a frontend message."""

    opened = []

    def __init__(self, **kwargs):
        self.open_args = kwargs
        self.comm_id = f"comm-{len(FakeComm.opened)}"
        self.sent = []
        self.closed = False
        self.handler = None
        FakeComm.opened.append(self)

    def on_msg(self, handler):
        self.handler = handler

    def send(self, data=None, metadata=None, buffers=None):
        self.sent.append({"data": data, "buffers": [bytes(b) for b in (buffers or [])]})

    def close(self):
        self.closed = True

    def receive(self, data, buffers=()):
        self.handler({"content": {"comm_id": self.comm_id, "data": data}, "buffers": list(buffers)})


def floats(raw):
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


class Encoding(unittest.TestCase):
    def test_lists_become_little_endian_float32_with_shape(self):
        encoded = _arrays.encode([[1, 2, 3], [4, 5, 6.5]])
        self.assertEqual(encoded.shape, (2, 3))
        self.assertEqual(floats(encoded.data.tobytes()), [1, 2, 3, 4, 5, 6.5])
        self.assertEqual(encoded.descriptor(), {"dtype": "float32", "shape": [2, 3]})

    def test_array_array_memoryview_and_booleans(self):
        self.assertEqual(floats(_arrays.encode(array.array("i", [1, -2])).data.tobytes()), [1, -2])
        self.assertEqual(floats(_arrays.encode(memoryview(array.array("d", [0.5]))).data.tobytes()), [0.5])
        self.assertEqual(floats(_arrays.encode([True, False]).data.tobytes()), [1, 0])

    def test_rejects_ragged_lists_and_non_numbers(self):
        with self.assertRaises(ValueError):
            _arrays.encode([[1, 2], [3]])
        with self.assertRaises(TypeError):
            _arrays.encode(["a"])
        with self.assertRaises(TypeError):
            _arrays.encode({"x": 1})

    def test_extent_skips_nan_and_infinity(self):
        self.assertEqual(_arrays.extent(_arrays.encode([float("nan"), 2, -3, float("inf")])), (-3.0, 2.0))
        self.assertEqual(_arrays.extent(_arrays.encode([float("nan")])), (0.0, 1.0))

    def test_column_resolves_names_against_the_data(self):
        data = {"a": [1, 2]}
        self.assertEqual(_arrays.column(data, "a", "x"), [1, 2])
        self.assertEqual(_arrays.column(data, [3], "x"), [3])
        with self.assertRaises(KeyError):
            _arrays.column(data, "missing", "x")
        with self.assertRaises(ValueError):
            _arrays.column(None, "a", "x")


class Buffers(unittest.TestCase):
    def test_split_and_join_round_trip_nested_binary_values(self):
        state = {"a": 1, "b": {"c": b"\x01\x02", "d": [memoryview(b"xy"), 3]}, "e": bytearray(b"z")}
        clean, paths, buffers = _widget.split_buffers(state)
        self.assertEqual(clean, {"a": 1, "b": {"d": [None, 3]}})
        self.assertEqual(paths, [["b", "c"], ["b", "d", 0], ["e"]])
        self.assertEqual([bytes(b) for b in buffers], [b"\x01\x02", b"xy", b"z"])
        joined = _widget.join_buffers(json.loads(json.dumps(clean)), paths, buffers)
        self.assertEqual(bytes(joined["b"]["c"]), b"\x01\x02")
        self.assertEqual(bytes(joined["b"]["d"][0]), b"xy")
        with self.assertRaises(ValueError):
            _widget.join_buffers({}, [["a"]], [])


class Protocol(unittest.TestCase):
    def setUp(self):
        FakeComm.opened.clear()

    def test_open_sends_the_model_and_view_classes_with_protocol_2_1(self):
        model = _widget.WidgetModel({"spec": {"data": b"\x00\x00\x80\x3f"}}, comm_factory=FakeComm)
        bundle = model.mimebundle()
        comm = FakeComm.opened[0]
        self.assertEqual(comm.open_args["target_name"], "jupyter.widget")
        self.assertEqual(comm.open_args["metadata"], {"version": "2.1.0"})
        state = comm.open_args["data"]["state"]
        self.assertEqual(state["_model_module"], "@margoengine/jupyter")
        self.assertEqual(state["_model_name"], "MargoFigureModel")
        self.assertEqual(state["_view_name"], "MargoFigureView")
        self.assertEqual(comm.open_args["data"]["buffer_paths"], [["spec", "data"]])
        self.assertEqual([bytes(b) for b in comm.open_args["buffers"]], [b"\x00\x00\x80\x3f"])
        self.assertEqual(bundle["application/vnd.jupyter.widget-view+json"], {"version_major": 2, "version_minor": 1, "model_id": "comm-0"})
        model.mimebundle()
        self.assertEqual(len(FakeComm.opened), 1, "displaying again reuses the comm")

    def test_updates_both_ways_echo_update_request_state_and_custom(self):
        model = _widget.WidgetModel({"camera": [0, 0, 1]}, comm_factory=FakeComm)
        model.open()
        comm = FakeComm.opened[0]
        model.set(camera=[1, 2, 3], blob=b"ab")
        self.assertEqual(comm.sent[-1]["data"], {"method": "update", "state": {"camera": [1, 2, 3]}, "buffer_paths": [["blob"]]})
        self.assertEqual(comm.sent[-1]["buffers"], [b"ab"])
        seen = []
        model.on_update(seen.append)
        comm.receive({"method": "update", "state": {"camera": [4, 5, 6]}, "buffer_paths": [["pixels"]]}, [b"img"])
        self.assertEqual(seen[0]["camera"], [4, 5, 6])
        self.assertEqual(bytes(seen[0]["pixels"]), b"img")
        self.assertEqual(model.state["camera"], [4, 5, 6])
        self.assertEqual(comm.sent[-1]["data"]["method"], "echo_update")
        comm.receive({"method": "request_state"})
        self.assertEqual(comm.sent[-1]["data"]["method"], "update")
        self.assertIn("_model_name", comm.sent[-1]["data"]["state"])
        events = []
        model.on_custom(lambda content, buffers: events.append((content, buffers)))
        comm.receive({"method": "custom", "content": {"event": "pick", "index": 7}})
        self.assertEqual(events, [({"event": "pick", "index": 7}, [])])
        model.send_custom({"event": "reset"})
        self.assertEqual(comm.sent[-1]["data"], {"method": "custom", "content": {"event": "reset"}})
        model.close()
        self.assertTrue(comm.closed)


class Figures(unittest.TestCase):
    def setUp(self):
        FakeComm.opened.clear()

    def test_scatter_from_a_dict_of_columns_sends_binary_buffers_and_a_colour_bar(self):
        data = {"a": [0, 1, 2], "b": [3, 4, 5], "c": [6, 7, 8], "t": [10, 20, 30]}
        fig = margo.scatter(data, x="a", y="b", z="c", color="t", colormap="ember", comm_factory=FakeComm)
        layer = fig.spec["layers"][0]
        self.assertEqual(layer["type"], "scatter")
        self.assertEqual(layer["x"]["shape"], [3])
        self.assertEqual(layer["range"], [10.0, 30.0])
        self.assertEqual(fig.spec["colorbars"], [{"colormap": "ember", "range": [10.0, 30.0], "label": "t"}])
        fig._repr_mimebundle_()
        open_args = FakeComm.opened[0].open_args
        paths = open_args["data"]["buffer_paths"]
        self.assertIn(["spec", "layers", 0, "x", "buffer"], paths)
        self.assertIn(["spec", "layers", 0, "color", "buffer"], paths)
        # No array data in the JSON part: only descriptors.
        text = json.dumps(open_args["data"]["state"])
        self.assertNotIn("buffer", text)
        index = paths.index(["spec", "layers", 0, "color", "buffer"])
        self.assertEqual(floats(bytes(open_args["buffers"][index])), [10, 20, 30])

    def test_adding_a_layer_after_display_sends_one_update(self):
        fig = margo.figure(comm_factory=FakeComm)
        fig._repr_mimebundle_()
        fig.line(x=[0, 1], y=[1, 0], width=3)
        sent = FakeComm.opened[0].sent[-1]
        self.assertEqual(sent["data"]["method"], "update")
        self.assertEqual(sent["data"]["state"]["spec"]["layers"][0]["width"], 3.0)
        self.assertEqual(len(sent["buffers"]), 2)

    def test_surface_volume_and_isosurface_shapes_and_validation(self):
        z = [[0, 1, 2], [3, 4, 5]]
        fig = margo.surface(z, x=(-1, 1), comm_factory=FakeComm)
        surf = fig.spec["layers"][0]
        self.assertEqual((surf["z"]["shape"], surf["x"], surf["y"], surf["range"]), ([2, 3], [-1.0, 1.0], [0.0, 1.0], [0.0, 5.0]))
        cube = [[[float(x + y + z) for x in range(4)] for y in range(3)] for z in range(2)]
        vol = margo.volume(cube, mode="mip", opacity=[(0, 0), (1, 1)], comm_factory=FakeComm).spec["layers"][0]
        self.assertEqual((vol["dims"], vol["mode"], vol["range"]), ([4, 3, 2], "mip", [0.0, 6.0]))
        iso = margo.isosurface(cube, 2.5, color="#ffcc00", comm_factory=FakeComm).spec["layers"][0]
        self.assertEqual((iso["dims"], iso["level"], iso["color"]), ([4, 3, 2], 2.5, "#ffcc00"))
        with self.assertRaises(ValueError):
            margo.surface([1, 2, 3], comm_factory=FakeComm)
        with self.assertRaises(ValueError):
            margo.volume(z, comm_factory=FakeComm)
        with self.assertRaises(ValueError):
            margo.scatter(x=[1, 2], y=[1], comm_factory=FakeComm)
        with self.assertRaises(ValueError):
            margo.scatter(x=[1], y=[1], colormap="viridis-ish", comm_factory=FakeComm)
        with self.assertRaises(ValueError):
            margo.figure(theme="neon")
        with self.assertRaises(ValueError):
            margo.volume(cube, mode="sum", comm_factory=FakeComm)

    def test_save_html_embeds_the_bundle_and_base64_buffers(self):
        original = figure_module._frontend_bundle
        figure_module._frontend_bundle = lambda: "var MargoFigure = { renderPayload() {} };"
        try:
            page = margo.scatter(x=[1.5, 2], y=[3, 4], comm_factory=FakeComm).to_html(title="Test <page>")
        finally:
            figure_module._frontend_bundle = original
        self.assertIn("<title>Test &lt;page&gt;</title>", page)
        payload = json.loads(page.split('id="margo-spec">')[1].split("</script>")[0])
        self.assertEqual(payload["bufferPaths"][0], ["layers", 0, "x", "buffer"])
        self.assertEqual(floats(base64.b64decode(payload["buffers"][0])), [1.5, 2])

    def test_missing_frontend_bundle_names_the_build_command(self):
        import tempfile

        with tempfile.TemporaryDirectory() as empty:
            with self.assertRaises(FileNotFoundError) as caught:
                figure_module._frontend_bundle(Path(empty))
        self.assertIn("build-frontend.mjs", str(caught.exception))


@unittest.skipIf(np is None, "NumPy is not installed")
class NumPyInputs(unittest.TestCase):
    def test_any_numeric_dtype_and_layout_becomes_contiguous_float32(self):
        a = np.arange(12, dtype=np.int64).reshape(3, 4).T
        encoded = _arrays.encode(a)
        self.assertEqual(encoded.shape, (4, 3))
        self.assertEqual(floats(encoded.data.tobytes()), [float(v) for v in a.ravel()])
        self.assertEqual(_arrays.extent(_arrays.encode(np.array([np.nan, 1.0, 5.0]))), (1.0, 5.0))
        with self.assertRaises(TypeError):
            _arrays.encode(np.array(["a", "b"]))

    def test_volume_from_an_ndarray_keeps_x_fastest(self):
        values = np.random.default_rng(0).random((5, 6, 7), dtype=np.float32)
        layer = margo.volume(values, comm_factory=FakeComm).spec["layers"][0]
        self.assertEqual(layer["dims"], [7, 6, 5])
        self.assertEqual(bytes(layer["values"]["buffer"]), values.astype("<f4").tobytes())


@unittest.skipIf(pd is None, "pandas is not installed")
class PandasInputs(unittest.TestCase):
    def test_scatter_takes_dataframe_column_names(self):
        df = pd.DataFrame({"lon": [1.0, 2.0], "lat": [3.0, 4.0], "mag": [5, 6]})
        fig = margo.scatter(df, x="lon", y="lat", color="mag", comm_factory=FakeComm)
        layer = fig.spec["layers"][0]
        self.assertEqual(floats(bytes(layer["y"]["buffer"])), [3.0, 4.0])
        self.assertEqual(layer["range"], [5.0, 6.0])
        with self.assertRaises(KeyError):
            margo.scatter(df, x="nope", y="lat", comm_factory=FakeComm)


@unittest.skipIf(np is None or pd is None, "NumPy and pandas are not installed")
class ExampleNotebook(unittest.TestCase):
    def test_every_code_cell_of_the_example_notebook_runs(self):
        import os
        import tempfile

        notebook = Path(__file__).resolve().parents[2] / "examples" / "notebooks" / "margo-data.ipynb"
        cells = [c for c in json.loads(notebook.read_text(encoding="utf-8"))["cells"] if c["cell_type"] == "code"]
        original = figure_module._frontend_bundle
        figure_module._frontend_bundle = lambda: "var MargoFigure = { renderPayload() {} };"
        here = os.getcwd()
        try:
            with tempfile.TemporaryDirectory() as folder:
                # Leave the folder before it is removed: Windows cannot delete the current directory.
                os.chdir(folder)
                try:
                    scope = {}
                    for cell in cells:
                        exec(compile("".join(cell["source"]), str(notebook), "exec"), scope)
                    self.assertTrue(Path(folder, "margo-figure.html").exists(), "the notebook saves a page")
                    self.assertEqual(len(scope["fig"].spec["layers"]), 2)
                finally:
                    os.chdir(here)
        finally:
            figure_module._frontend_bundle = original


if __name__ == "__main__":
    unittest.main()
