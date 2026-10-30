// Prévia do desenho em SVG (mesmas coordenadas da folha, em mm).

import type { Drawing, LineStyle } from './layout';
import { textWidth } from './pdf';

const STROKE: Record<LineStyle, string> = {
  visible: 'stroke-width="0.5"',
  hidden: 'stroke-width="0.25" stroke-dasharray="3 1"',
  center: 'stroke-width="0.25" stroke-dasharray="8 1 1 1"',
  thin: 'stroke-width="0.25"',
  frame: 'stroke-width="0.7"',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

export function toSVG(d: Drawing, color = '#111'): string {
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(d.width)} ${n(d.height)}" width="${n(d.width)}mm" height="${n(d.height)}mm" font-family="Helvetica, Arial, sans-serif">`];
  out.push(`<rect width="${n(d.width)}" height="${n(d.height)}" fill="#fff"/>`);
  out.push(`<g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">`);
  for (const p of d.primitives) {
    if (p.kind === 'polyline') {
      const pts: string[] = []; for (let i = 0; i + 1 < p.pts.length; i += 2) pts.push(`${n(p.pts[i])},${n(p.pts[i + 1])}`);
      out.push(`<${p.closed ? 'polygon' : 'polyline'} points="${pts.join(' ')}" ${STROKE[p.style]}/>`);
    } else if (p.kind === 'circle') out.push(`<circle cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}" ${STROKE[p.style]}/>`);
    else if (p.kind === 'polygon') { const pts: string[] = []; for (let i = 0; i + 1 < p.pts.length; i += 2) pts.push(`${n(p.pts[i])},${n(p.pts[i + 1])}`); out.push(`<polygon points="${pts.join(' ')}" fill="${color}" stroke="none"/>`); }
  }
  out.push('</g>');
  for (const p of d.primitives) {
    if (p.kind !== 'text') continue;
    const anchor = p.anchor === 'middle' ? 'middle' : p.anchor === 'end' ? 'end' : 'start';
    const tr = p.rotate ? ` transform="rotate(${n(-p.rotate)} ${n(p.x)} ${n(p.y)})"` : '';
    out.push(`<text x="${n(p.x)}" y="${n(p.y)}" font-size="${n(p.h)}" text-anchor="${anchor}" fill="${color}"${p.bold ? ' font-weight="bold"' : ''} textLength="${n(textWidth(p.text, p.h))}" lengthAdjust="spacingAndGlyphs"${tr}>${esc(p.text)}</text>`);
  }
  out.push('</svg>');
  return out.join('\n');
}
