// Modelo do esboço 2D: pontos, entidades, restrições e cotas.
// Tudo que o solver precisa está aqui. O esboço vive num plano do documento.

import type { Vec2 } from '../geom';

export type Id = string;

let counter = 0;
export function newId(prefix: string): Id {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export interface SketchPoint { id: Id; x: number; y: number; fixed?: boolean; }

export interface LineEntity { id: Id; type: 'line'; a: Id; b: Id; construction?: boolean; }
export interface CircleEntity { id: Id; type: 'circle'; center: Id; r: number; construction?: boolean; }
/** Arco anti-horário de `start` até `end`, ambos pontos sobre a circunferência. */
export interface ArcEntity { id: Id; type: 'arc'; center: Id; start: Id; end: Id; r: number; construction?: boolean; }
/** Curva suave que passa pelos pontos (Catmull-Rom centrípeta na tela, B-spline no kernel). `closed` fecha o laço. */
export interface SplineEntity { id: Id; type: 'spline'; points: Id[]; closed?: boolean; construction?: boolean; }
/** Elipse: centro, semieixos `rx` (ao longo de `angle`, em rad) e `ry`. */
export interface EllipseEntity { id: Id; type: 'ellipse'; center: Id; rx: number; ry: number; angle: number; construction?: boolean; }
export type Entity = LineEntity | CircleEntity | ArcEntity | SplineEntity | EllipseEntity;
/** Círculo ou arco: entidades com centro e raio que o solver e as cotas conhecem. */
export function isRound(e: Entity | undefined | null): e is CircleEntity | ArcEntity { return !!e && (e.type === 'circle' || e.type === 'arc'); }
/** Entidade fechada sozinha (vira um laço inteiro no perfil). */
export function isClosedEntity(e: Entity): boolean { return e.type === 'circle' || e.type === 'ellipse' || (e.type === 'spline' && !!e.closed); }

export type ConstraintKind =
  | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'equal'
  | 'tangent' | 'concentric' | 'pointOnLine' | 'pointOnCircle' | 'midpoint' | 'fixed';

export interface Constraint { id: Id; kind: ConstraintKind; refs: Id[]; }

export type DimensionKind = 'distance' | 'hdistance' | 'vdistance' | 'angle' | 'radius' | 'diameter';

export interface Dimension {
  id: Id; kind: DimensionKind; refs: Id[]; value: number;
  /** Deslocamento do texto da cota em relação à geometria, em mm do plano. */
  offset: Vec2;
}

export interface Sketch {
  id: Id;
  name: string;
  /** Plano do documento onde o esboço vive. */
  plane: Id;
  points: SketchPoint[];
  entities: Entity[];
  constraints: Constraint[];
  dimensions: Dimension[];
}

export function createSketch(plane: Id, name = 'Esboço'): Sketch {
  return { id: newId('sk'), name, plane, points: [], entities: [], constraints: [], dimensions: [] };
}

export function getPoint(s: Sketch, id: Id): SketchPoint {
  const p = s.points.find((q) => q.id === id);
  if (!p) throw new Error(`Ponto inexistente: ${id}`);
  return p;
}
export function findPoint(s: Sketch, id: Id): SketchPoint | undefined { return s.points.find((q) => q.id === id); }
export function getEntity(s: Sketch, id: Id): Entity {
  const e = s.entities.find((q) => q.id === id);
  if (!e) throw new Error(`Entidade inexistente: ${id}`);
  return e;
}
export function findEntity(s: Sketch, id: Id): Entity | undefined { return s.entities.find((q) => q.id === id); }

export function addPoint(s: Sketch, x: number, y: number): SketchPoint {
  const p: SketchPoint = { id: newId('p'), x, y }; s.points.push(p); return p;
}
export function addLine(s: Sketch, a: Id, b: Id): LineEntity {
  const e: LineEntity = { id: newId('l'), type: 'line', a, b }; s.entities.push(e); return e;
}
export function addCircle(s: Sketch, center: Id, r: number): CircleEntity {
  const e: CircleEntity = { id: newId('c'), type: 'circle', center, r }; s.entities.push(e); return e;
}
export function addSpline(s: Sketch, points: Id[], closed = false): SplineEntity {
  const e: SplineEntity = { id: newId('e'), type: 'spline', points: [...points], closed }; s.entities.push(e); return e;
}
export function addEllipse(s: Sketch, center: Id, rx: number, ry: number, angle = 0): EllipseEntity {
  const e: EllipseEntity = { id: newId('e'), type: 'ellipse', center, rx, ry, angle }; s.entities.push(e); return e;
}
export function addArc(s: Sketch, center: Id, start: Id, end: Id, r: number): ArcEntity {
  const e: ArcEntity = { id: newId('a'), type: 'arc', center, start, end, r }; s.entities.push(e); return e;
}
export function addConstraint(s: Sketch, kind: ConstraintKind, refs: Id[]): Constraint {
  const c: Constraint = { id: newId('k'), kind, refs }; s.constraints.push(c); return c;
}
export function addDimension(s: Sketch, kind: DimensionKind, refs: Id[], value: number, offset: Vec2 = { x: 0, y: 8 }): Dimension {
  const d: Dimension = { id: newId('d'), kind, refs, value, offset }; s.dimensions.push(d); return d;
}

/** Pontos referenciados por uma entidade. */
export function entityPoints(e: Entity): Id[] {
  switch (e.type) {
    case 'line': return [e.a, e.b];
    case 'circle': return [e.center];
    case 'arc': return [e.center, e.start, e.end];
    case 'spline': return [...e.points];
    case 'ellipse': return [e.center];
  }
}

/** Funde o ponto `from` em `to`: toda referência a `from` passa a apontar para `to`. */
export function mergePoints(s: Sketch, from: Id, to: Id): void {
  if (from === to) return;
  for (const e of s.entities) {
    if (e.type === 'line') { if (e.a === from) e.a = to; if (e.b === from) e.b = to; }
    else if (e.type === 'circle' || e.type === 'ellipse') { if (e.center === from) e.center = to; }
    else if (e.type === 'spline') { e.points = e.points.map((p) => (p === from ? to : p)); }
    else { if (e.center === from) e.center = to; if (e.start === from) e.start = to; if (e.end === from) e.end = to; }
  }
  for (const c of s.constraints) c.refs = c.refs.map((r) => (r === from ? to : r));
  for (const d of s.dimensions) d.refs = d.refs.map((r) => (r === from ? to : r));
  s.points = s.points.filter((p) => p.id !== from);
  // Linhas degeneradas (a === b) somem; splines perdem pontos repetidos em sequência.
  for (const e of s.entities) if (e.type === 'spline') e.points = e.points.filter((p, i) => i === 0 || p !== e.points[i - 1]);
  s.entities = s.entities.filter((e) => !(e.type === 'line' && e.a === e.b) && !(e.type === 'spline' && e.points.length < 2));
}

/** Remove entidades e tudo que as referencia; pontos órfãos também somem. */
export function removeEntities(s: Sketch, ids: Id[]): void {
  const set = new Set(ids);
  s.entities = s.entities.filter((e) => !set.has(e.id));
  s.constraints = s.constraints.filter((c) => !c.refs.some((r) => set.has(r)));
  s.dimensions = s.dimensions.filter((d) => !d.refs.some((r) => set.has(r)));
  pruneOrphanPoints(s);
}

export function removeConstraint(s: Sketch, id: Id): void { s.constraints = s.constraints.filter((c) => c.id !== id); }
export function removeDimension(s: Sketch, id: Id): void { s.dimensions = s.dimensions.filter((d) => d.id !== id); }

export function pruneOrphanPoints(s: Sketch): void {
  const used = new Set<Id>();
  for (const e of s.entities) for (const p of entityPoints(e)) used.add(p);
  for (const c of s.constraints) for (const r of c.refs) used.add(r);
  for (const d of s.dimensions) for (const r of d.refs) used.add(r);
  s.points = s.points.filter((p) => used.has(p.id));
  s.constraints = s.constraints.filter((c) => c.refs.every((r) => findPoint(s, r) || findEntity(s, r)));
  s.dimensions = s.dimensions.filter((d) => d.refs.every((r) => findPoint(s, r) || findEntity(s, r)));
}

export function cloneSketch(s: Sketch): Sketch { return JSON.parse(JSON.stringify(s)); }

/** Ângulo (rad) de um ponto do arco em relação ao centro. */
export function arcAngles(s: Sketch, a: ArcEntity): { start: number; end: number } {
  const c = getPoint(s, a.center), ps = getPoint(s, a.start), pe = getPoint(s, a.end);
  return { start: Math.atan2(ps.y - c.y, ps.x - c.x), end: Math.atan2(pe.y - c.y, pe.x - c.x) };
}

// ---------- Amostragem de curvas (tela, perfis e encaixe) ----------
const TAU2 = Math.PI * 2;
/** Ponto da elipse no parâmetro t (0..2π). */
export function ellipsePoint(c: Vec2, e: EllipseEntity, t: number): Vec2 {
  const ca = Math.cos(e.angle), sa = Math.sin(e.angle); const x = e.rx * Math.cos(t), y = e.ry * Math.sin(t);
  return { x: c.x + x * ca - y * sa, y: c.y + x * sa + y * ca };
}
/** Catmull-Rom centrípeta pelos pontos; fechada repete o laço. `segs` amostras por vão. */
export function catmullRom(pts: Vec2[], closed: boolean, segs = 12): Vec2[] {
  const n = pts.length; if (n < 2) return pts.slice();
  if (n === 2 && !closed) return [pts[0], pts[1]];
  const at = (i: number): Vec2 => closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  const out: Vec2[] = []; const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const tj = (ti: number, a: Vec2, b: Vec2) => ti + Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)) || ti + 1e-6;
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
    for (let k = 0; k < segs; k++) {
      const t = t1 + ((t2 - t1) * k) / segs;
      const lerp = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => { const w = tb - ta < 1e-12 ? 0 : (t - ta) / (tb - ta); return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w }; };
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  out.push(closed ? pts[0] : pts[n - 1]);
  return out;
}
/** Polilinha de qualquer entidade, em coordenadas do plano (círculos e elipses fechados repetem o primeiro ponto no fim). */
export function sampleEntity(s: Sketch, e: Entity, segs = 48): Vec2[] {
  if (e.type === 'line') { const a = getPoint(s, e.a), b = getPoint(s, e.b); return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }]; }
  if (e.type === 'spline') return catmullRom(e.points.map((id) => { const p = getPoint(s, id); return { x: p.x, y: p.y }; }), !!e.closed);
  const c = getPoint(s, e.center); const out: Vec2[] = [];
  if (e.type === 'ellipse') { const n = Math.max(segs, 64); for (let i = 0; i <= n; i++) out.push(ellipsePoint(c, e, (i / n) * TAU2)); return out; }
  if (e.type === 'circle') { for (let i = 0; i <= segs; i++) { const t = (i / segs) * TAU2; out.push({ x: c.x + e.r * Math.cos(t), y: c.y + e.r * Math.sin(t) }); } return out; }
  const { start, end } = arcAngles(s, e); let sweep = end - start; while (sweep <= 0) sweep += TAU2; while (sweep > TAU2) sweep -= TAU2;
  const n = Math.max(6, Math.ceil((sweep / TAU2) * segs));
  for (let i = 0; i <= n; i++) { const t = start + (sweep * i) / n; out.push({ x: c.x + e.r * Math.cos(t), y: c.y + e.r * Math.sin(t) }); }
  return out;
}
/** Direção (rad) da spline saindo do ponto inicial ou do final. */
export function splineEndDir(s: Sketch, e: SplineEntity, atStart: boolean): number {
  const pts = catmullRom(e.points.map((id) => { const p = getPoint(s, id); return { x: p.x, y: p.y }; }), false, 8);
  if (pts.length < 2) return 0;
  const a = atStart ? pts[0] : pts[pts.length - 1], b = atStart ? pts[1] : pts[pts.length - 2];
  return Math.atan2(b.y - a.y, b.x - a.x);
}
