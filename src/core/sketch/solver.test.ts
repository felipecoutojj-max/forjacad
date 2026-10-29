import { describe, it, expect } from 'vitest';
import { createSketch, addPoint, addLine, addCircle, addArc, addConstraint, addDimension, getPoint } from './model';
import { solveSketch } from './solver';

describe('solver', () => {
  it('retângulo com H/V e duas cotas fica totalmente definido', () => {
    const s = createSketch('xy');
    const p1 = addPoint(s, 0, 0), p2 = addPoint(s, 48, 2), p3 = addPoint(s, 51, 29), p4 = addPoint(s, -1, 31);
    const l1 = addLine(s, p1.id, p2.id), l2 = addLine(s, p2.id, p3.id), l3 = addLine(s, p3.id, p4.id), l4 = addLine(s, p4.id, p1.id);
    addConstraint(s, 'horizontal', [l1.id]); addConstraint(s, 'vertical', [l2.id]);
    addConstraint(s, 'horizontal', [l3.id]); addConstraint(s, 'vertical', [l4.id]);
    addDimension(s, 'distance', [l1.id], 50); addDimension(s, 'distance', [l2.id], 30);
    addConstraint(s, 'fixed', [p1.id]);
    const r = solveSketch(s);
    expect(r.converged).toBe(true);
    expect(Math.abs(getPoint(s, p2.id).x - getPoint(s, p1.id).x)).toBeCloseTo(50, 5);
    expect(Math.abs(getPoint(s, p3.id).y - getPoint(s, p2.id).y)).toBeCloseTo(30, 5);
    expect(getPoint(s, p1.id).y).toBeCloseTo(getPoint(s, p2.id).y, 6);
    expect(r.dof).toBe(0);
    expect(r.overConstrained).toBe(false);
  });

  it('sem ponto fixo, retângulo cotado ainda tem DOF 0 (corpo rígido não conta)', () => {
    const s = createSketch('xy');
    const p1 = addPoint(s, 0, 0), p2 = addPoint(s, 50, 0), p3 = addPoint(s, 50, 30), p4 = addPoint(s, 0, 30);
    const l1 = addLine(s, p1.id, p2.id), l2 = addLine(s, p2.id, p3.id), l3 = addLine(s, p3.id, p4.id), l4 = addLine(s, p4.id, p1.id);
    addConstraint(s, 'horizontal', [l1.id]); addConstraint(s, 'vertical', [l2.id]);
    addConstraint(s, 'horizontal', [l3.id]); addConstraint(s, 'vertical', [l4.id]);
    addDimension(s, 'distance', [l1.id], 50); addDimension(s, 'distance', [l2.id], 30);
    const r = solveSketch(s);
    expect(r.converged).toBe(true);
    expect(r.dof).toBe(0);
  });

  it('círculo com diâmetro e concêntrico', () => {
    const s = createSketch('xy');
    const c1 = addPoint(s, 10, 10), c2 = addPoint(s, 12, 9);
    const a = addCircle(s, c1.id, 8), b = addCircle(s, c2.id, 3);
    addConstraint(s, 'concentric', [a.id, b.id]);
    addDimension(s, 'diameter', [a.id], 20); addDimension(s, 'diameter', [b.id], 6.5);
    addConstraint(s, 'fixed', [c1.id]);
    const r = solveSketch(s);
    expect(r.converged).toBe(true);
    expect(a.r).toBeCloseTo(10, 6); expect(b.r).toBeCloseTo(3.25, 6);
    expect(getPoint(s, c2.id).x).toBeCloseTo(10, 6);
    expect(r.dof).toBe(0);
  });

  it('linha tangente a arco e arco mantém pontas na circunferência', () => {
    const s = createSketch('xy');
    const c = addPoint(s, 0, 0), ps = addPoint(s, 10, 0.5), pe = addPoint(s, 0.3, 10);
    const arc = addArc(s, c.id, ps.id, pe.id, 10);
    const q = addPoint(s, 30, 12);
    const l = addLine(s, pe.id, q.id);
    addConstraint(s, 'tangent', [l.id, arc.id]);
    addConstraint(s, 'fixed', [c.id]);
    addDimension(s, 'radius', [arc.id], 10);
    addDimension(s, 'distance', [l.id], 30);
    const r = solveSketch(s);
    expect(r.converged).toBe(true);
    const e = getPoint(s, pe.id);
    expect(Math.hypot(e.x, e.y)).toBeCloseTo(10, 5);
    // tangente: direção da linha perpendicular ao raio no ponto de contato
    const qq = getPoint(s, q.id);
    const dx = qq.x - e.x, dy = qq.y - e.y; const L = Math.hypot(dx, dy);
    expect(L).toBeCloseTo(30, 4);
    expect(Math.abs((dx * e.x + dy * e.y) / L / 10)).toBeLessThan(2e-3);
  });

  it('arrastar ponto respeita a cota', () => {
    const s = createSketch('xy');
    const p1 = addPoint(s, 0, 0), p2 = addPoint(s, 40, 0);
    const l = addLine(s, p1.id, p2.id);
    addDimension(s, 'distance', [l.id], 40);
    addConstraint(s, 'fixed', [p1.id]);
    const r = solveSketch(s, { drag: { point: p2.id, x: 30, y: 30 } });
    expect(r.converged).toBe(true);
    const p = getPoint(s, p2.id);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(40, 4);
    expect(p.x).toBeGreaterThan(20); expect(p.y).toBeGreaterThan(20);
  });

  it('detecta sobre-restrição', () => {
    const s = createSketch('xy');
    const p1 = addPoint(s, 0, 0), p2 = addPoint(s, 40, 0);
    const l = addLine(s, p1.id, p2.id);
    addDimension(s, 'distance', [l.id], 40);
    addDimension(s, 'hdistance', [l.id], 40);
    addConstraint(s, 'horizontal', [l.id]);
    const r = solveSketch(s);
    expect(r.overConstrained).toBe(true);
  });

  it('ângulo entre linhas', () => {
    const s = createSketch('xy');
    const o = addPoint(s, 0, 0), a = addPoint(s, 50, 0), b = addPoint(s, 40, 20);
    const l1 = addLine(s, o.id, a.id), l2 = addLine(s, o.id, b.id);
    addConstraint(s, 'fixed', [o.id]); addConstraint(s, 'fixed', [a.id]);
    addDimension(s, 'angle', [l1.id, l2.id], 45);
    addDimension(s, 'distance', [l2.id], 50);
    const r = solveSketch(s);
    expect(r.converged).toBe(true);
    const pb = getPoint(s, b.id);
    expect(Math.atan2(pb.y, pb.x) * 180 / Math.PI).toBeCloseTo(45, 3);
    expect(Math.hypot(pb.x, pb.y)).toBeCloseTo(50, 4);
  });
});
