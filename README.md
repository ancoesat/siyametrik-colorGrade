# Siyametrik ColorGrade

A small RAW color grading tool that runs entirely in the browser. Built for DJI DNG files (Osmo Pocket, Osmo Action, Mavic), also opens JPG and PNG. Photos never leave your computer.

**Live:** https://ancoesat.dev/renk

## Use

Open the live link, or download the repo and double click `index.html` (Chrome or Edge). No install, no server, no internet needed.

1. Drag photos into the window.
2. Pick a look, press "Otomatik" (auto) and adjust the sliders if needed.
3. "Karşılaştır" or holding Space shows the original.
4. "Dışa aktar" saves a full resolution JPG to your downloads folder.

Settings are remembered per file name in the browser. The interface is in Turkish.

## How it works

- `dng.js`: DNG reader with no dependencies. TIFF parsing, uncompressed and lossless JPEG Bayer data, color matrices per the DNG spec, and the lens correction opcodes the camera writes (GainMap, WarpRectilinear, FixVignetteRadial). Runs in a Web Worker.
- `app.js`: WebGL2 pipeline (Malvar-He-Cutler demosaic, camera to linear sRGB, grading in linear light, filmic shoulder) and the UI.
- `index.html`: markup and styles.

To add a look, add one line to `LOOKS` in `app.js`.

## Limits

- Bayer DNG only (no X-Trans, no linear or lossy compressed DNG). Unsupported files fall back to the embedded preview.
- Raw decoding is verified against LibRaw on DJI Mavic 3 Pro, Osmo Action and FC9287 samples.
- No noise reduction.

## License

MIT
