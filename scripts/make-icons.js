// Draws the home-screen icons (a white tick on a blue tile) as PNGs, with no
// image libraries: rasterise with 4x4 supersampling, encode with zlib.
//   node scripts/make-icons.js

import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = (name) => fileURLToPath(new URL(`../client/public/${name}`, import.meta.url));
const BLUE = [15, 108, 189];
const WHITE = [255, 255, 255];
const TICK = [[0.27, 0.53], [0.43, 0.68], [0.74, 0.36]];

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function draw(size, { scale = 1, radius = 0 } = {}) {
  const width = 0.105 * scale;
  const pts = TICK.map(([x, y]) => [0.5 + (x - 0.5) * scale, 0.5 + (y - 0.5) * scale]);
  const rows = [];
  const S = 4;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let tick = 0, tile = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
          // rounded-square tile (radius 0 = full bleed)
          const qx = Math.max(Math.abs(u - 0.5) - (0.5 - radius), 0), qy = Math.max(Math.abs(v - 0.5) - (0.5 - radius), 0);
          if (Math.hypot(qx, qy) <= radius || radius === 0) tile++;
          if (distToSegment(u, v, pts[0], pts[1]) <= width / 2 || distToSegment(u, v, pts[1], pts[2]) <= width / 2) tick++;
        }
      }
      const a = tile / (S * S), k = tick / (S * S);
      const o = 1 + x * 4;
      for (let c = 0; c < 3; c++) row[o + c] = Math.round(BLUE[c] * (1 - k) + WHITE[c] * k);
      row[o + 3] = Math.round(a * 255);
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(out('apple-touch-icon.png'), draw(180)); // iOS rounds the corners itself
writeFileSync(out('icon-192.png'), draw(192, { radius: 0.2 }));
writeFileSync(out('icon-512.png'), draw(512, { radius: 0.2 }));
writeFileSync(out('icon-maskable-512.png'), draw(512, { scale: 0.8 }));
writeFileSync(
  out('favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#0f6cbd"/><polyline points="${TICK.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}" fill="none" stroke="#fff" stroke-width="10.5" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`,
);
console.log('icons written to client/public');
