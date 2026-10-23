"""Write a multi-size .ico from pre-rendered PNG frames, one frame per size, no rescaling.

Usage:
    python make_ico.py OUT.ico 16=frames/16.png 20=frames/20.png ... 256=frames/256.png
        [--png-from 256]   # frames >= this size are stored PNG-compressed, smaller ones as 32-bit BMP

Each frame image must already be exactly SIZE x SIZE (RGBA). After writing, the file is read
back and every frame is decoded and compared pixel by pixel with its source; any mismatch
raises. For LineHush the frames are rendered with render_svg.mjs (same folder):
16/20/24/32 from the hand-drawn sNN.svg, 40/48/64/256 from master.svg at the target size.
"""
import argparse
import io
import struct
import sys
from pathlib import Path

from PIL import Image


def bmp_frame(im: Image.Image) -> bytes:
    """32-bit BGRA DIB (straight alpha, bottom-up, height doubled) followed by the AND mask."""
    w, h = im.size
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    px = im.load()
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
    stride = ((w + 31) // 32) * 4
    mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(stride)
        for x in range(w):
            if px[x, y][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        mask += row
    return header + bytes(xor) + bytes(mask)


def png_frame(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_ico(out: Path, frames: list[tuple[int, Image.Image]], png_from: int) -> None:
    frames = sorted(frames, key=lambda f: f[0])
    blobs = [png_frame(im) if n >= png_from else bmp_frame(im) for n, im in frames]
    offset = 6 + 16 * len(frames)
    head = struct.pack("<HHH", 0, 1, len(frames))
    entries = b""
    for (n, _), blob in zip(frames, blobs):
        d = 0 if n >= 256 else n
        entries += struct.pack("<BBBBHHII", d, d, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    out.write_bytes(head + entries + b"".join(blobs))


def read_ico(path: Path) -> list[tuple[int, str, Image.Image]]:
    data = path.read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", data, 0)
    assert reserved == 0 and kind == 1, "not an icon file"
    result = []
    for i in range(count):
        w, h, _, _, _, bpp, size, off = struct.unpack_from("<BBBBHHII", data, 6 + 16 * i)
        w, h = w or 256, h or 256
        blob = data[off:off + size]
        if blob[:8] == b"\x89PNG\r\n\x1a\n":
            im = Image.open(io.BytesIO(blob)).convert("RGBA")
            result.append((w, "PNG", im))
            continue
        hsize, bw, bh, _, bbpp = struct.unpack_from("<IiiHH", blob, 0)
        assert bbpp == 32 and bw == w and bh == 2 * h, f"unexpected BMP frame {bw}x{bh}@{bbpp}"
        im = Image.new("RGBA", (w, h))
        px = im.load()
        p = hsize
        for y in range(h - 1, -1, -1):
            for x in range(w):
                b, g, r, a = blob[p:p + 4]
                px[x, y] = (r, g, b, a)
                p += 4
        result.append((w, "BMP", im))
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("frames", nargs="+", help="SIZE=path.png")
    ap.add_argument("--png-from", type=int, default=256)
    args = ap.parse_args()

    frames = []
    for spec in args.frames:
        size, path = spec.split("=", 1)
        n = int(size)
        im = Image.open(path).convert("RGBA")
        if im.size != (n, n):
            raise SystemExit(f"{path}: {im.size} is not {n}x{n}")
        frames.append((n, im))
    write_ico(args.out, frames, args.png_from)

    back = {n: (fmt, im) for n, fmt, im in read_ico(args.out)}
    ok = True
    for n, src in frames:
        fmt, im = back[n]
        same = im.size == src.size and im.tobytes() == src.tobytes()
        ok &= same
        print(f"{n:>3} {fmt}  {'identical' if same else 'MISMATCH'}")
    if set(back) != {n for n, _ in frames}:
        print("frame sizes differ:", sorted(back))
        ok = False
    print("written", args.out, args.out.stat().st_size, "bytes")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
