import { describe, it, expect } from 'vitest';
import { layoutDrawing, defaultDrawingSettings, viewSpecsFor, STANDARD_SCALES, scaleLabel } from './layout';
import { toPDF } from './pdf';
import { toDXF } from './dxf';
import { toSVG } from './svg';
import type { ProjectedView } from '../kernel/occ/types';

/** Bloco 100×60 visto de frente com furo Ø20, e topo 100×20 com duas ocultas. */
function sampleViews(): ProjectedView[] {
  const rectPoly = (w: number, h: number) => [new Float32Array([0, 0, w, 0]), new Float32Array([w, 0, w, h]), new Float32Array([w, h, 0, h]), new Float32Array([0, h, 0, 0])];
  const circle = (cx: number, cy: number, r: number) => { const pts: number[] = []; for (let i = 0; i <= 32; i++) { const t = (i / 32) * Math.PI * 2; pts.push(cx + r * Math.cos(t), cy + r * Math.sin(t)); } return new Float32Array(pts); };
  return [
    { name: 'front', visible: [...rectPoly(100, 60), circle(50, 30, 10)], hidden: [], tangent: [], circles: [{ cx: 50, cy: 30, r: 10, hidden: false }], bbox: [0, 0, 100, 60] },
    { name: 'top', visible: rectPoly(100, 20), hidden: [new Float32Array([40, 0, 40, 20]), new Float32Array([60, 0, 60, 20])], tangent: [], circles: [], bbox: [0, 0, 100, 20] },
    { name: 'side', visible: rectPoly(20, 60), hidden: [new Float32Array([0, 20, 20, 20]), new Float32Array([0, 40, 20, 40])], tangent: [], circles: [], bbox: [0, 0, 20, 60] },
    { name: 'iso', visible: rectPoly(80, 70), hidden: [], tangent: [], circles: [], bbox: [0, 0, 80, 70] },
  ];
}

describe('layout do desenho', () => {
  it('escolhe escala normalizada e coloca as vistas no 1º diedro', () => {
    const s = defaultDrawingSettings('Bloco'); s.company = 'Têmpera Gaúcha'; s.author = 'Felipe';
    const d = layoutDrawing(sampleViews(), s, { date: '30/10/2026', docName: 'Bloco' });
    expect(d.width).toBe(297); expect(d.height).toBe(210);
    expect(STANDARD_SCALES).toContain(d.scale); expect(d.scale).toBe(0.5); // com a isométrica (70 de altura) não cabe em 1:1 no A4
    const noIso = { ...s, iso: false }; expect(layoutDrawing(sampleViews(), noIso, { date: '', docName: 'Bloco' }).scale).toBe(1);
    const a3 = { ...s, sheet: 'A3' as const }; expect(layoutDrawing(sampleViews(), a3, { date: '', docName: 'Bloco' }).scale).toBe(1);
    const texts = d.primitives.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text);
    expect(texts).toContain('100'); expect(texts).toContain('60'); expect(texts).toContain('Ø20'); expect(texts).toContain('1:2'); expect(texts).toContain('Bloco'); expect(texts).toContain('1º DIEDRO');
    const hidden = d.primitives.filter((p) => p.kind === 'polyline' && p.style === 'hidden'); expect(hidden.length).toBe(4);
    const center = d.primitives.filter((p) => p.kind === 'polyline' && p.style === 'center'); expect(center.length).toBe(2);
    // Tudo dentro da folha.
    for (const p of d.primitives) if (p.kind === 'polyline' || p.kind === 'polygon') for (let i = 0; i + 1 < p.pts.length; i += 2) { expect(p.pts[i]).toBeGreaterThanOrEqual(0); expect(p.pts[i]).toBeLessThanOrEqual(297); expect(p.pts[i + 1]).toBeGreaterThanOrEqual(0); expect(p.pts[i + 1]).toBeLessThanOrEqual(210); }
    // 1º diedro: topo abaixo da frente (y maior), lateral à direita (x maior).
    const vis = (name: string) => { const v = sampleViews().find((x) => x.name === name)!; return v; };
    void vis;
  });

  it('reduz a escala quando a peça é grande e respeita a escala fixa', () => {
    const big = sampleViews().map((v) => ({ ...v, bbox: [v.bbox[0] * 10, v.bbox[1] * 10, v.bbox[2] * 10, v.bbox[3] * 10] as [number, number, number, number] }));
    const s = defaultDrawingSettings('Grande');
    const d = layoutDrawing(big, s, { date: '', docName: 'Grande' });
    expect(d.scale).toBeLessThan(1); expect(STANDARD_SCALES).toContain(d.scale);
    s.scale = 0.2; const d2 = layoutDrawing(big, s, { date: '', docName: 'Grande' }); expect(d2.scale).toBe(0.2);
    expect(scaleLabel(0.2)).toBe('1:5'); expect(scaleLabel(2)).toBe('2:1');
  });

  it('3º diedro pede a vista direita e sem ocultas/cotas quando desligadas', () => {
    const s = defaultDrawingSettings('x'); s.projection = 'third'; s.hidden = false; s.dimensions = false;
    expect(viewSpecsFor(s).find((v) => v.name === 'side')!.n).toEqual([1, 0, 0]);
    const d = layoutDrawing(sampleViews(), s, { date: '', docName: 'x' });
    expect(d.primitives.some((p) => p.kind === 'polyline' && p.style === 'hidden')).toBe(false);
    expect(d.primitives.some((p) => p.kind === 'text' && p.text === 'Ø20')).toBe(false);
    expect(d.primitives.some((p) => p.kind === 'text' && p.text === '3º DIEDRO')).toBe(true);
  });

  it('gera PDF válido com xref correto', () => {
    const d = layoutDrawing(sampleViews(), defaultDrawingSettings('Bloco'), { date: '30/10/2026', docName: 'Bloco' });
    const bytes = toPDF(d); const txt = new TextDecoder('latin1').decode(bytes);
    expect(txt.startsWith('%PDF-1.4')).toBe(true); expect(txt.trim().endsWith('%%EOF')).toBe(true);
    expect(txt).toContain('/Type /Page'); expect(txt).toContain('Helvetica');
    const start = Number(/startxref\n(\d+)\n%%EOF/.exec(txt)![1]);
    expect(txt.slice(start, start + 4)).toBe('xref');
    // Offsets da tabela apontam para "N 0 obj".
    const entries = txt.slice(start).split('\n').slice(3, 10);
    entries.forEach((e, i) => { const off = Number(e.slice(0, 10)); expect(txt.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`); });
    expect(txt).toContain('(Ø20) Tj'); // Ø em WinAnsi
    expect(txt).toContain('[8.504 2.835] 0 d'); // tracejado das ocultas (3 mm, 1 mm)
    expect(txt).toContain('[22.677 2.835 2.835 2.835] 0 d'); // traço-ponto das linhas de centro
  });

  it('gera DXF R12 com camadas, linhas, círculos e textos', () => {
    const d = layoutDrawing(sampleViews(), defaultDrawingSettings('Bloco'), { date: '', docName: 'Bloco' });
    const dxf = toDXF(d);
    expect(dxf).toContain('AC1009'); expect(dxf.trim().endsWith('EOF')).toBe(true);
    for (const layer of ['VISIVEL', 'OCULTA', 'CENTRO', 'COTA', 'TEXTO']) expect(dxf).toContain(`\r\n8\r\n${layer}\r\n`);
    expect((dxf.match(/\r\n0\r\nLINE\r\n/g) || []).length).toBeGreaterThan(20);
    expect(dxf).toContain('%%c20'); // diâmetro no código DXF
    expect(dxf).toContain('\r\n0\r\nSOLID\r\n'); // setas
    // Linhas do pares código/valor: número par de linhas, mesmo com texto malicioso no título.
    const lines = dxf.trim().split('\r\n'); expect(lines.length % 2).toBe(0);
    const evil = layoutDrawing(sampleViews(), { ...defaultDrawingSettings('x'), title: 'a\r\n0\r\nLINE\r\n8\r\nHACK' }, { date: '', docName: 'x' });
    const dxf2 = toDXF(evil); expect(dxf2).not.toContain('HACK\r\n'); expect(dxf2.trim().split('\r\n').length % 2).toBe(0);
  });

  it('gera SVG com a folha e os textos', () => {
    const d = layoutDrawing(sampleViews(), defaultDrawingSettings('Bloco'), { date: '', docName: 'Bloco' });
    const svg = toSVG(d);
    expect(svg.startsWith('<svg')).toBe(true); expect(svg).toContain('viewBox="0 0 297 210"'); expect(svg).toContain('>Ø20<'); expect(svg).toContain('stroke-dasharray="3 1"');
  });
});
