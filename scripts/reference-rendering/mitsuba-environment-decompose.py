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
shadow ray, so other geometry neither occludes nor reflects. Runs on the CUDA variant (GPU-locked by the caller).
"""
import json
from pathlib import Path
import sys
import numpy as np
import mitsuba as mi
import drjit as dr

mi.set_variant('cuda_ad_rgb')
import mitsuba_gltf  # noqa: E402  (after the variant)

folder = Path(sys.argv[1])
ALPHA_MIN = 1e-3  # GGX alpha floor for roughness 0 (a mirror to float precision); Mitsuba's principled clamps too.


def ggx_d(alpha, nh):
    a2 = alpha * alpha
    t = nh * nh * (a2 - 1) + 1
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
    specular = fresnel * vis * ggx_d(alpha, h.z)
    return dr.select(nl > 0, (diffuse + specular) * nl, 0)


class Unoccluded(mi.SamplingIntegrator):
    def __init__(self, props):
        mi.SamplingIntegrator.__init__(self, props)
        self.model = props.get('model', 'principled')
        self.radiance = mi.Color3f(props.get('radiance'))

    def sample(self, scene, sampler, ray, medium=None, active=True):
        si = scene.ray_intersect(ray, active)
        valid = active & si.is_valid()
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
            a2 = alpha * alpha
            vis = 0.5 / (wo.z * dr.sqrt(wi.z * wi.z * (1 - a2) + a2) + wi.z * dr.sqrt(wo.z * wo.z * (1 - a2) + a2))
            g = ggx_d(alpha, m.z) * vis * wo.z / pdf
            fc = dr.power(1 - dr.clip(dr.dot(wi, m), 0, 1), 5)
            return mi.Spectrum(dr.select(ok, mi.Color3f(g * (1 - fc), g * fc, 0), 0)), valid, []
        wo = dr.select(choose < 0.5, mi.warp.square_to_cosine_hemisphere(u), mi.reflect(wi, m))
        h = dr.normalize(wi + wo)
        pdf_specular = distribution.pdf(wi, h) / (4 * dr.abs(dr.dot(wo, h)))
        pdf = 0.5 * mi.warp.square_to_cosine_hemisphere_pdf(wo) + 0.5 * pdf_specular
        ok = valid & (wo.z > 0) & (wi.z > 0) & (pdf > 0)
        value = gltf_eval(color, metallic, alpha, wi, wo) / pdf
        return mi.Spectrum(dr.select(ok, self.radiance * value, 0)), valid, []


mi.register_integrator('unoccluded', lambda props: Unoccluded(props))


def render(name, samples, seed, model, write=True):
    settings, objects, counts = mitsuba_gltf.load(mi, folder, material_attributes=model not in (None, 'principled'))
    integrator = ({'type': 'path', 'max_depth': 2, 'hide_emitters': True} if model is None else
                  {'type': 'unoccluded', 'model': model, 'radiance': settings['environment']})
    scene = mi.load_dict({'type': 'scene', **objects, 'integrator': integrator,
                          'environment': {'type': 'constant', 'radiance': {'type': 'rgb', 'value': settings['environment']}},
                          'sensor': mitsuba_gltf.sensor(mi, settings, samples)})
    image = mi.render(scene, seed=seed, spp=samples)
    values = np.asarray(image, dtype='<f4')
    assert values.shape == (settings['height'], settings['width'], 3) and np.isfinite(values).all()
    if write:
        save(name, values, image, counts, samples, seed, model)
    return settings, counts, values


def save(name, values, image, counts, samples, seed, model):
    values.astype('<f4').tofile(folder / ('mitsuba-' + name + '-rgb.f32'))
    mi.Bitmap(image).write(str(folder / ('mitsuba-' + name + '.exr')))
    (folder / ('mitsuba-' + name + '-meta.json')).write_text(json.dumps({
        'version': mi.__version__, 'variant': mi.variant(), **counts, 'samples': samples, 'seed': seed,
        'maxDepth': 2, 'mode': name, 'visibility': model is None, 'bsdf': model or 'principled',
        'alphaMin': None if model in (None, 'principled') else ALPHA_MIN}))
    print('REFERENCE', name, counts, flush=True)


for name, samples, seed, model in [
    ('principled-direct-1024', 1024, 161, None),
    ('principled-unoccluded-1024', 1024, 162, 'principled'),
    ('gltf-unoccluded-1024', 1024, 163, 'gltf'),
]:
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
