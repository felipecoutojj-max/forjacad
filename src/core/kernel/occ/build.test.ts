// Testa o kernel com o OpenCASCADE real em Node (carga ~3 s).
import { describe, it, expect, beforeAll } from 'vitest';
import initOpenCascade from 'opencascade.js/dist/node.js';
import type { OpenCascadeInstance } from 'opencascade.js';
import { rebuildDocument, tessellate, exportSTEP } from './build';
import { createDocument, addExtrude, addFillet, addBoolean, type ForjaDocument } from '../../document';
import * as M from '../../sketch/model';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await initOpenCascade(); }, 60000);

function rectSketch(doc: ForjaDocument, plane: string, x0: number, y0: number, w: number, h: number): M.Sketch {
  const s = M.createSketch(plane, 'ret'); doc.sketches.push(s);
  const p1 = M.addPoint(s, x0, y0), p2 = M.addPoint(s, x0 + w, y0), p3 = M.addPoint(s, x0 + w, y0 + h), p4 = M.addPoint(s, x0, y0 + h);
  M.addLine(s, p1.id, p2.id); M.addLine(s, p2.id, p3.id); M.addLine(s, p3.id, p4.id); M.addLine(s, p4.id, p1.id);
  return s;
}
function circleSketch(doc: ForjaDocument, plane: string, cx: number, cy: number, r: number): M.Sketch {
  const s = M.createSketch(plane, 'circ'); doc.sketches.push(s);
  const c = M.addPoint(s, cx, cy); M.addCircle(s, c.id, r);
  return s;
}
function slotSketch(doc: ForjaDocument, plane: string): M.Sketch {
  // Oblongo: duas linhas horizontais e dois arcos, 40 de comprimento entre centros, raio 10.
  const s = M.createSketch(plane, 'slot'); doc.sketches.push(s);
  const a = M.addPoint(s, 0, 10), b = M.addPoint(s, 40, 10), c = M.addPoint(s, 40, -10), d = M.addPoint(s, 0, -10);
  const c1 = M.addPoint(s, 40, 0), c2 = M.addPoint(s, 0, 0);
  M.addLine(s, a.id, b.id); M.addArc(s, c1.id, c.id, b.id, 10); M.addLine(s, c.id, d.id); M.addArc(s, c2.id, a.id, d.id, 10);
  return s;
}

describe('kernel OpenCASCADE', () => {
  it('extruda um retângulo em um bloco de 100×60×20', () => {
    const doc = createDocument(); const s = rectSketch(doc, 'plane-xy', 0, 0, 100, 60);
    addExtrude(doc, s.id, 20);
    const r = rebuildDocument(oc, doc);
    expect(r.errors).toEqual([]); expect(r.bodies).toHaveLength(1);
    const m = tessellate(oc, r.bodies[0], 'Corpo 1');
    expect(m.volume).toBeCloseTo(120000, 0);
    expect(m.faces).toHaveLength(6); expect(m.edges).toHaveLength(12);
    expect(m.indices.length / 3).toBeGreaterThanOrEqual(12);
    // Normais para fora: a face com normal +z fica em z = 20.
    const top = m.faces.find((f) => f.type === 'plane' && f.normal && f.normal[2] > 0.99)!;
    expect(top).toBeTruthy(); expect(top.center[2]).toBeCloseTo(20, 5);
    expect(m.bbox[0][2]).toBeCloseTo(0, 5); expect(m.bbox[1][2]).toBeCloseTo(20, 5);
  });

  it('corta um furo passante com throughAll', () => {
    const doc = createDocument(); const s = rectSketch(doc, 'plane-xy', 0, 0, 100, 60);
    const body = addExtrude(doc, s.id, 20);
    const hole = circleSketch(doc, 'plane-xy', 50, 30, 10);
    addExtrude(doc, hole.id, 5, { op: 'cut', target: body.id, throughAll: true });
    const r = rebuildDocument(oc, doc);
    expect(r.errors).toEqual([]); expect(r.bodies).toHaveLength(1);
    const m = tessellate(oc, r.bodies[0], 'Corpo 1');
    expect(m.volume).toBeCloseTo(120000 - Math.PI * 100 * 20, 0);
    expect(m.faces.some((f) => f.type === 'cylinder')).toBe(true);
  });

  it('extruda um oblongo (linhas + arcos) e corta um retângulo parcial', () => {
    const doc = createDocument(); const s = slotSketch(doc, 'plane-xy');
    const body = addExtrude(doc, s.id, 10);
    const r1 = rebuildDocument(oc, doc); expect(r1.errors).toEqual([]);
    const v1 = tessellate(oc, r1.bodies[0], 'c').volume;
    expect(v1).toBeCloseTo((40 * 20 + Math.PI * 100) * 10, 0);
    const cut = rectSketch(doc, 'plane-xy', 10, -5, 20, 10);
    addExtrude(doc, cut.id, 4, { op: 'cut', target: body.id, flip: true }); // corta 4 mm a partir de z=0 para baixo: não toca o corpo
    const r2 = rebuildDocument(oc, doc);
    expect(r2.errors).toEqual([]); expect(tessellate(oc, r2.bodies[0], 'c').volume).toBeCloseTo(v1, 0);
    doc.features.pop();
    addExtrude(doc, cut.id, 4, { op: 'cut', target: body.id }); // z de 0 a 4: remove 20×10×4
    const r3 = rebuildDocument(oc, doc); expect(r3.errors).toEqual([]);
    expect(tessellate(oc, r3.bodies[0], 'c').volume).toBeCloseTo(v1 - 800, 0);
  });

  it('aplica filete por referência de aresta e sobrevive a mudar a profundidade', () => {
    const doc = createDocument(); const s = rectSketch(doc, 'plane-xy', 0, 0, 100, 60);
    const body = addExtrude(doc, s.id, 20);
    const m0 = tessellate(oc, rebuildDocument(oc, doc).bodies[0], 'c');
    const vertical = m0.edges.filter((e) => Math.abs(e.mid[2] - 10) < 1e-6);
    expect(vertical).toHaveLength(4);
    addFillet(doc, 'fillet', body.id, vertical.map((e) => ({ mid: e.mid, len: e.len })), 5);
    const r = rebuildDocument(oc, doc); expect(r.errors).toEqual([]);
    const m = tessellate(oc, r.bodies[0], 'c');
    expect(m.volume).toBeCloseTo(120000 - 4 * (1 - Math.PI / 4) * 25 * 20, 0);
    expect(m.faces.filter((f) => f.type === 'cylinder')).toHaveLength(4);
    // Mudar a profundidade mexe no comprimento das arestas: a referência deixa de bater e o filete acusa erro, sem derrubar o corpo.
    (doc.features[0] as { depth: number }).depth = 30;
    const r2 = rebuildDocument(oc, doc);
    expect(r2.bodies).toHaveLength(1); expect(r2.errors).toHaveLength(1);
  });

  it('chanfro em todas as arestas do bloco', () => {
    const doc = createDocument(); const s = rectSketch(doc, 'plane-xy', 0, 0, 50, 50);
    const body = addExtrude(doc, s.id, 50);
    const m0 = tessellate(oc, rebuildDocument(oc, doc).bodies[0], 'c');
    addFillet(doc, 'chamfer', body.id, m0.edges.map((e) => ({ mid: e.mid, len: e.len })), 2);
    const r = rebuildDocument(oc, doc); expect(r.errors).toEqual([]);
    const m = tessellate(oc, r.bodies[0], 'c');
    // 12 arestas × (2·2/2) × 50 = 1200 mm³ a menos, com pequeno ajuste nos cantos.
    expect(m.volume).toBeLessThan(125000 - 1100); expect(m.volume).toBeGreaterThan(125000 - 1300);
    expect(m.faces.length).toBe(26); // 6 + 12 chanfros + 8 cantos
  });

  it('une dois corpos com booleana e consome a ferramenta', () => {
    const doc = createDocument();
    const a = addExtrude(doc, rectSketch(doc, 'plane-xy', 0, 0, 40, 40).id, 10);
    const b = addExtrude(doc, rectSketch(doc, 'plane-xy', 20, 20, 40, 40).id, 10);
    expect(rebuildDocument(oc, doc).bodies).toHaveLength(2);
    addBoolean(doc, 'union', a.id, b.id);
    const r = rebuildDocument(oc, doc); expect(r.errors).toEqual([]); expect(r.bodies).toHaveLength(1);
    expect(tessellate(oc, r.bodies[0], 'c').volume).toBeCloseTo((1600 + 1600 - 400) * 10, 0);
  });

  it('exporta STEP com os corpos', () => {
    const doc = createDocument(); addExtrude(doc, rectSketch(doc, 'plane-xy', 0, 0, 10, 10).id, 10);
    const r = rebuildDocument(oc, doc);
    const step = exportSTEP(oc, r.bodies);
    expect(step.startsWith('ISO-10303-21;')).toBe(true);
    expect(step).toContain('MANIFOLD_SOLID_BREP');
    expect(step.trim().endsWith('END-ISO-10303-21;')).toBe(true);
  });

  it('esboço sem contorno fechado vira erro de feature, não exceção', () => {
    const doc = createDocument(); const s = M.createSketch('plane-xy', 'aberto'); doc.sketches.push(s);
    const p1 = M.addPoint(s, 0, 0), p2 = M.addPoint(s, 10, 0); M.addLine(s, p1.id, p2.id);
    addExtrude(doc, s.id, 5);
    const r = rebuildDocument(oc, doc);
    expect(r.bodies).toHaveLength(0); expect(r.errors[0].message).toMatch(/contorno/);
  });
});
