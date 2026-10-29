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
export type Entity = LineEntity | CircleEntity | ArcEntity;

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
  }
}

/** Funde o ponto `from` em `to`: toda referência a `from` passa a apontar para `to`. */
export function mergePoints(s: Sketch, from: Id, to: Id): void {
  if (from === to) return;
  for (const e of s.entities) {
    if (e.type === 'line') { if (e.a === from) e.a = to; if (e.b === from) e.b = to; }
    else if (e.type === 'circle') { if (e.center === from) e.center = to; }
    else { if (e.center === from) e.center = to; if (e.start === from) e.start = to; if (e.end === from) e.end = to; }
  }
  for (const c of s.constraints) c.refs = c.refs.map((r) => (r === from ? to : r));
  for (const d of s.dimensions) d.refs = d.refs.map((r) => (r === from ? to : r));
  s.points = s.points.filter((p) => p.id !== from);
  // Linhas degeneradas (a === b) somem.
  s.entities = s.entities.filter((e) => !(e.type === 'line' && e.a === e.b));
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
