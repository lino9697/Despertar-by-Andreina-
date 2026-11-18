"""
Merges the sky panorama renders into the final world image:
the sharp window the film camera sees (sky_panorama.py --crop) laid over the
full low-resolution panorama (light and reflections from every direction),
then exports the web version for the live site.

  blender -b --factory-startup --python film/sky_merge.py -- --base film/sky/heaven_low.exr
      --crop film/sky/heaven_crop.exr --window -75,75,-78,25 --out film/sky/heaven.exr
      --jpg public/textures/heaven.jpg
"""
import bpy
import os
import sys
import argparse
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
ap = argparse.ArgumentParser()
ap.add_argument('--base', required=True)
ap.add_argument('--crop', default='')
ap.add_argument('--window', default='-75,75,-78,25')
ap.add_argument('--feather', type=int, default=40)
ap.add_argument('--out', required=True)
ap.add_argument('--jpg', default='')
ap.add_argument('--jpg-width', type=int, default=4096)
args = ap.parse_args(argv)
sc = bpy.context.scene


def pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


base = bpy.data.images.load(os.path.abspath(args.base))
if args.crop:
    crop = bpy.data.images.load(os.path.abspath(args.crop))
    W, H = crop.size
    base.scale(W, H)
    out = pixels(base)
    sharp = pixels(crop)
    lo0, lo1, la0, la1 = (float(v) for v in args.window.split(','))
    x0, x1 = int((lo0 + 180) / 360 * W), int((lo1 + 180) / 360 * W)
    y0, y1 = int((la0 + 90) / 180 * H), int((la1 + 90) / 180 * H)
    f = args.feather
    # soft-edged mask, fully sharp inside the window, blending over `f` pixels
    xs = np.arange(W, dtype=np.float32)
    ys = np.arange(H, dtype=np.float32)
    mx = np.clip(np.minimum(xs - (x0 + 2), (x1 - 3) - xs) / f, 0, 1)
    my = np.clip(np.minimum(ys - (y0 + 2), (y1 - 3) - ys) / f, 0, 1)
    if y0 <= 1:
        my = np.clip(((y1 - 3) - ys) / f, 0, 1)       # the window reaches the pole
    m = (my[:, None] * mx[None, :])[..., None]
    m = m * m * (3 - 2 * m)
    out = out * (1 - m) + sharp * m
    out[..., 3] = 1.0
else:
    W, H = base.size
    out = pixels(base)

img = bpy.data.images.new('Heaven', W, H, float_buffer=True, alpha=False)
img.pixels.foreach_set(out.ravel())
s = sc.render.image_settings
s.file_format = 'OPEN_EXR'
s.color_depth = '16'
s.exr_codec = 'DWAA'
sc.view_settings.view_transform = 'Standard'
img.save_render(os.path.abspath(args.out), scene=sc)
print('MERGED', args.out, W, H, flush=True)

if args.jpg:
    img.scale(args.jpg_width, args.jpg_width // 2)
    sc.view_settings.view_transform = 'AgX'
    s.file_format = 'JPEG'
    s.quality = 88
    img.save_render(os.path.abspath(args.jpg), scene=sc)
    print('JPEG', args.jpg, flush=True)
