import { describe, it, expect } from 'vitest';
import { recognizeStroke } from './recognizer';
import { v2, type Vec2 } from '../geom';

const noise = (n: number, seed = 1) => { let s = seed; return () => { s = (s * 16807) % 2147483647; return ((s / 2147483647) - 0.5) * n; }; };

function jitter(pts: Vec2[], amt: number): Vec2[] { const r = noise(amt, 7); return pts.map((p) => v2(p.x + r(), p.y + r())); }
function seg(a: Vec2, b: Vec2, n = 30): Vec2[] { const out: Vec2[] = []; for (let i = 0; i <= n; i++) out.push(v2(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n)); return out; }
function arc(c: Vec2, r: number, a0: number, a1: number, n = 40): Vec2[] { const out: Vec2[] = []; for (let i = 0; i <= n; i++) { const t = a0 + (a1 - a0) * i / n; out.push(v2(c.x + r * Math.cos(t), c.y + r * Math.sin(t))); } return out; }

describe('reconhecedor', () => {
  it('traço quase reto vira linha', () => {
    const pr = recognizeStroke(jitter(seg(v2(0, 0), v2(80, 5)), 0.6), { tol: 1 });
    expect(pr).toHaveLength(1); expect(pr[0].type).toBe('line');
  });
  it('traço fechado redondo vira círculo', () => {
    const pr = recognizeStroke(jitter(arc(v2(20, 20), 15, 0, Math.PI * 2, 80), 0.5), { tol: 1 });
    expect(pr).toHaveLength(1); expect(pr[0].type).toBe('circle');
    if (pr[0].type === 'circle') { expect(pr[0].r).toBeCloseTo(15, 0); expect(pr[0].c.x).toBeCloseTo(20, 0); }
  });
  it('meia volta vira arco, sentido detectado', () => {
    const pr = recognizeStroke(jitter(arc(v2(0, 0), 20, 0, Math.PI), 0.4), { tol: 1 });
    expect(pr).toHaveLength(1); expect(pr[0].type).toBe('arc');
    if (pr[0].type === 'arc') expect(pr[0].ccw).toBe(true);
    const pr2 = recognizeStroke(jitter(arc(v2(0, 0), 20, Math.PI, 0), 0.4), { tol: 1 });
    if (pr2[0].type === 'arc') expect(pr2[0].ccw).toBe(false);
  });
  it('retângulo riscado num traço só vira quatro linhas encadeadas', () => {
    const pts = [...seg(v2(0, 0), v2(60, 0)), ...seg(v2(60, 0), v2(60, 30)), ...seg(v2(60, 30), v2(0, 30)), ...seg(v2(0, 30), v2(0, 1))];
    const pr = recognizeStroke(jitter(pts, 0.5), { tol: 1 });
    expect(pr).toHaveLength(4);
    expect(pr.every((p) => p.type === 'line')).toBe(true);
    for (let i = 1; i < pr.length; i++) {
      const a = pr[i - 1], b = pr[i];
      if (a.type === 'line' && b.type === 'line') { expect(a.b.x).toBeCloseTo(b.a.x, 6); expect(a.b.y).toBeCloseTo(b.a.y, 6); }
    }
  });
  it('linha + arco + linha (ranhura) vira três primitivas', () => {
    const pts = [...seg(v2(0, 0), v2(40, 0)), ...arc(v2(40, 10), 10, -Math.PI / 2, Math.PI / 2), ...seg(v2(40, 20), v2(0, 20))];
    const pr = recognizeStroke(jitter(pts, 0.3), { tol: 1 });
    expect(pr.map((p) => p.type)).toEqual(['line', 'arc', 'line']);
  });
});
