import { describe, it, expect } from 'vitest';
import { createAssembly, addPart, addInstance, addJoint, computeTransforms, applyPoint, applyDir, fromFrame, invertRigid, mul, transformFrame, frameFromFace, bomRows, rotationAxis, type Frame } from './model';
import { createDocument } from '../document';
import type { FaceData } from '../kernel/occ/types';

const close = (a: number[], b: number[], tol = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < tol);

describe('montagem: transformações e juntas', () => {
  it('inversa rígida e quadro', () => {
    const f: Frame = { origin: [10, 20, 30], z: [0, 0, 1], x: [0, 1, 0] };
    const m = fromFrame(f); const inv = invertRigid(m);
    expect(close(mul(m, inv), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBe(true);
    expect(close(applyPoint(m, [0, 0, 0]), [10, 20, 30])).toBe(true);
    expect(close(applyDir(m, [1, 0, 0]), [0, 1, 0])).toBe(true); // x do quadro aponta para +y
  });

  it('junta rígida encaixa o quadro móvel no quadro base', () => {
    const asm = createAssembly(); const p = addPart(asm, createDocument('Bloco'));
    const a = addInstance(asm, p.id), b = addInstance(asm, p.id, [500, 0, 0]);
    const baseFrame: Frame = { origin: [100, 30, 10], z: [1, 0, 0], x: [0, 1, 0] };   // face direita de A
    const movingFrame: Frame = { origin: [0, 30, 10], z: [-1, 0, 0], x: [0, 1, 0] }; // face esquerda de B
    addJoint(asm, 'fixed', b.id, movingFrame, a.id, baseFrame, true); // flip: normais opostas
    const T = computeTransforms(asm);
    expect(close(T.get(a.id)!, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBe(true);
    const fm = transformFrame(T.get(b.id)!, movingFrame);
    expect(close(fm.origin, baseFrame.origin)).toBe(true);
    expect(close(fm.z, [-1, 0, 0])).toBe(true); // Z móvel oposto ao Z base (flip)
    // B fica encostado em A: seu canto (0,0,0) vai para x=100.
    expect(close(applyPoint(T.get(b.id)!, [0, 0, 0]), [100, 0, 0])).toBe(true);
  });

  it('pino gira em torno do eixo da junta e a árvore propaga', () => {
    const asm = createAssembly(); const p = addPart(asm, createDocument('Peça'));
    const base = addInstance(asm, p.id), arm = addInstance(asm, p.id), tip = addInstance(asm, p.id);
    const pin: Frame = { origin: [50, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };
    const hole: Frame = { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };
    const j = addJoint(asm, 'revolute', arm.id, hole, base.id, pin);
    addJoint(asm, 'fixed', tip.id, { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] }, arm.id, { origin: [100, 0, 0], z: [0, 0, 1], x: [1, 0, 0] });
    let T = computeTransforms(asm);
    expect(close(applyPoint(T.get(arm.id)!, [100, 0, 0]), [150, 0, 0])).toBe(true);
    expect(close(applyPoint(T.get(tip.id)!, [0, 0, 0]), [150, 0, 0])).toBe(true);
    j.angle = 90; T = computeTransforms(asm);
    expect(close(applyPoint(T.get(arm.id)!, [100, 0, 0]), [50, 100, 0])).toBe(true);
    expect(close(applyPoint(T.get(tip.id)!, [0, 0, 0]), [50, 100, 0])).toBe(true); // a ponta acompanha o braço
  });

  it('deslizante translada no eixo e recusa ciclos', () => {
    const asm = createAssembly(); const p = addPart(asm, createDocument('Peça'));
    const a = addInstance(asm, p.id), b = addInstance(asm, p.id);
    const fr: Frame = { origin: [0, 0, 0], z: [0, 1, 0], x: [1, 0, 0] };
    const j = addJoint(asm, 'slider', b.id, fr, a.id, fr); j.distance = 25;
    expect(close(applyPoint(computeTransforms(asm).get(b.id)!, [0, 0, 0]), [0, 25, 0])).toBe(true);
    expect(() => addJoint(asm, 'fixed', a.id, fr, b.id, fr)).toThrow(/ciclo/);
    expect(() => addJoint(asm, 'fixed', b.id, fr, a.id, fr)).toThrow(/já é a parte móvel/);
  });

  it('quadro de face plana e de cilindro', () => {
    const plane: FaceData = { index: 0, type: 'plane', area: 1, triStart: 0, triCount: 0, center: [5, 5, 10.001], origin: [0, 0, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] };
    const f = frameFromFace(plane)!; expect(close(f.origin, [5, 5, 10])).toBe(true); expect(close(f.z, [0, 0, 1])).toBe(true);
    const cyl: FaceData = { index: 1, type: 'cylinder', area: 1, triStart: 0, triCount: 0, center: [10, 7, 15], axisOrigin: [10, 7, 0], axisDir: [0, 0, 1], radius: 5 };
    const g = frameFromFace(cyl)!; expect(close(g.origin, [10, 7, 15])).toBe(true); expect(Math.abs(g.x[2])).toBeLessThan(1e-9);
    expect(frameFromFace({ ...cyl, type: 'torus' })).toBeNull();
    expect(close(applyDir(rotationAxis([0, 0, 1], 90), [1, 0, 0]), [0, 1, 0])).toBe(true);
  });

  it('lista de materiais agrupa por peça', () => {
    const asm = createAssembly(); const p1 = addPart(asm, createDocument('Base')); const p2 = addPart(asm, createDocument('Pino'));
    p2.doc.drawing = { ...(p2.doc.drawing ?? { sheet: 'A4', projection: 'first', scale: 'auto', front: true, top: true, side: true, iso: true, hidden: true, tangent: false, dimensions: true, title: '', number: '', material: '', author: '', company: '' }), material: 'SAE 1045' };
    addInstance(asm, p1.id); addInstance(asm, p2.id); addInstance(asm, p2.id);
    const rows = bomRows(asm);
    expect(rows.map((r) => [r.item, r.name, r.qty, r.material])).toEqual([[1, 'Base', 1, ''], [2, 'Pino', 2, 'SAE 1045']]);
  });
});
