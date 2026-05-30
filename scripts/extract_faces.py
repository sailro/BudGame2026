"""
Detect faces in roaster.jpg using OpenCV Haar cascade, sort by X position,
and save the 4 male faces (positions 1, 4, 5, 6 from left) as Pat/Seb/Bud/Nico.

Two outputs per character:
  - assets/faces/{name}.png  : square circular-alpha cutout (used in UI portraits)
  - assets/heads/{name}.png  : 1024x512 spherical UV texture (skin background +
                               face centered on front-of-sphere) for the head mesh.
"""
import cv2
import os
from PIL import Image, ImageDraw, ImageFilter

PHOTOS = os.path.join(os.path.dirname(__file__), '..', 'photos')
FACES_OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'faces')
HEADS_OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'heads')
os.makedirs(FACES_OUT, exist_ok=True)
os.makedirs(HEADS_OUT, exist_ok=True)

img = cv2.imread(os.path.join(PHOTOS, 'roaster.jpg'))
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
cascade = cv2.CascadeClassifier(cascade_path)

faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5,
                                 minSize=(200, 200))

faces = sorted(faces, key=lambda f: f[0])
print(f"Detected {len(faces)} faces:")
for i, (x, y, w, h) in enumerate(faces):
    print(f"  {i}: x={x}, y={y}, w={w}, h={h}")

labels_in_order = ['pat', 'lady1', 'lady2', 'seb', 'bud', 'nico']
wanted = {'pat', 'seb', 'bud', 'nico'}

PAD = 0.20
FACE_SIZE = 256              # menu portrait size (displayed at 84px in CSS)
HEAD_W, HEAD_H = 1024, 512   # 2:1 for spherical UV mapping
HEAD_JPEG_Q = 85             # JPEG quality for head textures
SKIN_RGB = (243, 200, 154)

top_pad_override = {'nico': 0.10}


def circular_alpha(img: Image.Image) -> Image.Image:
    size = img.size[0]
    mask = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4, size * 4), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=1.5))
    out = img.convert('RGBA')
    out.putalpha(mask)
    return out


def make_head_texture(face_rgba: Image.Image) -> Image.Image:
    """Build a 1024x512 RGB texture: skin background + LARGE face decal that
    covers as much of the sphere's visible front as possible.

    A Babylon sphere wraps U from 0 (back) -> 0.5 (back wrapping around) and
    V from 0 (top pole) -> 1 (bottom pole) with invertY=false. Painting the
    face at U=0.5 centers it on the front of the sphere. We make the face
    big enough that the cheeks wrap a bit toward the sides of the head, so
    the model reads as "all face" from gameplay angles.
    """
    canvas = Image.new('RGB', (HEAD_W, HEAD_H), SKIN_RGB)
    # Subtle vertical shading so the head looks rounded near the poles
    shade = Image.new('L', (HEAD_W, HEAD_H), 255)
    sdraw = ImageDraw.Draw(shade)
    for v in range(HEAD_H):
        d = abs(v - HEAD_H / 2) / (HEAD_H / 2)
        sdraw.line([(0, v), (HEAD_W, v)], fill=int(255 - 40 * d ** 2))
    canvas = Image.composite(canvas, Image.new('RGB', canvas.size, (10, 5, 0)),
                             shade)

    # Face: scale to ~70% of canvas width so it covers the entire visible
    # front hemisphere of the sphere (sphere is 2:1 aspect, so 70% of width =
    # 140% of height — we use 80% of height instead to avoid the face
    # squishing into the pole).
    face_w = int(HEAD_W * 0.70)
    face_h = int(HEAD_H * 0.85)
    face_resized = face_rgba.resize((face_w, face_h), Image.LANCZOS)
    # Center horizontally on U=0.5 (front of sphere). Center vertically on
    # V=0.5 so eyes/mouth land near the equator.
    px = (HEAD_W - face_w) // 2
    py = (HEAD_H - face_h) // 2
    canvas.paste(face_resized, (px, py), face_resized)
    return canvas


def save_face_png(img: Image.Image, label: str):
    """Save the small circular portrait (used in the menu) as an optimized PNG.
    Quantize to 256 colors so the file is much smaller (~30 KB instead of 200+ KB)."""
    path = os.path.join(FACES_OUT, f'{label}.png')
    # Quantize RGB to 255 colors and keep alpha as a separate channel
    rgb = img.convert('RGB').quantize(colors=255, dither=Image.Dither.FLOYDSTEINBERG)
    rgba = rgb.convert('RGBA')
    rgba.putalpha(img.split()[3])  # preserve original alpha
    rgba.save(path, 'PNG', optimize=True)


def save_head_jpg(img: Image.Image, label: str):
    """Save the spherical wrap as JPEG (no alpha needed) at ~85 quality.
    Cuts ~200 KB PNG down to ~25-40 KB JPEG."""
    path = os.path.join(HEADS_OUT, f'{label}.jpg')
    img.convert('RGB').save(path, 'JPEG', quality=HEAD_JPEG_Q, optimize=True,
                            progressive=True)


def build_from_override(label: str, src_path: str):
    """Build the face + head outputs for a single character from a dedicated
    photo file (one face per image, face mostly fills the frame). The image
    is upscaled to FACE_SIZE, given circular alpha, and wrapped into a head
    texture - same pipeline as the roaster-cropped faces."""
    pil = Image.open(src_path).convert('RGBA')
    # Drop alpha so the skin background shows through after the circular mask
    bg = Image.new('RGB', pil.size, SKIN_RGB)
    bg.paste(pil, (0, 0), pil)
    pil = bg
    # Pad to square so the circular crop doesn't squash the face
    side = max(pil.size)
    sq = Image.new('RGB', (side, side), SKIN_RGB)
    sq.paste(pil, ((side - pil.size[0]) // 2, (side - pil.size[1]) // 2))
    sq = sq.resize((FACE_SIZE, FACE_SIZE), Image.LANCZOS)
    sq_alpha = circular_alpha(sq)
    save_face_png(sq_alpha, label)
    head_tex = make_head_texture(sq_alpha)
    save_head_jpg(head_tex, label)
    print(f"Saved face + head for {label} (from override: {src_path})")


# Per-character override: if photos/{label}.png exists, use it instead of
# cropping from the roaster. Lets us swap in dedicated portraits later
# without re-running face detection.
override_results = set()
for label in wanted:
    override_path = os.path.join(PHOTOS, f'{label}.png')
    if os.path.exists(override_path):
        build_from_override(label, override_path)
        override_results.add(label)


for i, (x, y, w, h) in enumerate(faces):
    if i >= len(labels_in_order):
        break
    label = labels_in_order[i]
    if label not in wanted:
        continue
    if label in override_results:
        # Already produced from override photo - don't overwrite.
        continue
    px = int(w * PAD)
    top_pad = top_pad_override.get(label, 0.30)
    py_top = int(h * top_pad)
    py_bot = int(h * PAD * 0.5)
    x1 = max(0, x - px); y1 = max(0, y - py_top)
    x2 = min(img.shape[1], x + w + px); y2 = min(img.shape[0], y + h + py_bot)
    crop = img[y1:y2, x1:x2]
    crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(crop_rgb)
    side = max(pil.size)
    sq = Image.new('RGB', (side, side), SKIN_RGB)
    sq.paste(pil, ((side - pil.size[0]) // 2, (side - pil.size[1]) // 2))
    sq = sq.resize((FACE_SIZE, FACE_SIZE), Image.LANCZOS)
    sq_alpha = circular_alpha(sq)

    save_face_png(sq_alpha, label)
    head_tex = make_head_texture(sq_alpha)
    save_head_jpg(head_tex, label)
    print(f"Saved face + head for {label}")


