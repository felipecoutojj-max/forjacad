// Escritor DXF R12 (AC1009), o dialeto mais aceito por AutoCAD, SolidWorks, LibreCAD e máquinas de corte.
// Coordenadas da folha em mm com y para cima. Camadas por tipo de linha, textos como TEXT, setas como SOLID.

import type { Drawing, LineStyle } from './layout';

const LAYER: Record<LineStyle, string> = { visible: 'VISIVEL', hidden: 'OCULTA', center: 'CENTRO', thin: 'COTA', frame: 'FOLHA' };
const COLOR: Record<string, number> = { VISIVEL: 7, OCULTA: 8, CENTRO: 1, COTA: 3, FOLHA: 7, TEXTO: 7 };
const LTYPE: Record<string, string> = { VISIVEL: 'CONTINUOUS', OCULTA: 'OCULTA', CENTRO: 'CENTRO', COTA: 'CONTINUOUS', FOLHA: 'CONTINUOUS', TEXTO: 'CONTINUOUS' };

const f = (v: number) => (Math.round(v * 10000) / 10000).toString();

export function toDXF(d: Drawing): string {
  const H = d.height;
  const L: string[] = [];
  const g = (code: number, value: string | number) => { L.push(String(code), String(value)); };
  // HEADER
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSBASE'); g(10, 0); g(20, 0); g(30, 0);
  g(9, '$EXTMIN'); g(10, 0); g(20, 0); g(30, 0);
  g(9, '$EXTMAX'); g(10, f(d.width)); g(20, f(d.height)); g(30, 0);
  g(9, '$LTSCALE'); g(40, 1);
  g(0, 'ENDSEC');
  // TABLES
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 3);
  ltype(g, 'CONTINUOUS', 'Solid line', []);
  ltype(g, 'OCULTA', '__ __ __ __', [3, -1]);
  ltype(g, 'CENTRO', '____ _ ____ _', [8, -1, 1, -1]);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 6);
  for (const name of Object.keys(COLOR)) { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, COLOR[name]); g(6, LTYPE[name]); }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'STYLE'); g(70, 1);
  g(0, 'STYLE'); g(2, 'STANDARD'); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, 'txt'); g(4, '');
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  // BLOCKS (vazio, mas alguns leitores exigem a seção)
  g(0, 'SECTION'); g(2, 'BLOCKS'); g(0, 'ENDSEC');
  // ENTITIES
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const p of d.primitives) {
    if (p.kind === 'polyline') {
      const layer = LAYER[p.style]; const pts = p.pts; const nseg = pts.length / 2 - (p.closed ? 0 : 1);
      for (let i = 0; i < nseg; i++) {
        const a = i * 2, b = ((i + 1) % (pts.length / 2)) * 2;
        g(0, 'LINE'); g(8, layer); g(10, f(pts[a])); g(20, f(H - pts[a + 1])); g(30, 0); g(11, f(pts[b])); g(21, f(H - pts[b + 1])); g(31, 0);
      }
    } else if (p.kind === 'circle') {
      g(0, 'CIRCLE'); g(8, LAYER[p.style]); g(10, f(p.cx)); g(20, f(H - p.cy)); g(30, 0); g(40, f(p.r));
    } else if (p.kind === 'polygon') {
      const q = p.pts;
      g(0, 'SOLID'); g(8, 'COTA');
      g(10, f(q[0])); g(20, f(H - q[1])); g(30, 0);
      g(11, f(q[2])); g(21, f(H - q[3])); g(31, 0);
      g(12, f(q[4])); g(22, f(H - q[5])); g(32, 0);
      g(13, f(q[4])); g(23, f(H - q[5])); g(33, 0);
    } else if (p.kind === 'text') {
      const align = p.anchor === 'middle' ? 1 : p.anchor === 'end' ? 2 : 0;
      g(0, 'TEXT'); g(8, 'TEXTO'); g(10, f(p.x)); g(20, f(H - p.y)); g(30, 0); g(40, f(p.h)); g(1, dxfText(p.text)); g(50, f(p.rotate ?? 0)); g(7, 'STANDARD');
      if (align) { g(72, align); g(11, f(p.x)); g(21, f(H - p.y)); g(31, 0); }
    }
  }
  g(0, 'ENDSEC'); g(0, 'EOF');
  return L.join('\r\n') + '\r\n';
}

function ltype(g: (c: number, v: string | number) => void, name: string, desc: string, pattern: number[]): void {
  g(0, 'LTYPE'); g(2, name); g(70, 0); g(3, desc); g(72, 65); g(73, pattern.length); g(40, pattern.reduce((a, b) => a + Math.abs(b), 0));
  for (const v of pattern) g(49, v);
}

/** Códigos especiais do DXF: %%c é o símbolo de diâmetro, %%d o de grau. */
function dxfText(t: string): string {
  return t.replace(/[Ø⌀∅]/g, '%%c').replace(/°/g, '%%d');
}
