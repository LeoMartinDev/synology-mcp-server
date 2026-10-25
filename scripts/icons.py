# Draws the package and app icons (PNG) into package/: run once after changing the design,
# with Pillow installed: python scripts/icons.py
from PIL import Image, ImageDraw

S = 1024  # drawn large, then scaled down for smooth edges


def gradient(size, top, bottom):
    img = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        draw.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    return img


def icon():
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(gradient(S, (64, 132, 245), (88, 64, 214)), (0, 0), mask)

    draw = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    accent = (255, 170, 60, 255)
    # A NAS: two drive bays with their status lights.
    for top in (250, 470):
        draw.rounded_rectangle([230, top, 794, top + 170], radius=40, fill=white)
        draw.ellipse([300, top + 60, 350, top + 110], fill=accent)
        draw.rounded_rectangle([400, top + 70, 720, top + 100], radius=15, fill=(88, 64, 214, 255))
    # The link to Claude: a cable going down to a plug.
    draw.rounded_rectangle([492, 640, 532, 760], radius=20, fill=white)
    draw.rounded_rectangle([400, 740, 624, 800], radius=30, fill=white)
    return img


def save(img, size, path):
    img.resize((size, size), Image.LANCZOS).save(path, optimize=True)


big = icon()
for size in (16, 24, 32, 48, 64, 72, 256):
    save(big, size, f"package/target/ui/images/icon_{size}.png")
save(big, 64, "package/PACKAGE_ICON.PNG")
save(big, 256, "package/PACKAGE_ICON_256.PNG")
