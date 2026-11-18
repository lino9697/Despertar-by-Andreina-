"""
Renders the heavenly environment once, as a 360-degree equirectangular
panorama: a physically scattered golden-hour sky, a vast sea of sunlit
cumulus clouds far below, and snow-dusted peaks rising through them.
bible_film.py then uses the panorama as the world the Bible floats in
(background, light and reflections); the live site uses a JPEG of it.

  blender -b --factory-startup --python film/sky_panorama.py -- --res 12288 --samples 48
  blender -b --factory-startup --python film/sky_panorama.py -- --views film/sky/views --view-res 960
"""
import bpy
import bmesh
import math
import os
import sys
import argparse
import random
import time
from mathutils import Vector, noise
T0 = time.time()


def stamp(msg):
    print(f'STAGE {msg} at {time.time() - T0:.1f}s', flush=True)

HERE = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('--res', type=int, default=12288)
ap.add_argument('--samples', type=int, default=48)
ap.add_argument('--out', default=os.path.join(HERE, 'sky', 'heaven.exr'))
ap.add_argument('--views', default='')        # only render test views through film-like lenses into this folder
ap.add_argument('--view-res', type=int, default=960)
ap.add_argument('--view-samples', type=int, default=64)
ap.add_argument('--peak-res', type=int, default=280)
ap.add_argument('--vbounces', type=int, default=8)
ap.add_argument('--step-rate', type=float, default=1.0)
ap.add_argument('--only', default='')
ap.add_argument('--crop', default='')       # lon_min,lon_max,lat_min,lat_max in degrees: render only this window sharply
args = ap.parse_args(argv)


def sock(node, name, kind=None, out=False):
    for nm in {'Fac': ('Fac', 'Factor')}.get(name, (name,)):
        for s in (node.outputs if out else node.inputs):
            if s.name == nm and (kind is None or s.type == kind):
                return s
    raise KeyError(f'{node.bl_idname} has no {name}')


class N:
    def __init__(self, tree):
        self.t, self.n, self.l = tree, tree.nodes, tree.links
        for x in list(self.n):
            self.n.remove(x)

    def add(self, kind, **kw):
        nd = self.n.new(kind)
        for k, v in kw.items():
            setattr(nd, k, v)
        return nd

    def link(self, a, b):
        self.l.new(a, b)

    def val(self, a, node_input):
        if isinstance(a, (int, float)):
            node_input.default_value = a
        else:
            self.link(a, node_input)

    def math(self, op, a, b=None, c=None):
        m = self.add('ShaderNodeMath', operation=op)
        for i, v in enumerate((a, b, c)):
            if v is not None:
                self.val(v, m.inputs[i])
        return m.outputs[0]

    def smooth(self, x, lo, hi):
        """smoothstep(lo, hi, x) through a Map Range node."""
        mr = self.add('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP')
        self.link(x, sock(mr, 'Value'))
        sock(mr, 'From Min').default_value = lo
        sock(mr, 'From Max').default_value = hi
        return sock(mr, 'Result', out=True)

    def mix(self, fac, a, b, blend='MIX', clamp=True):
        m = self.add('ShaderNodeMix', data_type='RGBA', blend_type=blend)
        m.clamp_factor = clamp
        m.clamp_result = False
        self.val(fac, sock(m, 'Factor', 'VALUE'))
        for v, nm in ((a, 'A'), (b, 'B')):
            if isinstance(v, tuple):
                sock(m, nm, 'RGBA').default_value = v
            else:
                self.link(v, sock(m, nm, 'RGBA'))
        return sock(m, 'Result', 'RGBA', out=True)

    def noise(self, vec, scale, detail, rough, lac=2.0, out='Fac'):
        t = self.add('ShaderNodeTexNoise')
        sock(t, 'Scale').default_value = scale
        sock(t, 'Detail').default_value = detail
        sock(t, 'Roughness').default_value = rough
        sock(t, 'Lacunarity').default_value = lac
        self.link(vec, sock(t, 'Vector'))
        return sock(t, out, out=True)


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
r = scene.render
r.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'OPTIX'
prefs.refresh_devices()
for d in prefs.devices:
    d.use = d.type == 'OPTIX'
print('DEVICES', [(d.name, d.type, d.use) for d in prefs.devices if d.use], flush=True)
cy = scene.cycles
cy.device = 'GPU'
cy.use_denoising = True
cy.use_adaptive_sampling = True
cy.adaptive_threshold = 0.01
cy.max_bounces = 12
cy.diffuse_bounces = 2
cy.glossy_bounces = 1
cy.volume_bounces = args.vbounces     # multiple scattering: what makes clouds white and soft-edged
cy.volume_step_rate = args.step_rate
cy.volume_max_steps = 512
ap2 = None

# ------------------------------------------------------------- golden-hour sky
# The sun hangs low, straight behind the Bible (+Y here; bible_film.py rotates the
# panorama so this direction lies behind the book).
SUN_ELEV = math.radians(5.5)
SUN_DIR = Vector((0.0, math.cos(SUN_ELEV), math.sin(SUN_ELEV)))

world = bpy.data.worlds.new('Heaven')
scene.world = world
w = N(world.node_tree)
wout = w.add('ShaderNodeOutputWorld')
sky = w.add('ShaderNodeTexSky', sky_type='MULTIPLE_SCATTERING')
sky.sun_disc = False
sky.sun_elevation = SUN_ELEV
sky.sun_rotation = 0.0
sky.altitude = 3200.0
sky.air_density = 0.6
sky.aerosol_density = 2.2              # a soft, luminous haze around the sun
sky.ozone_density = 1.0
tc = w.add('ShaderNodeTexCoord')
dirv = sock(tc, 'Generated', out=True)
# the sky model's sun sits along -Y at rotation 0; turn the lookup so it is at +Y
rot = w.add('ShaderNodeVectorRotate', rotation_type='Z_AXIS')
sock(rot, 'Angle').default_value = math.pi
w.link(dirv, sock(rot, 'Vector'))
w.link(sock(rot, 'Vector', out=True), sock(sky, 'Vector'))
sky_col = w.mix(1.0, sock(sky, 'Color', out=True), (0.26, 0.25, 0.24, 1), 'MULTIPLY')
# radiance: a wide warm halo and a brilliant core where the light pours from
dot = w.add('ShaderNodeVectorMath', operation='DOT_PRODUCT')
w.link(dirv, dot.inputs[0])
dot.inputs[1].default_value = SUN_DIR
dd = w.math('MAXIMUM', sock(dot, 'Value', out=True), 0.0)
glow = w.math('ADD', w.math('ADD', w.math('MULTIPLY', w.math('POWER', dd, 6.0), 0.9),
                                   w.math('MULTIPLY', w.math('POWER', dd, 40.0), 4.0)),
              w.math('MULTIPLY', w.math('POWER', dd, 900.0), 120.0))
lit = w.mix(glow, sky_col, (1.0, 0.72, 0.4, 1), 'ADD', clamp=False)
bg = w.add('ShaderNodeBackground')
w.link(lit, sock(bg, 'Color'))
sock(bg, 'Strength').default_value = 1.0
w.link(sock(bg, 'Background', out=True), sock(wout, 'Surface'))

sun_d = bpy.data.lights.new('Sun', 'SUN')
sun_d.energy = 6.5
sun_d.angle = math.radians(1.2)
sun_d.color = (1.0, 0.78, 0.55)
sun = bpy.data.objects.new('Sun', sun_d)
scene.collection.objects.link(sun)
LIGHT_DIR = Vector((0.0, math.cos(math.radians(16)), math.sin(math.radians(16))))   # the light that models the clouds sits a little higher
sun.rotation_euler = (-LIGHT_DIR).to_track_quat('-Z', 'Y').to_euler()

# ------------------------------------------------------------- sea of clouds
# Metres, with the viewer at the origin: the cloud tops lie a few hundred metres
# below, the layer stretches to the horizon.
BOTTOM, TOP_BASE, CEIL, RADIUS = -1350.0, -1000.0, -620.0, 14000.0
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=RADIUS, depth=CEIL - BOTTOM, location=(0, 0, (CEIL + BOTTOM) / 2))
clouds = bpy.context.active_object
cm = bpy.data.materials.new('Clouds')
clouds.data.materials.append(cm)
c = N(cm.node_tree)
co = c.add('ShaderNodeOutputMaterial')
geo = c.add('ShaderNodeNewGeometry')
pos = sock(geo, 'Position', out=True)
sep = c.add('ShaderNodeSeparateXYZ')
c.link(pos, sep.inputs[0])
z = sock(sep, 'Z', out=True)
# domain warp so the heaps are not round blobs on a grid
warp = c.noise(pos, 1 / 800, 1, 0.5, out='Color')
wv = c.add('ShaderNodeVectorMath', operation='MULTIPLY_ADD')
c.link(warp, wv.inputs[0])
wv.inputs[1].default_value = (210, 210, 90)
c.link(pos, wv.inputs[2])
wpos = sock(wv, 'Vector', out=True)
# coverage: wide gaps and dense banks
cover = c.smooth(c.noise(wpos, 1 / 2600, 1, 0.5), 0.3, 0.62)
# cumulus heaps: inverted cellular distance makes rounded towers
vor = c.add('ShaderNodeTexVoronoi', feature='F1', distance='EUCLIDEAN')
sock(vor, 'Scale').default_value = 1 / 250
c.link(wpos, sock(vor, 'Vector'))
heap = c.math('POWER', c.math('MAXIMUM', c.math('SUBTRACT', 1.0, sock(vor, 'Distance', out=True)), 0.0), 2.2)
vor2 = c.add('ShaderNodeTexVoronoi', feature='F1', distance='EUCLIDEAN')
sock(vor2, 'Scale').default_value = 1 / 90
c.link(wpos, sock(vor2, 'Vector'))
heap2 = c.math('POWER', c.math('MAXIMUM', c.math('SUBTRACT', 1.0, sock(vor2, 'Distance', out=True)), 0.0), 2.0)
# height of the cloud surface above each point
# rolling swells of the cloud deck
swell = c.math('MULTIPLY', c.math('SUBTRACT', c.noise(wpos, 1 / 2200, 2, 0.55), 0.5), 300.0)
# billowy heaps whose size varies from place to place
vary = c.smooth(c.noise(wpos, 1 / 1100, 0, 0.5), 0.25, 0.75)
billow = c.math('ABSOLUTE', c.math('SUBTRACT', c.noise(wpos, 1 / 380, 3, 0.5), 0.5))
heaps = c.math('ADD', c.math('MULTIPLY', heap, c.math('MULTIPLY_ADD', vary, 150.0, 40.0)),
               c.math('ADD', c.math('MULTIPLY', heap2, 22.0), c.math('MULTIPLY', billow, 150.0)))
# now and then a towering cumulus rises out of the deck
vor3 = c.add('ShaderNodeTexVoronoi', feature='F1', distance='EUCLIDEAN')
sock(vor3, 'Scale').default_value = 1 / 1500
c.link(wpos, sock(vor3, 'Vector'))
tower = c.math('POWER', c.math('MAXIMUM', c.math('SUBTRACT', 1.0, c.math('MULTIPLY', sock(vor3, 'Distance', out=True), 2.4)), 0.0), 2.5)
tops = c.math('ADD', c.math('ADD', TOP_BASE - 80.0, swell),
              c.math('ADD', c.math('MULTIPLY', c.math('ADD', 0.2, c.math('MULTIPLY', cover, 0.8)), heaps),
                     c.math('MULTIPLY', tower, 0.0)))
# erosion: billowy cauliflower detail on the surface
fine = c.noise(pos, 1 / 16, 3, 0.62)
mid = c.noise(pos, 1 / 85, 2, 0.55)
ero = c.math('ADD', c.math('MULTIPLY', c.math('SUBTRACT', fine, 0.5), 14.0), c.math('MULTIPLY', c.math('SUBTRACT', mid, 0.5), 38.0))
depth_in = c.math('SUBTRACT', c.math('ADD', tops, ero), z)          # metres below the local surface
dens = c.smooth(depth_in, 0.0, 26.0)
dens = c.math('MULTIPLY', dens, c.smooth(z, BOTTOM, BOTTOM + 120.0))
# fade the layer out at the far rim of the domain
rl = c.add('ShaderNodeVectorMath', operation='LENGTH')
c.link(pos, rl.inputs[0])
dist = sock(rl, 'Value', out=True)
dens = c.math('MULTIPLY', dens, c.math('SUBTRACT', 1.0, c.smooth(dist, RADIUS * 0.8, RADIUS * 0.98)))
dens = c.math('MULTIPLY', dens, 0.07)
vol = c.add('ShaderNodeVolumePrincipled')
c.link(dens, sock(vol, 'Density'))
# aerial perspective: distant clouds dissolve into the warm air
haze = c.smooth(dist, 1500.0, 12000.0)
c.link(c.mix(haze, (0.99, 0.98, 0.97, 1), (1.0, 0.93, 0.84, 1)), sock(vol, 'Color'))
sock(vol, 'Anisotropy').default_value = 0.35
c.link(c.math('MULTIPLY', c.math('MULTIPLY', haze, haze), c.math('MULTIPLY', dens, 1.4)), sock(vol, 'Emission Strength'))
sock(vol, 'Emission Color').default_value = (1.0, 0.84, 0.66, 1)
c.link(sock(vol, 'Volume', out=True), sock(co, 'Volume'))

# ------------------------------------------------------------- mountain peaks
rock = bpy.data.materials.new('Peaks')
m = N(rock.node_tree)
mo = m.add('ShaderNodeOutputMaterial')
bsdf = m.add('ShaderNodeBsdfPrincipled')
mg = m.add('ShaderNodeNewGeometry')
mpos = sock(mg, 'Position', out=True)
nsep = m.add('ShaderNodeSeparateXYZ')
m.link(sock(mg, 'Normal', out=True), nsep.inputs[0])
psep = m.add('ShaderNodeSeparateXYZ')
m.link(mpos, psep.inputs[0])
strata = m.noise(mpos, 1 / 18, 10, 0.6)
grain = m.noise(mpos, 1 / 3, 6, 0.6)
rock_col = m.mix(strata, (0.11, 0.095, 0.085, 1), (0.3, 0.27, 0.24, 1))
# snow settles on the gentler slopes and the upper reaches
slope = m.smooth(m.math('ADD', sock(nsep, 'Z', out=True), m.math('MULTIPLY', m.math('SUBTRACT', strata, 0.5), 0.5)), 0.62, 0.78)
high = m.smooth(sock(psep, 'Z', out=True), -700.0, 400.0)
snow = m.math('MINIMUM', m.math('MULTIPLY', slope, m.math('ADD', 0.35, m.math('MULTIPLY', high, 0.65))), 1.0)
col = m.mix(snow, rock_col, (0.92, 0.92, 0.94, 1))
# distant peaks dissolve into the warm haze
cam_d = m.add('ShaderNodeCameraData')
hz = m.smooth(sock(cam_d, 'View Distance', out=True), 3000.0, 16000.0)
hz = m.math('MULTIPLY', m.math('ADD', 0.08, m.math('MULTIPLY', hz, 0.92)), 0.82)
m.link(m.mix(hz, col, (1.0, 0.86, 0.7, 1)), sock(bsdf, 'Base Color'))
sock(bsdf, 'Emission Color').default_value = (1.0, 0.84, 0.66, 1)
m.link(m.math('MULTIPLY', m.math('MULTIPLY', hz, hz), 1.2), sock(bsdf, 'Emission Strength'))
m.link(m.mix(snow, (0.9, 0.9, 0.9, 1), (0.35, 0.35, 0.35, 1)), sock(bsdf, 'Roughness'))
bump = m.add('ShaderNodeBump')
sock(bump, 'Strength').default_value = 0.6
m.link(m.math('ADD', strata, m.math('MULTIPLY', grain, 0.35)), sock(bump, 'Height'))
m.link(sock(bump, 'Normal', out=True), sock(bsdf, 'Normal'))
m.link(sock(bsdf, 'BSDF', out=True), sock(mo, 'Surface'))


def ridged(p, octaves=7):
    h, amp, freq, norm = 0.0, 1.0, 1.0, 0.0
    for o in range(octaves):
        n = 1 - abs(noise.noise(p * freq + Vector((o * 3.1, o * 1.7, o * 0.3))))
        h += n * n * amp * (0.6 + 0.4 * h if o else 1.0)
        norm += amp
        amp *= 0.5
        freq *= 2.05
    return h / norm


def peak(cx, cy, height, radius, seed):
    """A sharp alpine peak: a steep cone shaped by domain-warped ridged noise."""
    res = args.peak_res
    bm = bmesh.new()
    verts = []
    off = Vector((seed * 13.1, seed * 7.7, seed * 2.9))
    for j in range(res + 1):
        row = []
        for i in range(res + 1):
            x = (i / res - 0.5) * 2 * radius
            y = (j / res - 0.5) * 2 * radius
            p = Vector((x, y, 0)) * (2.6 / radius) + off
            wp = p + noise.noise_vector(p * 0.6) * 0.45
            rr = math.hypot(x, y) / radius
            cone = max(0.0, 1 - rr) ** 1.35
            rid = ridged(wp)
            h = height * (cone * (0.3 + 0.9 * rid ** 1.4) + 0.25 * cone ** 6)
            row.append(bm.verts.new((cx + x, cy + y, BOTTOM + h)))
        verts.append(row)
    for j in range(res):
        for i in range(res):
            bm.faces.new((verts[j][i], verts[j][i + 1], verts[j + 1][i + 1], verts[j + 1][i]))
    me = bpy.data.meshes.new('Peak')
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new('Peak', me)
    scene.collection.objects.link(ob)
    me.materials.append(rock)


stamp('materials built')
rnd = random.Random(23)
# great peaks flanking the light on both sides, and ranges all around
flank = [(-34, 7600, 2700), (-55, 10500, 3200), (31, 8400, 2900), (52, 11500, 3300), (-20, 12500, 2500), (18, 13000, 2400)]
for k, (deg, dist, h) in enumerate(flank):
    a = math.radians(90 - deg)          # 0 deg = straight toward the sun (+Y)
    peak(math.cos(a) * dist, math.sin(a) * dist, h, h * rnd.uniform(0.95, 1.25), k)
for k in range(18):
    deg = rnd.uniform(70, 290)
    a = math.radians(90 - deg)
    dist = rnd.uniform(8000, 13500)
    h = rnd.uniform(1900, 2900)
    peak(math.cos(a) * dist, math.sin(a) * dist, h, h * rnd.uniform(0.95, 1.3), 40 + k)

stamp('peaks built')


def look(cam, yaw_deg, pitch_deg):
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    d = Vector((math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


if args.views:
    # test views through the film's lens (30 degrees vertical), graded as in the film
    os.makedirs(args.views, exist_ok=True)
    cd = bpy.data.cameras.new('View')
    cd.sensor_fit = 'VERTICAL'
    cd.angle_y = math.radians(30)
    cd.clip_end = 40000
    cam = bpy.data.objects.new('View', cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.view_settings.view_transform = 'AgX'
    try:
        scene.view_settings.look = 'AgX - High Contrast'
    except TypeError:
        pass
    cy.samples = args.view_samples
    r.resolution_x, r.resolution_y, r.resolution_percentage = args.view_res, args.view_res * 9 // 16, 100
    r.image_settings.file_format = 'JPEG'
    for name, yaw, pitch in (('a_opening', 0, -3), ('b_reading', 15, -52), ('c_side', -70, -20), ('d_end', 180, -35)):
        if args.only and name not in args.only.split(','):
            continue
        look(cam, yaw, pitch)
        r.filepath = os.path.join(os.path.abspath(args.views), name + '.jpg')
        bpy.ops.render.render(write_still=True)
        stamp('VIEW SAVED ' + name)
    sys.exit(0)

# ------------------------------------------------------------- render the panorama
cy.samples = args.samples
scene.view_settings.view_transform = 'Standard'   # keep real light values
cd = bpy.data.cameras.new('Pano')
cd.type = 'PANO'
try:
    cd.panorama_type = 'EQUIRECTANGULAR'
except AttributeError:
    cd.cycles.panorama_type = 'EQUIRECTANGULAR'
cd.clip_end = 40000
cam = bpy.data.objects.new('Pano', cd)
scene.collection.objects.link(cam)
cam.rotation_euler = (math.pi / 2, 0, 0)
scene.camera = cam
r.resolution_x, r.resolution_y, r.resolution_percentage = args.res, args.res // 2, 100
if args.crop:
    # only the part of the sky the film camera ever sees (longitude 0 = toward the light)
    lo0, lo1, la0, la1 = (float(v) for v in args.crop.split(','))
    r.use_border = True
    r.use_crop_to_border = False
    r.border_min_x, r.border_max_x = (lo0 + 180) / 360, (lo1 + 180) / 360
    r.border_min_y, r.border_max_y = (la0 + 90) / 180, (la1 + 90) / 180
out = os.path.abspath(args.out)
if out.endswith('.exr'):
    r.image_settings.file_format = 'OPEN_EXR'
    r.image_settings.color_depth = '16'
    r.image_settings.exr_codec = 'DWAA'
else:
    r.image_settings.file_format = 'HDR'
os.makedirs(os.path.dirname(out), exist_ok=True)
r.filepath = out
bpy.ops.render.render(write_still=True)
print('PANORAMA SAVED', r.filepath, flush=True)
