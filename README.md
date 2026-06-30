# panopto-fetch

Download **every video in a Panopto folder** (or a single video), in the *view* you
choose, re-encoded efficiently in one pass — no giant raw files hit the disk.

Two pieces with a clean boundary:

1. **`panopto-export.user.js`** — a Tampermonkey userscript that runs in your
   authenticated browser. It enumerates the folder, lets you pick one view (Podcast,
   Primary, Secondary, screen capture…), resolves the real CDN stream URL for each
   video, and copies a single **manifest** string to your clipboard.
2. **`panopto-fetch.py`** — a CLI. Paste the manifest; for each video it runs one
   `ffmpeg` process that reads the remote stream directly and re-encodes it,
   naming the file after the original Panopto title with the view appended.

The browser does all the authenticated work; the CLI only fetches already-resolved
CDN URLs, so it never needs your Panopto cookies.

## Setup

Install `panopto-export.user.js` in Tampermonkey/Violentmonkey (open the file in the
browser, or paste it into a new userscript).

The CLI needs `python3` + an `ffmpeg` with SVT-AV1/x265/Opus. On NixOS just use the
flake:

```sh
nix develop          # gives you python3, ffmpeg, jq and a `panopto-fetch` alias
# or run it directly:
nix run . -- '<MANIFEST>' -o ~/panopto
```

## Use

1. Open a Panopto **folder** (`List.aspx`) or a single **video** (`Viewer.aspx`).
2. Click **⬇ Export views** (top of the folder toolbar / near the video tabs), or
   use the Tampermonkey menu command. Pick the view you want.
3. The manifest is copied to your clipboard. Run:

   ```sh
   panopto-fetch '<paste the manifest>' -o ~/panopto
   # or:  pbpaste | panopto-fetch -o ~/panopto
   # or:  panopto-fetch -f manifest.txt -o ~/panopto
   ```

Files land as `01 - <Original Title> [<View>].mkv`.

> The manifest carries signed CDN URLs that expire after a few hours. Run the CLI
> soon after exporting; on auth/403 errors, just click the button again.

## Encoding

Default is **SVT-AV1, 10-bit, CRF 32, preset 6** with a light `hqdn3d` pre-filter —
a good speed/size middle ground that handles grainy/noisy lecture video well. Audio
is Opus 96k. Output container is `.mkv`.

| Flag | Default | Notes |
|------|---------|-------|
| `--codec av1\|hevc\|nvenc` | `av1` | `hevc` = libx265 → `.mp4`; `nvenc` = GPU HEVC (fast, larger) |
| `--crf N` | per codec (av1 32, hevc 27) | lower = bigger/better |
| `--preset P` | av1 `6`, hevc `medium` | encoder preset |
| `--no-10bit` | off | encode 8-bit |
| `--no-denoise` | off | disable the hqdn3d pre-filter |
| `--jobs N` | `min(3, cpu, #videos)` | parallel encodes |
| `--no-number` | off | drop the `NN - ` filename prefix |
| `--overwrite` | off | re-encode even if output exists (otherwise skips = resume) |
| `--dry-run` | off | print the ffmpeg commands without running |

`nvenc` needs a system ffmpeg built with NVENC + a working NVIDIA driver. The flake's
ffmpeg doesn't include it; point at your system build:

```sh
FFMPEG=/run/current-system/sw/bin/ffmpeg panopto-fetch '<MANIFEST>' --codec nvenc
```

## Files

- `panopto-export.user.js` — the browser userscript (folder + single video).
- `panopto-fetch.py` — the downloader/encoder CLI (pure stdlib).
- `flake.nix` — dev shell + `panopto-fetch` package/app.
- `Panopto-Video-DL/` — upstream GUI project, kept as reference.
- `panopto-batch-video-downloader.user.js`, `panopto-diagnostics-console.js` —
  earlier scratch/diagnostic scripts, superseded by `panopto-export.user.js`.
