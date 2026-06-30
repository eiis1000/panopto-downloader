#!/usr/bin/env python3
"""panopto-fetch — download + re-encode a whole Panopto folder from a manifest.

The companion userscript (panopto-export.user.js) runs inside your authenticated
browser session, resolves the real CDN stream URL for the *view* you pick, and
copies a single base64 string (the "manifest"). Paste that string here.

This tool then, for each video, runs ONE ffmpeg process that reads the remote
stream directly and re-encodes it in a single pass — no raw intermediate file is
ever written to disk. Output is named after the original Panopto title with the
view appended.

Usage
-----
    panopto-fetch '<BASE64_MANIFEST>'           # paste the string from the button
    pbpaste | panopto-fetch                      # or pipe it in (stdin)
    panopto-fetch -f manifest.txt                # or from a file
    panopto-fetch '<...>' -o ~/lectures --jobs 4
    panopto-fetch '<...>' --codec hevc           # H.265/mp4 instead of AV1/mkv
    panopto-fetch '<...>' --codec nvenc          # GPU (fast, larger files)

The manifest carries already-resolved, signed CDN URLs. Those expire after a few
hours, so run this reasonably soon after clicking the button; if you hit auth
errors, just re-export.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

# --------------------------------------------------------------------------- #
# Codec profiles. Each maps to a chunk of ffmpeg output args.
# "middle ground between speed and compression" with grain robustness in mind.
# --------------------------------------------------------------------------- #

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# Allow pointing at a specific ffmpeg (e.g. a system build with NVENC) via $FFMPEG.
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")


def video_args(codec: str, crf: int | None, preset: str | None,
               ten_bit: bool, have: set[str]) -> tuple[list[str], str]:
    """Return (ffmpeg video args, container extension)."""
    pix = ["-pix_fmt", "yuv420p10le"] if ten_bit else ["-pix_fmt", "yuv420p"]

    if codec == "av1":
        if "libsvtav1" not in have:
            sys.exit("error: ffmpeg has no libsvtav1; try --codec hevc")
        c = crf if crf is not None else 32
        p = preset if preset is not None else "6"
        return (["-c:v", "libsvtav1", "-preset", p, "-crf", str(c),
                 "-svtav1-params", "tune=0", "-g", "240", *pix], "mkv")

    if codec == "hevc":
        if "libx265" not in have:
            sys.exit("error: ffmpeg has no libx265; try --codec av1")
        c = crf if crf is not None else 27
        p = preset if preset is not None else "medium"
        return (["-c:v", "libx265", "-preset", p, "-crf", str(c),
                 "-tag:v", "hvc1", *pix], "mp4")

    if codec == "nvenc":  # GPU HEVC — fast, larger files, no 10-bit grain win
        if "hevc_nvenc" not in have:
            sys.exit("error: ffmpeg has no hevc_nvenc (no NVIDIA?); try --codec av1")
        c = crf if crf is not None else 28
        p = preset if preset is not None else "p5"
        return (["-c:v", "hevc_nvenc", "-preset", p, "-rc", "vbr",
                 "-cq", str(c), "-tag:v", "hvc1",
                 "-pix_fmt", "p010le" if ten_bit else "yuv420p"], "mp4")

    sys.exit(f"error: unknown codec {codec!r}")


def audio_args(have: set[str]) -> list[str]:
    # Opus is tiny and excellent for speech; fall back to AAC if unavailable.
    if "libopus" in have:
        return ["-c:a", "libopus", "-b:a", "96k"]
    return ["-c:a", "aac", "-b:a", "128k"]


# --------------------------------------------------------------------------- #
# Manifest parsing
# --------------------------------------------------------------------------- #

@dataclass
class Item:
    index: int
    title: str
    view: str
    url: str


def load_manifest(raw: str) -> tuple[dict, list[Item]]:
    raw = raw.strip()
    # Allow either raw JSON or the base64 the userscript emits.
    data = None
    if raw and raw[0] in "{[":
        data = json.loads(raw)
    else:
        compact = re.sub(r"\s+", "", raw)
        try:
            decoded = base64.b64decode(compact + "=" * (-len(compact) % 4))
            data = json.loads(decoded.decode("utf-8"))
        except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as e:
            sys.exit(f"error: could not parse manifest (not base64 JSON): {e}")

    items_raw = data.get("items") or []
    if not items_raw:
        sys.exit("error: manifest contains no items")
    items = []
    for i, it in enumerate(items_raw, 1):
        url = it.get("url")
        if not url:
            continue
        items.append(Item(
            index=it.get("index", i),
            title=(it.get("title") or f"video-{i}").strip(),
            view=(it.get("view") or "video").strip(),
            url=url,
        ))
    if not items:
        sys.exit("error: manifest items have no resolvable stream URLs")
    return data, items


# --------------------------------------------------------------------------- #
# Filenames
# --------------------------------------------------------------------------- #

_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize(name: str, limit: int = 150) -> str:
    name = _ILLEGAL.sub(" ", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    if len(name) > limit:
        name = name[:limit].rstrip(" .")
    return name or "video"


def output_path(outdir: Path, item: Item, n_items: int, ext: str,
                number: bool) -> Path:
    base = sanitize(item.title)
    view = sanitize(item.view)
    prefix = ""
    if number:
        width = max(2, len(str(n_items)))
        prefix = f"{item.index:0{width}d} - "
    stem = f"{prefix}{base} [{view}]" if view else f"{prefix}{base}"
    return outdir / f"{sanitize(stem, 200)}.{ext}"


# --------------------------------------------------------------------------- #
# Encoding
# --------------------------------------------------------------------------- #

def ffmpeg_encoders() -> set[str]:
    out = subprocess.run([FFMPEG, "-hide_banner", "-encoders"],
                         capture_output=True, text=True).stdout
    return {line.split()[1] for line in out.splitlines()
            if line.startswith(" ") and len(line.split()) > 1}


_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def encode_one(item: Item, out: Path, origin: str, vargs: list[str],
               aargs: list[str], filters: list[str], ext: str,
               overwrite: bool, dry_run: bool) -> tuple[Item, str]:
    if out.exists() and not overwrite:
        return item, "skip"

    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-stats",
           "-user_agent", UA]
    if origin:
        cmd += ["-headers", f"Referer: {origin}/\r\n"]
    cmd += ["-i", item.url]

    # Panopto HLS playlists can advertise pathological nominal frame rates.
    # SVT-AV1 rejects anything above 240 fps, so normalize CFR before encode.
    cmd += ["-map", "0:v:0", "-map", "0:a?", "-sn", "-dn"]
    if filters:
        cmd += ["-vf", ",".join(filters)]
    cmd += vargs + aargs
    if ext == "mp4":
        cmd += ["-movflags", "+faststart"]
    # Keep the real extension last so ffmpeg can infer the muxer (foo.part.mkv).
    part = out.with_suffix(".part" + out.suffix)
    cmd += ["-y", str(part)]

    if dry_run:
        log("DRY  " + " ".join(map(_shquote, cmd)))
        return item, "dry"

    log(f"START {out.name}")
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        part.unlink(missing_ok=True)
        return item, f"fail (ffmpeg exit {e.returncode})"
    part.rename(out)
    size_mb = out.stat().st_size / 1e6
    log(f"DONE  {out.name}  ({size_mb:.1f} MB)")
    return item, "ok"


def _shquote(s: str) -> str:
    return s if re.fullmatch(r"[\w@%+=:,./-]+", s) else "'" + s.replace("'", "'\\''") + "'"


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def read_manifest_arg(args) -> str:
    if args.file:
        return Path(args.file).read_text()
    if args.manifest:
        return args.manifest
    if not sys.stdin.isatty():
        return sys.stdin.read()
    sys.exit("error: no manifest given (pass as argument, --file, or via stdin)")


def main() -> None:
    p = argparse.ArgumentParser(
        description="Download + re-encode a Panopto folder from a userscript manifest.",
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    p.add_argument("manifest", nargs="?", help="base64 manifest string from the button")
    p.add_argument("-f", "--file", help="read manifest from a file instead")
    p.add_argument("-o", "--outdir", default=".", help="output directory (default: cwd)")
    p.add_argument("--codec", choices=["av1", "hevc", "nvenc"], default="av1",
                   help="av1=SVT-AV1/mkv (default), hevc=x265/mp4, nvenc=GPU HEVC/mp4")
    p.add_argument("--crf", type=int, help="quality (lower=bigger/better); per-codec default")
    p.add_argument("--preset", help="encoder preset; per-codec default")
    p.add_argument("--no-10bit", dest="ten_bit", action="store_false",
                   help="encode 8-bit instead of 10-bit")
    p.add_argument("--no-denoise", dest="denoise", action="store_false",
                   help="disable the light hqdn3d pre-filter")
    p.add_argument("--fps", type=float, default=30,
                   help="normalize output video FPS before encoding (default: 30; use 0 to disable)")
    p.add_argument("--jobs", type=int, default=1,
                   help="parallel encodes/downloads (default: 1)")
    p.add_argument("--skip", type=int, default=0,
                   help="skip the first N videos from the manifest before downloading")
    p.add_argument("--no-number", dest="number", action="store_false",
                   help="don't prefix filenames with NN -")
    p.add_argument("--overwrite", action="store_true", help="re-encode even if output exists")
    p.add_argument("--dry-run", action="store_true", help="print ffmpeg commands, don't run")
    args = p.parse_args()

    if not (shutil.which(FFMPEG) or Path(FFMPEG).exists()):
        sys.exit(f"error: ffmpeg ({FFMPEG!r}) not found (run inside the flake devShell)")

    meta, items = load_manifest(read_manifest_arg(args))
    if args.skip < 0:
        sys.exit("error: --skip must be non-negative")
    original_count = len(items)
    if args.skip:
        items = items[args.skip:]
        if not items:
            sys.exit(f"error: --skip {args.skip} skipped all {original_count} videos")
    origin = meta.get("origin", "")
    folder = meta.get("folderTitle") or meta.get("folderId") or ""

    have = ffmpeg_encoders()
    vargs, ext = video_args(args.codec, args.crf, args.preset, args.ten_bit, have)
    aargs = audio_args(have)
    filters = []
    if args.fps:
        filters.append(f"fps={args.fps:g}")
    if args.denoise:
        filters.append("hqdn3d=1.5:1.5:6:6")

    outdir = Path(args.outdir).expanduser()
    outdir.mkdir(parents=True, exist_ok=True)

    jobs = max(1, min(args.jobs, len(items)))
    log(f"Folder : {folder}")
    if args.skip:
        log(f"Skipped: {args.skip} of {original_count} manifest videos")
    log(f"Videos : {len(items)}   codec={args.codec} ({ext})   jobs={jobs}"
        + (f"   filters={','.join(filters)}" if filters else "   filters=off"))
    log(f"Output : {outdir}\n")

    results: list[tuple[Item, str]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as ex:
        futs = []
        for it in items:
            out = output_path(outdir, it, len(items), ext, args.number)
            futs.append(ex.submit(encode_one, it, out, origin, vargs, aargs,
                                  filters, ext, args.overwrite, args.dry_run))
        for f in concurrent.futures.as_completed(futs):
            results.append(f.result())

    ok = [r for r in results if r[1] == "ok"]
    skip = [r for r in results if r[1] == "skip"]
    fail = [r for r in results if r[1].startswith("fail")]
    log(f"\nDone: {len(ok)} encoded, {len(skip)} skipped, {len(fail)} failed.")
    for it, status in fail:
        log(f"  FAILED: {it.title} [{it.view}] — {status}")
    if fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
