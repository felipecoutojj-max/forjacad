// Kernel de prévia: transforma esboços fechados em sólidos extrudados usando malhas do three.js.
// Não é um kernel B-rep. Serve enquanto o OpenCASCADE carrega (ou se ele falhar) e para testes rápidos.
// Só desenha features "novo corpo": cortes, uniões e filetes aparecem quando o kernel real responde.

import * as THREE from 'three';
import type { Sketch } from '../sketch/model';
import { getPoint } from '../sketch/model';
import type { Plane, ExtrudeFeature, ForjaDocument } from '../document';
import { planeNormal, getPlane, getSketch } from '../document';
import { TAU } from '../geom';
import { extractProfiles, loopArcAngles, profileContainsPoint, type Loop, type Profile } from './profiles';

export { extractProfiles, signedArea, profileContainsPoint, profileInnerPoint, type Loop, type LoopEdge, type Profile } from './profiles';

/** Converte um laço em THREE.Shape ou THREE.Path (coordenadas do plano). */
function loopToPath<T extends THREE.Path>(s: Sketch, loop: Loop, target: T): T {
  if (loop.kind === 'circle') {
    const e = loop.entity; if (e.type !== 'circle') return target; const c = getPoint(s, e.center);
    target.absarc(c.x, c.y, e.r, 0, TAU, false); return target;
  }
  const first = getPoint(s, loop.edges[0].from); target.moveTo(first.x, first.y);
  for (const ed of loop.edges) {
    const to = getPoint(s, ed.to);
    if (ed.entity.type === 'line') target.lineTo(to.x, to.y);
    else if (ed.entity.type === 'arc') {
      const a = ed.entity; const c = getPoint(s, a.center); const { a0, a1, sweep } = loopArcAngles(s, ed);
      target.absarc(c.x, c.y, a.r, a0, a1, sweep < 0);
    }
  }
  target.closePath(); return target;
}

export function profileToShape(s: Sketch, prof: Profile): THREE.Shape {
  const shape = loopToPath(s, prof.outer, new THREE.Shape());
  for (const h of prof.holes) shape.holes.push(loopToPath(s, h, new THREE.Path()));
  return shape;
}

/** Matriz que leva coordenadas do plano (u, v, normal) para o mundo. */
export function planeMatrix(p: Plane): THREE.Matrix4 {
  const n = planeNormal(p);
  const m = new THREE.Matrix4();
  m.makeBasis(new THREE.Vector3(...p.u), new THREE.Vector3(...p.v), new THREE.Vector3(...n));
  m.setPosition(new THREE.Vector3(...p.origin));
  return m;
}

export interface BodyMesh { feature: ExtrudeFeature; geometry: THREE.BufferGeometry; }

/** Gera a malha de uma extrusão. Retorna null se o esboço não tem perfil fechado. */
export function buildExtrude(doc: ForjaDocument, f: ExtrudeFeature): THREE.BufferGeometry | null {
  const sk = getSketch(doc, f.sketch); const plane = getPlane(doc, sk.plane);
  let profiles = extractProfiles(sk);
  if (f.profilePoint) { const pt = { x: f.profilePoint[0], y: f.profilePoint[1] }; profiles = profiles.filter((p) => profileContainsPoint(sk, p, pt)); }
  if (!profiles.length) return null;
  const shapes = profiles.map((p) => profileToShape(sk, p));
  const depth = Math.abs(f.depth) || 1;
  const geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments: 24, steps: 1 });
  const m = planeMatrix(plane);
  const negative = (f.depth < 0) !== !!f.flip;
  const shift = new THREE.Matrix4().makeTranslation(0, 0, f.symmetric ? -depth / 2 : negative ? -depth : 0);
  geo.applyMatrix4(m.multiply(shift));
  geo.computeVertexNormals();
  return geo;
}

export function buildAllBodies(doc: ForjaDocument): BodyMesh[] {
  const out: BodyMesh[] = [];
  for (const f of doc.features) {
    if (f.type !== 'extrude' || f.visible === false || f.op === 'cut') continue;
    try { const g = buildExtrude(doc, f); if (g) out.push({ feature: f, geometry: g }); } catch (err) { console.warn('Extrusão falhou', f.id, err); }
  }
  return out;
}
