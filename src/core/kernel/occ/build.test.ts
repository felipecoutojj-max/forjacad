// Testa o kernel com o OpenCASCADE real em Node (carga ~3 s).
import { describe, it, expect, beforeAll } from 'vitest';
import initOpenCascade from 'opencascade.js/dist/node.js';
import type { OpenCascadeInstance } from 'opencascade.js';
import { rebuildDocument, tessellate, exportSTEP, projectViews, assemblyShapes, interferences } from './build';
import { createDocument, addExtrude, addRevolve, addFillet, addBoolean, addPushPull, type ForjaDocument } from '../../document';
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

  it('revoluciona um retângulo em tubo (360°) e em quarto de tubo (90°)', () => {
    const doc = createDocument(); const s = rectSketch(doc, 'plane-xy', 10, 0, 10, 30); // u 10..20, v 0..30
    const f = addRevolve(doc, s.id, { p: [0, 0], d: [0, 1] }, 360);
    const r = rebuildDocument(oc, doc); expect(r.errors).toEqual([]); expect(r.bodies).toHaveLength(1);
    const m = tessellate(oc, r.bodies[0], 'c');
    expect(m.volume).toBeCloseTo(Math.PI * (400 - 100) * 30, 0);
    expect(m.faces.filter((x) => x.type === 'cylinder')).toHaveLength(2);
    f.angle = 90;
    const m2 = tessellate(oc, rebuildDocument(oc, doc).bodies[0], 'c');
    expect(m2.volume).toBeCloseTo((Math.PI * 300 * 30) / 4, 0);
    expect(m2.faces.filter((x) => x.type === 'plane')).toHaveLength(4);
  });

  it('revolução usa uma linha de construção como eixo e recusa perfil que cruza o eixo', () => {
    const doc = createDocument(); const s = rectSketch(doc, 'plane-xy', 10, 0, 10, 30);
    const a = M.addPoint(s, 5, -10), b = M.addPoint(s, 5, 50); const axisLine = M.addLine(s, a.id, b.id); axisLine.construction = true;
    addRevolve(doc, s.id, { line: axisLine.id, p: [0, 0], d: [0, 1] }, 360);
    const r = rebuildDocument(oc, doc); expect(r.errors).toEqual([]);
    // Raios em relação a u=5: interno 5, externo 15.
    expect(tessellate(oc, r.bodies[0], 'c').volume).toBeCloseTo(Math.PI * (225 - 25) * 30, 0);
    // Eixo passando pelo meio do perfil: erro de feature.
    M.getPoint(s, a.id).x = 15; M.getPoint(s, b.id).x = 15;
    const r2 = rebuildDocument(oc, doc); expect(r2.bodies).toHaveLength(0); expect(r2.errors[0].message).toMatch(/cruza o eixo/);
  });

  it('revolução em corte tira um quarto de cilindro do canto do bloco', () => {
    const doc = createDocument(); const body = addExtrude(doc, rectSketch(doc, 'plane-xy', 0, 0, 100, 60).id, 20);
    const prof = rectSketch(doc, 'plane-xy', 0, 0, 5, 20); // u 0..5, v 0..20 girando em torno de u=0 (eixo y do mundo)
    addRevolve(doc, prof.id, { p: [0, 0], d: [0, 1] }, 360, { op: 'cut', target: body.id });
    const r = rebuildDocument(oc, doc); expect(r.errors).toEqual([]); expect(r.bodies).toHaveLength(1);
    expect(tessellate(oc, r.bodies[0], 'c').volume).toBeCloseTo(120000 - (Math.PI * 25 * 20) / 4, 0);
  });

  it('projeta frente, topo e lateral esquerda com linhas ocultas do furo', () => {
    const doc = createDocument(); const body = addExtrude(doc, rectSketch(doc, 'plane-xy', 0, 0, 100, 60).id, 20);
    addExtrude(doc, circleSketch(doc, 'plane-xy', 50, 30, 10).id, 5, { op: 'cut', target: body.id, throughAll: true });
    const r = rebuildDocument(oc, doc); expect(r.errors).toEqual([]);
    const [front, top, left] = projectViews(oc, r.bodies.map((b) => b.shape), [
      { name: 'front', n: [0, 0, 1], up: [0, 1, 0] }, { name: 'top', n: [0, 1, 0], up: [0, 0, -1] }, { name: 'left', n: [-1, 0, 0], up: [0, 1, 0] },
    ]);
    // Frente: contorno 100×60, furo visível como círculo, nada oculto.
    expect(front.bbox[2] - front.bbox[0]).toBeCloseTo(100, 3); expect(front.bbox[3] - front.bbox[1]).toBeCloseTo(60, 3);
    expect(front.visible.length).toBeGreaterThanOrEqual(5); expect(front.hidden).toHaveLength(0);
    expect(front.circles).toHaveLength(1); expect(front.circles[0].r).toBeCloseTo(10, 3); expect(front.circles[0].cx).toBeCloseTo(50, 3); expect(front.circles[0].cy).toBeCloseTo(30, 3);
    // Topo: 100×20, furo vira duas linhas ocultas.
    expect(top.bbox[2] - top.bbox[0]).toBeCloseTo(100, 3); expect(top.bbox[3] - top.bbox[1]).toBeCloseTo(20, 3);
    expect(top.hidden.length).toBeGreaterThanOrEqual(2); expect(top.circles).toHaveLength(0);
    // Lateral esquerda: 20×60, o lado da frente (+z) fica à direita (X = z).
    expect(left.bbox[2] - left.bbox[0]).toBeCloseTo(20, 3); expect(left.bbox[3] - left.bbox[1]).toBeCloseTo(60, 3);
    expect(left.bbox[0]).toBeCloseTo(0, 3); expect(left.hidden.length).toBeGreaterThanOrEqual(2);
  });

  it('face cilíndrica traz eixo e raio; montagem com duas instâncias projeta o dobro da largura', () => {
    const doc = createDocument(); const body = addExtrude(doc, rectSketch(doc, 'plane-xy', 0, 0, 100, 60).id, 20);
    addExtrude(doc, circleSketch(doc, 'plane-xy', 50, 30, 10).id, 5, { op: 'cut', target: body.id, throughAll: true });
    const m = tessellate(oc, rebuildDocument(oc, doc).bodies[0], 'c');
    const cyl = m.faces.find((f) => f.type === 'cylinder')!;
    expect(cyl.radius).toBeCloseTo(10, 5); expect(Math.abs(cyl.axisDir![2])).toBeCloseTo(1, 6); expect(cyl.axisOrigin![0]).toBeCloseTo(50, 5); expect(cyl.axisOrigin![1]).toBeCloseTo(30, 5);
    const cache = new Map();
    const shapes = assemblyShapes(oc, [{ id: 'p', doc }], [{ part: 'p', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, { part: 'p', matrix: [1, 0, 0, 120, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }], cache);
    expect(shapes).toHaveLength(2); expect(cache.size).toBe(1);
    const [front] = projectViews(oc, shapes, [{ name: 'front', n: [0, 0, 1], up: [0, 1, 0] }]);
    expect(front.bbox[2] - front.bbox[0]).toBeCloseTo(220, 3); expect(front.circles).toHaveLength(2);
    expect(exportSTEP(oc, shapes.map((shape, i) => ({ id: String(i), shape }))).length).toBeGreaterThan(1000);
  });

  it('interferência: blocos separados não acusam, sobrepostos acusam o volume comum', () => {
    const doc = createDocument(); addExtrude(doc, rectSketch(doc, 'plane-xy', 0, 0, 50, 50).id, 50);
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; const shift = (x: number) => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const cache = new Map();
    const hits = interferences(oc, [{ id: 'p', doc }], [
      [{ part: 'p', matrix: I }, { part: 'p', matrix: shift(60) }],   // passo 0: afastados
      [{ part: 'p', matrix: I }, { part: 'p', matrix: shift(50) }],   // passo 1: encostados (volume 0)
      [{ part: 'p', matrix: I }, { part: 'p', matrix: shift(40) }],   // passo 2: 10 mm dentro
    ], cache);
    expect(hits).toHaveLength(1); expect(hits[0]).toMatchObject({ step: 2, a: 0, b: 1 }); expect(hits[0].volume).toBeCloseTo(10 * 50 * 50, 0);
  });

  it('extrusão por região: só o perfil que contém o ponto', () => {
    const doc = createDocument(); const s = rectSketch(doc, 'plane-xy', 0, 0, 30, 30);
    const p1 = M.addPoint(s, 50, 0), p2 = M.addPoint(s, 70, 0), p3 = M.addPoint(s, 70, 20), p4 = M.addPoint(s, 50, 20);
    M.addLine(s, p1.id, p2.id); M.addLine(s, p2.id, p3.id); M.addLine(s, p3.id, p4.id); M.addLine(s, p4.id, p1.id);
    const f = addExtrude(doc, s.id, 10); f.profilePoint = [60, 10];
    const r = rebuildDocument(oc, doc); expect(r.errors).toEqual([]);
    expect(tessellate(oc, r.bodies[0], 'c').volume).toBeCloseTo(20 * 20 * 10, 0);
    f.profilePoint = [15, 15]; expect(tessellate(oc, rebuildDocument(oc, doc).bodies[0], 'c').volume).toBeCloseTo(30 * 30 * 10, 0);
    f.profilePoint = [40, 40]; expect(rebuildDocument(oc, doc).errors[0].message).toMatch(/região/);
  });

  it('puxar e empurrar face plana', () => {
    const doc = createDocument(); const body = addExtrude(doc, rectSketch(doc, 'plane-xy', 0, 0, 100, 60).id, 20);
    const top = { center: [50, 30, 20] as [number, number, number], normal: [0, 0, 1] as [number, number, number], area: 6000 };
    const pull = addPushPull(doc, body.id, top, 10);
    let r = rebuildDocument(oc, doc); expect(r.errors).toEqual([]);
    expect(tessellate(oc, r.bodies[0], 'c').volume).toBeCloseTo(100 * 60 * 30, 0);
    pull.distance = -5;
    r = rebuildDocument(oc, doc); expect(r.errors).toEqual([]);
    expect(tessellate(oc, r.bodies[0], 'c').volume).toBeCloseTo(100 * 60 * 15, 0);
    // Face que não existe: erro de feature, corpo preservado.
    pull.face = { center: [50, 30, 99], normal: [0, 0, 1], area: 6000 };
    r = rebuildDocument(oc, doc); expect(r.errors).toHaveLength(1); expect(r.bodies).toHaveLength(1);
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
