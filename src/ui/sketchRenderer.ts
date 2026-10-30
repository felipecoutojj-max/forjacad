// Desenha um esboço no espaço 3D (sobre o seu plano) e devolve os rótulos a posicionar em HTML.

import * as THREE from 'three';
import type { Sketch, Entity, Id } from '../core/sketch/model';
import { getPoint, arcAngles, findEntity, findPoint } from '../core/sketch/model';
import type { Plane } from '../core/document';
import { planeToWorld } from '../core/document';
import { normAngle, TAU, type Vec2, dist, v2, sub, norm, perp, add, scale } from '../core/geom';

export interface Selection { points: Set<Id>; entities: Set<Id>; dimensions: Set<Id>; }
export const emptySelection = (): Selection => ({ points: new Set(), entities: new Set(), dimensions: new Set() });

export interface LabelDesc { id: Id; kind: 'dimension' | 'tag'; u: number; v: number; text: string; selected?: boolean; }

const C_LINE = new THREE.Color(0xe6e9ef), C_SEL = new THREE.Color(0x4aa3ff), C_CONSTR = new THREE.Color(0x6f7a8c), C_POINT = new THREE.Color(0xf28c28), C_DIM = new THREE.Color(0x9aa4b5), C_STROKE = new THREE.Color(0xffb15c), C_INACTIVE = new THREE.Color(0x7d8aa3);

export class SketchRenderer {
  readonly group = new THREE.Group();
  private lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
  private dims = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: C_DIM, transparent: true, opacity: 0.9 }));
  private points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true }));
  private stroke = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: C_STROKE }));
  labels: LabelDesc[] = [];

  constructor() { this.group.add(this.lines, this.dims, this.points, this.stroke); this.group.renderOrder = 10; }

  /** Pontos 3D de uma entidade (polilinha), em coordenadas do plano. */
  static sample(s: Sketch, e: Entity, segs = 48): Vec2[] {
    if (e.type === 'line') { const a = getPoint(s, e.a), b = getPoint(s, e.b); return [v2(a.x, a.y), v2(b.x, b.y)]; }
    const c = getPoint(s, e.center); const out: Vec2[] = [];
    if (e.type === 'circle') { for (let i = 0; i <= segs; i++) { const t = (i / segs) * TAU; out.push(v2(c.x + e.r * Math.cos(t), c.y + e.r * Math.sin(t))); } return out; }
    const { start, end } = arcAngles(s, e); let sweep = normAngle(end - start); if (sweep === 0) sweep = TAU;
    const n = Math.max(6, Math.ceil((sweep / TAU) * segs));
    for (let i = 0; i <= n; i++) { const t = start + (sweep * i) / n; out.push(v2(c.x + e.r * Math.cos(t), c.y + e.r * Math.sin(t))); }
    return out;
  }

  update(s: Sketch, plane: Plane, sel: Selection, active: boolean, mmPerPx: number): void {
    // O esboço ativo fica sempre visível, mesmo sobre a face de um corpo (sem teste de profundidade).
    for (const o of [this.lines, this.dims, this.points, this.stroke]) { const m = o.material as THREE.Material; if (m.depthTest !== !active) { m.depthTest = !active; m.needsUpdate = true; } }
    const pos: number[] = []; const col: number[] = [];
    const push = (a: Vec2, b: Vec2, c: THREE.Color) => { pos.push(...planeToWorld(plane, a.x, a.y, 0.05), ...planeToWorld(plane, b.x, b.y, 0.05)); col.push(c.r, c.g, c.b, c.r, c.g, c.b); };
    for (const e of s.entities) {
      const color = sel.entities.has(e.id) ? C_SEL : e.construction ? C_CONSTR : active ? C_LINE : C_INACTIVE;
      const pts = SketchRenderer.sample(s, e);
      for (let i = 1; i < pts.length; i++) push(pts[i - 1], pts[i], color);
    }
    this.setLines(this.lines.geometry, pos, col);

    // Pontos (só no esboço ativo).
    const ppos: number[] = []; const pcol: number[] = [];
    if (active) for (const p of s.points) { ppos.push(...planeToWorld(plane, p.x, p.y, 0.1)); const c = sel.points.has(p.id) ? C_SEL : p.fixed || s.constraints.some((k) => k.kind === 'fixed' && k.refs[0] === p.id) ? C_CONSTR : C_POINT; pcol.push(c.r, c.g, c.b); }
    this.points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(ppos, 3));
    this.points.geometry.setAttribute('color', new THREE.Float32BufferAttribute(pcol, 3));
    this.points.geometry.computeBoundingSphere();

    // Cotas.
    this.labels = [];
    const dpos: number[] = [];
    const dline = (a: Vec2, b: Vec2) => { dpos.push(...planeToWorld(plane, a.x, a.y, 0.08), ...planeToWorld(plane, b.x, b.y, 0.08)); };
    if (active) {
      const arrow = mmPerPx * 7;
      for (const d of s.dimensions) {
        const txt = fmtDim(d.kind, d.value);
        const selected = sel.dimensions.has(d.id);
        if (d.kind === 'radius' || d.kind === 'diameter') {
          const e = findEntity(s, d.refs[0]); if (!e || e.type === 'line') continue;
          const c = getPoint(s, e.center); const dirv = norm(d.offset.x || d.offset.y ? d.offset : v2(1, 1));
          const on = add(v2(c.x, c.y), scale(dirv, e.r)); const out = add(on, scale(dirv, Math.max(arrow * 2, 6)));
          if (d.kind === 'diameter') dline(add(v2(c.x, c.y), scale(dirv, -e.r)), out); else dline(v2(c.x, c.y), out);
          this.labels.push({ id: d.id, kind: 'dimension', u: out.x, v: out.y, text: txt, selected });
        } else if (d.kind === 'angle') {
          const l1 = findEntity(s, d.refs[0]), l2 = findEntity(s, d.refs[1]); if (!l1 || !l2 || l1.type !== 'line' || l2.type !== 'line') continue;
          const a1 = getPoint(s, l1.a), b1 = getPoint(s, l1.b), a2 = getPoint(s, l2.a), b2 = getPoint(s, l2.b);
          const m1 = v2((a1.x + b1.x) / 2, (a1.y + b1.y) / 2), m2 = v2((a2.x + b2.x) / 2, (a2.y + b2.y) / 2);
          const mid = add(v2((m1.x + m2.x) / 2, (m1.y + m2.y) / 2), d.offset);
          dline(m1, mid); dline(m2, mid);
          this.labels.push({ id: d.id, kind: 'dimension', u: mid.x, v: mid.y, text: txt, selected });
        } else {
          const [pa, pb] = dimEndpoints(s, d); if (!pa || !pb) continue;
          let a = v2(pa.x, pa.y), b = v2(pb.x, pb.y);
          if (d.kind === 'hdistance') { b = v2(b.x, a.y + 0); }
          if (d.kind === 'vdistance') { b = v2(a.x, b.y); }
          const dir = d.kind === 'hdistance' ? v2(1, 0) : d.kind === 'vdistance' ? v2(0, 1) : norm(sub(b, a));
          const nrm = perp(dir);
          const off = d.offset.x * nrm.x + d.offset.y * nrm.y || 8;
          const a2 = add(a, scale(nrm, off)), b2 = add(b, scale(nrm, off));
          const pa2 = d.kind === 'hdistance' ? v2(pa.x, pa.y) : d.kind === 'vdistance' ? v2(pa.x, pa.y) : a;
          const pb2 = d.kind === 'hdistance' ? v2(pb.x, pb.y) : d.kind === 'vdistance' ? v2(pb.x, pb.y) : b;
          // linhas de chamada e linha de cota
          dline(pa2, add(a2, scale(nrm, Math.sign(off) * arrow * 0.6)));
          dline(pb2, add(b2, scale(nrm, Math.sign(off) * arrow * 0.6)));
          if (d.kind === 'hdistance') { const a3 = v2(pa.x, a2.y), b3 = v2(pb.x, a2.y); dline(a3, b3); this.labels.push({ id: d.id, kind: 'dimension', u: (a3.x + b3.x) / 2, v: a3.y, text: txt, selected }); }
          else if (d.kind === 'vdistance') { const a3 = v2(a2.x, pa.y), b3 = v2(a2.x, pb.y); dline(a3, b3); this.labels.push({ id: d.id, kind: 'dimension', u: a3.x, v: (a3.y + b3.y) / 2, text: txt, selected }); }
          else { dline(a2, b2); this.labels.push({ id: d.id, kind: 'dimension', u: (a2.x + b2.x) / 2, v: (a2.y + b2.y) / 2, text: txt, selected }); }
        }
      }
      // Etiquetas de restrição.
      const glyph: Record<string, string> = { horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⟂', equal: '=', tangent: '⌒', concentric: '◎', pointOnLine: '•', pointOnCircle: '•', midpoint: '½', fixed: '⚓' };
      const offsets = new Map<string, number>();
      for (const k of s.constraints) {
        const g = glyph[k.kind]; if (!g) continue;
        const anchor = constraintAnchor(s, k.refs, k.kind); if (!anchor) continue;
        const key = `${Math.round(anchor.x)}|${Math.round(anchor.y)}`; const n = offsets.get(key) ?? 0; offsets.set(key, n + 1);
        this.labels.push({ id: k.id, kind: 'tag', u: anchor.x + n * mmPerPx * 14, v: anchor.y + mmPerPx * 10, text: g });
      }
    }
    this.dims.geometry.setAttribute('position', new THREE.Float32BufferAttribute(dpos, 3)); this.dims.geometry.computeBoundingSphere();
    this.dims.visible = dpos.length > 0;
  }

  setStroke(plane: Plane | null, pts: Vec2[]): void {
    if (!plane || pts.length < 2) { this.stroke.visible = false; return; }
    const pos: number[] = []; for (const p of pts) pos.push(...planeToWorld(plane, p.x, p.y, 0.2));
    this.stroke.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); this.stroke.geometry.computeBoundingSphere(); this.stroke.visible = true;
  }

  private setLines(geo: THREE.BufferGeometry, pos: number[], col: number[]): void {
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeBoundingSphere();
  }
}

export function dimEndpoints(s: Sketch, d: { kind: string; refs: Id[] }): [Vec2 | null, Vec2 | null] {
  if (d.refs.length === 1) { const l = findEntity(s, d.refs[0]); if (l && l.type === 'line') return [getPoint(s, l.a), getPoint(s, l.b)]; return [null, null]; }
  const p0 = findPoint(s, d.refs[0]); const second = findPoint(s, d.refs[1]) ?? findEntity(s, d.refs[1]);
  if (!p0 || !second) return [null, null];
  if ('type' in second) { // ponto a linha: pé da perpendicular
    if (second.type !== 'line') return [null, null];
    const a = getPoint(s, second.a), b = getPoint(s, second.b); const ab = sub(b, a); const l2 = ab.x * ab.x + ab.y * ab.y || 1;
    const t = ((p0.x - a.x) * ab.x + (p0.y - a.y) * ab.y) / l2; return [p0, add(a, scale(ab, t))];
  }
  return [p0, second];
}

function constraintAnchor(s: Sketch, refs: Id[], kind: string): Vec2 | null {
  const r0 = refs[0];
  const e = findEntity(s, r0); const p = findPoint(s, r0);
  if (kind === 'pointOnLine' || kind === 'pointOnCircle' || kind === 'midpoint' || kind === 'fixed') { if (p) return v2(p.x, p.y); }
  const midOf = (ent: Entity): Vec2 => {
    if (ent.type === 'line') { const a = getPoint(s, ent.a), b = getPoint(s, ent.b); return v2((a.x + b.x) / 2, (a.y + b.y) / 2); }
    const pts = SketchRenderer.sample(s, ent, 16); return pts[Math.floor(pts.length / 2)];
  };
  if (e) {
    const m = midOf(e);
    if (refs.length > 1) { const e2 = findEntity(s, refs[1]); if (e2 && (kind === 'concentric' || kind === 'tangent')) { const m2 = midOf(e2); return v2((m.x + m2.x) / 2, (m.y + m2.y) / 2); } }
    return m;
  }
  if (p) return v2(p.x, p.y);
  return null;
}

export function fmtDim(kind: string, v: number): string {
  const n = Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2);
  const t = n.replace(/\.?0+$/, '').replace('.', ',');
  if (kind === 'angle') return `${t}°`;
  if (kind === 'radius') return `R${t}`;
  if (kind === 'diameter') return `⌀${t}`;
  return t;
}

export { dist };
