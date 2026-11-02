// Aparar: tira de uma linha, círculo ou arco o trecho entre dois cruzamentos (ou até a ponta).
// Cortes vêm de qualquer entidade do esboço (spline e elipse por amostragem) e de pontos já sobre a entidade.

import type { Vec2 } from '../geom';
import { v2, add, sub, scale, dist, dot, normAngle, TAU, intersectSegments, intersectLineCircle, intersectCircles, angleInArc, arcSweep, angleOf } from '../geom';
import * as M from './model';
import type { Sketch, Entity, Id } from './model';

/** Entidade que o aparar sabe cortar. */
export type Trimmable = M.LineEntity | M.CircleEntity | M.ArcEntity;
export function isTrimmable(e: Entity | undefined | null): e is Trimmable { return !!e && (e.type === 'line' || e.type === 'circle' || e.type === 'arc'); }

/** Um corte sobre a entidade: parâmetro `t`, posição e quem corta (para prender o ponto novo). */
export interface Cut { t: number; q: Vec2; cutters: Entity[]; point?: Id; }

/** Trecho a remover: tudo, ou o pedaço entre `lo` e `hi` (null = até a ponta). */
export type TrimSegment =
  | { kind: 'all'; entity: Trimmable }
  | { kind: 'segment'; entity: Trimmable; lo: Cut | null; hi: Cut | null; poly: Vec2[] };

const EPS = 1e-3; // mm: pontos "em cima" da entidade e cortes repetidos

interface Param { max: number; cyclic: boolean; at: (t: number) => Vec2; of: (q: Vec2) => number; }

function param(s: Sketch, e: Trimmable): Param {
  if (e.type === 'line') {
    const a = M.getPoint(s, e.a), b = M.getPoint(s, e.b); const ab = sub(b, a); const l2 = dot(ab, ab) || 1;
    return { max: 1, cyclic: false, at: (t) => add(v2(a.x, a.y), scale(ab, t)), of: (q) => dot(sub(q, a), ab) / l2 };
  }
  const c = M.getPoint(s, e.center);
  if (e.type === 'circle') return { max: TAU, cyclic: true, at: (t) => add(v2(c.x, c.y), v2(Math.cos(t) * e.r, Math.sin(t) * e.r)), of: (q) => normAngle(angleOf(sub(q, c))) };
  const { start, end } = M.arcAngles(s, e); const sweep = arcSweep(start, end);
  return { max: sweep, cyclic: false, at: (t) => add(v2(c.x, c.y), v2(Math.cos(start + t) * e.r, Math.sin(start + t) * e.r)), of: (q) => normAngle(angleOf(sub(q, c)) - start) };
}

/** Pontos onde `e` cruza a entidade `f` (só os que caem sobre as duas). */
function crossings(s: Sketch, e: Trimmable, f: Entity): Vec2[] {
  const P = (id: Id) => M.getPoint(s, id);
  const onE = (q: Vec2) => onEntity(s, e, q);
  if (f.type === 'line' || f.type === 'circle' || f.type === 'arc') {
    let cands: Vec2[] = [];
    if (e.type === 'line' && f.type === 'line') { const q = intersectSegments(P(e.a), P(e.b), P(f.a), P(f.b)); if (q) cands = [q]; }
    else if (e.type === 'line' || f.type === 'line') { const l = (e.type === 'line' ? e : f) as M.LineEntity, c = (e.type === 'line' ? f : e) as M.CircleEntity | M.ArcEntity; cands = intersectLineCircle(P(l.a), P(l.b), P(c.center), c.r); }
    else cands = intersectCircles(P(e.center), e.r, P(f.center), f.r);
    return cands.filter((q) => onE(q) && onEntity(s, f, q));
  }
  // Spline e elipse: cada segmento da amostra corta a entidade analiticamente.
  const poly = M.sampleEntity(s, f, 96); const out: Vec2[] = [];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const cands = e.type === 'line' ? [intersectSegments(P(e.a), P(e.b), a, b)].filter((q): q is Vec2 => !!q)
      : intersectLineCircle(a, b, P(e.center), e.r).filter((q) => { const ab = sub(b, a); const t = dot(sub(q, a), ab) / (dot(ab, ab) || 1); return t >= -1e-6 && t <= 1 + 1e-6; });
    for (const q of cands) if (onE(q) && !out.some((o) => dist(o, q) < EPS)) out.push(q);
  }
  return out;
}

/** O ponto está sobre a entidade (dentro do segmento ou do arco)? */
function onEntity(s: Sketch, e: Entity, q: Vec2): boolean {
  const P = (id: Id) => M.getPoint(s, id);
  if (e.type === 'line') { const a = P(e.a), b = P(e.b); const ab = sub(b, a); const t = dot(sub(q, a), ab) / (dot(ab, ab) || 1); return t >= -1e-6 && t <= 1 + 1e-6 && Math.abs((q.x - a.x) * ab.y - (q.y - a.y) * ab.x) / (Math.hypot(ab.x, ab.y) || 1) < EPS; }
  if (e.type === 'circle') return Math.abs(dist(q, P(e.center)) - e.r) < EPS;
  if (e.type === 'arc') { const c = P(e.center); if (Math.abs(dist(q, c) - e.r) >= EPS) return false; const { start, end } = M.arcAngles(s, e); return angleInArc(angleOf(sub(q, c)), start, end); }
  return false;
}

/** Todos os cortes sobre `e`, ordenados pelo parâmetro, sem as próprias pontas. */
export function cutsOf(s: Sketch, e: Trimmable): Cut[] {
  const pr = param(s, e); const own = new Set(M.entityPoints(e)); const cuts: Cut[] = [];
  const push = (q: Vec2, cutter: Entity | null, point?: Id) => {
    const t = pr.of(q); if (!pr.cyclic && (t < EPS / Math.max(pr.max, EPS) || t > pr.max - EPS / Math.max(pr.max, EPS))) return;
    const ex = cuts.find((c) => dist(c.q, q) < EPS);
    if (ex) { if (cutter && !ex.cutters.includes(cutter)) ex.cutters.push(cutter); if (point && !ex.point) ex.point = point; return; }
    cuts.push({ t, q, cutters: cutter ? [cutter] : [], point });
  };
  for (const f of s.entities) { if (f.id === e.id) continue; for (const q of crossings(s, e, f)) push(q, f); }
  // Pontas de outras linhas, arcos e splines que já estão em cima da entidade também cortam (centros não).
  const curvePts = new Set<Id>();
  for (const f of s.entities) { if (f.id === e.id) continue; if (f.type === 'line') { curvePts.add(f.a); curvePts.add(f.b); } else if (f.type === 'arc') { curvePts.add(f.start); curvePts.add(f.end); } else if (f.type === 'spline') for (const id of f.points) curvePts.add(id); }
  for (const p of s.points) { if (own.has(p.id) || !curvePts.has(p.id)) continue; const q = v2(p.x, p.y); if (onEntity(s, e, q)) push(q, null, p.id); }
  // Afasta das pontas em mm, não em parâmetro: para linhas o parâmetro é relativo ao comprimento.
  const near = (t: number) => dist(pr.at(t), pr.at(0)) < EPS || (!pr.cyclic && dist(pr.at(t), pr.at(pr.max)) < EPS);
  return cuts.filter((c) => pr.cyclic || !near(c.t)).sort((a, b) => a.t - b.t);
}

/** Trecho de `e` sob o ponto `uv` (o que sumiria ao aparar ali). */
export function trimSegmentAt(s: Sketch, e: Trimmable, uv: Vec2): TrimSegment {
  const cuts = cutsOf(s, e); const pr = param(s, e);
  if (pr.cyclic) {
    if (cuts.length < 2) return { kind: 'all', entity: e };
    const t = pr.of(uv); let i = cuts.findIndex((c) => c.t > t); if (i < 0) i = 0;
    const hi = cuts[i], lo = cuts[(i - 1 + cuts.length) % cuts.length];
    return { kind: 'segment', entity: e, lo, hi, poly: sampleBetween(pr, lo.t, hi.t, true) };
  }
  if (!cuts.length) return { kind: 'all', entity: e };
  const t = Math.max(0, Math.min(pr.max, pr.of(uv)));
  const lo = [...cuts].reverse().find((c) => c.t <= t) ?? null; const hi = cuts.find((c) => c.t > t) ?? null;
  return { kind: 'segment', entity: e, lo, hi, poly: sampleBetween(pr, lo ? lo.t : 0, hi ? hi.t : pr.max, false) };
}

function sampleBetween(pr: Param, t0: number, t1: number, cyclic: boolean): Vec2[] {
  let span = t1 - t0; if (cyclic && span <= 0) span += TAU;
  const n = pr.max === 1 ? 1 : Math.max(4, Math.ceil((span / TAU) * 48)); const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) out.push(pr.at(t0 + (span * i) / n));
  return out;
}

/** Ponto do esboço em `q`: reaproveita um existente ou cria preso às entidades que cortam ali. */
function pointAt(s: Sketch, cut: Cut): Id {
  if (cut.point) return cut.point;
  const ex = s.points.find((p) => dist(p, cut.q) < EPS); if (ex) return ex.id;
  const p = M.addPoint(s, cut.q.x, cut.q.y);
  for (const f of cut.cutters) if (f.type === 'line' || f.type === 'circle' || f.type === 'arc') M.addConstraint(s, f.type === 'line' ? 'pointOnLine' : 'pointOnCircle', [p.id, f.id]);
  return p.id;
}

/** Aplica o aparar. Devolve as entidades que ficaram (0, 1 ou 2). */
export function applyTrim(s: Sketch, seg: TrimSegment): Entity[] {
  const e = seg.entity;
  if (seg.kind === 'all') { M.removeEntities(s, [e.id]); return []; }
  const { lo, hi } = seg; const kept: Entity[] = [];
  if (e.type === 'circle') {
    // Círculo vira arco do fim do trecho removido até o começo dele (anti-horário).
    const arc: M.ArcEntity = { id: e.id, type: 'arc', center: e.center, start: pointAt(s, hi!), end: pointAt(s, lo!), r: e.r };
    if (e.construction) arc.construction = true;
    s.entities[s.entities.indexOf(e)] = arc; kept.push(arc);
  } else if (lo && hi) {
    // Meio: a entidade fica com o começo, uma nova fica com o fim.
    const pLo = pointAt(s, lo), pHi = pointAt(s, hi);
    const tail: Entity = e.type === 'line' ? { id: M.newId('l'), type: 'line', a: pHi, b: e.b } : { id: M.newId('a'), type: 'arc', center: e.center, start: pHi, end: e.end, r: e.r };
    if (e.construction) tail.construction = true;
    if (e.type === 'line') e.b = pLo; else e.end = pLo;
    s.entities.splice(s.entities.indexOf(e) + 1, 0, tail); kept.push(e, tail);
    // Restrições de direção valem para as duas metades; pontos presos vão para a metade onde estão.
    for (const k of [...s.constraints]) {
      if (!k.refs.includes(e.id)) continue;
      if (k.kind === 'horizontal' || k.kind === 'vertical') M.addConstraint(s, k.kind, [tail.id]);
      else if (k.kind === 'pointOnLine' || k.kind === 'pointOnCircle' || k.kind === 'midpoint') {
        const p = M.findPoint(s, k.refs[0]); if (!p) continue;
        if (k.kind === 'midpoint' || !onEntity(s, e, v2(p.x, p.y))) { if (k.kind !== 'midpoint' && onEntity(s, tail, v2(p.x, p.y))) k.refs = [k.refs[0], tail.id]; else M.removeConstraint(s, k.id); }
      }
    }
  } else if (lo) { const p = pointAt(s, lo); if (e.type === 'line') e.b = p; else e.end = p; kept.push(e); }
  else if (hi) { const p = pointAt(s, hi); if (e.type === 'line') e.a = p; else e.start = p; kept.push(e); }
  // Cota de comprimento da linha aparada perde o sentido; cotas e restrições sobre pontos que ficaram soltos também.
  if (e.type === 'line') s.dimensions = s.dimensions.filter((d) => !(d.refs.length === 1 && d.refs[0] === e.id));
  const used = new Set<Id>(); for (const en of s.entities) for (const p of M.entityPoints(en)) used.add(p);
  const loose = (id: Id) => !!M.findPoint(s, id) && !used.has(id);
  // Ponto que virou ponta da própria entidade não precisa mais de "ponto sobre" ela (seria redundante).
  const endsOf = (en: Entity): Id[] => en.type === 'line' ? [en.a, en.b] : en.type === 'arc' ? [en.start, en.end] : [];
  s.constraints = s.constraints.filter((k) => {
    if (k.refs.some(loose)) return false;
    if (k.kind === 'pointOnLine' || k.kind === 'pointOnCircle') { const en = M.findEntity(s, k.refs[1]); if (en && endsOf(en).includes(k.refs[0])) return false; }
    return true;
  });
  s.dimensions = s.dimensions.filter((d) => !d.refs.some(loose));
  M.pruneOrphanPoints(s);
  return kept;
}
