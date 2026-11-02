// Projetar arestas de um corpo no plano do esboço: a polilinha 3D cai no plano e vira
// linha, círculo, arco ou spline do esboço (aresta de ponta para o plano vira nada).

import type { Vec2 } from '../geom';
import { v2, dist, sub, dot, fitLine, fitCircle, angleOf, TAU } from '../geom';
import type { Plane, V3 } from '../document';
import * as M from './model';
import type { Sketch, Entity, Id } from './model';

/** Ponto 3D → coordenadas (u, v) do plano (a altura fora do plano é descartada). */
export function worldToPlane(p: Plane, q: V3): Vec2 {
  const d: V3 = [q[0] - p.origin[0], q[1] - p.origin[1], q[2] - p.origin[2]];
  return v2(d[0] * p.u[0] + d[1] * p.u[1] + d[2] * p.u[2], d[0] * p.v[0] + d[1] * p.v[1] + d[2] * p.v[2]);
}

export type Projected =
  | { type: 'line'; a: Vec2; b: Vec2 }
  | { type: 'circle'; c: Vec2; r: number }
  | { type: 'arc'; c: Vec2; r: number; start: Vec2; end: Vec2 }
  | { type: 'spline'; pts: Vec2[]; closed: boolean };

/** Reconhece a polilinha projetada (pontos exatos da curva, não um traço de caneta). */
export function classify(raw: Vec2[], tol = 0.01): Projected | null {
  const pts: Vec2[] = []; for (const p of raw) if (!pts.length || dist(pts[pts.length - 1], p) > 1e-6) pts.push(p);
  if (pts.length < 2) return null;
  let length = 0; for (let i = 1; i < pts.length; i++) length += dist(pts[i - 1], pts[i]);
  if (length < tol * 5) return null;
  const closed = pts.length > 3 && dist(pts[0], pts[pts.length - 1]) < 1e-3;
  if (pts.length === 2) return { type: 'line', a: pts[0], b: pts[1] };
  // Reta (inclusive curva vista de lado, que vai e volta sobre a mesma reta).
  const fl = fitLine(pts);
  if (fl && fl.rms < tol) {
    let lo = Infinity, hi = -Infinity; for (const p of pts) { const t = dot(sub(p, fl.p), fl.d); lo = Math.min(lo, t); hi = Math.max(hi, t); }
    if (hi - lo < tol * 5) return null;
    return { type: 'line', a: v2(fl.p.x + fl.d.x * lo, fl.p.y + fl.d.y * lo), b: v2(fl.p.x + fl.d.x * hi, fl.p.y + fl.d.y * hi) };
  }
  // Círculo ou arco (um círculo inclinado vira elipse e cai na spline).
  const fc = fitCircle(pts);
  if (fc && fc.rms < tol && pts.every((p) => Math.abs(dist(p, fc.c) - fc.r) < tol * 3)) {
    if (closed) return { type: 'circle', c: fc.c, r: fc.r };
    let turn = 0; for (let i = 1; i < pts.length; i++) { let d = angleOf(sub(pts[i], fc.c)) - angleOf(sub(pts[i - 1], fc.c)); d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI; turn += d; }
    const ccw = turn > 0;
    return { type: 'arc', c: fc.c, r: fc.r, start: ccw ? pts[0] : pts[pts.length - 1], end: ccw ? pts[pts.length - 1] : pts[0] };
  }
  const body = closed ? pts.slice(0, -1) : pts;
  const step = Math.max(1, Math.ceil(body.length / 32)); const out: Vec2[] = [];
  for (let i = 0; i < body.length; i += step) out.push(body[i]);
  if (!closed && out[out.length - 1] !== body[body.length - 1]) out.push(body[body.length - 1]);
  return out.length >= 2 ? { type: 'spline', pts: out, closed } : null;
}

export interface ProjectOptions { construction?: boolean; /** Pontos a menos disto (mm) fundem com os existentes. */ mergeTol?: number; tol?: number; }

/** Projeta polilinhas 3D no esboço. Devolve as entidades criadas (repetidas não entram de novo). */
export function projectPolylines(s: Sketch, plane: Plane, polys: V3[][], opts: ProjectOptions = {}): Entity[] {
  const mergeTol = opts.mergeTol ?? 1e-3; const created: Entity[] = [];
  const pointFor = (q: Vec2): Id => { const ex = s.points.find((p) => dist(p, q) < mergeTol); return ex ? ex.id : M.addPoint(s, q.x, q.y).id; };
  const sameLine = (a: Id, b: Id) => s.entities.some((e) => e.type === 'line' && ((e.a === a && e.b === b) || (e.a === b && e.b === a)));
  const sameRound = (c: Id, r: number, st?: Id, en?: Id) => s.entities.some((e) => M.isRound(e) && (st ? e.type === 'arc' && e.start === st && e.end === en : e.type === 'circle') && e.center === c && Math.abs(e.r - r) < mergeTol);
  for (const poly of polys) {
    const pr = classify(poly.map((q) => worldToPlane(plane, q)), opts.tol); if (!pr) continue;
    let e: Entity | null = null;
    if (pr.type === 'line') { const a = pointFor(pr.a), b = pointFor(pr.b); if (a !== b && !sameLine(a, b)) e = M.addLine(s, a, b); }
    else if (pr.type === 'circle') { const c = pointFor(pr.c); if (!sameRound(c, pr.r)) e = M.addCircle(s, c, pr.r); }
    else if (pr.type === 'arc') { const c = pointFor(pr.c), st = pointFor(pr.start), en = pointFor(pr.end); if (st !== en && !sameRound(c, pr.r, st, en)) e = M.addArc(s, c, st, en, pr.r); }
    else { const ids = pr.pts.map((q, i) => (i === 0 || i === pr.pts.length - 1) && !pr.closed ? pointFor(q) : M.addPoint(s, q.x, q.y).id); e = M.addSpline(s, ids, pr.closed); }
    if (e) { if (opts.construction) e.construction = true; created.push(e); }
  }
  M.pruneOrphanPoints(s);
  return created;
}

/** Direção perpendicular do plano (para saber se uma aresta está de ponta). */
export function planeNormalOf(p: Plane): V3 { return [p.u[1] * p.v[2] - p.u[2] * p.v[1], p.u[2] * p.v[0] - p.u[0] * p.v[2], p.u[0] * p.v[1] - p.u[1] * p.v[0]]; }


