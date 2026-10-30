// Documento ForjaCAD: planos, esboços e features em ordem.
// Serializa para JSON legível (.forja). Guarda geometria + restrições + features, nunca a malha.

import { type Sketch, type Id, newId } from './sketch/model';
import { type DrawingSettings, defaultDrawingSettings, SHEET_MM } from './drawing/layout';
import { type Assembly, type Frame, type JointType, createAssembly, JOINT_NAMES } from './assembly/model';

export const FORJA_VERSION = 2;

export type V3 = [number, number, number];

/** Plano de trabalho: origem + eixos u, v no espaço 3D (mm). normal = u × v. */
export interface Plane {
  id: Id; name: string; origin: V3; u: V3; v: V3;
  /** 'base' são os três planos fixos; 'face' nasce de uma face plana de um corpo (não desenhado); 'offset' é um plano de construção deslocado (desenhado). */
  kind?: 'base' | 'face' | 'offset';
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
  /** Extruda só o perfil fechado que contém este ponto (u, v) do esboço; sem ele, todos os perfis. */
  profilePoint?: [number, number];
  pattern?: PatternSpec;
  color?: string;
  visible?: boolean;
}

/** Repetição de uma feature: em linha (passo em mm) ou em volta de um eixo (ângulo total em graus). */
export type PatternSpec = { kind: 'linear'; count: number; step: V3 } | { kind: 'circular'; count: number; axisPoint: V3; axisDir: V3; angle: number };

/** Referência geométrica a uma face plana: centro, normal para fora e área. */
export interface FaceRef { center: V3; normal: V3; area: number; }

/** Puxar/empurrar uma face plana de um corpo (modelagem direta). Positivo cresce para fora, negativo corta. */
export interface PushPullFeature { id: Id; type: 'pushpull'; name: string; body: Id; face: FaceRef; distance: number; }

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
  pattern?: PatternSpec;
  visible?: boolean;
}

/** Casca: esvazia o corpo deixando paredes de `thickness`; as faces em `openFaces` ficam abertas. */
export interface ShellFeature { id: Id; type: 'shell'; name: string; body: Id; thickness: number; openFaces: FaceRef[]; }
/** Espelho em relação a um plano. `join` funde a cópia ao original; senão cria um corpo novo (id da feature). */
export interface MirrorFeature { id: Id; type: 'mirror'; name: string; body: Id; origin: V3; normal: V3; join: boolean; }
/** Mover, girar (em torno de um eixo) e escalar um corpo. */
export interface TransformFeature { id: Id; type: 'transform'; name: string; body: Id; translate: V3; axisPoint: V3; axisDir: V3; angle: number; scale: number; }
/** Divide um corpo por um plano. 'both' mantém os dois (o segundo vira corpo com o id da feature). */
export interface SplitFeature { id: Id; type: 'split'; name: string; body: Id; origin: V3; normal: V3; keep: 'both' | 'front' | 'back'; }
/** Varredura: perfil fechado de um esboço ao longo do caminho (linhas e arcos) de outro. */
export interface SweepFeature { id: Id; type: 'sweep'; name: string; profile: Id; path: Id; op: ExtrudeOp; target?: Id; }
/** Loft entre perfis de dois ou mais esboços. */
export interface LoftFeature { id: Id; type: 'loft'; name: string; sketches: Id[]; ruled: boolean; op: ExtrudeOp; target?: Id; }
/** Corpo importado de um STEP (texto guardado no documento). */
export interface ImportFeature { id: Id; type: 'import'; name: string; step: string; }

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

export type Feature = ExtrudeFeature | RevolveFeature | PushPullFeature | FilletFeature | BooleanFeature | ShellFeature | MirrorFeature | TransformFeature | SplitFeature | SweepFeature | LoftFeature | ImportFeature;

export interface ForjaDocument {
  format: 'forja'; version: number; name: string; units: 'mm';
  createdAt: string; modifiedAt: string;
  planes: Plane[]; sketches: Sketch[]; features: Feature[];
  /** Opções do desenho técnico (folha, vistas, legenda). Ausente até o primeiro desenho. */
  drawing?: DrawingSettings;
  /** 'part' (padrão) ou 'assembly'. Uma montagem embute as peças em `assembly.parts`. */
  kind?: 'part' | 'assembly';
  assembly?: Assembly;
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

export function createAssemblyDocument(name = 'Montagem sem nome'): ForjaDocument {
  const d = createDocument(name); d.kind = 'assembly'; d.assembly = createAssembly(); return d;
}

export function serialize(doc: ForjaDocument): string {
  doc.modifiedAt = new Date().toISOString();
  doc.version = FORJA_VERSION;
  return JSON.stringify(doc, null, 2);
}

const isV3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

export function deserialize(text: string): ForjaDocument { return fromObject(JSON.parse(text), 0); }

function fromObject(d: Record<string, unknown> & { [k: string]: any }, depth: number): ForjaDocument {
  if (d?.format !== 'forja') throw new Error('Arquivo não é um documento ForjaCAD.');
  if (typeof d.version !== 'number' || d.version > FORJA_VERSION) throw new Error(`Versão de arquivo ${d.version} não suportada por este ForjaCAD.`);
  const fileVersion: number = d.version;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v.slice(0, 200) : fallback);
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const id = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : undefined);
  const doc: ForjaDocument = { ...createDocument(str(d.name, 'Peça')), ...d, name: str(d.name, 'Peça'), version: FORJA_VERSION };
  if (!Array.isArray(doc.planes)) doc.planes = []; if (!Array.isArray(doc.sketches)) doc.sketches = []; if (!Array.isArray(doc.features)) doc.features = [];
  doc.planes = doc.planes.filter((p) => p && typeof p.id === 'string' && isV3(p.origin) && isV3(p.u) && isV3(p.v))
    .map((p) => ({ id: p.id, name: str(p.name, 'Plano'), origin: p.origin, u: p.u, v: p.v, kind: p.kind === 'face' ? 'face' : p.kind === 'offset' ? 'offset' : 'base', body: id(p.body) }));
  doc.sketches = doc.sketches.filter((s) => s && typeof s.id === 'string' && typeof s.plane === 'string').map((s) => ({ ...s, name: str(s.name, 'Esboço'), points: Array.isArray(s.points) ? s.points : [], entities: Array.isArray(s.entities) ? s.entities : [], constraints: Array.isArray(s.constraints) ? s.constraints : [], dimensions: Array.isArray(s.dimensions) ? s.dimensions : [] }));
  const features: Feature[] = [];
  const pattern = (v: unknown): PatternSpec | undefined => {
    const q = v as Partial<{ kind: string; count: number; step: unknown; axisPoint: unknown; axisDir: unknown; angle: number }> | undefined; if (!q || typeof q !== 'object') return undefined;
    const count = Math.max(2, Math.min(200, Math.round(num(q.count, 2))));
    if (q.kind === 'linear' && isV3(q.step)) return { kind: 'linear', count, step: q.step };
    if (q.kind === 'circular' && isV3(q.axisPoint) && isV3(q.axisDir)) return { kind: 'circular', count, axisPoint: q.axisPoint, axisDir: q.axisDir, angle: num(q.angle, 360) || 360 };
    return undefined;
  };
  const faceRef = (v: unknown): FaceRef | null => { const fr = v as Partial<FaceRef> | undefined; return fr && isV3(fr.center) && isV3(fr.normal) && typeof fr.area === 'number' ? { center: fr.center, normal: fr.normal, area: fr.area } : null; };
  const opOf = (f: Record<string, unknown>): ExtrudeOp => { let op: ExtrudeOp = f.op === 'cut' ? 'cut' : f.op === 'add' ? 'add' : 'new'; if (op !== 'new' && typeof f.target !== 'string') op = 'new'; return op; };
  for (const raw of doc.features as unknown[]) {
    const f = raw as Record<string, unknown>; if (!f || typeof f.id !== 'string') continue;
    if (f.type === 'extrude' && typeof f.sketch === 'string') {
      // v1: 'add' significava corpo novo.
      let op: ExtrudeOp = f.op === 'cut' ? 'cut' : f.op === 'add' && fileVersion >= 2 ? 'add' : 'new';
      if (op !== 'new' && typeof f.target !== 'string') op = 'new';
      const pp = f.profilePoint as unknown; const profilePoint = Array.isArray(pp) && pp.length === 2 && pp.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (pp as [number, number]) : undefined;
      features.push({ id: f.id, type: 'extrude', name: str(f.name, 'Extrusão'), sketch: f.sketch, depth: Math.abs(num(f.depth, 10)) || 10, op, target: op === 'new' ? undefined : id(f.target), symmetric: !!f.symmetric, flip: !!f.flip, throughAll: !!f.throughAll, profilePoint, pattern: pattern(f.pattern), visible: f.visible !== false });
    } else if (f.type === 'pushpull' && typeof f.body === 'string') {
      const fr = f.face as Partial<FaceRef> | undefined;
      if (fr && isV3(fr.center) && isV3(fr.normal) && typeof fr.area === 'number') features.push({ id: f.id, type: 'pushpull', name: str(f.name, 'Puxar face'), body: f.body, face: { center: fr.center, normal: fr.normal, area: fr.area }, distance: num(f.distance, 1) || 1 });
    } else if (f.type === 'revolve' && typeof f.sketch === 'string') {
      const ax = f.axis as Partial<SketchAxis> | undefined;
      const is2 = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
      const axis: SketchAxis = { line: id(ax?.line), p: is2(ax?.p) ? ax!.p! : [0, 0], d: is2(ax?.d) && (ax!.d![0] || ax!.d![1]) ? ax!.d! : [0, 1] };
      let op: ExtrudeOp = f.op === 'cut' ? 'cut' : f.op === 'add' ? 'add' : 'new';
      if (op !== 'new' && typeof f.target !== 'string') op = 'new';
      const angle = Math.min(360, Math.abs(num(f.angle, 360))) || 360;
      features.push({ id: f.id, type: 'revolve', name: str(f.name, 'Revolução'), sketch: f.sketch, axis, angle, op, target: op === 'new' ? undefined : id(f.target), flip: !!f.flip, pattern: pattern(f.pattern), visible: f.visible !== false });
    } else if (f.type === 'shell' && typeof f.body === 'string') {
      const open = (Array.isArray(f.openFaces) ? f.openFaces : []).map(faceRef).filter((x): x is FaceRef => !!x);
      features.push({ id: f.id, type: 'shell', name: str(f.name, 'Casca'), body: f.body, thickness: Math.abs(num(f.thickness, 2)) || 2, openFaces: open });
    } else if (f.type === 'mirror' && typeof f.body === 'string' && isV3(f.origin) && isV3(f.normal)) {
      features.push({ id: f.id, type: 'mirror', name: str(f.name, 'Espelho'), body: f.body, origin: f.origin, normal: f.normal, join: f.join !== false });
    } else if (f.type === 'transform' && typeof f.body === 'string') {
      features.push({ id: f.id, type: 'transform', name: str(f.name, 'Mover'), body: f.body, translate: isV3(f.translate) ? f.translate : [0, 0, 0], axisPoint: isV3(f.axisPoint) ? f.axisPoint : [0, 0, 0], axisDir: isV3(f.axisDir) ? f.axisDir : [0, 0, 1], angle: num(f.angle, 0), scale: num(f.scale, 1) || 1 });
    } else if (f.type === 'split' && typeof f.body === 'string' && isV3(f.origin) && isV3(f.normal)) {
      features.push({ id: f.id, type: 'split', name: str(f.name, 'Dividir'), body: f.body, origin: f.origin, normal: f.normal, keep: f.keep === 'front' || f.keep === 'back' ? f.keep : 'both' });
    } else if (f.type === 'sweep' && typeof f.profile === 'string' && typeof f.path === 'string') {
      const op = opOf(f); features.push({ id: f.id, type: 'sweep', name: str(f.name, 'Varredura'), profile: f.profile, path: f.path, op, target: op === 'new' ? undefined : id(f.target) });
    } else if (f.type === 'loft' && Array.isArray(f.sketches)) {
      const sk = (f.sketches as unknown[]).filter((x): x is string => typeof x === 'string'); if (sk.length < 2) continue;
      const op = opOf(f); features.push({ id: f.id, type: 'loft', name: str(f.name, 'Loft'), sketches: sk, ruled: !!f.ruled, op, target: op === 'new' ? undefined : id(f.target) });
    } else if (f.type === 'import' && typeof f.step === 'string' && f.step.length < 50_000_000) {
      features.push({ id: f.id, type: 'import', name: str(f.name, 'Importado'), step: f.step });
    } else if ((f.type === 'fillet' || f.type === 'chamfer') && typeof f.body === 'string' && Array.isArray(f.edges)) {
      const edges = (f.edges as unknown[]).filter((e): e is EdgeRef => !!e && isV3((e as EdgeRef).mid) && typeof (e as EdgeRef).len === 'number').map((e) => ({ mid: e.mid, len: e.len }));
      if (edges.length) features.push({ id: f.id, type: f.type, name: str(f.name, f.type === 'fillet' ? 'Filete' : 'Chanfro'), body: f.body, edges, radius: Math.abs(num(f.radius, 1)) || 1 });
    } else if (f.type === 'boolean' && typeof f.body === 'string' && typeof f.tool === 'string') {
      const op = f.op === 'subtract' ? 'subtract' : f.op === 'intersect' ? 'intersect' : 'union';
      features.push({ id: f.id, type: 'boolean', name: str(f.name, 'Booleana'), op, body: f.body, tool: f.tool });
    }
  }
  doc.features = features;
  doc.drawing = sanitizeDrawing(d.drawing, doc.name);
  delete doc.kind; delete doc.assembly;
  if (d.kind === 'assembly' && depth === 0) { doc.kind = 'assembly'; doc.assembly = sanitizeAssembly(d.assembly, (o) => fromObject(o as Record<string, unknown>, depth + 1)); }
  // Planos base sempre existem, mesmo que o arquivo venha sem eles.
  for (const bp of BASE_PLANES) if (!doc.planes.some((p) => p.id === bp.id)) doc.planes.push({ ...bp });
  return doc;
}

/** Montagem válida a partir de um objeto qualquer: peças embutidas, instâncias e juntas conferidas. */
function sanitizeAssembly(raw: unknown, partDoc: (o: unknown) => ForjaDocument): Assembly {
  const asm = createAssembly();
  if (!raw || typeof raw !== 'object') return asm;
  const r = raw as { parts?: unknown[]; instances?: unknown[]; joints?: unknown[] };
  const str = (v: unknown, fb: string) => (typeof v === 'string' ? v.slice(0, 120) : fb);
  for (const p of Array.isArray(r.parts) ? r.parts : []) {
    const q = p as { id?: unknown; name?: unknown; doc?: unknown }; if (typeof q.id !== 'string') continue;
    try { asm.parts.push({ id: q.id, name: str(q.name, 'Peça'), doc: partDoc(q.doc) }); } catch { /* peça corrompida: fica de fora */ }
  }
  const partIds = new Set(asm.parts.map((p) => p.id));
  for (const i of Array.isArray(r.instances) ? r.instances : []) {
    const q = i as { id?: unknown; part?: unknown; name?: unknown; pos?: unknown; rot?: unknown };
    if (typeof q.id !== 'string' || typeof q.part !== 'string' || !partIds.has(q.part)) continue;
    asm.instances.push({ id: q.id, part: q.part, name: str(q.name, 'Peça'), pos: isV3(q.pos) ? q.pos : [0, 0, 0], rot: isV3(q.rot) ? q.rot : [0, 0, 0] });
  }
  const instIds = new Set(asm.instances.map((i) => i.id));
  const frame = (f: unknown): Frame | null => { const g = f as Frame; return g && isV3(g.origin) && isV3(g.z) && isV3(g.x) ? { origin: g.origin, z: g.z, x: g.x } : null; };
  for (const j of Array.isArray(r.joints) ? r.joints : []) {
    const q = j as { id?: unknown; type?: unknown; name?: unknown; moving?: unknown; base?: unknown; movingFrame?: unknown; baseFrame?: unknown; angle?: unknown; distance?: unknown; flip?: unknown };
    if (typeof q.id !== 'string' || typeof q.moving !== 'string' || typeof q.base !== 'string' || !instIds.has(q.moving) || !instIds.has(q.base)) continue;
    const type: JointType = (['fixed', 'revolute', 'slider', 'cylindrical'] as JointType[]).includes(q.type as JointType) ? (q.type as JointType) : 'fixed';
    const mf = frame(q.movingFrame), bf = frame(q.baseFrame); if (!mf || !bf) continue;
    if (asm.joints.some((x) => x.moving === q.moving)) continue;
    asm.joints.push({ id: q.id, type, name: str(q.name, JOINT_NAMES[type]), moving: q.moving, base: q.base, movingFrame: mf, baseFrame: bf, angle: typeof q.angle === 'number' && Number.isFinite(q.angle) ? q.angle : 0, distance: typeof q.distance === 'number' && Number.isFinite(q.distance) ? q.distance : 0, flip: !!q.flip });
  }
  const an = (raw as { animation?: unknown }).animation as { duration?: unknown; loop?: unknown; tracks?: unknown[] } | undefined;
  if (an && typeof an === 'object') {
    const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
    const jointIds = new Set(asm.joints.map((j) => j.id));
    asm.animation = {
      duration: Math.min(120, Math.max(0.5, num(an.duration, 4))), loop: an.loop !== false,
      tracks: (Array.isArray(an.tracks) ? an.tracks : []).filter((t): t is Record<string, unknown> => !!t && typeof (t as Record<string, unknown>).joint === 'string' && jointIds.has((t as Record<string, unknown>).joint as string))
        .map((t) => ({ joint: t.joint as string, enabled: t.enabled !== false, mode: t.mode === 'linear' || t.mode === 'spin' ? t.mode : 'pingpong', angleFrom: num(t.angleFrom, 0), angleTo: num(t.angleTo, 90), distFrom: num(t.distFrom, 0), distTo: num(t.distTo, 20) })),
    };
  }
  return asm;
}

/** Opções de desenho válidas a partir de um objeto qualquer (arquivo antigo ou editado à mão). */
export function sanitizeDrawing(raw: unknown, title: string): DrawingSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>; const def = defaultDrawingSettings(title);
  const bool = (k: keyof DrawingSettings) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (def[k] as boolean));
  const text = (k: keyof DrawingSettings) => (typeof r[k] === 'string' ? (r[k] as string).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120) : (def[k] as string));
  return {
    sheet: typeof r.sheet === 'string' && r.sheet in SHEET_MM ? (r.sheet as DrawingSettings['sheet']) : def.sheet,
    projection: r.projection === 'third' ? 'third' : 'first',
    scale: typeof r.scale === 'number' && Number.isFinite(r.scale) && r.scale > 0 ? r.scale : 'auto',
    front: bool('front'), top: bool('top'), side: bool('side'), iso: bool('iso'), hidden: bool('hidden'), tangent: bool('tangent'), dimensions: bool('dimensions'),
    title: text('title'), number: text('number'), material: text('material'), author: text('author'), company: text('company'),
  };
}

export function cloneDocument(doc: ForjaDocument): ForjaDocument { return JSON.parse(JSON.stringify(doc)); }

export function getPlane(doc: ForjaDocument, id: Id): Plane {
  const p = doc.planes.find((q) => q.id === id); if (!p) throw new Error(`Plano inexistente: ${id}`); return p;
}
export function getSketch(doc: ForjaDocument, id: Id): Sketch {
  const s = doc.sketches.find((q) => q.id === id); if (!s) throw new Error(`Esboço inexistente: ${id}`); return s;
}
export function findFeature(doc: ForjaDocument, id: Id): Feature | undefined { return doc.features.find((f) => f.id === id); }

/** A feature cria um corpo novo (com o próprio id)? */
export const createsBody = (f: Feature): boolean =>
  ((f.type === 'extrude' || f.type === 'revolve' || f.type === 'sweep' || f.type === 'loft') && f.op === 'new') || f.type === 'import' || (f.type === 'mirror' && !f.join) || (f.type === 'split' && f.keep === 'both');

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
  return doc.features.filter((f) => f.id === body || ('target' in f && f.target === body) || ('body' in f && f.body === body) || ((f.type === 'fillet' || f.type === 'chamfer') && f.body === body) || (f.type === 'boolean' && (f.body === body || f.tool === body)));
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

export function addShell(doc: ForjaDocument, body: Id, thickness: number, openFaces: FaceRef[]): ShellFeature {
  const n = doc.features.filter((f) => f.type === 'shell').length + 1;
  const f: ShellFeature = { id: newId('f'), type: 'shell', name: `Casca ${n}`, body, thickness: Math.abs(thickness), openFaces }; doc.features.push(f); return f;
}
export function addMirror(doc: ForjaDocument, body: Id, origin: V3, normal: V3, join = true): MirrorFeature {
  const n = doc.features.filter((f) => f.type === 'mirror').length + 1;
  const f: MirrorFeature = { id: newId('f'), type: 'mirror', name: `Espelho ${n}`, body, origin, normal, join }; doc.features.push(f); return f;
}
export function addTransform(doc: ForjaDocument, body: Id, t: Partial<Omit<TransformFeature, 'id' | 'type' | 'name' | 'body'>> = {}): TransformFeature {
  const n = doc.features.filter((f) => f.type === 'transform').length + 1;
  const f: TransformFeature = { id: newId('f'), type: 'transform', name: `Mover ${n}`, body, translate: t.translate ?? [0, 0, 0], axisPoint: t.axisPoint ?? [0, 0, 0], axisDir: t.axisDir ?? [0, 0, 1], angle: t.angle ?? 0, scale: t.scale ?? 1 }; doc.features.push(f); return f;
}
export function addSplit(doc: ForjaDocument, body: Id, origin: V3, normal: V3, keep: SplitFeature['keep'] = 'both'): SplitFeature {
  const n = doc.features.filter((f) => f.type === 'split').length + 1;
  const f: SplitFeature = { id: newId('f'), type: 'split', name: `Dividir ${n}`, body, origin, normal, keep }; doc.features.push(f); return f;
}
export function addSweep(doc: ForjaDocument, profile: Id, path: Id, opts: { op?: ExtrudeOp; target?: Id } = {}): SweepFeature {
  const op = opts.op ?? 'new'; const n = doc.features.filter((f) => f.type === 'sweep').length + 1;
  const f: SweepFeature = { id: newId('f'), type: 'sweep', name: `Varredura ${n}`, profile, path, op, target: op === 'new' ? undefined : opts.target }; doc.features.push(f); return f;
}
export function addLoft(doc: ForjaDocument, sketches: Id[], opts: { ruled?: boolean; op?: ExtrudeOp; target?: Id } = {}): LoftFeature {
  const op = opts.op ?? 'new'; const n = doc.features.filter((f) => f.type === 'loft').length + 1;
  const f: LoftFeature = { id: newId('f'), type: 'loft', name: `Loft ${n}`, sketches, ruled: !!opts.ruled, op, target: op === 'new' ? undefined : opts.target }; doc.features.push(f); return f;
}
export function addImport(doc: ForjaDocument, name: string, step: string): ImportFeature {
  const f: ImportFeature = { id: newId('f'), type: 'import', name: name.slice(0, 80) || 'Importado', step }; doc.features.push(f); return f;
}

export function addPushPull(doc: ForjaDocument, body: Id, face: FaceRef, distance: number): PushPullFeature {
  const n = doc.features.filter((f) => f.type === 'pushpull').length + 1;
  const f: PushPullFeature = { id: newId('f'), type: 'pushpull', name: `${distance >= 0 ? 'Puxar' : 'Empurrar'} face ${n}`, body, face, distance };
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
/** Plano de construção deslocado: aparece na cena e serve para esboços, lofts e cortes. */
export function addOffsetPlane(doc: ForjaDocument, name: string, origin: V3, u: V3, v: V3): Plane {
  const p: Plane = { id: newId('pl'), name, origin, u, v, kind: 'offset' };
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
