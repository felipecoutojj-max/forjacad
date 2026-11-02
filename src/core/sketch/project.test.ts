import { describe, it, expect } from 'vitest';
import * as M from './model';
import { classify, projectPolylines, worldToPlane } from './project';
import { BASE_PLANES, type V3 } from '../document';
import { v2, dist } from '../geom';

const XY = BASE_PLANES[0];
const circle3 = (c: V3, r: number, n: number, tiltDeg = 0, a0 = 0, a1 = Math.PI * 2): V3[] => {
  const out: V3[] = []; const t = (tiltDeg * Math.PI) / 180;
  for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; const x = r * Math.cos(a), y = r * Math.sin(a); out.push([c[0] + x, c[1] + y * Math.cos(t), c[2] + y * Math.sin(t)]); }
  return out;
};

describe('projetar arestas', () => {
  it('converte ponto 3D para o plano', () => { expect(worldToPlane(XY, [3, 4, 9])).toEqual(v2(3, 4)); expect(worldToPlane(BASE_PLANES[1], [3, 4, 9])).toEqual(v2(3, -9)); });

  it('reconhece linha, círculo e arco (com o sentido anti-horário certo)', () => {
    expect(classify([v2(0, 0), v2(10, 0)])).toEqual({ type: 'line', a: v2(0, 0), b: v2(10, 0) });
    const c = classify(circle3([5, 5, 0], 4, 64).map((p) => v2(p[0], p[1])));
    expect(c?.type).toBe('circle'); if (c?.type === 'circle') { expect(c.r).toBeCloseTo(4, 4); expect(c.c.x).toBeCloseTo(5, 4); }
    // Arco de 0 a 90° percorrido ao contrário: start/end trocam para manter anti-horário.
    const pts = circle3([0, 0, 0], 10, 16, 0, Math.PI / 2, 0).map((p) => v2(p[0], p[1]));
    const a = classify(pts); expect(a?.type).toBe('arc');
    if (a?.type === 'arc') { expect(a.start.x).toBeCloseTo(10, 4); expect(a.end.y).toBeCloseTo(10, 4); }
  });

  it('círculo inclinado vira spline fechada; aresta de ponta vira nada; arco visto de lado vira linha', () => {
    const tilted = classify(circle3([0, 0, 0], 10, 64, 45).map((p) => v2(p[0], p[1])));
    expect(tilted?.type).toBe('spline'); if (tilted?.type === 'spline') { expect(tilted.closed).toBe(true); expect(tilted.pts.length).toBeLessThanOrEqual(33); }
    expect(classify([v2(1, 1), v2(1, 1), v2(1, 1)])).toBeNull();
    const edgeOn = classify(circle3([0, 0, 0], 10, 32, 90, 0, Math.PI).map((p) => v2(p[0], p[1])));
    expect(edgeOn?.type).toBe('line'); if (edgeOn?.type === 'line') expect(dist(edgeOn.a, edgeOn.b)).toBeCloseTo(20, 4);
  });

  it('projeta as 4 arestas do topo de um bloco como retângulo com cantos compartilhados, sem repetir', () => {
    const s = M.createSketch(XY.id);
    const q: V3[] = [[0, 0, 20], [40, 0, 20], [40, 20, 20], [0, 20, 20]];
    const polys: V3[][] = [[q[0], q[1]], [q[1], q[2]], [q[2], q[3]], [q[3], q[0]]];
    const made = projectPolylines(s, XY, polys, { construction: true });
    expect(made).toHaveLength(4); expect(s.points).toHaveLength(4); expect(made.every((e) => e.construction)).toBe(true);
    expect(projectPolylines(s, XY, polys)).toHaveLength(0); // de novo: nada repete
    // Aresta vertical do bloco (de ponta para XY) não vira nada.
    expect(projectPolylines(s, XY, [[[0, 0, 0], [0, 0, 20]]])).toHaveLength(0);
  });
});
