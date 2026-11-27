# SqueezeBox — a lossless PNG minimizer

[![make.fun bounty](https://img.shields.io/badge/make.fun-png--squeeze--01-blue)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

SqueezeBox re-encodes 1280×720 RGBA screenshots into the smallest valid PNG
that decodes to the *identical* pixels — every channel of every pixel exact,
including the red, green and blue values hiding under fully transparent
pixels. It is a single `main.ts` using nothing but the Node standard library.

## How it squeezes

1. **Decode** the stored source PNG (inflate + unfilter) back to raw pixels.
2. **Propose every representation that could win** and let the finished byte
   count decide:
   - palette (colour type 3, plus a `tRNS` chunk when alpha varies) whenever
     the screenshot holds at most 256 distinct colours — tried under three
     palette orders: frequency-first, colour-value, and first-appearance;
   - grey (type 0) or grey+alpha (type 4) when every pixel is grey;
   - plain RGB (type 2) when alpha is everywhere opaque;
   - RGBA (type 6) otherwise.
3. **Filter twice per candidate**: a per-row brute-force search over all five
   PNG filters scored by the sum of absolute signed residuals, and a fixed
   Paeth stream, which noisy photo-like rows often prefer.
4. **Deflate** each stream with zlib at level 9 under two strategies and keep
   the smaller; assemble the PNG with a hand-rolled chunk writer.

No clock, no randomness: the same input always produces the same bytes.

## Practice-set result

Measured locally against the kit's practice set and official scorer:

| program | total score (of 1,000,000) |
| --- | --- |
| house baseline `fixed-paeth` 1.0.0 | 420,399 |
| **SqueezeBox** | **633,669** |

All 8 instances answered, all pixel-exact, ~14 s wall for the set on a
shared vCPU (the limit is 60 s).

## Running it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

The program reads `<id>/image.png` for every instance directory in the input
folder and writes the re-encoded file to the matching directory in the output
folder, creating directories as needed.

## License

MIT — see [LICENSE](LICENSE).
