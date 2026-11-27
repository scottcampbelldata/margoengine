"""KB3563 decomposition references for the environment furnace (public Mitsuba APIs, standard glTF bytes only).

Each picture removes one difference between Margo's split-sum IBL and the frozen Mitsuba direct reference:
  principled-direct-1024     the frozen direct integrator (path, max depth 2) at 1024 spp: reference noise
  principled-unoccluded-1024 the same principled BSDF lit by the constant environment with no visibility test
  gltf-unoccluded-1024       the glTF 2.0 metal/rough BRDF (specification appendix B: Lambert diffuse, Schlick
                             Fresnel, GGX with height-correlated Smith visibility), no visibility test
  split-model-unoccluded-1024 the split-sum ambient model with multiple-scattering compensation (Karis 2013 scale
                             and bias; Fdez-Aguera 2019), its directional albedo terms A and B integrated per pixel
                             by Monte Carlo instead of read from a table: what the model gives with exact integrals
The unoccluded pictures are one-bounce estimates: radiance E times the BSDF-sampled weight f cos / pdf, with no
shadow ray, so other geometry neither occludes nor reflects.

Runs on the scalar_rgb variant, so a rerun gives the same float32 bytes (KB-REF-DECOMP-CUDA1): the CUDA variant adds a
pixel's samples in a parallel order that is not fixed, so its raw files differed from run to run. Each picture is the
mean of CHUNKS renders of SAMPLES / CHUNKS samples with their own seeds, run in parallel processes and averaged in chunk
order in float64, since the scalar variant calls these Python integrators once a sample under one interpreter lock.
"""
import json
from pathlib import Path
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
import os
import numpy as np
import mitsuba as mi
import drjit as dr

VARIANT = 'scalar_rgb'
CHUNKS = 8
mi.set_variant(VARIANT)
import mitsuba_gltf  # noqa: E402  (after the variant)

folder = Path(sys.argv[1])
ALPHA_MIN = 1e-3  # GGX alpha floor for roughness 0 (a mirror to float precision); Mitsuba's principled clamps too.


def ggx_d(alpha, m):
    """GGX D for a unit half vector m in the local frame (z is the normal), with the denominator written
    |n x m|^2 + a2 (n.m)^2 (equal to (n.m)^2 (a2 - 1) + 1 for unit vectors): in float32 the expanded form cancels
    near the normal, so at the alpha floor 1e-3 the albedo integral came out 0.896 instead of 1 (KB6016b), as
    core's KB6016c. Walter et al. 2007, eq. 33."""
    a2 = alpha * alpha
    t = m.x * m.x + m.y * m.y + a2 * m.z * m.z
    return a2 / (dr.pi * t * t)


def gltf_eval(color, metallic, alpha, wi, wo):
    """glTF 2.0 appendix B BRDF times cos(wo), local shading frame (z is the normal)."""
    nv, nl = wi.z, wo.z
    h = dr.normalize(wi + wo)
    vh = dr.clip(dr.dot(wi, h), 0, 1)
    f0 = dr.lerp(mi.Color3f(0.04), color, metallic)
    fresnel = f0 + (1 - f0) * dr.power(1 - vh, 5)
    diffuse = (1 - fresnel) * dr.lerp(color, mi.Color3f(0), metallic) / dr.pi
    a2 = alpha * alpha
    vis = 0.5 / (nl * dr.sqrt(nv * nv * (1 - a2) + a2) + nv * dr.sqrt(nl * nl * (1 - a2) + a2))
    specular = fresnel * vis * ggx_d(alpha, h)
    return dr.select(nl > 0, (diffuse + specular) * nl, 0)


class Unoccluded(mi.SamplingIntegrator):
    def __init__(self, props):
        mi.SamplingIntegrator.__init__(self, props)
        self.model = props.get('model', 'principled')
        self.radiance = mi.Color3f(props.get('radiance'))

    def sample(self, scene, sampler, ray, medium=None, active=True):
        si = scene.ray_intersect(ray, active)
        valid = active & si.is_valid()
        if not valid:  # scalar variant: one ray a call, and a miss has no shape to read
            return mi.Spectrum(0.0), False, []
        if self.model == 'principled':
            bsdf = si.bsdf(ray)
            bs, weight = bsdf.sample(mi.BSDFContext(), si, sampler.next_1d(valid), sampler.next_2d(valid), valid)
            result = dr.select(valid & (bs.pdf > 0), self.radiance * weight, 0)
            return mi.Spectrum(result), valid, []
        if self.model == 'base':
            return mi.Spectrum(dr.select(valid, si.shape.eval_attribute_3('vertex_gltf_color', si, valid), 0)), valid, []
        if self.model == 'factors':
            factors = si.shape.eval_attribute_3('vertex_gltf_factors', si, valid)
            return mi.Spectrum(dr.select(valid, mi.Color3f(factors.x, factors.y, 1), 0)), valid, []
        color = si.shape.eval_attribute_3('vertex_gltf_color', si, valid)
        factors = si.shape.eval_attribute_3('vertex_gltf_factors', si, valid)
        metallic = factors.x
        alpha = dr.maximum(factors.y * factors.y, ALPHA_MIN)
        wi = mi.Vector3f(si.wi.x, si.wi.y, dr.abs(si.wi.z))
        distribution = mi.MicrofacetDistribution(mi.MicrofacetType.GGX, alpha, True)
        choose = sampler.next_1d(valid)
        u = sampler.next_2d(valid)
        m, _ = distribution.sample(wi, u)
        if self.model == 'albedo':
            # Split-sum directional albedo: A = integral of the F = 1 specular lobe times (1 - Fc), B times Fc,
            # with Fc = (1 - v.h)^5 (Karis 2013), sampled from the visible normals.
            wo = mi.reflect(wi, m)
            pdf = distribution.pdf(wi, m) / (4 * dr.abs(dr.dot(wo, m)))
            ok = valid & (wo.z > 0) & (wi.z > 0) & (pdf > 0)
            if not ok:  # scalar variant: a zero pdf raises where the vector variants mask an infinity
                return mi.Spectrum(0.0), valid, []
            a2 = alpha * alpha
            vis = 0.5 / (wo.z * dr.sqrt(wi.z * wi.z * (1 - a2) + a2) + wi.z * dr.sqrt(wo.z * wo.z * (1 - a2) + a2))
            g = ggx_d(alpha, m) * vis * wo.z / pdf
            fc = dr.power(1 - dr.clip(dr.dot(wi, m), 0, 1), 5)
            return mi.Spectrum(dr.select(ok, mi.Color3f(g * (1 - fc), g * fc, 0), 0)), valid, []
        wo = dr.select(choose < 0.5, mi.warp.square_to_cosine_hemisphere(u), mi.reflect(wi, m))
        h = dr.normalize(wi + wo)
        pdf_specular = distribution.pdf(wi, h) / (4 * dr.abs(dr.dot(wo, h)))
        pdf = 0.5 * mi.warp.square_to_cosine_hemisphere_pdf(wo) + 0.5 * pdf_specular
        ok = valid & (wo.z > 0) & (wi.z > 0) & (pdf > 0)
        if not ok:
            return mi.Spectrum(0.0), valid, []
        value = gltf_eval(color, metallic, alpha, wi, wo) / pdf
        return mi.Spectrum(dr.select(ok, self.radiance * value, 0)), valid, []


mi.register_integrator('unoccluded', lambda props: Unoccluded(props))


def scene_for(samples, model):
    settings, objects, counts = mitsuba_gltf.load(mi, folder, material_attributes=model not in (None, 'principled'))
    integrator = ({'type': 'path', 'max_depth': 2, 'hide_emitters': True} if model is None else
                  {'type': 'unoccluded', 'model': model, 'radiance': settings['environment']})
    scene = mi.load_dict({'type': 'scene', **objects, 'integrator': integrator,
                          'environment': {'type': 'constant', 'radiance': {'type': 'rgb', 'value': settings['environment']}},
                          'sensor': mitsuba_gltf.sensor(mi, settings, samples)})
    return settings, counts, scene


def chunk(name, samples, seed, model, index):
    """One chunk, in its own process: SAMPLES / CHUNKS samples with seed seed * CHUNKS + index."""
    settings, _, scene = scene_for(samples // CHUNKS, model)
    image = mi.render(scene, seed=seed * CHUNKS + index, spp=samples // CHUNKS)
    values = np.asarray(image, dtype='<f4')
    assert values.shape == (settings['height'], settings['width'], 3) and np.isfinite(values).all()
    values.tofile(parts / f'{name}-{index}.f32')


def render(name, samples, seed, model, write=True):
    """The mean of the CHUNKS chunks of `name`, which run_chunks has written, in chunk order."""
    settings, counts, _ = scene_for(samples, model)
    shape = (settings['height'], settings['width'], 3)
    total = np.zeros(shape, np.float64)
    for index in range(CHUNKS):
        total += np.fromfile(parts / f'{name}-{index}.f32', dtype='<f4').reshape(shape)
    values = (total / CHUNKS).astype('<f4')
    assert np.isfinite(values).all()
    if write:
        save(name, values, mi.TensorXf(values), counts, samples, seed, model)
    return settings, counts, values


def run_chunks(jobs):
    """Every chunk of every job, each in a fresh process of this script, as many at once as the machine has cores."""
    def one(job):
        name, samples, seed, model, index = job
        subprocess.run([sys.executable, __file__, str(folder), 'chunk', name, str(samples), str(seed),
                        model or '', str(index)], check=True)
    with ThreadPoolExecutor(max_workers=max(1, (os.cpu_count() or 2) - 1)) as pool:
        list(pool.map(one, [(*job, index) for job in jobs for index in range(CHUNKS)]))


def save(name, values, image, counts, samples, seed, model):
    values.astype('<f4').tofile(folder / ('mitsuba-' + name + '-rgb.f32'))
    mi.Bitmap(image).write(str(folder / ('mitsuba-' + name + '.exr')))
    (folder / ('mitsuba-' + name + '-meta.json')).write_text(json.dumps({
        'version': mi.__version__, 'variant': mi.variant(), **counts, 'samples': samples, 'seed': seed,
        'chunks': CHUNKS,
        'maxDepth': 2, 'mode': name, 'visibility': model is None, 'bsdf': model or 'principled',
        'alphaMin': None if model in (None, 'principled') else ALPHA_MIN}))
    print('REFERENCE', name, counts, flush=True)


parts = folder / 'chunks'
if len(sys.argv) > 2 and sys.argv[2] == 'chunk':
    name, samples, seed, model, index = sys.argv[3:8]
    chunk(name, int(samples), int(seed), model or None, int(index))
    sys.exit(0)
parts.mkdir(exist_ok=True)
pictures = [
    ('principled-direct-1024', 1024, 161, None),
    ('principled-unoccluded-1024', 1024, 162, 'principled'),
    ('gltf-unoccluded-1024', 1024, 163, 'gltf'),
]
terms = [('albedo', 1024, 164, 'albedo'), ('base', 1024, 164, 'base'), ('factors', 1024, 164, 'factors')]
run_chunks(pictures + terms)
for name, samples, seed, model in pictures:
    render(name, samples, seed, model)

# Split-sum model with exact A and B: averaged per pixel over the covered area, then composed as the model composes
# them (f90 1, dielectric F0 0.04, Fdez-Aguera 2019 multiple scattering), and weighted by coverage again.
settings, counts, albedo = render('albedo', 1024, 164, 'albedo', write=False)
_, _, base = render('base', 1024, 164, 'base', write=False)
_, _, factors = render('factors', 1024, 164, 'factors', write=False)
coverage = factors[..., 2:3]
inside = np.maximum(coverage, 1e-6)
a, b = albedo[..., 0:1] / inside, albedo[..., 1:2] / inside
color, metal = base / inside, factors[..., 0:1] / inside
f0 = 0.04 + (color - 0.04) * metal
single = f0 * a + b
lost = 1 - (a + b)
favg = f0 + (1 - f0) / 21
# A white metal (f0 = favg = 1) at a grazing pixel whose samples all missed has A + B = 0: the term's limit
# there is lost (single / (1 - lost) = 1), as the model gives for a vanishing single-scattering albedo.
denominator = 1 - lost * favg
multiple = np.where(denominator > 1e-9, single * favg / np.maximum(denominator, 1e-9) * lost, lost)
diffuse = (1 - single - multiple) * (1 - metal) * color
composed = np.asarray(settings['environment'], np.float32) * (single + multiple + diffuse) * coverage
composed = np.where(coverage > 0, composed, 0).astype('<f4')
assert np.isfinite(composed).all()
save('split-model-unoccluded-1024', composed, mi.TensorXf(composed), counts, 1024, 164, 'split-model')
