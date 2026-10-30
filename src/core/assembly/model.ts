// Montagem: peças (documentos embutidos), instâncias posicionadas e juntas entre faces.
// As juntas formam uma árvore: cada instância pode ser "móvel" de no máximo uma junta, e a posição dela
// sai da instância base + quadro da face base + movimento (ângulo/distância) + inverso do quadro da face móvel.
// Matrizes 4×4 em linha-maior (m[linha*4+coluna]), sem dependência de three.js, para testar em Node.

import type { ForjaDocument, V3 } from '../document';
import { newId, type Id } from '../sketch/model';
import type { FaceData } from '../kernel/occ/types';

export type Mat4 = number[];

export interface Frame { origin: V3; z: V3; x: V3; }
export interface PartDef { id: Id; name: string; doc: ForjaDocument; }
export interface Instance { id: Id; part: Id; name: string; pos: V3; rot: V3; }
export type JointType = 'fixed' | 'revolute' | 'slider' | 'cylindrical';
export interface Joint {
  id: Id; type: JointType; name: string;
  moving: Id; base: Id;
  movingFrame: Frame; baseFrame: Frame;
  /** Ângulo em graus (pino, cilíndrica). */
  angle: number;
  /** Deslocamento em mm ao longo do eixo (deslizante, cilíndrica). */
  distance: number;
  /** Inverte o eixo (Z da face móvel oposto ao Z da face base), como encaixar um pino num furo. */
  flip?: boolean;
}
export interface Assembly { parts: PartDef[]; instances: Instance[]; joints: Joint[]; animation?: Animation; }

/** Movimento de uma junta ao longo da animação (t de 0 a 1). */
export type MotionMode = 'linear' | 'pingpong' | 'spin';
export interface MotionTrack {
  joint: Id; enabled: boolean; mode: MotionMode;
  /** Ângulo inicial e final em graus (pino, cilíndrica). Em 'spin', `angleTo` é o total girado (360 = uma volta). */
  angleFrom: number; angleTo: number;
  /** Curso inicial e final em mm (deslizante, cilíndrica). */
  distFrom: number; distTo: number;
}
export interface Animation { duration: number; loop: boolean; tracks: MotionTrack[]; }
export const MOTION_NAMES: Record<MotionMode, string> = { linear: 'Ida', pingpong: 'Ida e volta', spin: 'Giro contínuo' };

export const JOINT_NAMES: Record<JointType, string> = { fixed: 'Rígida', revolute: 'Pino (rotação)', slider: 'Deslizante', cylindrical: 'Cilíndrica' };

export function createAssembly(): Assembly { return { parts: [], instances: [], joints: [] }; }

export function addPart(asm: Assembly, doc: ForjaDocument, name?: string): PartDef {
  const p: PartDef = { id: newId('pt'), name: name ?? doc.name, doc }; asm.parts.push(p); return p;
}
export function addInstance(asm: Assembly, part: Id, pos: V3 = [0, 0, 0]): Instance {
  const p = asm.parts.find((x) => x.id === part); if (!p) throw new Error('peça inexistente');
  const n = asm.instances.filter((i) => i.part === part).length + 1;
  const inst: Instance = { id: newId('in'), part, name: `${p.name} ${n}`, pos, rot: [0, 0, 0] }; asm.instances.push(inst); return inst;
}
export function removeInstance(asm: Assembly, id: Id): void {
  asm.instances = asm.instances.filter((i) => i.id !== id);
  asm.joints = asm.joints.filter((j) => j.moving !== id && j.base !== id);
}
export function removePart(asm: Assembly, id: Id): void {
  for (const i of asm.instances.filter((x) => x.part === id)) removeInstance(asm, i.id);
  asm.parts = asm.parts.filter((p) => p.id !== id);
}
export function jointOf(asm: Assembly, moving: Id): Joint | undefined { return asm.joints.find((j) => j.moving === moving); }
/** `a` depende (direta ou indiretamente) de `b`? */
export function dependsOn(asm: Assembly, a: Id, b: Id): boolean {
  let cur: Id | undefined = a; const seen = new Set<Id>();
  while (cur && !seen.has(cur)) { if (cur === b) return true; seen.add(cur); cur = jointOf(asm, cur)?.base; }
  return false;
}
export function addJoint(asm: Assembly, type: JointType, moving: Id, movingFrame: Frame, base: Id, baseFrame: Frame, flip = false): Joint {
  if (moving === base) throw new Error('escolha faces de peças diferentes');
  if (jointOf(asm, moving)) throw new Error('essa peça já é a parte móvel de outra junta');
  if (dependsOn(asm, base, moving)) throw new Error('isso fecharia um ciclo de juntas');
  const n = asm.joints.length + 1;
  const j: Joint = { id: newId('jt'), type, name: `${JOINT_NAMES[type]} ${n}`, moving, base, movingFrame: normalizeFrame(movingFrame), baseFrame: normalizeFrame(baseFrame), angle: 0, distance: 0, flip };
  asm.joints.push(j); return j;
}
export function removeJoint(asm: Assembly, id: Id): void { asm.joints = asm.joints.filter((j) => j.id !== id); }

// ---------- Vetores e matrizes ----------
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: V3): V3 => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (v: V3, s: number): V3 => [v[0] * s, v[1] * s, v[2] * s];

/** Garante z unitário e x unitário perpendicular a z. */
export function normalizeFrame(f: Frame): Frame {
  const z = norm(f.z); let x = sub(f.x, scale(z, dot(f.x, z)));
  if (Math.hypot(x[0], x[1], x[2]) < 1e-9) x = anyPerpendicular(z);
  return { origin: [...f.origin] as V3, z, x: norm(x) };
}
export function anyPerpendicular(z: V3): V3 {
  const t: V3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return norm(cross(t, z));
}

export const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; o[r * 4 + c] = s; }
  return o;
}
export function mulAll(...ms: Mat4[]): Mat4 { return ms.reduce((acc, m) => mul(acc, m), identity()); }
export function translation(v: V3): Mat4 { return [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1]; }
/** Rotação de `deg` graus em torno do eixo unitário `axis` (Rodrigues). */
export function rotationAxis(axis: V3, deg: number): Mat4 {
  const [x, y, z] = norm(axis); const a = (deg * Math.PI) / 180; const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0, t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0, t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0, 0, 0, 0, 1];
}
/** Rotação por ângulos de Euler em graus, aplicados na ordem X, depois Y, depois Z (R = Rz·Ry·Rx). */
export function eulerXYZ(rot: V3): Mat4 { return mulAll(rotationAxis([0, 0, 1], rot[2]), rotationAxis([0, 1, 0], rot[1]), rotationAxis([1, 0, 0], rot[0])); }
/** Matriz que leva coordenadas do quadro (x, y, z, origem) para o espaço onde o quadro está descrito. */
export function fromFrame(f: Frame): Mat4 {
  const n = normalizeFrame(f); const y = cross(n.z, n.x);
  return [n.x[0], y[0], n.z[0], n.origin[0], n.x[1], y[1], n.z[1], n.origin[1], n.x[2], y[2], n.z[2], n.origin[2], 0, 0, 0, 1];
}
/** Inversa de uma transformação rígida (rotação + translação). */
export function invertRigid(m: Mat4): Mat4 {
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; // R transposta
  const t: V3 = [m[3], m[7], m[11]];
  const nt: V3 = [-(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]), -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]), -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2])];
  return [r[0], r[1], r[2], nt[0], r[3], r[4], r[5], nt[1], r[6], r[7], r[8], nt[2], 0, 0, 0, 1];
}
export function applyPoint(m: Mat4, p: V3): V3 {
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
}
export function applyDir(m: Mat4, d: V3): V3 {
  return [m[0] * d[0] + m[1] * d[1] + m[2] * d[2], m[4] * d[0] + m[5] * d[1] + m[6] * d[2], m[8] * d[0] + m[9] * d[1] + m[10] * d[2]];
}
export function transformFrame(m: Mat4, f: Frame): Frame { return { origin: applyPoint(m, f.origin), z: applyDir(m, f.z), x: applyDir(m, f.x) }; }
/** Elementos em coluna-maior (como three.js Matrix4.elements). */
export function toColumnMajor(m: Mat4): number[] { return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]]; }

/** Quadro de uma face, em coordenadas da peça: plano → centro + normal; cilindro → ponto do eixo + eixo. */
export function frameFromFace(f: FaceData): Frame | null {
  if (f.type === 'plane' && f.normal && f.u && f.origin) {
    const n = norm(f.normal); const d = dot(sub(f.center, f.origin), n);
    return normalizeFrame({ origin: sub(f.center, scale(n, d)), z: n, x: f.u });
  }
  if (f.type === 'cylinder' && f.axisOrigin && f.axisDir) {
    const z = norm(f.axisDir); const d = dot(sub(f.center, f.axisOrigin), z);
    const origin: V3 = [f.axisOrigin[0] + z[0] * d, f.axisOrigin[1] + z[1] * d, f.axisOrigin[2] + z[2] * d];
    return normalizeFrame({ origin, z, x: anyPerpendicular(z) });
  }
  return null;
}

function motion(j: Joint): Mat4 {
  const rot = j.type === 'revolute' || j.type === 'cylindrical' ? rotationAxis([0, 0, 1], j.angle) : identity();
  const sl = j.type === 'slider' || j.type === 'cylindrical' ? translation([0, 0, j.distance]) : identity();
  return mul(sl, rot);
}
const FLIP: Mat4 = rotationAxis([1, 0, 0], 180);

/** Transformação mundo de cada instância (linha-maior). Instâncias sem junta usam pos/rot próprios. */
export function computeTransforms(asm: Assembly): Map<Id, Mat4> {
  const out = new Map<Id, Mat4>(); const visiting = new Set<Id>();
  const world = (id: Id): Mat4 => {
    const cached = out.get(id); if (cached) return cached;
    const inst = asm.instances.find((i) => i.id === id); if (!inst) return identity();
    const j = jointOf(asm, id);
    let m: Mat4;
    if (!j || visiting.has(id) || !asm.instances.some((i) => i.id === j.base)) m = mul(translation(inst.pos), eulerXYZ(inst.rot));
    else {
      visiting.add(id);
      const base = world(j.base);
      m = mulAll(base, fromFrame(j.baseFrame), motion(j), j.flip ? FLIP : identity(), invertRigid(fromFrame(j.movingFrame)));
      visiting.delete(id);
    }
    out.set(id, m); return m;
  };
  for (const i of asm.instances) world(i.id);
  return out;
}

export interface BomRow { item: number; part: Id; name: string; qty: number; material: string; instances: Id[]; }
/** Lista de materiais: um item por peça, na ordem de primeira aparição entre as instâncias. */
export function bomRows(asm: Assembly): BomRow[] {
  const rows: BomRow[] = [];
  for (const inst of asm.instances) {
    let row = rows.find((r) => r.part === inst.part);
    if (!row) { const p = asm.parts.find((x) => x.id === inst.part); row = { item: rows.length + 1, part: inst.part, name: p?.name ?? 'Peça', qty: 0, material: p?.doc.drawing?.material ?? '', instances: [] }; rows.push(row); }
    row.qty++; row.instances.push(inst.id);
  }
  return rows;
}

// ---------- Animação ----------

export function createAnimation(): Animation { return { duration: 4, loop: true, tracks: [] }; }

/** Faixa padrão para uma junta: parte do valor atual e vai um pouco além, ida e volta. */
export function defaultTrack(j: Joint): MotionTrack {
  return { joint: j.id, enabled: true, mode: j.type === 'revolute' ? 'pingpong' : 'pingpong', angleFrom: j.angle, angleTo: j.angle + 90, distFrom: j.distance, distTo: j.distance + 20 };
}
/** Garante uma faixa para cada junta móvel (pino, deslizante, cilíndrica) e tira as de juntas que sumiram. */
export function syncTracks(asm: Assembly): Animation {
  const anim = asm.animation ?? (asm.animation = createAnimation());
  anim.tracks = anim.tracks.filter((t) => asm.joints.some((j) => j.id === t.joint && j.type !== 'fixed'));
  for (const j of asm.joints) if (j.type !== 'fixed' && !anim.tracks.some((t) => t.joint === j.id)) anim.tracks.push(defaultTrack(j));
  return anim;
}

function interp(from: number, to: number, mode: MotionMode, t: number): number {
  if (mode === 'spin') return from + to * t;
  const s = mode === 'pingpong' ? (t < 0.5 ? 2 * t : 2 - 2 * t) : t;
  return from + (to - from) * s;
}

/** Valores (ângulo, curso) de cada junta no instante t ∈ [0, 1]; juntas sem faixa ficam no valor fixo. */
export function jointValuesAt(asm: Assembly, t: number): Map<Id, { angle: number; distance: number }> {
  const out = new Map<Id, { angle: number; distance: number }>();
  const tt = Math.max(0, Math.min(1, t));
  for (const j of asm.joints) {
    const tr = asm.animation?.tracks.find((x) => x.joint === j.id && x.enabled);
    if (!tr) { out.set(j.id, { angle: j.angle, distance: j.distance }); continue; }
    const angle = j.type === 'revolute' || j.type === 'cylindrical' ? interp(tr.angleFrom, tr.angleTo, tr.mode, tt) : j.angle;
    const distance = j.type === 'slider' || j.type === 'cylindrical' ? interp(tr.distFrom, tr.distTo, tr.mode === 'spin' ? 'linear' : tr.mode, tt) : j.distance;
    out.set(j.id, { angle, distance });
  }
  return out;
}

/** Transformações das instâncias com as juntas nos valores do instante t, sem alterar o documento. */
export function computeTransformsAt(asm: Assembly, t: number): Map<Id, Mat4> {
  const values = jointValuesAt(asm, t);
  const posed: Assembly = { ...asm, joints: asm.joints.map((j) => ({ ...j, ...values.get(j.id) })) };
  return computeTransforms(posed);
}
