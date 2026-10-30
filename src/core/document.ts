// Documento ForjaCAD: planos, esboços e features em ordem.
// Serializa para JSON legível (.forja). Guarda geometria + restrições + features, nunca a malha.

import { type Sketch, type Id, newId } from './sketch/model';

export const FORJA_VERSION = 2;

export type V3 = [number, number, number];

/** Plano de trabalho: origem + eixos u, v no espaço 3D (mm). normal = u × v. */
export interface Plane {
  id: Id; name: string; origin: V3; u: V3; v: V3;
  /** 'base' são os três planos fixos; 'face' nasce de uma face plana de um corpo. */
  kind?: 'base' | 'face';
  /** Corpo de onde a face veio (só para kind 'face'). */
  body?: Id;
}

export type ExtrudeOp = 'new' | 'add' | 'cut';

export interface ExtrudeFeature {
  id: Id; type: 'extrude'; name: string; sketch: Id;
  /** Profundidade em mm, sempre positiva na prática. */
  depth: number;
  /** 'new' cria um corpo; 'add' funde ao corpo `target`; 'cut' subtrai do corpo `target`. */
  op: ExtrudeOp;
  target?: Id;
  /** Simétrico em relação ao plano. */
  symmetric?: boolean;
  /** Inverte o sentido (contra a normal do plano). */
  flip?: boolean;
  /** Atravessa tudo (só faz sentido para corte). */
  throughAll?: boolean;
  color?: string;
  visible?: boolean;
}

/** Eixo de revolução em coordenadas do plano do esboço: uma linha do esboço (quando existir) ou ponto + direção. */
export interface SketchAxis { line?: Id; p: [number, number]; d: [number, number]; }

export interface RevolveFeature {
  id: Id; type: 'revolve'; name: string; sketch: Id;
  axis: SketchAxis;
  /** Ângulo em graus (360 = volta completa). */
  angle: number;
  op: ExtrudeOp;
  target?: Id;
  /** Gira no sentido contrário. */
  flip?: boolean;
  visible?: boolean;
}

/** Referência geométrica a uma aresta: ponto médio e comprimento. Sobrevive a recálculos enquanto a aresta existir. */
export interface EdgeRef { mid: V3; len: number; }

export interface FilletFeature {
  id: Id; type: 'fillet' | 'chamfer'; name: string;
  body: Id; edges: EdgeRef[];
  /** Raio (filete) ou distância (chanfro), em mm. */
  radius: number;
}

export interface BooleanFeature {
  id: Id; type: 'boolean'; name: string;
  op: 'union' | 'subtract' | 'intersect';
  body: Id; tool: Id;
}

export type Feature = ExtrudeFeature | RevolveFeature | FilletFeature | BooleanFeature;

export interface ForjaDocument {
  format: 'forja'; version: number; name: string; units: 'mm';
  createdAt: string; modifiedAt: string;
  planes: Plane[]; sketches: Sketch[]; features: Feature[];
}

export const BASE_PLANES: Plane[] = [
  { id: 'plane-xy', name: 'Frente (XY)', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], kind: 'base' },
  { id: 'plane-xz', name: 'Topo (XZ)', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, -1], kind: 'base' },
  { id: 'plane-yz', name: 'Lateral (YZ)', origin: [0, 0, 0], u: [0, 0, -1], v: [0, 1, 0], kind: 'base' },
];

export function createDocument(name = 'Peça sem nome'): ForjaDocument {
  const now = new Date().toISOString();
  return { format: 'forja', version: FORJA_VERSION, name, units: 'mm', createdAt: now, modifiedAt: now, planes: BASE_PLANES.map((p) => ({ ...p })), sketches: [], features: [] };
}

export function serialize(doc: ForjaDocument): string {
  doc.modifiedAt = new Date().toISOString();
  doc.version = FORJA_VERSION;
  return JSON.stringify(doc, null, 2);
}

const isV3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

export function deserialize(text: string): ForjaDocument {
  const d = JSON.parse(text);
  if (d?.format !== 'forja') throw new Error('Arquivo não é um documento ForjaCAD.');
  if (typeof d.version !== 'number' || d.version > FORJA_VERSION) throw new Error(`Versão de arquivo ${d.version} não suportada por este ForjaCAD.`);
  const fileVersion: number = d.version;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v.slice(0, 200) : fallback);
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const id = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : undefined);
  const doc: ForjaDocument = { ...createDocument(str(d.name, 'Peça')), ...d, name: str(d.name, 'Peça'), version: FORJA_VERSION };
  if (!Array.isArray(doc.planes)) doc.planes = []; if (!Array.isArray(doc.sketches)) doc.sketches = []; if (!Array.isArray(doc.features)) doc.features = [];
  doc.planes = doc.planes.filter((p) => p && typeof p.id === 'string' && isV3(p.origin) && isV3(p.u) && isV3(p.v))
    .map((p) => ({ id: p.id, name: str(p.name, 'Plano'), origin: p.origin, u: p.u, v: p.v, kind: p.kind === 'face' ? 'face' : 'base', body: id(p.body) }));
  doc.sketches = doc.sketches.filter((s) => s && typeof s.id === 'string' && typeof s.plane === 'string').map((s) => ({ ...s, name: str(s.name, 'Esboço'), points: Array.isArray(s.points) ? s.points : [], entities: Array.isArray(s.entities) ? s.entities : [], constraints: Array.isArray(s.constraints) ? s.constraints : [], dimensions: Array.isArray(s.dimensions) ? s.dimensions : [] }));
  const features: Feature[] = [];
  for (const raw of doc.features as unknown[]) {
    const f = raw as Record<string, unknown>; if (!f || typeof f.id !== 'string') continue;
    if (f.type === 'extrude' && typeof f.sketch === 'string') {
      // v1: 'add' significava corpo novo.
      let op: ExtrudeOp = f.op === 'cut' ? 'cut' : f.op === 'add' && fileVersion >= 2 ? 'add' : 'new';
      if (op !== 'new' && typeof f.target !== 'string') op = 'new';
      features.push({ id: f.id, type: 'extrude', name: str(f.name, 'Extrusão'), sketch: f.sketch, depth: Math.abs(num(f.depth, 10)) || 10, op, target: op === 'new' ? undefined : id(f.target), symmetric: !!f.symmetric, flip: !!f.flip, throughAll: !!f.throughAll, visible: f.visible !== false });
    } else if (f.type === 'revolve' && typeof f.sketch === 'string') {
      const ax = f.axis as Partial<SketchAxis> | undefined;
      const is2 = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
      const axis: SketchAxis = { line: id(ax?.line), p: is2(ax?.p) ? ax!.p! : [0, 0], d: is2(ax?.d) && (ax!.d![0] || ax!.d![1]) ? ax!.d! : [0, 1] };
      let op: ExtrudeOp = f.op === 'cut' ? 'cut' : f.op === 'add' ? 'add' : 'new';
      if (op !== 'new' && typeof f.target !== 'string') op = 'new';
      const angle = Math.min(360, Math.abs(num(f.angle, 360))) || 360;
      features.push({ id: f.id, type: 'revolve', name: str(f.name, 'Revolução'), sketch: f.sketch, axis, angle, op, target: op === 'new' ? undefined : id(f.target), flip: !!f.flip, visible: f.visible !== false });
    } else if ((f.type === 'fillet' || f.type === 'chamfer') && typeof f.body === 'string' && Array.isArray(f.edges)) {
      const edges = (f.edges as unknown[]).filter((e): e is EdgeRef => !!e && isV3((e as EdgeRef).mid) && typeof (e as EdgeRef).len === 'number').map((e) => ({ mid: e.mid, len: e.len }));
      if (edges.length) features.push({ id: f.id, type: f.type, name: str(f.name, f.type === 'fillet' ? 'Filete' : 'Chanfro'), body: f.body, edges, radius: Math.abs(num(f.radius, 1)) || 1 });
    } else if (f.type === 'boolean' && typeof f.body === 'string' && typeof f.tool === 'string') {
      const op = f.op === 'subtract' ? 'subtract' : f.op === 'intersect' ? 'intersect' : 'union';
      features.push({ id: f.id, type: 'boolean', name: str(f.name, 'Booleana'), op, body: f.body, tool: f.tool });
    }
  }
  doc.features = features;
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
export function findFeature(doc: ForjaDocument, id: Id): Feature | undefined { return doc.features.find((f) => f.id === id); }

/** A feature cria um corpo novo? */
export const createsBody = (f: Feature): boolean => (f.type === 'extrude' || f.type === 'revolve') && f.op === 'new';

/** Corpos existentes ao final da lista de features: cada extrusão/revolução 'new' cria um, booleanas consomem a ferramenta. */
export function bodyIds(doc: ForjaDocument): Id[] {
  const ids: Id[] = [];
  for (const f of doc.features) {
    if (createsBody(f)) ids.push(f.id);
    else if (f.type === 'boolean') { const i = ids.indexOf(f.tool); if (i >= 0) ids.splice(i, 1); }
  }
  return ids;
}

/** Nome amigável de um corpo: "Corpo N" pela ordem de criação. */
export function bodyName(doc: ForjaDocument, body: Id): string {
  let n = 0;
  for (const f of doc.features) if (createsBody(f)) { n++; if (f.id === body) return `Corpo ${n}`; }
  return 'Corpo';
}

/** Features que dependem de um corpo (inclusive a que o criou). */
export function featuresOfBody(doc: ForjaDocument, body: Id): Feature[] {
  return doc.features.filter((f) => f.id === body || ((f.type === 'extrude' || f.type === 'revolve') && f.target === body) || ((f.type === 'fillet' || f.type === 'chamfer') && f.body === body) || (f.type === 'boolean' && (f.body === body || f.tool === body)));
}

export function addExtrude(doc: ForjaDocument, sketch: Id, depth: number, opts: Partial<Omit<ExtrudeFeature, 'id' | 'type' | 'name' | 'sketch' | 'depth'>> = {}): ExtrudeFeature {
  const op = opts.op ?? 'new';
  const n = doc.features.filter((f) => f.type === 'extrude' && f.op === op).length + 1;
  const base = op === 'cut' ? 'Corte' : op === 'add' ? 'Adição' : 'Extrusão';
  const f: ExtrudeFeature = { id: newId('f'), type: 'extrude', name: `${base} ${n}`, sketch, depth: Math.abs(depth), op, target: op === 'new' ? undefined : opts.target, symmetric: !!opts.symmetric, flip: !!opts.flip, throughAll: !!opts.throughAll, visible: true };
  doc.features.push(f); return f;
}

export function addRevolve(doc: ForjaDocument, sketch: Id, axis: SketchAxis, angle: number, opts: Partial<Pick<RevolveFeature, 'op' | 'target' | 'flip'>> = {}): RevolveFeature {
  const op = opts.op ?? 'new';
  const n = doc.features.filter((f) => f.type === 'revolve').length + 1;
  const f: RevolveFeature = { id: newId('f'), type: 'revolve', name: `Revolução ${n}`, sketch, axis, angle: Math.min(360, Math.abs(angle)) || 360, op, target: op === 'new' ? undefined : opts.target, flip: !!opts.flip, visible: true };
  doc.features.push(f); return f;
}

export function addFillet(doc: ForjaDocument, type: 'fillet' | 'chamfer', body: Id, edges: EdgeRef[], radius: number): FilletFeature {
  const n = doc.features.filter((f) => f.type === type).length + 1;
  const f: FilletFeature = { id: newId('f'), type, name: `${type === 'fillet' ? 'Filete' : 'Chanfro'} ${n}`, body, edges, radius: Math.abs(radius) };
  doc.features.push(f); return f;
}

export function addBoolean(doc: ForjaDocument, op: BooleanFeature['op'], body: Id, tool: Id): BooleanFeature {
  const n = doc.features.filter((f) => f.type === 'boolean').length + 1;
  const label = op === 'union' ? 'União' : op === 'subtract' ? 'Subtração' : 'Interseção';
  const f: BooleanFeature = { id: newId('f'), type: 'boolean', name: `${label} ${n}`, op, body, tool };
  doc.features.push(f); return f;
}

export function addFacePlane(doc: ForjaDocument, name: string, origin: V3, u: V3, v: V3, body: Id): Plane {
  const p: Plane = { id: newId('pl'), name, origin, u, v, kind: 'face', body };
  doc.planes.push(p); return p;
}

/** Remove planos de face que nenhum esboço usa mais. */
export function pruneFacePlanes(doc: ForjaDocument): void {
  doc.planes = doc.planes.filter((p) => p.kind !== 'face' || doc.sketches.some((s) => s.plane === p.id));
}

export function planeNormal(p: Plane): V3 {
  const [ux, uy, uz] = p.u, [vx, vy, vz] = p.v;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Ponto do plano (u,v) → espaço 3D. */
export function planeToWorld(p: Plane, u: number, v: number, w = 0): V3 {
  const n = planeNormal(p);
  return [p.origin[0] + p.u[0] * u + p.v[0] * v + n[0] * w, p.origin[1] + p.u[1] * u + p.v[1] * v + n[1] * w, p.origin[2] + p.u[2] * u + p.v[2] * v + n[2] * w];
}
