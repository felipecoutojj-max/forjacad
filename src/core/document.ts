// Documento ForjaCAD: planos, esboços e features (por enquanto só extrusão).
// Serializa para JSON legível (.forja). Guarda geometria + restrições, nunca só o resultado.

import { type Sketch, type Id, newId } from './sketch/model';

export const FORJA_VERSION = 1;

/** Plano de trabalho: origem + eixos u, v no espaço 3D (mm). normal = u × v. */
export interface Plane { id: Id; name: string; origin: [number, number, number]; u: [number, number, number]; v: [number, number, number]; }

export interface ExtrudeFeature {
  id: Id; type: 'extrude'; name: string; sketch: Id;
  /** Profundidade em mm. Positiva segue a normal do plano. */
  depth: number;
  /** 'add' cria um corpo novo. 'cut' fica reservado para quando houver kernel de booleanas. */
  op: 'add';
  /** Simétrico em relação ao plano. */
  symmetric?: boolean;
  color?: string;
  visible?: boolean;
}
export type Feature = ExtrudeFeature;

export interface ForjaDocument {
  format: 'forja'; version: number; name: string; units: 'mm';
  createdAt: string; modifiedAt: string;
  planes: Plane[]; sketches: Sketch[]; features: Feature[];
}

export const BASE_PLANES: Plane[] = [
  { id: 'plane-xy', name: 'Frente (XY)', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] },
  { id: 'plane-xz', name: 'Topo (XZ)', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { id: 'plane-yz', name: 'Lateral (YZ)', origin: [0, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
];

export function createDocument(name = 'Peça sem nome'): ForjaDocument {
  const now = new Date().toISOString();
  return { format: 'forja', version: FORJA_VERSION, name, units: 'mm', createdAt: now, modifiedAt: now, planes: BASE_PLANES.map((p) => ({ ...p })), sketches: [], features: [] };
}

export function serialize(doc: ForjaDocument): string {
  doc.modifiedAt = new Date().toISOString();
  return JSON.stringify(doc, null, 2);
}

export function deserialize(text: string): ForjaDocument {
  const d = JSON.parse(text);
  if (d?.format !== 'forja') throw new Error('Arquivo não é um documento ForjaCAD.');
  if (typeof d.version !== 'number' || d.version > FORJA_VERSION) throw new Error(`Versão de arquivo ${d.version} não suportada por este ForjaCAD.`);
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v.slice(0, 200) : fallback);
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const doc: ForjaDocument = { ...createDocument(str(d.name, 'Peça')), ...d, name: str(d.name, 'Peça') };
  if (!Array.isArray(doc.planes)) doc.planes = []; if (!Array.isArray(doc.sketches)) doc.sketches = []; if (!Array.isArray(doc.features)) doc.features = [];
  doc.planes = doc.planes.filter((p) => p && Array.isArray(p.origin) && Array.isArray(p.u) && Array.isArray(p.v)).map((p) => ({ ...p, name: str(p.name, 'Plano') }));
  doc.sketches = doc.sketches.filter((s) => s && typeof s.id === 'string').map((s) => ({ ...s, name: str(s.name, 'Esboço'), points: Array.isArray(s.points) ? s.points : [], entities: Array.isArray(s.entities) ? s.entities : [], constraints: Array.isArray(s.constraints) ? s.constraints : [], dimensions: Array.isArray(s.dimensions) ? s.dimensions : [] }));
  doc.features = doc.features.filter((f) => f && f.type === 'extrude' && typeof f.sketch === 'string').map((f) => ({ ...f, name: str(f.name, 'Extrusão'), depth: num(f.depth, 10) || 10 }));
  // Planos base sempre existem, mesmo que o arquivo venha sem eles.
  for (const bp of BASE_PLANES) if (!doc.planes.some((p) => p.id === bp.id)) doc.planes.push({ ...bp });
  return doc;
}

export function cloneDocument(doc: ForjaDocument): ForjaDocument { return JSON.parse(JSON.stringify(doc)); }

export function getPlane(doc: ForjaDocument, id: Id): Plane {
  const p = doc.planes.find((q) => q.id === id); if (!p) throw new Error(`Plano inexistente: ${id}`); return p;
}
export function getSketch(doc: ForjaDocument, id: Id): Sketch {
  const s = doc.sketches.find((q) => q.id === id); if (!s) throw new Error(`Esboço inexistente: ${id}`); return s;
}

export function addExtrude(doc: ForjaDocument, sketch: Id, depth: number, symmetric = false): ExtrudeFeature {
  const n = doc.features.filter((f) => f.type === 'extrude').length + 1;
  const f: ExtrudeFeature = { id: newId('f'), type: 'extrude', name: `Extrusão ${n}`, sketch, depth, op: 'add', symmetric, visible: true };
  doc.features.push(f); return f;
}

export function planeNormal(p: Plane): [number, number, number] {
  const [ux, uy, uz] = p.u, [vx, vy, vz] = p.v;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Ponto do plano (u,v) → espaço 3D. */
export function planeToWorld(p: Plane, u: number, v: number, w = 0): [number, number, number] {
  const n = planeNormal(p);
  return [p.origin[0] + p.u[0] * u + p.v[0] * v + n[0] * w, p.origin[1] + p.u[1] * u + p.v[1] * v + n[1] * w, p.origin[2] + p.u[2] * u + p.v[2] * v + n[2] * w];
}
