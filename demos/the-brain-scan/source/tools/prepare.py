"""Prepare a registered MRI/CT display pair from the attributed Zenodo NIfTI files.

Run this offline with NumPy and SciPy:
python prepare.py PATH_TO_PAIR PATH_TO_ASSETS
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import struct

import numpy as np
from scipy.ndimage import gaussian_filter, zoom

def read_nifti(path):
    with gzip.open(path, 'rb') as source:
        header = source.read(352)
        if len(header) < 352 or header[344:348] != b'n+1\0':
            raise ValueError(f'{path.name}: expected a single-file NIfTI-1 volume')
        endian = '<' if struct.unpack_from('<i', header)[0] == 348 else '>'
        if struct.unpack_from(endian + 'i', header)[0] != 348:
            raise ValueError(f'{path.name}: NIfTI header length')
        dims = struct.unpack_from(endian + '4h', header, 40)
        datatype, bit_width = struct.unpack_from(endian + '2h', header, 70)
        start, slope, offset = struct.unpack_from(endian + '3f', header, 108)
        planes = struct.unpack_from(endian + '12f', header, 280)
        units = header[123] & 7
        if dims[0] != 3 or units != 2 or not struct.unpack_from(endian + 'h', header, 254)[0]:
            raise ValueError(f'{path.name}: expected a 3D grid with an sform in mm')
        dtype = np.dtype(endian + {4: 'i2', 16: 'f4'}[datatype])
        if dtype.itemsize * 8 != bit_width or start < 352:
            raise ValueError(f'{path.name}: unexpected voxel layout')
        source.seek(int(start))
        raw = source.read(np.prod(dims[1:]) * dtype.itemsize)
    affine = np.vstack((np.array(planes).reshape(3, 4), [0, 0, 0, 1]))
    values = np.frombuffer(raw, dtype=dtype).reshape(tuple(reversed(dims[1:])))
    # Source indices increase towards L, P and S. Display axes increase R, A
    # and S. The returned array is C-ordered with display X fastest.
    if not np.allclose(affine[:3, :3], np.diag([-.5, -.5, .5])):
        raise ValueError(f'{path.name}: unexpected source orientation')
    rotated = np.ascontiguousarray(values[:, ::-1, ::-1], dtype=np.float32)
    rotated *= slope if slope else 1.0
    rotated += offset if slope else 0.0
    return rotated, affine, list(dims[1:])

def resample(data, factor, sigma):
    shape = [round((n - 1) / factor) + 1 for n in data.shape]
    sampled = zoom(gaussian_filter(data, sigma, mode='nearest'), np.array(shape) / data.shape,
                   order=1, prefilter=False, mode='nearest', grid_mode=False)
    return sampled

def write_data(path, values):
    packed = gzip.compress(values.tobytes(order='C'), compresslevel=9, mtime=0)
    path.write_bytes(packed)
    return {'dims': list(reversed(values.shape)), 'bytes': len(packed),
            'sha256': hashlib.sha256(packed).hexdigest()}

def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('pair', type=Path)
    parser.add_argument('assets', type=Path)
    args = parser.parse_args()
    pair = json.loads(Path(__file__).with_name('original-pair.json').read_text(encoding='utf-8'))
    args.assets.mkdir(parents=True, exist_ok=True)
    values, affine, source_dims = read_nifti(args.pair / 'CE-T1W.nii.gz')
    extent = [(n - 1) * 0.5 for n in reversed(values.shape)]
    mr = resample(values, 3, .88)
    del values
    foreground = mr[(mr > 0) & np.isfinite(mr)]
    window = float(np.percentile(foreground, 99.65))
    stored_mr = np.rint(np.nan_to_num(mr).clip(0, window) * (255 / window)).astype(np.uint8)
    del mr, foreground
    mr_meta = write_data(args.assets / 'mri.bin', stored_mr)
    mr_meta.update(displayWindow=[0, window], role='MRI CE-T1W', scalar='relative intensity')
    initial = np.rint(resample(stored_mr.astype(np.float32), 2.65, .52)).astype(np.uint8)
    initial_meta = write_data(args.assets / 'mri-opening.bin', initial)
    del stored_mr, initial

    values, ct_affine, ct_original_shape = read_nifti(args.pair / 'CT-BONE.nii.gz')
    if source_dims != ct_original_shape or not np.array_equal(affine, ct_affine):
        raise ValueError('Original CT and MRI grids differ in geometry')
    ct = resample(values, 4, .93)
    del values
    stored_ct = np.rint(ct.clip(-1024, 3071) / 4).astype('<i2')
    del ct
    ct_meta = write_data(args.assets / 'ct.bin', stored_ct)
    ct_meta.update(huPerUnit=4, rangeHU=[-1024, 3072], role='CT-BONE')
    del stored_ct

    paths = [args.pair / name for name in ['CE-T1W.nii.gz', 'CT-BONE.nii.gz']]
    for path in paths:
        kind = path.name.removesuffix('.nii.gz')
        if pair['pair'][kind]['sha256'] != file_hash(path):
            raise ValueError(f'Source hash mismatch for {kind}')
    meta = {'record':pair['record'], 'sample':pair['sample'], 'cohort':'cerebrovascular-disease',
            'license':'CC-BY-4.0', 'originalDims':source_dims, 'originalSpacingMM':[.5,.5,.5],
            'axes':['right','anterior','superior'], 'extentMM':extent, 'originalSform':affine.tolist(),
            'mri':mr_meta, 'initial':initial_meta, 'ct':ct_meta, 'originalSHA256':{p.name:file_hash(p) for p in paths}}
    (args.assets / 'pair.json').write_text(json.dumps(meta, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(meta))
