// Escritor PDF mínimo (PDF 1.4, vetorial, fontes padrão Helvetica), sem dependências.
// Espessuras e tracejados conforme NBR 8403: visível 0,5; fina 0,25; oculta tracejada; centro traço-ponto.

import type { Drawing, LineStyle } from './layout';

const PT = 72 / 25.4;
const K = 0.5522847498; // fator das Béziers de um quarto de círculo

const STYLE: Record<LineStyle, { w: number; dash: number[] }> = {
  visible: { w: 0.5, dash: [] },
  hidden: { w: 0.25, dash: [3, 1] },
  center: { w: 0.25, dash: [8, 1, 1, 1] },
  thin: { w: 0.25, dash: [] },
  frame: { w: 0.7, dash: [] },
};

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** Texto para WinAnsi (Latin-1): o que não cabe vira equivalente próximo ou '?'. */
function winAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0x2300 || c === 0x2205) out += 'Ø'; // ⌀ ∅ → Ø
    else if (c === 0x2192) out += '->';
    else if (c === 0x00ba || c === 0x00b0 || c < 256) out += ch;
    else out += '?';
  }
  return out.replace(/[\\()]/g, (m) => '\\' + m);
}
/** Largura aproximada de um texto em Helvetica (fração da altura por caractere). */
export function textWidth(text: string, h: number): number {
  let w = 0;
  for (const ch of text) w += /[iljtfI.,:;' ]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.85 : /[A-Z0-9Øº°]/.test(ch) ? 0.65 : 0.55;
  return w * h;
}

export function toPDF(d: Drawing): Uint8Array {
  const H = d.height;
  const X = (x: number) => n(x * PT), Y = (y: number) => n((H - y) * PT);
  const parts: string[] = [];
  let curStyle = ''; let lineRun = '';
  const setStyle = (st: LineStyle) => {
    if (curStyle === st) return; curStyle = st;
    const s = STYLE[st];
    parts.push(`${n(s.w * PT)} w ${s.dash.length ? `[${s.dash.map((v) => n(v * PT)).join(' ')}] 0 d` : '[] 0 d'}`);
  };
  parts.push('0 0 0 RG 0 0 0 rg 1 J 1 j');
  for (const p of d.primitives) {
    if (p.kind === 'polyline') {
      if (p.pts.length < 4) continue;
      setStyle(p.style);
      let s = `${X(p.pts[0])} ${Y(p.pts[1])} m`;
      for (let i = 2; i + 1 < p.pts.length; i += 2) s += ` ${X(p.pts[i])} ${Y(p.pts[i + 1])} l`;
      parts.push(s + (p.closed ? ' h S' : ' S'));
    } else if (p.kind === 'circle') {
      setStyle(p.style);
      const cx = p.cx * PT, cy = (H - p.cy) * PT, r = p.r * PT, k = K * r;
      parts.push(`${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c S`);
    } else if (p.kind === 'polygon') {
      let s = `${X(p.pts[0])} ${Y(p.pts[1])} m`;
      for (let i = 2; i + 1 < p.pts.length; i += 2) s += ` ${X(p.pts[i])} ${Y(p.pts[i + 1])} l`;
      parts.push(s + ' h f');
    } else if (p.kind === 'text') {
      const w = textWidth(p.text, p.h); const shift = p.anchor === 'middle' ? -w / 2 : p.anchor === 'end' ? -w : 0;
      const a = ((p.rotate ?? 0) * Math.PI) / 180; const c = Math.cos(a), si = Math.sin(a);
      // Deslocamento de ancoragem ao longo da direção do texto.
      const x = p.x * PT + shift * c * PT, y = (H - p.y) * PT + shift * si * PT;
      parts.push(`BT /${p.bold ? 'F2' : 'F1'} ${n(p.h * PT)} Tf ${n(c)} ${n(si)} ${n(-si)} ${n(c)} ${n(x)} ${n(y)} Tm (${winAnsi(p.text)}) Tj ET`);
    }
  }
  void lineRun;
  const content = parts.join('\n');
  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(d.width * PT)} ${n(d.height * PT)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`);
  objects.push(`<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  objects.push(`<< /Producer (ForjaCAD) /Title (${winAnsi(d.sheet)}) >>`);

  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(byteLen(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = byteLen(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(out);
}

/** Tamanho em bytes de uma string Latin-1 (cada caractere vira um byte). */
function byteLen(s: string): number { return s.length; }
function latin1(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}
