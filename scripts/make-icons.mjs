// Gera os ícones PNG do app sem dependências: desenha num buffer RGBA e codifica PNG com zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function draw(size, padding) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [0x14, 0x17, 0x1c], orange = [0xf2, 0x8c, 0x28], steel = [0x9a, 0xa7, 0xb8];
  const set = (x, y, c, a = 1) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = Math.round(px[i] * (1 - a) + c[0] * a); px[i + 1] = Math.round(px[i + 1] * (1 - a) + c[1] * a); px[i + 2] = Math.round(px[i + 2] * (1 - a) + c[2] * a); px[i + 3] = 255;
  };
  const r = size * 0.22; // cantos arredondados do fundo
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = Math.max(r - x, 0, x - (size - 1 - r)), dy = Math.max(r - y, 0, y - (size - 1 - r));
    const inside = padding ? true : dx * dx + dy * dy <= r * r;
    if (inside) set(x, y, bg); else { const i = (y * size + x) * 4; px[i + 3] = 0; }
  }
  // Bloco isométrico: um cubo em linha (esboço) com a face frontal cheia.
  const s = size * (padding ? 0.72 : 0.78), cx = size / 2, cy = size / 2;
  const w = s * 0.5, hgt = s * 0.5, d = s * 0.28;
  const front = [[cx - w / 2, cy - hgt / 2 + d / 2], [cx + w / 2, cy - hgt / 2 + d / 2], [cx + w / 2, cy + hgt / 2 + d / 2], [cx - w / 2, cy + hgt / 2 + d / 2]];
  const off = [d * 0.9, -d * 0.9];
  const back = front.map(([x, y]) => [x + off[0], y + off[1]]);
  const fill = (poly, c, a) => {
    const ys = poly.map((p) => p[1]); const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
    for (let y = y0; y <= y1; y++) {
      const xs = [];
      for (let i = 0; i < poly.length; i++) { const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length]; if ((ay <= y) !== (by <= y)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay)); }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x <= Math.round(xs[k + 1]); x++) set(x, y, c, a);
    }
  };
  const line = (a, b, c, t) => {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2);
    for (let i = 0; i <= n; i++) { const x = a[0] + ((b[0] - a[0]) * i) / n, y = a[1] + ((b[1] - a[1]) * i) / n; for (let ox = -t; ox <= t; ox++) for (let oy = -t; oy <= t; oy++) if (ox * ox + oy * oy <= t * t) set(Math.round(x + ox), Math.round(y + oy), c); }
  };
  // Face de cima e lateral em aço, frente em laranja.
  fill([front[0], front[1], back[1], back[0]], steel, 0.55);
  fill([front[1], back[1], back[2], front[2]], steel, 0.35);
  fill(front, orange, 1);
  const t = Math.max(1, Math.round(size * 0.012));
  for (let i = 0; i < 4; i++) { line(front[i], front[(i + 1) % 4], bg, t); line(back[i], back[(i + 1) % 4], steel, t); line(front[i], back[i], steel, t); }
  return png(size, size, px);
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', draw(192, false));
writeFileSync('public/icons/icon-512.png', draw(512, true));
writeFileSync('public/icons/apple-touch-icon.png', draw(180, true));
console.log('ícones gerados');
