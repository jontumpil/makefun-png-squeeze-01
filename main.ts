// SqueezeBox — a lossless PNG re-encoder for 1280x720 RGBA screenshots.
// Reads /input/<id>/image.png and writes the identical pixels to
// /output/<id>/image.png in as few bytes as it can manage:
//   * colour-type reduction — palette (type 3) when the screenshot holds at
//     most 256 distinct colours, grey (0) or grey+alpha (4) when every pixel
//     is grey, plain RGB (2) when alpha is everywhere opaque;
//   * a per-row brute-force filter search, each of the five PNG filters
//     scored by the sum of its absolute signed residuals, cheapest wins;
//   * zlib at level 9 under two strategies, the smaller stream kept.
// Node standard library only; no clock, no randomness — same input, same
// output bytes, every run.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync, constants as ZC } from "node:zlib";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

// ---- CRC-32 (PNG chunk checksums) ----------------------------------------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// ---- PNG decoding ---------------------------------------------------------
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

type Picture = { width: number; height: number; rgba: Uint8Array };

function decodePng(bytes: Buffer): Picture {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error("not a png");
  let width = 0;
  let height = 0;
  let colorType = 6;
  let bitDepth = 8;
  const idat: Buffer[] = [];
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString("ascii", off + 4, off + 8);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error("unsupported png: bitDepth " + bitDepth + " colourType " + colorType);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const rowBytes = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const base = y * (rowBytes + 1);
    const f = raw[base];
    const cur = new Uint8Array(rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[base + 1 + x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 0) cur[x] = v;
      else if (f === 1) cur[x] = (v + a) & 255;
      else if (f === 2) cur[x] = (v + b) & 255;
      else if (f === 3) cur[x] = (v + ((a + b) >> 1)) & 255;
      else cur[x] = (v + paeth(a, b, c)) & 255;
    }
    prev = cur;
    if (bpp === 4) {
      px.set(cur, y * width * 4);
    } else {
      for (let x = 0; x < width; x++) {
        const s = x * 3;
        const d = (y * width + x) * 4;
        px[d] = cur[s];
        px[d + 1] = cur[s + 1];
        px[d + 2] = cur[s + 2];
        px[d + 3] = 255;
      }
    }
  }
  return { width, height, rgba: px };
}

// ---- Choosing the smallest exact representation ---------------------------
type Plan = {
  colorType: number;
  bpp: number;
  rowBytes: number;
  rows: Uint8Array;
  plte: Buffer | null;
  trns: Buffer | null;
};

function plans(pic: Picture): Plan[] {
  const { width, height, rgba } = pic;
  const npix = width * height;
  const counts = new Map<number, number>();
  let allGrey = true;
  let allOpaque = true;
  let tooMany = false;
  for (let i = 0; i < npix; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (r !== g || g !== b) allGrey = false;
    if (a !== 255) allOpaque = false;
    if (!tooMany) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (counts.size > 256) tooMany = true;
    }
  }
  // Every representation that could plausibly win becomes a candidate; the
  // encoder keeps whichever candidate's finished PNG is smallest, so an
  // unlucky guess costs a little time, never points.
  const out: Plan[] = [];

  if (!tooMany) {
    // Palette order matters: it sets the index values the filters subtract.
    // Try frequency-first (common colours get small indices), colour-value
    // order (smooth gradients get smooth index steps) and first-appearance
    // order; the finished-size contest in encodePng keeps the best.
    const byFreq = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([k]) => k);
    const byValue = [...counts.keys()].sort((a, b) => a - b);
    const byAppearance = [...counts.keys()];
    for (const order of [byFreq, byValue, byAppearance]) {
      const index = new Map<number, number>();
      const plte = Buffer.alloc(order.length * 3);
      const alphas: number[] = [];
      order.forEach((key, i) => {
        index.set(key, i);
        plte[i * 3] = (key >>> 24) & 255;
        plte[i * 3 + 1] = (key >>> 16) & 255;
        plte[i * 3 + 2] = (key >>> 8) & 255;
        alphas.push(key & 255);
      });
      let lastAlpha = alphas.length - 1;
      while (lastAlpha >= 0 && alphas[lastAlpha] === 255) lastAlpha--;
      const trns = lastAlpha >= 0 ? Buffer.from(alphas.slice(0, lastAlpha + 1)) : null;
      const rows = new Uint8Array(npix);
      for (let i = 0; i < npix; i++) {
        const key = ((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]) >>> 0;
        rows[i] = index.get(key) as number;
      }
      out.push({ colorType: 3, bpp: 1, rowBytes: width, rows, plte, trns });
    }
  }

  if (allGrey && allOpaque) {
    const rows = new Uint8Array(npix);
    for (let i = 0; i < npix; i++) rows[i] = rgba[i * 4];
    out.push({ colorType: 0, bpp: 1, rowBytes: width, rows, plte: null, trns: null });
  } else if (allGrey) {
    const rows = new Uint8Array(npix * 2);
    for (let i = 0; i < npix; i++) {
      rows[i * 2] = rgba[i * 4];
      rows[i * 2 + 1] = rgba[i * 4 + 3];
    }
    out.push({ colorType: 4, bpp: 2, rowBytes: width * 2, rows, plte: null, trns: null });
  }
  if (allOpaque && !allGrey) {
    const rows = new Uint8Array(npix * 3);
    for (let i = 0; i < npix; i++) {
      rows[i * 3] = rgba[i * 4];
      rows[i * 3 + 1] = rgba[i * 4 + 1];
      rows[i * 3 + 2] = rgba[i * 4 + 2];
    }
    out.push({ colorType: 2, bpp: 3, rowBytes: width * 3, rows, plte: null, trns: null });
  }
  if (!allOpaque && !allGrey) {
    out.push({ colorType: 6, bpp: 4, rowBytes: width * 4, rows: rgba, plte: null, trns: null });
  }
  if (out.length === 0) {
    out.push({ colorType: 6, bpp: 4, rowBytes: width * 4, rows: rgba, plte: null, trns: null });
  }
  return out;
}

// ---- Per-row brute-force filter search ------------------------------------
// Every row tries all five filters; a filter's price is the sum of the
// absolute values of its signed residuals, and scoring stops early once a
// candidate can no longer beat the row's current best.
function filteredStream(p: Plan, height: number, mode: string): Buffer {
  const { bpp, rowBytes, rows } = p;
  const out = Buffer.alloc(height * (rowBytes + 1));
  const cand = new Uint8Array(rowBytes);
  const best = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const rowOff = y * rowBytes;
    const upOff = rowOff - rowBytes;
    let bestCost = Infinity;
    let bestFilter = 0;
    for (let f = mode === "paeth" ? 4 : 0; f < 5; f++) {
      let cost = 0;
      for (let x = 0; x < rowBytes; x++) {
        const raw = rows[rowOff + x];
        const a = x >= bpp ? rows[rowOff + x - bpp] : 0;
        const b = y > 0 ? rows[upOff + x] : 0;
        const c = y > 0 && x >= bpp ? rows[upOff + x - bpp] : 0;
        let v: number;
        if (f === 0) v = raw;
        else if (f === 1) v = raw - a;
        else if (f === 2) v = raw - b;
        else if (f === 3) v = raw - ((a + b) >> 1);
        else v = raw - paeth(a, b, c);
        v &= 255;
        cand[x] = v;
        cost += v < 128 ? v : 256 - v;
        if (cost >= bestCost) break;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestFilter = f;
        best.set(cand);
      }
    }
    const o = y * (rowBytes + 1);
    out[o] = bestFilter;
    out.set(best, o + 1);
  }
  return out;
}

// ---- Assembly --------------------------------------------------------------
function encodePng(pic: Picture, candidates: Plan[]): Buffer {
  // Every candidate representation is finished both ways — the scored
  // filter search and a fixed Paeth stream (which noisy, photo-like rows
  // often prefer) — and the smallest finished PNG wins.
  let winner: Buffer | null = null;
  for (const p of candidates) {
    for (const mode of ["msad", "paeth"]) {
      const stream = filteredStream(p, pic.height, mode);
      const plain = deflateSync(stream, { level: 9, memLevel: 9 });
      const filtered = deflateSync(stream, { level: 9, memLevel: 9, strategy: ZC.Z_FILTERED });
      const idat = filtered.length < plain.length ? filtered : plain;
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(pic.width, 0);
      ihdr.writeUInt32BE(pic.height, 4);
      ihdr[8] = 8;
      ihdr[9] = p.colorType;
      const parts: Buffer[] = [
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr),
      ];
      if (p.plte) parts.push(chunk("PLTE", p.plte));
      if (p.trns) parts.push(chunk("tRNS", p.trns));
      parts.push(chunk("IDAT", idat));
      parts.push(chunk("IEND", Buffer.alloc(0)));
      const png = Buffer.concat(parts);
      if (winner === null || png.length < winner.length) winner = png;
    }
  }
  return winner as Buffer;
}

function main(): void {
  const ids = readdirSync(INPUT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^i\d{3}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const id of ids) {
    const src = join(INPUT_DIR, id, "image.png");
    if (!existsSync(src)) continue;
    const pic = decodePng(readFileSync(src));
    const out = encodePng(pic, plans(pic));
    const dir = join(OUTPUT_DIR, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "image.png"), out);
  }
}
main();
