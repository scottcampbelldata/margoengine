"""Binary transport, precision, portable state and offline output of the AFM wrapper."""
import base64
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from margoengine.notebook import NotebookFigure
from ipywidgets.widgets.widget import _remove_buffers


def test_numpy_borrowing_binary_comm_and_explicit_refresh():
    x = np.arange(12, dtype=np.float64)[2:8]
    fig = NotebookFigure(options={"axes": False}).add("scatter", {"x": x, "y": x})
    assert np.shares_memory(np.frombuffer(fig.buffers["b0"], dtype="<f8"), x)
    state, paths, buffers = _remove_buffers(fig.get_state())
    assert ["buffers", "b0"] in paths
    assert len(buffers) == 2
    assert "$buffer" in json.dumps(state["spec"])
    assert base64.b64encode(x).decode() not in json.dumps(state["spec"])
    x[0] = 42
    prior = fig.spec["resources"][0]["args"][0]["x"]["sha256"]
    fig.refresh()
    assert prior != fig.spec["resources"][0]["args"][0]["x"]["sha256"]
    portable = fig.to_spec()["resources"][0]["args"][0]["x"]
    assert hashlib.sha256(base64.b64decode(portable["bytes"])).hexdigest() == portable["sha256"]
    fig.close()


def test_arrow_offsets_chunks_nulls_and_exact_integer_policy():
    source = pa.array([9.0, 1.25, 3.5, 8.0], type=pa.float64()).slice(1, 2)
    fig = NotebookFigure().add("line", {"x": source, "y": pa.chunked_array([source])})
    assert np.frombuffer(fig.buffers["b0"], dtype="<f8").ctypes.data == source.buffers()[1].address + 8
    assert np.frombuffer(fig.buffers["b1"], dtype="<f8").ctypes.data == source.buffers()[1].address + 8
    fig.add("scatter", {"x": pa.array([1, None, 3]), "y": np.arange(3, dtype=np.int32)})
    assert np.isnan(np.frombuffer(fig.buffers["b2"], dtype="<f8")[1])
    fig.add("scatter", {"x": pa.chunked_array([[1.0], [2.0]]), "y": [1, 2]})
    assert list(np.frombuffer(fig.buffers["b4"], dtype="<f8")) == [1, 2]
    with pytest.raises(ValueError, match="exact JavaScript"):
        fig.add("scatter", {"x": np.array([2**53+1], dtype=np.int64)})
    with pytest.raises(TypeError, match="real numeric"):
        fig.add("scatter", {"x": np.array(["x"])})
    fig.close()


def test_noncontiguous_endian_arrays_and_transaction_failure():
    x = np.arange(12, dtype=">f4").reshape(3, 4)[:, ::2]
    fig = NotebookFigure().add("surface", x, {"nx": 2, "ny": 3})
    assert list(np.frombuffer(fig.buffers["b0"], dtype="<f4")) == list(x.ravel())
    previous = fig.to_spec()
    with pytest.raises(TypeError):
        fig.add("scatter", {"x": np.ones(3), "y": object()})
    assert fig.to_spec() == previous
    assert list(fig.buffers) == ["b0"]
    fig.close()


def test_camera_selection_and_offline_html(tmp_path):
    fig = NotebookFigure().add("scatter", {"x": [0, 1], "y": [0, 1]})
    fig.camera = {**fig.spec["camera"], "position": [1, 2, 3]}
    fig.selection = {"region": {"rect": [0, 0, 100, 100]}, "points": [{"layer": 0, "indices": np.array([1], dtype="<u4")}]}
    portable = fig.to_spec()
    assert portable["camera"]["position"] == [1, 2, 3]
    assert portable["selection"]["points"][0]["layer"] == {"$ref": "r0"}
    assert base64.b64decode(portable["selection"]["points"][0]["indices"]["bytes"]) == b"\x01\x00\x00\x00"
    fig.save_html(tmp_path / "plot.html", title="</script><img>")
    page = (tmp_path / "plot.html").read_text()
    assert '<title>&lt;/script&gt;&lt;img&gt;</title>' in page
    assert 'data:text/javascript;base64,' in page
    assert 'https://cdn' not in page
    fig.close()
