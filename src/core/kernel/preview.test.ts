import { describe, it, expect } from 'vitest';
import { createSketch, addPoint, addLine, addCircle, addArc, addSpline, addEllipse } from '../sketch/model';
import { extractProfiles, signedArea } from './preview';

describe('perfis', () => {
  it('retângulo com furo circular vira um perfil com um furo', () => {
    const s = createSketch('plane-xy');
    const p1 = addPoint(s, 0, 0), p2 = addPoint(s, 50, 0), p3 = addPoint(s, 50, 30), p4 = addPoint(s, 0, 30);
    addLine(s, p1.id, p2.id); addLine(s, p2.id, p3.id); addLine(s, p3.id, p4.id); addLine(s, p4.id, p1.id);
    const c = addPoint(s, 25, 15); addCircle(s, c.id, 5);
    const pr = extractProfiles(s);
    expect(pr).toHaveLength(1);
    expect(pr[0].holes).toHaveLength(1);
    expect(pr[0].area).toBeCloseTo(1500, 3);
  });
  it('dois retângulos separados viram dois perfis', () => {
    const s = createSketch('plane-xy');
    const r = (x: number) => { const a = addPoint(s, x, 0), b = addPoint(s, x + 10, 0), c = addPoint(s, x + 10, 10), d = addPoint(s, x, 10); addLine(s, a.id, b.id); addLine(s, b.id, c.id); addLine(s, c.id, d.id); addLine(s, d.id, a.id); };
    r(0); r(30);
    expect(extractProfiles(s)).toHaveLength(2);
  });
  it('ranhura (linha, arco, linha, arco) fecha um perfil', () => {
    const s = createSketch('plane-xy');
    const a = addPoint(s, 0, 0), b = addPoint(s, 40, 0), c1 = addPoint(s, 40, 10), c = addPoint(s, 40, 20), d = addPoint(s, 0, 20), c2 = addPoint(s, 0, 10);
    addLine(s, a.id, b.id); addArc(s, c1.id, b.id, c.id, 10); addLine(s, c.id, d.id); addArc(s, c2.id, d.id, a.id, 10);
    const pr = extractProfiles(s);
    expect(pr).toHaveLength(1);
    expect(Math.abs(pr[0].area - (40 * 20 + Math.PI * 100))).toBeLessThan(3);
  });
  it('dois retângulos lado a lado compartilhando aresta viram dois perfis, não três', () => {
    const s = createSketch('plane-xy');
    const a = addPoint(s, 0, 0), b = addPoint(s, 10, 0), c = addPoint(s, 20, 0), d = addPoint(s, 20, 10), e = addPoint(s, 10, 10), f = addPoint(s, 0, 10);
    addLine(s, a.id, b.id); addLine(s, b.id, c.id); addLine(s, c.id, d.id); addLine(s, d.id, e.id); addLine(s, e.id, f.id); addLine(s, f.id, a.id); addLine(s, b.id, e.id);
    const pr = extractProfiles(s);
    expect(pr).toHaveLength(2);
    expect(pr.reduce((acc, p) => acc + p.area, 0)).toBeCloseTo(200, 6);
  });
  it('área assinada', () => {
    expect(signedArea([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])).toBeCloseTo(1);
  });
  it('elipse e spline fechada viram perfis; spline aberta fecha contorno com linha', () => {
    const s = createSketch('plane-xy');
    addEllipse(s, addPoint(s, 0, 0).id, 20, 10, 0.3);
    addSpline(s, [[100, 0], [130, -5], [160, 0], [150, 25], [110, 25]].map(([x, y]) => addPoint(s, x, y).id), true);
    const a = addPoint(s, 200, 0), b = addPoint(s, 260, 0); addLine(s, a.id, b.id);
    addSpline(s, [b.id, addPoint(s, 250, 20).id, addPoint(s, 230, 30).id, a.id]);
    const pr = extractProfiles(s);
    expect(pr).toHaveLength(3);
    const areas = pr.map((p) => p.area).sort((x, y) => x - y);
    expect(areas[0]).toBeCloseTo(Math.PI * 20 * 10, -1);
    expect(areas[1]).toBeGreaterThan(900); expect(areas[2]).toBeGreaterThan(900);
  });
});
