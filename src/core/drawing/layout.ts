// Layout do desenho técnico: folha ABNT (NBR 10068), vistas em 1º ou 3º diedro, escala normalizada,
// cotas gerais e de furos (NBR 10126), linhas de centro e legenda (NBR 10582).
// Coordenadas da folha em mm, origem no canto superior esquerdo, y para baixo. Os escritores PDF/DXF invertem.

import type { ProjectedView, ViewSpec } from '../kernel/occ/types';
import type { V3 } from '../document';
import type { BomRow } from '../assembly/model';

export type SheetSize = 'A4' | 'A3' | 'A2';
export type Projection = 'first' | 'third';

export interface DrawingSettings {
  sheet: SheetSize; projection: Projection;
  /** 'auto' escolhe a maior escala normalizada que cabe. */
  scale: number | 'auto';
  front: boolean; top: boolean; side: boolean; iso: boolean;
  hidden: boolean; tangent: boolean; dimensions: boolean;
  title: string; number: string; material: string; author: string; company: string;
}

export function defaultDrawingSettings(title: string): DrawingSettings {
  return { sheet: 'A4', projection: 'first', scale: 'auto', front: true, top: true, side: true, iso: true, hidden: true, tangent: false, dimensions: true, title, number: '', material: '', author: '', company: '' };
}

/** Folhas em paisagem: [largura, altura] em mm. */
export const SHEET_MM: Record<SheetSize, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420] };
/** Escalas de redução e ampliação recomendadas (NBR 8196 / ISO 5455). */
export const STANDARD_SCALES = [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];
export function scaleLabel(s: number): string { return s >= 1 ? `${fmtNum(s)}:1` : `1:${fmtNum(1 / s)}`; }

export type LineStyle = 'visible' | 'hidden' | 'center' | 'thin' | 'frame';
export type Primitive =
  | { kind: 'polyline'; pts: number[]; style: LineStyle; closed?: boolean }
  | { kind: 'circle'; cx: number; cy: number; r: number; style: LineStyle }
  | { kind: 'polygon'; pts: number[] }
  | { kind: 'text'; x: number; y: number; text: string; h: number; anchor: 'start' | 'middle' | 'end'; rotate?: number; bold?: boolean };

export interface Drawing { width: number; height: number; scale: number; sheet: SheetSize; primitives: Primitive[]; }
/** Onde cada vista caiu na folha: X_folha = vx + (X - bbox[0])·scale, Y_folha = vy + (bbox[3] - Y)·scale. */
export interface ViewPlacement { name: string; vx: number; vy: number; scale: number; bbox: [number, number, number, number]; }
export interface LayoutResult { drawing: Drawing; placements: ViewPlacement[]; titleBlock: { x: number; y: number; w: number; h: number }; }
export const placeX = (p: ViewPlacement, X: number) => p.vx + (X - p.bbox[0]) * p.scale;
export const placeY = (p: ViewPlacement, Y: number) => p.vy + (p.bbox[3] - Y) * p.scale;

export const fmtNum = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return String(r).replace('.', ',');
};

const norm3 = (v: V3): V3 => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };

/** Projeta um ponto 3D nas coordenadas (X, Y) de uma vista, como o kernel faz. */
export function projectPoint(spec: ViewSpec, p: V3): [number, number] {
  const n = norm3(spec.n); const cr: V3 = [spec.up[1] * n[2] - spec.up[2] * n[1], spec.up[2] * n[0] - spec.up[0] * n[2], spec.up[0] * n[1] - spec.up[1] * n[0]];
  const r = norm3(cr); const u: V3 = [n[1] * r[2] - n[2] * r[1], n[2] * r[0] - n[0] * r[2], n[0] * r[1] - n[1] * r[0]];
  return [p[0] * r[0] + p[1] * r[1] + p[2] * r[2], p[0] * u[0] + p[1] * u[1] + p[2] * u[2]];
}

/** Vistas a pedir ao kernel conforme as opções. A lateral é a esquerda no 1º diedro e a direita no 3º. */
export function viewSpecsFor(s: DrawingSettings): ViewSpec[] {
  const out: ViewSpec[] = [];
  if (s.front) out.push({ name: 'front', n: [0, 0, 1], up: [0, 1, 0] });
  if (s.top) out.push({ name: 'top', n: [0, 1, 0], up: [0, 0, -1] });
  if (s.side) out.push({ name: 'side', n: s.projection === 'first' ? [-1, 0, 0] : [1, 0, 0], up: [0, 1, 0] });
  if (s.iso) out.push({ name: 'iso', n: norm3([1, 1, 1]), up: [0, 1, 0] });
  return out;
}

interface Cell { view: ProjectedView | undefined; col: number; row: number; }
const TEXT_H = 3.5; // altura das cotas (NBR 8402)
const ARROW = 3;    // comprimento da seta
const GAP = 24;     // espaço entre vistas (sobra para cotas)
const PAD = 14;     // folga em volta do conjunto

export function layoutDrawing(views: ProjectedView[], s: DrawingSettings, meta: { date: string; docName: string }): Drawing {
  return layoutDrawingEx(views, s, meta).drawing;
}

export function layoutDrawingEx(views: ProjectedView[], s: DrawingSettings, meta: { date: string; docName: string }, opts: { reserveBottom?: number } = {}): LayoutResult {
  const [W, H] = SHEET_MM[s.sheet];
  const margin = s.sheet === 'A2' ? 10 : 7;
  const frame = { x: 25, y: margin, w: W - 25 - margin, h: H - 2 * margin };
  const titleH = 24, titleW = Math.min(178, frame.w);
  const reserve = opts.reserveBottom ?? 0;
  const area = { x: frame.x + 4, y: frame.y + 4, w: frame.w - 8, h: frame.h - titleH - reserve - 8 };
  const placements: ViewPlacement[] = [];
  const prims: Primitive[] = [];

  // Moldura e legenda.
  prims.push({ kind: 'polyline', pts: rect(frame.x, frame.y, frame.w, frame.h), style: 'frame', closed: true });
  // Só entram as vistas ligadas nas opções, mesmo que o chamador passe mais.
  const enabled: Record<string, boolean> = { front: s.front, top: s.top, side: s.side, iso: s.iso };
  const byName = (n: string) => (enabled[n] ? views.find((v) => v.name === n) : undefined);
  const F = byName('front'), T = byName('top'), S = byName('side'), I = byName('iso');

  // Grade 2×2: 1º diedro → [F S / T I]; 3º diedro → [T I / F S].
  const cells: Cell[] = s.projection === 'first'
    ? [{ view: F, col: 0, row: 0 }, { view: S, col: 1, row: 0 }, { view: T, col: 0, row: 1 }, { view: I, col: 1, row: 1 }]
    : [{ view: T, col: 0, row: 0 }, { view: I, col: 1, row: 0 }, { view: F, col: 0, row: 1 }, { view: S, col: 1, row: 1 }];
  const bw = (v?: ProjectedView) => (v ? v.bbox[2] - v.bbox[0] : 0), bh = (v?: ProjectedView) => (v ? v.bbox[3] - v.bbox[1] : 0);
  const colW = [0, 0], rowH = [0, 0];
  for (const c of cells) { colW[c.col] = Math.max(colW[c.col], bw(c.view)); rowH[c.row] = Math.max(rowH[c.row], bh(c.view)); }
  const nCols = colW.filter((w) => w > 0).length, nRows = rowH.filter((h) => h > 0).length;
  const modelW = colW[0] + colW[1], modelH = rowH[0] + rowH[1];

  let scale: number;
  if (typeof s.scale === 'number' && s.scale > 0) scale = s.scale;
  else {
    scale = STANDARD_SCALES[STANDARD_SCALES.length - 1];
    for (const sc of STANDARD_SCALES) {
      const gw = modelW * sc + GAP * Math.max(0, nCols - 1) + 2 * PAD, gh = modelH * sc + GAP * Math.max(0, nRows - 1) + 2 * PAD;
      if (gw <= area.w && gh <= area.h) { scale = sc; break; }
    }
  }
  const gw = modelW * scale + GAP * Math.max(0, nCols - 1), gh = modelH * scale + GAP * Math.max(0, nRows - 1);
  const x0 = area.x + (area.w - gw) / 2, y0 = area.y + (area.h - gh) / 2;
  const colX = [x0, x0 + colW[0] * scale + (colW[0] > 0 ? GAP : 0)];
  const rowY = [y0, y0 + rowH[0] * scale + (rowH[0] > 0 ? GAP : 0)];

  for (const c of cells) {
    const v = c.view; if (!v) continue;
    const cw = colW[c.col] * scale, ch = rowH[c.row] * scale;
    const vx = colX[c.col] + (cw - bw(v) * scale) / 2, vy = rowY[c.row] + (ch - bh(v) * scale) / 2;
    placements.push({ name: v.name, vx, vy, scale, bbox: v.bbox });
    const tx = (X: number) => vx + (X - v.bbox[0]) * scale;
    const ty = (Y: number) => vy + (v.bbox[3] - Y) * scale;
    const map = (pts: Float32Array) => { const out: number[] = []; for (let i = 0; i + 1 < pts.length; i += 2) out.push(tx(pts[i]), ty(pts[i + 1])); return out; };
    if (s.hidden) for (const p of v.hidden) prims.push({ kind: 'polyline', pts: map(p), style: 'hidden' });
    if (s.tangent) for (const p of v.tangent) prims.push({ kind: 'polyline', pts: map(p), style: 'thin' });
    for (const p of v.visible) prims.push({ kind: 'polyline', pts: map(p), style: 'visible' });
    // Linhas de centro dos furos.
    const isIso = v.name === 'iso';
    if (!isIso) for (const c2 of v.circles) {
      if (c2.hidden && !s.hidden) continue;
      const cx = tx(c2.cx), cy = ty(c2.cy), e = c2.r * scale + 2;
      prims.push({ kind: 'polyline', pts: [cx - e, cy, cx + e, cy], style: 'center' }, { kind: 'polyline', pts: [cx, cy - e, cx, cy + e], style: 'center' });
    }
    if (s.dimensions && !isIso) addDimensions(prims, v, tx, ty, vx, vy, bw(v) * scale, bh(v) * scale, scale, c);
  }

  // Legenda.
  const tbX = frame.x + frame.w - titleW, tbY = frame.y + frame.h - titleH;
  titleBlock(prims, tbX, tbY, titleW, titleH, s, scale, meta);
  return { drawing: { width: W, height: H, scale, sheet: s.sheet, primitives: prims }, placements, titleBlock: { x: tbX, y: tbY, w: titleW, h: titleH } };
}

export interface BalloonAnchor { item: number; view: string; X: number; Y: number; }
const BOM_ROW = 7;

/** Desenho de conjunto: vistas da montagem, balões numerados e lista de materiais sobre a legenda. */
export function layoutAssemblyDrawing(views: ProjectedView[], s: DrawingSettings, meta: { date: string; docName: string }, bom: BomRow[], anchors: BalloonAnchor[]): Drawing {
  const reserve = BOM_ROW * (bom.length + 1) + 2;
  const { drawing, placements, titleBlock: tb } = layoutDrawingEx(views, s, meta, { reserveBottom: reserve });
  const prims = drawing.primitives;
  // Lista de materiais: cabeçalho encostado na legenda, itens para cima (NBR 13272).
  const cols = [12, 12, 78, 48, tb.w - 150]; const heads = ['ITEM', 'QTD', 'DENOMINAÇÃO', 'MATERIAL', 'OBS'];
  const rowRect = (y: number, cells: string[], bold: boolean) => {
    prims.push({ kind: 'polyline', pts: rect(tb.x, y, tb.w, BOM_ROW), style: 'thin', closed: true });
    let cx = tb.x;
    cells.forEach((t, i) => { if (i) prims.push({ kind: 'polyline', pts: [cx, y, cx, y + BOM_ROW], style: 'thin' }); prims.push({ kind: 'text', x: i < 2 ? cx + cols[i] / 2 : cx + 1.5, y: y + BOM_ROW - 2.2, text: t, h: 2.5, anchor: i < 2 ? 'middle' : 'start', bold }); cx += cols[i]; });
  };
  rowRect(tb.y - BOM_ROW, heads, true);
  bom.forEach((r, k) => rowRect(tb.y - BOM_ROW * (k + 2), [String(r.item), String(r.qty), r.name, r.material, ''], false));
  // Balões: círculo numerado puxado para fora da vista, com linha de chamada até a peça.
  const placed: { x: number; y: number }[] = [];
  const byView = new Map<string, ViewPlacement>(); for (const p of placements) byView.set(p.name, p);
  const R = 4.5;
  for (const a of anchors) {
    const p = byView.get(a.view); if (!p) continue;
    const ax = placeX(p, a.X), ay = placeY(p, a.Y);
    const cxv = p.vx + ((p.bbox[2] - p.bbox[0]) * p.scale) / 2, cyv = p.vy + ((p.bbox[3] - p.bbox[1]) * p.scale) / 2;
    let dx = ax - cxv, dy = ay - cyv; const L = Math.hypot(dx, dy); if (L < 1e-6) { dx = 0; dy = -1; } else { dx /= L; dy /= L; }
    const half = Math.hypot((p.bbox[2] - p.bbox[0]) * p.scale, (p.bbox[3] - p.bbox[1]) * p.scale) / 2;
    let bx = cxv + dx * (half + 12), by = cyv + dy * (half + 12);
    for (let guard = 0; guard < 12 && placed.some((q) => Math.hypot(q.x - bx, q.y - by) < 2 * R + 1); guard++) { bx += dx * 6; by += dy * 6; }
    placed.push({ x: bx, y: by });
    const ex = bx - dx * R, ey = by - dy * R;
    prims.push({ kind: 'polyline', pts: [ax, ay, ex, ey], style: 'thin' });
    const dot: number[] = []; for (let i = 0; i < 8; i++) { const t = (i / 8) * Math.PI * 2; dot.push(ax + 0.8 * Math.cos(t), ay + 0.8 * Math.sin(t)); }
    prims.push({ kind: 'polygon', pts: dot });
    prims.push({ kind: 'circle', cx: bx, cy: by, r: R, style: 'thin' });
    prims.push({ kind: 'text', x: bx, y: by + 1.25, text: String(a.item), h: 3.5, anchor: 'middle' });
  }
  return drawing;
}

function rect(x: number, y: number, w: number, h: number): number[] { return [x, y, x + w, y, x + w, y + h, x, y + h]; }

/** Cotas gerais (largura e altura) e diâmetros dos furos visíveis, um por raio. */
function addDimensions(prims: Primitive[], v: ProjectedView, tx: (x: number) => number, ty: (y: number) => number, vx: number, vy: number, w: number, h: number, scale: number, cell: Cell): void {
  const mw = v.bbox[2] - v.bbox[0], mh = v.bbox[3] - v.bbox[1];
  // Cota horizontal acima (1ª linha) ou abaixo (2ª linha), para não bater na vista vizinha.
  if (cell.row === 0) dimH(prims, vx, vx + w, vy, -10, fmtNum(mw)); else dimH(prims, vx, vx + w, vy + h, 10, fmtNum(mw));
  // Cota vertical à esquerda (1ª coluna) ou à direita (2ª coluna).
  if (cell.col === 0) dimV(prims, vy, vy + h, vx, -10, fmtNum(mh)); else dimV(prims, vy, vy + h, vx + w, 10, fmtNum(mh));
  const seen = new Set<string>();
  for (const c of v.circles) {
    if (c.hidden) continue;
    const key = c.r.toFixed(3); if (seen.has(key)) continue; seen.add(key);
    const cx = tx(c.cx), cy = ty(c.cy), r = c.r * scale;
    const dir = Math.SQRT1_2; // 45°, para cima e para a direita
    const x1 = cx + r * dir, y1 = cy - r * dir, x2 = x1 + 6, y2 = y1 - 6;
    prims.push({ kind: 'polyline', pts: [x1, y1, x2, y2, x2 + 8, y2], style: 'thin' });
    arrow(prims, x1, y1, Math.atan2(y1 - y2, x1 - x2));
    prims.push({ kind: 'text', x: x2 + 1, y: y2 - 1, text: `Ø${fmtNum(c.r * 2)}`, h: TEXT_H, anchor: 'start' });
  }
}

function dimH(prims: Primitive[], x1: number, x2: number, yRef: number, off: number, text: string): void {
  const y = yRef + off; const ext = Math.sign(off) * 2;
  prims.push({ kind: 'polyline', pts: [x1, yRef + Math.sign(off), x1, y + ext], style: 'thin' }, { kind: 'polyline', pts: [x2, yRef + Math.sign(off), x2, y + ext], style: 'thin' });
  prims.push({ kind: 'polyline', pts: [x1, y, x2, y], style: 'thin' });
  arrow(prims, x1, y, Math.PI); arrow(prims, x2, y, 0);
  prims.push({ kind: 'text', x: (x1 + x2) / 2, y: y - 1, text, h: TEXT_H, anchor: 'middle' });
}
function dimV(prims: Primitive[], y1: number, y2: number, xRef: number, off: number, text: string): void {
  const x = xRef + off; const ext = Math.sign(off) * 2;
  prims.push({ kind: 'polyline', pts: [xRef + Math.sign(off), y1, x + ext, y1], style: 'thin' }, { kind: 'polyline', pts: [xRef + Math.sign(off), y2, x + ext, y2], style: 'thin' });
  prims.push({ kind: 'polyline', pts: [x, y1, x, y2], style: 'thin' });
  arrow(prims, x, y1, -Math.PI / 2); arrow(prims, x, y2, Math.PI / 2);
  prims.push({ kind: 'text', x: x - 1, y: (y1 + y2) / 2, text, h: TEXT_H, anchor: 'middle', rotate: 90 });
}
/** Seta cheia com a ponta em (x, y) apontando no ângulo `ang` (rad, y para baixo). */
function arrow(prims: Primitive[], x: number, y: number, ang: number): void {
  const bx = x - Math.cos(ang) * ARROW, by = y - Math.sin(ang) * ARROW; const nx = -Math.sin(ang), ny = Math.cos(ang); const hw = ARROW / 6;
  prims.push({ kind: 'polygon', pts: [x, y, bx + nx * hw, by + ny * hw, bx - nx * hw, by - ny * hw] });
}

function titleBlock(prims: Primitive[], x: number, y: number, w: number, h: number, s: DrawingSettings, scale: number, meta: { date: string; docName: string }): void {
  const rh = h / 3;
  const cA = 60, cB = 40, cD = 22, cC = w - cA - cB - cD;
  prims.push({ kind: 'polyline', pts: rect(x, y, w, h), style: 'frame', closed: true });
  for (let i = 1; i < 3; i++) prims.push({ kind: 'polyline', pts: [x, y + rh * i, x + w, y + rh * i], style: 'thin' });
  for (const cx of [x + cA, x + cA + cB, x + cA + cB + cC]) prims.push({ kind: 'polyline', pts: [cx, y, cx, y + h], style: 'thin' });
  const cell = (cx: number, cy: number, label: string, value: string, bold = false) => {
    prims.push({ kind: 'text', x: cx + 1.2, y: cy + 2.6, text: label, h: 1.8, anchor: 'start' });
    if (value) prims.push({ kind: 'text', x: cx + 1.2, y: cy + rh - 1.6, text: value, h: bold ? 3.5 : 3, anchor: 'start', bold });
  };
  cell(x, y, 'EMPRESA', s.company); cell(x, y + rh, 'DESENHOU', s.author); cell(x, y + 2 * rh, 'DATA', meta.date);
  cell(x + cA, y, 'ESCALA', scaleLabel(scale)); cell(x + cA, y + rh, 'UNIDADE', 'mm'); cell(x + cA, y + 2 * rh, 'FOLHA', '1/1');
  cell(x + cA + cB, y, 'TÍTULO', s.title || meta.docName, true); cell(x + cA + cB, y + rh, 'Nº DO DESENHO', s.number); cell(x + cA + cB, y + 2 * rh, 'MATERIAL', s.material);
  // Símbolo do diedro (ISO 128 / NBR 10067): tronco de cone e sua vista de topo.
  const sx = x + cA + cB + cC, sy = y;
  prims.push({ kind: 'text', x: sx + 1.2, y: sy + 2.6, text: s.projection === 'first' ? '1º DIEDRO' : '3º DIEDRO', h: 1.8, anchor: 'start' });
  const cy = sy + h * 0.62, R = 3.2, r = 1.7, L = 7;
  if (s.projection === 'first') {
    // Tronco à esquerda estreitando para a direita; círculos à direita.
    const fx = sx + 3;
    prims.push({ kind: 'polyline', pts: [fx, cy - R, fx + L, cy - r, fx + L, cy + r, fx, cy + R], style: 'thin', closed: true });
    prims.push({ kind: 'circle', cx: fx + L + 5.5, cy, r: R, style: 'thin' }, { kind: 'circle', cx: fx + L + 5.5, cy, r, style: 'thin' });
  } else {
    const ox = sx + 3 + R;
    prims.push({ kind: 'circle', cx: ox, cy, r: R, style: 'thin' }, { kind: 'circle', cx: ox, cy, r, style: 'thin' });
    const fx = ox + R + 2.5;
    prims.push({ kind: 'polyline', pts: [fx, cy - r, fx + L, cy - R, fx + L, cy + R, fx, cy + r], style: 'thin', closed: true });
  }
}
