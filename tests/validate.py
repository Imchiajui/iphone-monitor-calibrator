"""Cross-validate generated ICC profiles with LittleCMS (Pillow.ImageCms) and
CIEDE2000 with colour-science. Usage: python3 -I tests/validate.py tests/out"""
import json, struct, sys
from io import BytesIO
from PIL import Image, ImageCms
import colour, numpy as np

out = sys.argv[1] if len(sys.argv) > 1 else 'tests/out'
fail = 0

def check(cond, msg):
    global fail
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        fail += 1

for name in ['calibrated_srgb', 'profileonly_srgb', 'calibrated_p3', 'profileonly_p3']:
    data = open(f'{out}/{name}.icc', 'rb').read()
    prof = ImageCms.ImageCmsProfile(BytesIO(data))
    desc = ImageCms.getProfileDescription(prof).strip()
    check(len(desc) > 0, f'{name}: lcms opens profile, desc="{desc}"')
    p = prof.profile
    check(p.device_class == 'mntr' and p.xcolor_space.strip() == 'RGB', f'{name}: class/colorspace')
    # lcms reads colorants; compare with colour-science Bradford-adapted matrix
    space = colour.RGB_COLOURSPACES['sRGB' if name.endswith('srgb') else 'Display P3']
    M = space.matrix_RGB_to_XYZ
    wp = colour.xy_to_XYZ(space.whitepoint)
    d50 = np.array([0.9642, 1.0, 0.8249])
    A = colour.adaptation.matrix_chromatic_adaptation_VonKries(wp, d50, transform='Bradford')
    Md50 = A @ M
    got = np.array([p.red_colorant[0], p.green_colorant[0], p.blue_colorant[0]]).T
    err = np.abs(got - Md50).max()
    check(err < 2e-4, f'{name}: colorants vs colour-science Bradford (max err {err:.2e})')
    # round-trip transform through lcms: sRGB -> profile -> sRGB should be near identity
    srgb = ImageCms.createProfile('sRGB')
    img = Image.new('RGB', (4, 1)); img.putdata([(255, 255, 255), (128, 128, 128), (255, 0, 0), (30, 60, 90)])
    t1 = ImageCms.buildTransform(srgb, prof, 'RGB', 'RGB', renderingIntent=1)
    t2 = ImageCms.buildTransform(prof, srgb, 'RGB', 'RGB', renderingIntent=1)
    back = list(ImageCms.applyTransform(ImageCms.applyTransform(img, t1), t2).getdata())
    maxd = max(abs(a - b) for pa, pb in zip(img.getdata(), back) for a, b in zip(pa, pb))
    check(maxd <= 3, f'{name}: lcms round-trip max code error {maxd}')

# vcgt tag binary check (lcms ignores private tags; parse manually)
data = open(f'{out}/calibrated_srgb.icc', 'rb').read()
n = struct.unpack('>I', data[128:132])[0]
tags = {data[132+12*i:136+12*i].decode(): struct.unpack('>II', data[136+12*i:144+12*i]) for i in range(n)}
off, ln = tags['vcgt']
check(data[off:off+4] == b'vcgt' and struct.unpack('>I', data[off+8:off+12])[0] == 0, 'vcgt: table type')
ch, cnt, sz = struct.unpack('>HHH', data[off+12:off+18])
check((ch, cnt, sz) == (3, 256, 2), f'vcgt: 3x256x16bit ({ch},{cnt},{sz})')
lut = json.load(open(f'{out}/lut.json'))
vals = struct.unpack('>' + 'H' * 768, data[off+18:off+18+1536])
mx = max(abs(vals[i] / 65535 - lut['r'][i]) for i in range(256))
check(mx < 1e-4, f'vcgt: red table matches LUT (max err {mx:.1e})')
check(struct.unpack('>I', data[0:4])[0] == len(data), 'header size field equals file size')

pairs = json.load(open(f'{out}/de_pairs.json'))
A = np.array([p['a'] for p in pairs]); B = np.array([p['b'] for p in pairs])
ref = colour.delta_E(A, B, method='CIE 2000')
ours = np.array([p['de'] for p in pairs])
e = np.abs(ref - ours).max()
check(e < 1e-6, f'CIEDE2000 vs colour-science on {len(pairs)} random pairs (max diff {e:.1e})')
sys.exit(1 if fail else 0)
