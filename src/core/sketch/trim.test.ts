import { describe, it, expect } from 'vitest';
import * as M from './model';
import { cutsOf, trimSegmentAt, applyTrim } from './trim';
import { v2, dist } from '../geom';

function rectWithCross(): { s: M.Sketch; top: M.LineEntity; mid: M.LineEntity } {
  const s = M.createSketch('xy');
  const a = M.addPoint(s, 0, 0), b = M.addPoint(s, 40, 0), c = M.addPoint(s, 40, 20), d = M.addPoint(s, 0, 20);
  M.addLine(s, a.id, b.id); M.addLine(s, b.id, c.id); const top = M.addLine(s, c.id, d.id); M.addLine(s, d.id, a.id);
  const m1 = M.addPoint(s, 20, -5), m2 = M.addPoint(s, 20, 25); const mid = M.addLine(s, m1.id, m2.id);
  return { s, top, mid };
}

describe('aparar', () => {
  it('linha cruzada no meio: tocar numa metade tira só ela e prende a ponta nova à linha que corta', () => {
    const { s, top, mid } = rectWithCross();
    const cuts = cutsOf(s, top); expect(cuts).toHaveLength(1); expect(cuts[0].q.x).toBeCloseTo(20); expect(cuts[0].q.y).toBeCloseTo(20);
    const seg = trimSegmentAt(s, top, v2(30, 20)); expect(seg.kind).toBe('segment');
    applyTrim(s, seg);
    const t = M.getEntity(s, top.id) as M.LineEntity; const a = M.getPoint(s, t.a), b = M.getPoint(s, t.b);
    expect(dist(a, v2(20, 20))).toBeLessThan(1e-6); expect(dist(b, v2(0, 20))).toBeLessThan(1e-6);
    expect(s.constraints.some((k) => k.kind === 'pointOnLine' && k.refs[0] === t.a && k.refs[1] === mid.id)).toBe(true);
    expect(s.entities).toHaveLength(5); expect(s.points).toHaveLength(7);
  });

  it('linha cruzada duas vezes: tocar no meio divide em duas', () => {
    const s = M.createSketch('xy');
    const a = M.addPoint(s, 0, 0), b = M.addPoint(s, 60, 0); const l = M.addLine(s, a.id, b.id);
    for (const x of [20, 40]) { const p = M.addPoint(s, x, -10), q = M.addPoint(s, x, 10); M.addLine(s, p.id, q.id); }
    M.addConstraint(s, 'horizontal', [l.id]); M.addDimension(s, 'distance', [l.id], 60);
    applyTrim(s, trimSegmentAt(s, l, v2(30, 0)));
    const lines = s.entities.filter((e): e is M.LineEntity => e.type === 'line' && Math.abs(M.getPoint(s, e.a).y) < 1e-9 && Math.abs(M.getPoint(s, e.b).y) < 1e-9);
    expect(lines).toHaveLength(2);
    const xs = lines.map((e) => [M.getPoint(s, e.a).x, M.getPoint(s, e.b).x].sort((p, q) => p - q));
    expect(xs).toEqual(expect.arrayContaining([[0, 20], [40, 60]]));
    expect(s.constraints.filter((k) => k.kind === 'horizontal')).toHaveLength(2);
    expect(s.dimensions).toHaveLength(0);
  });

  it('linha sem cruzamento some inteira', () => {
    const s = M.createSketch('xy'); const l = M.addLine(s, M.addPoint(s, 0, 0).id, M.addPoint(s, 10, 0).id);
    const seg = trimSegmentAt(s, l, v2(5, 0)); expect(seg.kind).toBe('all'); applyTrim(s, seg);
    expect(s.entities).toHaveLength(0); expect(s.points).toHaveLength(0);
  });

  it('círculo cortado por uma linha vira arco com a metade tocada removida', () => {
    const s = M.createSketch('xy'); const c = M.addCircle(s, M.addPoint(s, 0, 0).id, 10);
    M.addLine(s, M.addPoint(s, -20, 0).id, M.addPoint(s, 20, 0).id);
    expect(cutsOf(s, c)).toHaveLength(2);
    applyTrim(s, trimSegmentAt(s, c, v2(0, -10)));
    const arc = M.getEntity(s, c.id); expect(arc.type).toBe('arc');
    if (arc.type === 'arc') {
      const ps = M.getPoint(s, arc.start), pe = M.getPoint(s, arc.end);
      expect(ps.x).toBeCloseTo(10); expect(pe.x).toBeCloseTo(-10); // anti-horário de 0 a π: fica a metade de cima
      const { start, end } = M.arcAngles(s, arc); expect(start).toBeCloseTo(0); expect(Math.abs(end)).toBeCloseTo(Math.PI);
    }
  });

  it('arco cortado perto de uma ponta encurta; ponta de linha encostada também conta como corte', () => {
    const s = M.createSketch('xy'); const c = M.addPoint(s, 0, 0);
    const ps = M.addPoint(s, 10, 0), pe = M.addPoint(s, -10, 0); const arc = M.addArc(s, c.id, ps.id, pe.id, 10);
    const top = M.addPoint(s, 0, 10); M.addLine(s, c.id, top.id); // linha do centro até o topo do arco (T)
    const cuts = cutsOf(s, arc); expect(cuts).toHaveLength(1); expect(cuts[0].point).toBe(top.id);
    applyTrim(s, trimSegmentAt(s, arc, v2(7, 7)));
    const a = M.getEntity(s, arc.id) as M.ArcEntity; expect(a.start).toBe(top.id); expect(a.end).toBe(pe.id);
    expect(s.points.find((p) => p.id === ps.id)).toBeUndefined();
  });

  it('aparar até uma ponta que já estava presa na linha não deixa restrição redundante', () => {
    const { s, top, mid } = rectWithCross();
    applyTrim(s, trimSegmentAt(s, top, v2(30, 20))); // ponta nova do topo presa em mid
    applyTrim(s, trimSegmentAt(s, mid, v2(20, 24))); // sobra de cima de mid some: a ponta vira essa mesma
    const m = M.getEntity(s, mid.id) as M.LineEntity; const t = M.getEntity(s, top.id) as M.LineEntity;
    expect(m.b).toBe(t.a);
    expect(s.constraints.filter((k) => k.kind === 'pointOnLine')).toHaveLength(0);
  });

  it('elipse também corta uma linha (por amostragem)', () => {
    const s = M.createSketch('xy'); M.addEllipse(s, M.addPoint(s, 0, 0).id, 20, 10, 0);
    const l = M.addLine(s, M.addPoint(s, -30, 0).id, M.addPoint(s, 30, 0).id);
    const cuts = cutsOf(s, l); expect(cuts).toHaveLength(2);
    expect(Math.abs(cuts[0].q.x)).toBeCloseTo(20, 1);
    applyTrim(s, trimSegmentAt(s, l, v2(0, 0)));
    expect(s.entities.filter((e) => e.type === 'line')).toHaveLength(2);
  });
});
