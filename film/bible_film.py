"""
Renders the Despertar Bible journey as a movie-quality frame sequence.

The geometry and timing are a direct port of src/bible.js, src/cinema.js and
src/timeline.js, so frame f shows exactly what the live site showed at scroll
progress P = f / (frames - 1).

Usage (Blender 5.x, background mode):
  blender -b --factory-startup --python film/bible_film.py -- \
      --lang es --frames 300 --res 1920x1080 --samples 96 --out film/out/es

  Test single moments instead of a sequence:
  ... -- --lang es --at 0.02,0.3,0.87 --res 960x540 --out film/test

Already rendered frames are skipped, so a long render can be resumed.
"""
import bpy
import bmesh
import math
import os
import sys
import argparse
from mathutils import Vector, Quaternion

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TEX = os.path.join(ROOT, 'public', 'textures')
PAGES = os.path.join(HERE, 'textures')

# ---------------------------------------------------------------- arguments
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('--lang', default='es')
ap.add_argument('--frames', type=int, default=300)
ap.add_argument('--start', type=int, default=0)
ap.add_argument('--end', type=int, default=-1)
ap.add_argument('--at', default='')
ap.add_argument('--res', default='1920x1080')
ap.add_argument('--samples', type=int, default=96)
ap.add_argument('--quality', type=int, default=82)
ap.add_argument('--beam', type=int, default=1)
ap.add_argument('--out', default=os.path.join(HERE, 'out'))
ap.add_argument('--blend', default='')
ap.add_argument('--sky', default=os.path.join(HERE, 'sky', 'heaven.exr'))
ap.add_argument('--no-bloom', action='store_true')
ap.add_argument('--sky-rot', type=float, default=-90.0)
args = ap.parse_args(argv)

# ---------------------------------------------------------------- timeline (src/timeline.js)
N_LEAVES = 5
T = dict(arrivalEnd=0.1, openStart=0.1, openEnd=0.25, firstTurn=0.325, turnEvery=0.09,
         turnLength=0.04, brightStart=0.795, brightEnd=0.86, fadeStart=0.9)


def clamp01(x):
    return min(1.0, max(0.0, x))


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(t):
    t = clamp01(t)
    return t * t * (3 - 2 * t)


def smoother(t):
    t = clamp01(t)
    return t * t * t * (t * (t * 6 - 15) + 10)


def rng(p, a, b):
    return clamp01((p - a) / (b - a))


def spread_window(k):
    start = T['openEnd'] - 0.02 if k == 0 else T['firstTurn'] + (k - 1) * T['turnEvery'] + T['turnLength']
    end = 0.8 if k == N_LEAVES else T['firstTurn'] + k * T['turnEvery']
    return start, end


def turn_progress(p, i):
    s = T['firstTurn'] + i * T['turnEvery']
    return rng(p, s, s + T['turnLength'])


# ---------------------------------------------------------------- book geometry (src/bible.js)
PW, PH, S, CT = 1.0, 1.46, 0.21, 0.022
CW, CH = PW + 0.04, PH + 0.08
EPS, TL = 0.0016, 0.08
TR = S - TL - (N_LEAVES + 1) * EPS
ALPHA, NS = 1.15, 48
DS = PW / NS
BELLY = 0.045
DESCENT = 1.1          # how far above the table the Bible starts


def sine_integral(x):
    s, term = 0.0, x
    for k in range(12):
        s += term / (2 * k + 1)
        term *= (-x * x) / ((2 * k + 2) * (2 * k + 3))
    return s


def rest_angles(rise, alpha):
    if rise < 1e-5 or alpha < 1e-4:
        return [0.0] * NS
    lam = rise / sine_integral(alpha)
    belly = BELLY * (alpha / ALPHA)
    out = []
    for i in range(NS):
        e = math.exp(-((i + 0.5) * DS) / lam)
        out.append(alpha * e - belly * (1 - e))
    return out


# ---------------------------------------------------------------- scene helpers
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def empty(name, parent=None, loc=(0, 0, 0)):
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    o.parent = parent
    o.location = loc
    return o


def mesh_obj(name, verts, faces, parent=None, mats=(), smooth_faces=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    for m in mats:
        me.materials.append(m)
    for p in me.polygons:
        p.use_smooth = smooth_faces
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.parent = parent
    return o


def set_verts(obj, verts):
    flat = [c for v in verts for c in v]
    obj.data.vertices.foreach_set('co', flat)
    obj.data.update()


def set_uvs(obj, uv_for_vertex):
    me = obj.data
    uv = me.uv_layers.new(name='UVMap') if not me.uv_layers else me.uv_layers[0]
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            uv.data[li].uv = uv_for_vertex(vi, me.vertices[vi].co)


def image(path, colorspace='sRGB'):
    img = bpy.data.images.load(path, check_existing=True)
    try:
        img.colorspace_settings.name = colorspace
    except TypeError:
        img.colorspace_settings.name = 'Non-Color' if colorspace != 'sRGB' else 'sRGB'
    return img


ALIASES = {'Fac': ('Fac', 'Factor'), 'Factor': ('Factor', 'Fac')}


def sock(node, name, kind=None, out=False):
    for nm in ALIASES.get(name, (name,)):
        for s in (node.outputs if out else node.inputs):
            if s.name == nm and (kind is None or s.type == kind):
                return s
    raise KeyError(f'{node.bl_idname} has no {"output" if out else "input"} {name} ({kind})')


class Nodes:
    """Small helper for building shader node trees."""

    def __init__(self, tree):
        self.t = tree
        self.n = tree.nodes
        self.l = tree.links
        for nd in list(self.n):
            self.n.remove(nd)

    def add(self, kind, **props):
        nd = self.n.new(kind)
        for k, v in props.items():
            setattr(nd, k, v)
        return nd

    def link(self, a, b):
        self.l.new(a, b)

    def mul_color(self, color_socket, rgb):
        m = self.add('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
        sock(m, 'Factor', 'VALUE').default_value = 1.0
        self.link(color_socket, sock(m, 'A', 'RGBA'))
        sock(m, 'B', 'RGBA').default_value = (*rgb, 1)
        return sock(m, 'Result', 'RGBA', out=True)


def principled(nd):
    return nd.add('ShaderNodeBsdfPrincipled')


# ---------------------------------------------------------------- materials
def leather_material(name, tint, scale):
    mat = bpy.data.materials.new(name)
    nd = Nodes(mat.node_tree)
    out = nd.add('ShaderNodeOutputMaterial')
    bsdf = principled(nd)
    tc = nd.add('ShaderNodeTexCoord')
    mp = nd.add('ShaderNodeMapping')
    sock(mp, 'Scale').default_value = (scale, scale, scale)
    nd.link(sock(tc, 'Object', out=True), sock(mp, 'Vector'))
    col = nd.add('ShaderNodeTexImage', image=image(os.path.join(TEX, 'leather-color.jpg')), projection='BOX', projection_blend=0.25)
    nor = nd.add('ShaderNodeTexImage', image=image(os.path.join(TEX, 'leather-normal.jpg'), 'Non-Color'), projection='BOX', projection_blend=0.25)
    rgh = nd.add('ShaderNodeTexImage', image=image(os.path.join(TEX, 'leather-rough.jpg'), 'Non-Color'), projection='BOX', projection_blend=0.25)
    for t in (col, nor, rgh):
        nd.link(sock(mp, 'Vector', out=True), sock(t, 'Vector'))
    nd.link(nd.mul_color(sock(col, 'Color', out=True), tint), sock(bsdf, 'Base Color'))
    rm = nd.add('ShaderNodeMath', operation='MULTIPLY_ADD')
    nd.link(sock(rgh, 'Color', out=True), rm.inputs[0])
    rm.inputs[1].default_value = 0.85
    rm.inputs[2].default_value = 0.05
    nd.link(rm.outputs[0], sock(bsdf, 'Roughness'))
    nm = nd.add('ShaderNodeNormalMap')
    sock(nm, 'Strength').default_value = 1.2
    nd.link(sock(nor, 'Color', out=True), sock(nm, 'Color'))
    nd.link(sock(nm, 'Normal', out=True), sock(bsdf, 'Normal'))
    sock(bsdf, 'Coat Weight').default_value = 0.08
    sock(bsdf, 'Coat Roughness').default_value = 0.45
    sock(bsdf, 'Sheen Weight').default_value = 0.04
    nd.link(sock(bsdf, 'BSDF', out=True), sock(out, 'Surface'))
    return mat, nd, bsdf, nm


def titled_material(lang):
    """Leather with the gold-foil title and frame stamped into it."""
    mat, nd, leather, nm = leather_material('Cover', (0.42, 0.32, 0.25), 1.54)
    out = [n for n in nd.n if n.bl_idname == 'ShaderNodeOutputMaterial'][0]
    tc = nd.add('ShaderNodeTexCoord')
    mask_img = nd.add('ShaderNodeTexImage', image=image(os.path.join(PAGES, f'cover_{lang}_orm.png'), 'Non-Color'))
    nd.link(sock(tc, 'UV', out=True), sock(mask_img, 'Vector'))
    sep = nd.add('ShaderNodeSeparateColor')
    nd.link(sock(mask_img, 'Color', out=True), sep.inputs[0])
    ramp = nd.add('ShaderNodeMath', operation='GREATER_THAN')
    nd.link(sock(sep, 'Blue', out=True), ramp.inputs[0])
    ramp.inputs[1].default_value = 0.5
    gold = principled(nd)
    sock(gold, 'Base Color').default_value = (1.0, 0.68, 0.28, 1)
    sock(gold, 'Metallic').default_value = 0.7
    sock(gold, 'Roughness').default_value = 0.38
    # the foil is pressed slightly into the leather
    bump = nd.add('ShaderNodeBump')
    sock(bump, 'Strength').default_value = 0.6
    sock(bump, 'Distance').default_value = 0.002
    inv = nd.add('ShaderNodeMath', operation='SUBTRACT')
    inv.inputs[0].default_value = 1.0
    nd.link(sock(sep, 'Blue', out=True), inv.inputs[1])
    nd.link(inv.outputs[0], sock(bump, 'Height'))
    nd.link(sock(nm, 'Normal', out=True), sock(bump, 'Normal'))
    nd.link(sock(bump, 'Normal', out=True), sock(gold, 'Normal'))
    mix = nd.add('ShaderNodeMixShader')
    nd.link(ramp.outputs[0], mix.inputs[0])
    nd.link(sock(leather, 'BSDF', out=True), mix.inputs[1])
    nd.link(sock(gold, 'BSDF', out=True), mix.inputs[2])
    nd.link(mix.outputs[0], sock(out, 'Surface'))
    return mat


def page_material(name, front, back=None, rotate=False):
    """Paper: printed image, fibre relief, light passing through thin sheets."""
    mat = bpy.data.materials.new(name)
    nd = Nodes(mat.node_tree)
    out = nd.add('ShaderNodeOutputMaterial')
    tc = nd.add('ShaderNodeTexCoord')
    uv = sock(tc, 'UV', out=True)
    if rotate:
        mp = nd.add('ShaderNodeMapping')
        sock(mp, 'Rotation').default_value = (0, 0, math.pi)
        sock(mp, 'Location').default_value = (1, 1, 0)
        nd.link(uv, sock(mp, 'Vector'))
        uv = sock(mp, 'Vector', out=True)
    f_img = nd.add('ShaderNodeTexImage', image=image(front), interpolation='Cubic')
    nd.link(uv, sock(f_img, 'Vector'))
    color = sock(f_img, 'Color', out=True)
    if back:
        flip = nd.add('ShaderNodeMapping')
        sock(flip, 'Scale').default_value = (-1, 1, 1)
        sock(flip, 'Location').default_value = (1, 0, 0)
        nd.link(sock(tc, 'UV', out=True), sock(flip, 'Vector'))
        b_img = nd.add('ShaderNodeTexImage', image=image(back), interpolation='Cubic')
        nd.link(sock(flip, 'Vector', out=True), sock(b_img, 'Vector'))
        back_color = sock(b_img, 'Color', out=True)
        # thin Bible paper: the other side's print shows through faintly
        f_seen = nd.add('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
        sock(f_seen, 'Factor', 'VALUE').default_value = 0.14
        nd.link(color, sock(f_seen, 'A', 'RGBA'))
        nd.link(back_color, sock(f_seen, 'B', 'RGBA'))
        b_seen = nd.add('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
        sock(b_seen, 'Factor', 'VALUE').default_value = 0.14
        nd.link(back_color, sock(b_seen, 'A', 'RGBA'))
        nd.link(color, sock(b_seen, 'B', 'RGBA'))
        geo = nd.add('ShaderNodeNewGeometry')
        m = nd.add('ShaderNodeMix', data_type='RGBA')
        nd.link(sock(geo, 'Backfacing', out=True), sock(m, 'Factor', 'VALUE'))
        nd.link(sock(f_seen, 'Result', 'RGBA', out=True), sock(m, 'A', 'RGBA'))
        nd.link(sock(b_seen, 'Result', 'RGBA', out=True), sock(m, 'B', 'RGBA'))
        color = sock(m, 'Result', 'RGBA', out=True)
    # paper yellows a little toward its edges
    sep = nd.add('ShaderNodeSeparateXYZ')
    nd.link(sock(tc, 'UV', out=True), sep.inputs[0])
    edge = None
    for axis in ('X', 'Y'):
        for flip in (False, True):
            src = sock(sep, axis, out=True)
            if flip:
                inv = nd.add('ShaderNodeMath', operation='SUBTRACT')
                inv.inputs[0].default_value = 1.0
                nd.link(src, inv.inputs[1])
                src = inv.outputs[0]
            if edge is None:
                edge = src
            else:
                mn = nd.add('ShaderNodeMath', operation='MINIMUM')
                nd.link(edge, mn.inputs[0])
                nd.link(src, mn.inputs[1])
                edge = mn.outputs[0]
    age = nd.add('ShaderNodeMapRange')
    nd.link(edge, sock(age, 'Value'))
    sock(age, 'From Max').default_value = 0.07
    sock(age, 'To Min').default_value = 0.0
    sock(age, 'To Max').default_value = 1.0
    aged = nd.add('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
    inv_age = nd.add('ShaderNodeMath', operation='SUBTRACT')
    inv_age.inputs[0].default_value = 1.0
    nd.link(sock(age, 'Result', out=True), inv_age.inputs[1])
    fac = nd.add('ShaderNodeMath', operation='MULTIPLY')
    nd.link(inv_age.outputs[0], fac.inputs[0])
    fac.inputs[1].default_value = 0.55
    nd.link(fac.outputs[0], sock(aged, 'Factor', 'VALUE'))
    nd.link(color, sock(aged, 'A', 'RGBA'))
    sock(aged, 'B', 'RGBA').default_value = (0.86, 0.74, 0.55, 1)
    color = sock(aged, 'Result', 'RGBA', out=True)
    bsdf = principled(nd)
    nd.link(color, sock(bsdf, 'Base Color'))
    sock(bsdf, 'Roughness').default_value = 0.88
    sock(bsdf, 'Sheen Weight').default_value = 0.2
    nmimg = nd.add('ShaderNodeTexImage', image=image(os.path.join(TEX, 'paper-normal.jpg'), 'Non-Color'))
    sc = nd.add('ShaderNodeMapping')
    sock(sc, 'Scale').default_value = (1.7, 2.5, 1)
    nd.link(sock(tc, 'UV', out=True), sock(sc, 'Vector'))
    nd.link(sock(sc, 'Vector', out=True), sock(nmimg, 'Vector'))
    nm = nd.add('ShaderNodeNormalMap')
    sock(nm, 'Strength').default_value = 0.35
    nd.link(sock(nmimg, 'Color', out=True), sock(nm, 'Color'))
    nd.link(sock(nm, 'Normal', out=True), sock(bsdf, 'Normal'))
    tr = nd.add('ShaderNodeBsdfTranslucent')
    nd.link(color, sock(tr, 'Color'))
    mix = nd.add('ShaderNodeMixShader')
    mix.inputs[0].default_value = 0.18
    nd.link(sock(bsdf, 'BSDF', out=True), mix.inputs[1])
    nd.link(sock(tr, 'BSDF', out=True), mix.inputs[2])
    nd.link(mix.outputs[0], sock(out, 'Surface'))
    return mat


def gilt_material():
    """Gilded page edges: gold leaf over hundreds of stacked sheets."""
    mat = bpy.data.materials.new('Gilt')
    nd = Nodes(mat.node_tree)
    out = nd.add('ShaderNodeOutputMaterial')
    bsdf = principled(nd)
    tc = nd.add('ShaderNodeTexCoord')
    wave = nd.add('ShaderNodeTexWave', wave_type='BANDS', bands_direction='Y')
    sock(wave, 'Scale').default_value = 260
    sock(wave, 'Distortion').default_value = 2.0
    sock(wave, 'Detail').default_value = 2.0
    nd.link(sock(tc, 'Object', out=True), sock(wave, 'Vector'))
    noise = nd.add('ShaderNodeTexNoise')
    sock(noise, 'Scale').default_value = 9.0
    sock(noise, 'Detail').default_value = 6.0
    nd.link(sock(tc, 'Object', out=True), sock(noise, 'Vector'))
    height = nd.add('ShaderNodeMath', operation='MULTIPLY_ADD')
    nd.link(sock(noise, 'Fac', out=True), height.inputs[0])
    height.inputs[1].default_value = 0.35
    nd.link(sock(wave, 'Fac', out=True), height.inputs[2])
    bump = nd.add('ShaderNodeBump')
    sock(bump, 'Strength').default_value = 0.35
    sock(bump, 'Distance').default_value = 0.0008
    nd.link(height.outputs[0], sock(bump, 'Height'))
    nd.link(sock(bump, 'Normal', out=True), sock(bsdf, 'Normal'))
    # rubbed areas are less shiny
    rough = nd.add('ShaderNodeMapRange')
    nd.link(sock(noise, 'Fac', out=True), sock(rough, 'Value'))
    sock(rough, 'To Min').default_value = 0.22
    sock(rough, 'To Max').default_value = 0.5
    nd.link(sock(rough, 'Result', out=True), sock(bsdf, 'Roughness'))
    ramp = nd.add('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (0.7, 0.48, 0.22, 1)
    ramp.color_ramp.elements[1].color = (0.95, 0.78, 0.48, 1)
    nd.link(sock(wave, 'Fac', out=True), sock(ramp, 'Fac'))
    nd.link(sock(ramp, 'Color', out=True), sock(bsdf, 'Base Color'))
    sock(bsdf, 'Metallic').default_value = 0.95
    nd.link(sock(bsdf, 'BSDF', out=True), sock(out, 'Surface'))
    return mat


def ribbon_material():
    mat = bpy.data.materials.new('Ribbon')
    nd = Nodes(mat.node_tree)
    out = nd.add('ShaderNodeOutputMaterial')
    bsdf = principled(nd)
    sock(bsdf, 'Base Color').default_value = (0.42, 0.23, 0.06, 1)
    sock(bsdf, 'Roughness').default_value = 0.42
    sock(bsdf, 'Sheen Weight').default_value = 0.8
    sock(bsdf, 'Sheen Tint').default_value = (1.0, 0.85, 0.55, 1)
    nd.link(sock(bsdf, 'BSDF', out=True), sock(out, 'Surface'))
    return mat


def wood_material():
    mat = bpy.data.materials.new('Table')
    nd = Nodes(mat.node_tree)
    out = nd.add('ShaderNodeOutputMaterial')
    bsdf = principled(nd)
    tc = nd.add('ShaderNodeTexCoord')
    mp = nd.add('ShaderNodeMapping')
    sock(mp, 'Scale').default_value = (20, 20, 1)
    nd.link(sock(tc, 'UV', out=True), sock(mp, 'Vector'))
    col = nd.add('ShaderNodeTexImage', image=image(os.path.join(TEX, 'wood-color.jpg')))
    nor = nd.add('ShaderNodeTexImage', image=image(os.path.join(TEX, 'wood-normal.jpg'), 'Non-Color'))
    rgh = nd.add('ShaderNodeTexImage', image=image(os.path.join(TEX, 'wood-rough.jpg'), 'Non-Color'))
    for t in (col, nor, rgh):
        nd.link(sock(mp, 'Vector', out=True), sock(t, 'Vector'))
    tint = nd.add('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
    sock(tint, 'Factor', 'VALUE').default_value = 1.0
    nd.link(sock(col, 'Color', out=True), sock(tint, 'A', 'RGBA'))
    sock(tint, 'B', 'RGBA').default_value = (0.55, 0.42, 0.33, 1)
    nd.link(sock(tint, 'Result', 'RGBA', out=True), sock(bsdf, 'Base Color'))
    rm = nd.add('ShaderNodeMath', operation='MULTIPLY_ADD')
    nd.link(sock(rgh, 'Color', out=True), rm.inputs[0])
    rm.inputs[1].default_value = 0.7
    rm.inputs[2].default_value = 0.3
    nd.link(rm.outputs[0], sock(bsdf, 'Roughness'))
    nm = nd.add('ShaderNodeNormalMap')
    sock(nm, 'Strength').default_value = 0.8
    nd.link(sock(nor, 'Color', out=True), sock(nm, 'Color'))
    nd.link(sock(nm, 'Normal', out=True), sock(bsdf, 'Normal'))
    sock(bsdf, 'Coat Weight').default_value = 0.1
    sock(bsdf, 'Coat Roughness').default_value = 0.5
    nd.link(sock(bsdf, 'BSDF', out=True), sock(out, 'Surface'))
    mat['tint'] = tint.name
    return mat


def beam_material():
    mat = bpy.data.materials.new('Beam')
    nd = Nodes(mat.node_tree)
    out = nd.add('ShaderNodeOutputMaterial')
    vol = nd.add('ShaderNodeVolumePrincipled')
    sock(vol, 'Density').default_value = 0.06
    sock(vol, 'Anisotropy').default_value = 0.55
    sock(vol, 'Color').default_value = (1.0, 0.86, 0.66, 1)
    nd.link(sock(vol, 'Volume', out=True), sock(out, 'Volume'))
    mat['vol'] = vol.name
    return mat


# ---------------------------------------------------------------- book parts
def strip_faces(n, offset=0):
    return [(offset + 2 * i, offset + 2 * i + 1, offset + 2 * i + 3, offset + 2 * i + 2) for i in range(n)]


class PageStack:
    def __init__(self, name, t, parent, page_mat, gilt):
        self.t = t
        n = (NS + 1) * 2
        verts = [(0, 0, 0)] * (n * 3 + 4)
        faces = strip_faces(NS)                         # printed top page
        top_count = len(faces)
        for cap in range(2):                            # head and tail of the block
            o = n + cap * n
            faces += [(o + 2 * i, o + 2 * i + 2, o + 2 * i + 3, o + 2 * i + 1) for i in range(NS)]
        f = n * 3
        faces.append((f, f + 1, f + 3, f + 2))         # fore-edge
        self.obj = mesh_obj(name, verts, faces, parent, (page_mat, gilt))
        for i, p in enumerate(self.obj.data.polygons):
            p.material_index = 0 if i < top_count else 1
        self.n = n
        self.update(0)
        set_uvs(self.obj, lambda vi, co: ((vi // 2) / NS if vi < n else 0, (1.0 if vi % 2 == 0 else 0.0) if vi < n else 0))

    def update(self, o):
        t = self.t
        ang = rest_angles(t * o, ALPHA * o)
        gx = (-S / 2) * o
        x, y = gx, t * (1 - o)
        top, caps = [], [[], []]
        last = None
        for i in range(NS + 1):
            xb = gx + (i / NS) * PW
            yt, yb = y, 0.0
            if i == 3:
                self.ribbon = (x, yt, ang[i])
            top += [(x, yt, -PH / 2), (x, yt, PH / 2)]
            for c, z in ((0, -PH / 2), (1, PH / 2)):
                caps[c] += [(x, yt, z), (xb, yb, z)]
            last = (x, yt, xb, yb)
            if i < NS:
                x += math.cos(ang[i]) * DS
                y += math.sin(ang[i]) * DS
        lx, lt, lxb, lb = last
        fore = [(lx, lt, -PH / 2), (lx, lt, PH / 2), (lxb, lb, -PH / 2), (lxb, lb, PH / 2)]
        set_verts(self.obj, top + caps[0] + caps[1] + fore)


class Leaf:
    def __init__(self, index, parent, mat):
        self.rest_right = TR + (N_LEAVES - index) * EPS
        self.rest_left = TL + (index + 1) * EPS
        verts = [(0, 0, 0)] * ((NS + 1) * 2)
        self.obj = mesh_obj(f'Leaf{index}', verts, strip_faces(NS), parent, (mat,))
        self.update(0, 0)
        set_uvs(self.obj, lambda vi, co: ((vi // 2) / NS, 1.0 if vi % 2 == 0 else 0.0))

    def update(self, p, o):
        right = rest_angles(self.rest_right * o, ALPHA * o)
        left = rest_angles(self.rest_left, ALPHA)
        e = smoother(p)
        sag = 1.25 * math.sin(math.pi * e) ** 2 * math.cos(math.pi * e)
        x, y = (-S / 2) * o, self.rest_right * (1 - o)
        verts = []
        for i in range(NS + 1):
            verts += [(x, y, -PH / 2), (x, y, PH / 2)]
            if i < NS:
                u = (i + 0.5) / NS
                a = right[i] + (math.pi - left[i] - right[i]) * e - sag * u ** 1.4
                x += math.cos(a) * DS
                y += math.sin(a) * DS
        set_verts(self.obj, verts)


def catmull(points, t):
    """Centripetal Catmull-Rom, identical to THREE.CatmullRomCurve3."""
    l = len(points)
    p = (l - 1) * t
    ip = int(math.floor(p))
    w = p - ip
    if ip >= l - 1:
        ip, w = l - 2, 1.0
    p1, p2 = points[ip], points[ip + 1]
    p0 = points[ip - 1] if ip > 0 else p1 + (p1 - p2)
    p3 = points[ip + 2] if ip + 2 < l else p2 + (p2 - p1)
    dt0 = ((p0 - p1).length_squared) ** 0.25
    dt1 = ((p1 - p2).length_squared) ** 0.25
    dt2 = ((p2 - p3).length_squared) ** 0.25
    if dt1 < 1e-4:
        dt1 = 1.0
    if dt0 < 1e-4:
        dt0 = dt1
    if dt2 < 1e-4:
        dt2 = dt1
    res = []
    for d in range(3):
        x0, x1, x2, x3 = p0[d], p1[d], p2[d], p3[d]
        t1 = ((x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1) * dt1
        t2 = ((x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2) * dt1
        c0, c1 = x1, t1
        c2 = -3 * x1 + 3 * x2 - 2 * t1 - t2
        c3 = 2 * x1 - 2 * x2 + t1 + t2
        res.append(c0 + c1 * w + c2 * w * w + c3 * w * w * w)
    return Vector(res)


RIBBON_SEG = 56


class Ribbon:
    def __init__(self, parent, mat):
        verts = [(0, 0, 0)] * ((RIBBON_SEG + 1) * 2)
        self.obj = mesh_obj('Ribbon', verts, strip_faces(RIBBON_SEG), parent, (mat,))

    def update(self, x, y, floor_y, tilt):
        length = 0.17
        edge = CH / 2 + 0.004
        depth = min(length, max(CT, -floor_y))
        rest = length - depth
        V = Vector
        pts = [V((x, y * 0.9, PH / 2 - 0.012)), V((x, y * 0.8, PH / 2 + 0.004)), V((x, 0.004, PH / 2 + 0.028)),
               V((x, 0.003, edge)), V((x + 0.004, -depth * 0.55, edge + 0.014)),
               V((x + 0.012, -depth + 0.004, edge + 0.03 + rest * 0.12))]
        if rest > 0.01:
            pts += [V((x + 0.03, -depth + 0.003, edge + 0.03 + rest * 0.6)), V((x + 0.022, -depth + 0.003, edge + 0.03 + rest))]
        w = 0.015
        verts = []
        for i in range(RIBBON_SEG + 1):
            p = catmull(pts, i / RIBBON_SEG)
            a = tilt * (1 - clamp01((p.z - PH / 2) / 0.025))
            cx, cy = math.cos(a) * w, math.sin(a) * w
            verts += [(p.x - cx, p.y - cy, p.z), (p.x + cx, p.y + cy, p.z)]
        set_verts(self.obj, verts)


def cover_slab(name, y0, y1, parent, mats, face_mat):
    """Leather board: rounded outer corners, rolled edges (bevel)."""
    r, x0, x1 = 0.05, -CT, CW
    outline = [(x0, -CH / 2)]
    for k in range(9):
        a = -math.pi / 2 + (k / 8) * (math.pi / 2)
        outline.append((x1 - r + math.cos(a) * r, -CH / 2 + r + math.sin(a) * r))
    for k in range(9):
        a = (k / 8) * (math.pi / 2)
        outline.append((x1 - r + math.cos(a) * r, CH / 2 - r + math.sin(a) * r))
    outline.append((x0, CH / 2))
    bm = bmesh.new()
    bottom = [bm.verts.new((x, y0, z)) for x, z in outline]
    face = bm.faces.new(bottom)
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    for v in [g for g in ext['geom'] if isinstance(g, bmesh.types.BMVert)]:
        v.co.y = y1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    for p in me.polygons:
        n = p.normal
        p.material_index = face_mat(n)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    set_uvs(obj, lambda vi, co: ((co.x + CT) / (CW + CT), (CH / 2 - co.z) / CH))
    bev = obj.modifiers.new('Roll', 'BEVEL')
    bev.width = 0.009
    bev.segments = 4
    bev.limit_method = 'ANGLE'
    bev.harden_normals = False
    for p in me.polygons:
        p.use_smooth = True
    obj.modifiers.new('Normals', 'WEIGHTED_NORMAL').keep_sharp = True
    return obj


# ---------------------------------------------------------------- camera path (src/cinema.js)
def build_shots():
    shots = [
        # eye level with the Bible: sky, radiance and peaks behind it
        (0.0, (0.9, 1.05, 3.6), (0, 0.85, 0)),
        (0.06, (0.75, 0.62, 3.3), (0, 0.38, 0)),
        (0.11, (0.25, 0.55, 3.1), (0, 0.22, 0)),
        (0.16, (1.2, 0.75, 3.1), (-0.15, 0.32, 0)),
        (0.21, (0.9, 2.2, 2.9), (0, 0.15, 0.05)),
    ]
    for k in range(N_LEAVES + 1):
        a, b = spread_window(k)
        side = -1 if k % 2 else 1
        shots.append(((0.27 if k == 0 else a) + 0.008, (0.22 * side, 3.55, 2.5), (0, 0, 0.12)))
        shots.append((b - 0.008, (0.1 * side, 3.38, 2.38), (0, 0, 0.12)))
        if k < N_LEAVES:
            mid = T['firstTurn'] + k * T['turnEvery'] + T['turnLength'] / 2
            shots.append((mid, (0.75 * side, 2.7, 2.9), (0, 0.16, 0.08)))
    shots += [(0.86, (-1.8, 2.2, 4.4), (0, 0.1, 0)), (0.93, (-0.6, 4.4, 5.0), (0, 0, -0.1)), (1.0, (0, 5.8, 4.6), (0, 0, -0.3))]
    return shots


SHOTS = build_shots()
SHOT_POS = [Vector(s[1]) for s in SHOTS]
SHOT_TGT = [Vector(s[2]) for s in SHOTS]


def camera_at(P):
    n = len(SHOTS)
    i = 0
    while i < n - 2 and P > SHOTS[i + 1][0]:
        i += 1
    f = clamp01((P - SHOTS[i][0]) / (SHOTS[i + 1][0] - SHOTS[i][0]))
    t = (i + f) / (n - 1)
    return catmull(SHOT_POS, t), catmull(SHOT_TGT, t)


def b(v):
    """three.js space (y up, z toward viewer) -> Blender space (z up)."""
    return Vector((v[0], -v[2], v[1]))


# ---------------------------------------------------------------- build
def build(lang):
    scene = reset_scene()
    W, H = (int(x) for x in args.res.split('x'))
    r = scene.render
    r.engine = 'CYCLES'
    r.resolution_x, r.resolution_y, r.resolution_percentage = W, H, 100
    r.film_transparent = False
    cy = scene.cycles
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.refresh_devices()
    for d in prefs.devices:
        d.use = d.type == 'OPTIX'
    cy.device = 'GPU'
    cy.samples = args.samples
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.012
    cy.use_denoising = True
    try:
        cy.denoiser = 'OPTIX'
    except TypeError:
        pass
    cy.max_bounces = 8
    cy.diffuse_bounces = 3
    cy.glossy_bounces = 3
    cy.transmission_bounces = 4
    cy.volume_bounces = 0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.volume_step_rate = 4.0
    cy.blur_glossy = 1.0
    vs = scene.view_settings
    vs.view_transform = 'AgX'
    for look in ('AgX - High Contrast',):
        try:
            vs.look = look
            break
        except TypeError:
            continue
    vs.exposure = 0.0
    r.image_settings.file_format = 'WEBP'
    r.image_settings.quality = args.quality
    r.image_settings.color_mode = 'RGB'

    # world: the heavenly panorama (film/sky_panorama.py), warm-graded. It is
    # both what the camera sees behind the Bible and the light that falls on it.
    world = bpy.data.worlds.new('World')
    scene.world = world
    nd = Nodes(world.node_tree)
    wo = nd.add('ShaderNodeOutputWorld')
    tc = nd.add('ShaderNodeTexCoord')
    mp = nd.add('ShaderNodeMapping')
    sock(mp, 'Rotation').default_value = (0, 0, math.radians(args.sky_rot))
    nd.link(sock(tc, 'Generated', out=True), sock(mp, 'Vector'))
    env = nd.add('ShaderNodeTexEnvironment', image=image(os.path.abspath(args.sky), 'Linear Rec.709'), interpolation='Cubic')
    nd.link(sock(mp, 'Vector', out=True), sock(env, 'Vector'))
    hs = nd.add('ShaderNodeHueSaturation')
    sock(hs, 'Saturation').default_value = 1.0
    nd.link(sock(env, 'Color', out=True), sock(hs, 'Color'))
    warm = nd.mul_color(sock(hs, 'Color', out=True), (1.0, 0.95, 0.86))
    # the camera sees the sky at full brightness; the light it casts on the
    # Bible is gentler, so the key and rim lights can model the book
    env_bg = nd.add('ShaderNodeBackground')
    nd.link(warm, sock(env_bg, 'Color'))
    cam_bg = nd.add('ShaderNodeBackground')
    # the camera sees the sky exactly as rendered, with a touch of warmth
    nd.link(nd.mul_color(sock(env, 'Color', out=True), (1.0, 0.97, 0.92)), sock(cam_bg, 'Color'))
    lp = nd.add('ShaderNodeLightPath')
    mix = nd.add('ShaderNodeMixShader')
    nd.link(sock(lp, 'Is Camera Ray', out=True), mix.inputs[0])
    nd.link(sock(env_bg, 'Background', out=True), mix.inputs[1])
    nd.link(sock(cam_bg, 'Background', out=True), mix.inputs[2])
    nd.link(mix.outputs[0], sock(wo, 'Surface'))

    # everything is authored in three.js coordinates under this axis swap
    axis = empty('Axis')
    axis.rotation_euler = (math.pi / 2, 0, 0)

    wood = None

    root = empty('BookRoot', axis)
    root.rotation_mode = 'ZYX'          # three.js 'XYZ' Euler order
    book = empty('Book', root)

    leather, *_ = leather_material('Leather', (0.42, 0.32, 0.25), 1.54)
    lining, *_ = leather_material('Lining', (0.5, 0.36, 0.26), 2.1)
    titled = titled_material(lang)
    gilt = gilt_material()

    def pg(side, k):
        return os.path.join(PAGES, f'page_{lang}_{k}_{side}.png')

    # back board: leather outside (-y), lining inside (+y)
    cover_slab('BackCover', -CT, 0, book, (leather, lining), lambda n: 1 if n.y > 0.9 else 0)
    right_stack = PageStack('RightStack', TR, book, page_material('RightPage', pg('right', N_LEAVES)), gilt)
    leaves = [Leaf(i, book, page_material(f'LeafMat{i}', pg('right', i), pg('left', i + 1))) for i in range(N_LEAVES)]
    ribbon = Ribbon(book, ribbon_material())

    spine_pivot = empty('SpinePivot', book)
    # rounded spine: the leather arches outward across the back of the book
    seg, bulge, th = 20, 0.045, CT - 0.003
    sv, sf = [], []
    for z in (-CH / 2, CH / 2):
        for i in range(seg + 1):
            x = S * i / seg
            arc = bulge * math.sin(math.pi * i / seg)
            sv += [(x, arc, z), (x, th + arc, z)]
    row = (seg + 1) * 2
    for i in range(seg):
        a, b2 = 2 * i, 2 * (i + 1)
        sf.append((a + 1, b2 + 1, row + b2 + 1, row + a + 1))      # outer face
        sf.append((a, row + a, row + b2, b2))                      # inner face
        sf.append((a, b2, b2 + 1, a + 1))                          # head
        sf.append((row + a, row + a + 1, row + b2 + 1, row + b2))  # tail
    sf.append((0, 1, row + 1, row))
    sf.append((2 * seg, row + 2 * seg, row + 2 * seg + 1, 2 * seg + 1))
    spine_me = mesh_obj('Spine', sv, sf, spine_pivot, (leather,))
    bev = spine_me.modifiers.new('Roll', 'BEVEL')
    bev.width, bev.segments, bev.limit_method = 0.006, 3, 'ANGLE'
    cover_pivot = empty('CoverPivot', spine_pivot, (S, 0, 0))
    cover_slab('FrontCover', 0, CT, cover_pivot, (leather, titled, lining),
               lambda n: 1 if n.y > 0.9 else (2 if n.y < -0.9 else 0))
    left_stack = PageStack('LeftStack', TL, cover_pivot, page_material('LeftPage', pg('left', 0), rotate=True), gilt)
    left_stack.obj.rotation_euler = (math.pi, 0, 0)

    # camera
    cam_data = bpy.data.cameras.new('Camera')
    cam_data.sensor_fit = 'VERTICAL'
    cam_data.angle_y = math.radians(30)
    cam_data.clip_start, cam_data.clip_end = 0.05, 100
    cam_data.dof.use_dof = True
    cam = bpy.data.objects.new('Camera', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    # lights (positions converted from three.js space)
    def light(name, kind, pos, color, **kw):
        ld = bpy.data.lights.new(name, kind)
        ld.color = color
        for k, v in kw.items():
            setattr(ld, k, v)
        ob = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(ob)
        ob.location = b(pos)
        return ob

    def aim(ob, target):
        d = Vector(target) - ob.location
        ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

    key = light('Key', 'SPOT', (-1.3, 6.5, 1.9), (1.0, 0.92, 0.82), spot_size=1.0, spot_blend=0.9, shadow_soft_size=0.35)
    aim(key, (0, 0, 0))
    rim = light('Rim', 'POINT', (0.3, 2.4, -2.6), (1.0, 0.82, 0.58), shadow_soft_size=0.8)
    sun = light('Sun', 'SUN', (4.5, 2.6, -2.5), (1.0, 0.86, 0.7), angle=math.radians(3))
    aim(sun, (0, 0, 0))
    glow_d = bpy.data.lights.new('Glow', 'POINT')
    glow_d.color = (1.0, 0.72, 0.42)
    glow_d.shadow_soft_size = 0.35
    glow = bpy.data.objects.new('Glow', glow_d)
    scene.collection.objects.link(glow)
    glow.parent = book

    beam_mat = None

    # fine golden light particles floating around the Bible
    dust_mat = bpy.data.materials.new('Dust')
    dn = Nodes(dust_mat.node_tree)
    do = dn.add('ShaderNodeOutputMaterial')
    em = dn.add('ShaderNodeEmission')
    sock(em, 'Color').default_value = (1.0, 0.8, 0.5, 1)
    sock(em, 'Strength').default_value = 6.0
    dn.link(sock(em, 'Emission', out=True), sock(do, 'Surface'))
    dust_mat['em'] = em.name
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.0013)
    mote = bpy.context.active_object
    mote.data.materials.append(dust_mat)
    mote.visible_shadow = False
    import random
    rnd = random.Random(7)
    motes = [mote]
    for _ in range(54):
        m2 = bpy.data.objects.new('Mote', mote.data)
        m2.visible_shadow = False
        scene.collection.objects.link(m2)
        motes.append(m2)
    # only inside the column of light falling from the spotlight
    seeds = [(rnd.uniform(-1.8, 1.8), rnd.uniform(-0.6, 2.2), rnd.uniform(-1.6, 1.4), rnd.uniform(0.5, 1.5), rnd.random() * 6.28)
             for _ in motes]

    # cinematic bloom: the brightest light (the radiance, the halo) glows softly
    if not args.no_bloom:
        ng = bpy.data.node_groups.new('Bloom', 'CompositorNodeTree')
        ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        rl = ng.nodes.new('CompositorNodeRLayers')
        gl = ng.nodes.new('CompositorNodeGlare')
        go = ng.nodes.new('NodeGroupOutput')
        gl.inputs['Type'].default_value = 'Bloom'
        gl.inputs['Quality'].default_value = 'High'
        gl.inputs['Threshold'].default_value = 1.6
        gl.inputs['Smoothness'].default_value = 0.6
        gl.inputs['Strength'].default_value = 0.28
        gl.inputs['Size'].default_value = 0.7
        ng.links.new(rl.outputs['Image'], gl.inputs['Image'])
        ng.links.new(gl.outputs[0], go.inputs[0])
        scene.compositing_node_group = ng
        scene.render.use_compositing = True

    return dict(scene=scene, root=root, book=book, motes=motes, seeds=seeds, dust=dust_mat, spine_pivot=spine_pivot, cover_pivot=cover_pivot,
                left_stack=left_stack, right_stack=right_stack, leaves=leaves, ribbon=ribbon,
                cam=cam, key=key, rim=rim, sun=sun, glow=glow, world=world, cam_bg=cam_bg, env_bg=env_bg,
                beam=beam_mat, wood=wood)


# ---------------------------------------------------------------- per-frame pose
DARK_BG = Vector((0.004, 0.003, 0.002))
LIGHT_BG = Vector((0.6, 0.42, 0.26))


def pose(s, P):
    o = smoother(rng(P, T['openStart'], T['openEnd']))
    arrive = smooth(rng(P, 0, T['arrivalEnd']))
    bright = smooth(rng(P, T['brightStart'], T['brightEnd']))

    s['spine_pivot'].rotation_euler = (0, 0, math.pi / 2 + (math.pi / 2) * o)
    s['cover_pivot'].rotation_euler = (0, 0, -math.pi / 2 + (math.pi / 2) * o)
    s['left_stack'].update(o)
    s['right_stack'].update(o)
    for i, leaf in enumerate(s['leaves']):
        leaf.update(turn_progress(P, i), o)

    s['book'].location = (lerp(-PW / 2, S / 2, o), 0, 0)
    root = s['root']
    # The Bible descends from above the frame and settles under the light
    # over the first tenth of the scroll (the brief's "The Arrival").
    land = smoother(rng(P, 0, T['arrivalEnd']))
    root.location = (0, lerp(DESCENT, 0, land), 0)
    root.rotation_euler = (lerp(0.32, 0, land), lerp(-0.34, 0, o) + lerp(-0.42, 0, land), lerp(-0.1, 0, land))
    rx, ry, tilt = s['right_stack'].ribbon
    s['ribbon'].update(rx, ry, -10.0, tilt)          # nothing below: the ribbon hangs free

    # camera glides along the shot path, with a faint hand-held breath
    pos, tgt = camera_at(P)
    breath = P * 70.0
    pos.x += math.sin(breath * 0.5) * 0.012
    pos.y += math.sin(breath * 0.37 + 1) * 0.008
    tgt.x += math.sin(breath * 0.43 + 2) * 0.006
    cam = s['cam']
    cam.location = b(pos)
    d = b(tgt) - b(pos)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    shallow = 1 - smooth(rng(P, 0.04, 0.27))
    cam.data.dof.focus_distance = d.length
    cam.data.dof.aperture_fstop = lerp(11.0, 5.6, shallow)

    # light: soft dawn as the Bible descends, growing radiant as it opens;
    # warm light rises from the pages once they are revealed
    s['key'].data.energy = lerp(900, 1100, arrive) + bright * 200
    s['rim'].data.energy = 420
    s['sun'].data.energy = 1.0 + bright * 2.0
    s['glow'].location = ((-S / 2) * o, 0.42, 0)
    s['glow'].data.energy = (0.6 + 1.6 * math.sin(math.pi * rng(P, T['openStart'], T['openEnd'] + 0.06)) + 0.6 * o) * 14
    s['cam_bg'].inputs['Strength'].default_value = lerp(1.15, 1.35, arrive) + bright * 0.2
    s['env_bg'].inputs['Strength'].default_value = lerp(0.42, 0.55, arrive) + 0.1 * o + bright * 0.2
    for m, (x, y, z, sp, ph) in zip(s['motes'], s['seeds']):
        t = P * 9.0 * sp
        m.location = b((x + 0.12 * math.sin(t + ph), ((y + t * 0.05) % 2.6) + 0.02, z + 0.1 * math.cos(t * 0.8 + ph)))
    dem = s['dust'].node_tree.nodes[s['dust']['em']]
    sock(dem, 'Strength').default_value = 6.0


# ---------------------------------------------------------------- render
def main():
    s = build(args.lang)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    if args.at:
        jobs = [(float(p), os.path.join(args.out, f'p{float(p):.3f}.webp')) for p in args.at.split(',')]
    else:
        n = args.frames
        end = n if args.end < 0 else min(n, args.end)
        jobs = [(f / (n - 1), os.path.join(args.out, f'frame_{f:04d}.webp')) for f in range(args.start, end)]
    import time
    for P, path in jobs:
        if os.path.exists(path):
            continue
        t0 = time.time()
        pose(s, P)
        s['scene'].render.filepath = path
        bpy.ops.render.render(write_still=True)
        print(f'RENDERED {os.path.basename(path)} P={P:.4f} in {time.time() - t0:.1f}s', flush=True)
    if not args.at:
        # mark the language complete only when every frame of the film exists
        n = args.frames
        if all(os.path.exists(os.path.join(args.out, f'frame_{f:04d}.webp')) for f in range(n)):
            import json
            W, H = (int(x) for x in args.res.split('x'))
            with open(os.path.join(args.out, 'complete.json'), 'w') as fh:
                json.dump({'frames': n, 'width': W, 'height': H, 'lang': args.lang}, fh)
            print('FILM COMPLETE', args.lang, flush=True)
    if args.blend:
        bpy.ops.wm.save_as_mainfile(filepath=args.blend)


main()
