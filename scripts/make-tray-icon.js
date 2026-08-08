const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// draws the macos status-bar icon (a small equalizer glyph, like three sync
// bars) as a template image: black pixels whose shape comes from the alpha
// channel, so the os can recolour it for light/dark menu bars.
const BARS = [
  { x: 1, w: 3, h: 6 },
  { x: 6, w: 3, h: 11 },
  { x: 11, w: 3, h: 8 },
];
const BASELINE = 14; // bars grow up from here (16-unit design grid)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: rgba
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function draw(size, scale) {
  const pixels = Buffer.alloc(size * size * 4);
  for (const bar of BARS) {
    const left = bar.x * scale;
    const right = (bar.x + bar.w) * scale;
    const top = (BASELINE - bar.h) * scale;
    const bottom = BASELINE * scale;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const i = (y * size + x) * 4;
        pixels[i] = 0; // r
        pixels[i + 1] = 0; // g
        pixels[i + 2] = 0; // b
        pixels[i + 3] = 255; // a
      }
    }
  }
  return pixels;
}

const outDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "trayTemplate.png"), png(16, 16, draw(16, 1)));
fs.writeFileSync(path.join(outDir, "trayTemplate@2x.png"), png(32, 32, draw(32, 2)));
console.log("wrote tray icons to " + outDir);
