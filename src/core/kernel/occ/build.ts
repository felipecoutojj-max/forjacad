// Kernel B-rep sobre o OpenCASCADE (opencascade.js). Funções puras que recebem a instância `oc`:
// esboço → faces, prisma, booleanas, filete/chanfro, malha com ids de face e polilinhas de aresta, STEP.
// Não importa three.js nem DOM: roda no worker e nos testes em Node.

import type { OpenCascadeInstance, TopoDS_Shape, TopoDS_Face, TopoDS_Edge, TopoDS_Wire, BRepAdaptor_Curve, gp_Trsf, GeomAbs_Shape } from 'opencascade.js';
import type { ForjaDocument, FilletFeature, EdgeRef, FaceRef, V3, Plane, SketchAxis, PatternSpec, ExtrudeOp } from '../../document';
import { getSketch, getPlane, planeNormal, planeToWorld } from '../../document';
import type { Sketch, Id, SplineEntity, EllipseEntity } from '../../sketch/model';
import { getPoint, findEntity, sampleEntity } from '../../sketch/model';
import { extractProfiles, loopArcAngles, profileContainsPoint, type Loop, type Profile } from '../profiles';
import type { BodyData, FaceData, EdgeData, FeatureError, FaceType, ViewSpec, ProjectedView, ProjCircle, InterferenceHit, SketchEntity2D } from './types';

type OC = OpenCascadeInstance;
export interface BuiltBody { id: Id; shape: TopoDS_Shape; }
export interface RebuildShapes { bodies: BuiltBody[]; errors: FeatureError[]; }

const enumVal = (e: unknown): number => (e as { value: number }).value;
const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
const dist3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Mensagem legível a partir de uma exceção JS ou de uma exceção C++ (número) do WASM. */
export function errorMessage(oc: OC, e: unknown): string {
  if (typeof e === 'number') {
    try { const fd = (oc as unknown as { OCJS: { getStandard_FailureData(p: number): { GetMessageString(): string } } }).OCJS.getStandard_FailureData(e); return fd.GetMessageString() || 'erro interno do kernel'; }
    catch { return 'erro interno do kernel'; }
  }
  return e instanceof Error ? e.message : String(e);
}

// ---------- Esboço → faces ----------

function pnt(oc: OC, p: V3) { return new oc.gp_Pnt_3(p[0], p[1], p[2]); }

/** Aresta B-spline passando pelos pontos (aproximação com tolerância mínima; fechada repete o primeiro ponto). */
function splineEdge(oc: OC, pts: V3[], closed: boolean): TopoDS_Edge {
  const list = closed ? [...pts, pts[0]] : pts;
  const arr = new oc.TColgp_Array1OfPnt_2(1, list.length);
  list.forEach((p, i) => arr.SetValue(i + 1, pnt(oc, p)));
  const fit = new oc.GeomAPI_PointsToBSpline_2(arr, 3, 8, oc.GeomAbs_Shape.GeomAbs_C2 as GeomAbs_Shape, 1e-4);
  if (!fit.IsDone()) throw new Error('spline degenerada');
  return new oc.BRepBuilderAPI_MakeEdge_24(new oc.Handle_Geom_Curve_2(fit.Curve().get())).Edge();
}
/** Aresta de elipse no plano (semieixo maior ao longo de `angle`; troca eixos se `ry` > `rx`). */
function ellipseEdge(oc: OC, s: Sketch, plane: Plane, e: EllipseEntity): TopoDS_Edge {
  const c = getPoint(s, e.center); const n = planeNormal(plane);
  const swap = e.ry > e.rx; const ang = e.angle + (swap ? Math.PI / 2 : 0); const major = swap ? e.ry : e.rx, minor = swap ? e.rx : e.ry;
  const xd = planeToWorld(plane, Math.cos(ang), Math.sin(ang)); const o = planeToWorld(plane, 0, 0); const vx: V3 = [xd[0] - o[0], xd[1] - o[1], xd[2] - o[2]];
  const ax = new oc.gp_Ax2_2(pnt(oc, planeToWorld(plane, c.x, c.y)), new oc.gp_Dir_4(n[0], n[1], n[2]), new oc.gp_Dir_4(vx[0], vx[1], vx[2]));
  return new oc.BRepBuilderAPI_MakeEdge_12(new oc.gp_Elips_2(ax, major, Math.max(1e-6, minor))).Edge();
}
function splinePoints(s: Sketch, plane: Plane, e: SplineEntity): V3[] { return e.points.map((id) => { const p = getPoint(s, id); return planeToWorld(plane, p.x, p.y); }); }

function loopToWire(oc: OC, s: Sketch, plane: Plane, loop: Loop): TopoDS_Wire {
  const mk = new oc.BRepBuilderAPI_MakeWire_1();
  if (loop.kind === 'circle') {
    const e = loop.entity;
    if (e.type === 'circle') {
      const c = getPoint(s, e.center); const n = planeNormal(plane);
      const ax = new oc.gp_Ax2_3(pnt(oc, planeToWorld(plane, c.x, c.y)), new oc.gp_Dir_4(n[0], n[1], n[2]));
      mk.Add_1(new oc.BRepBuilderAPI_MakeEdge_8(new oc.gp_Circ_2(ax, e.r)).Edge());
    } else if (e.type === 'ellipse') mk.Add_1(ellipseEdge(oc, s, plane, e));
    else if (e.type === 'spline') mk.Add_1(splineEdge(oc, splinePoints(s, plane, e), true));
    else throw new Error('laço inválido');
  } else {
    for (const ed of loop.edges) {
      const a = getPoint(s, ed.from), b = getPoint(s, ed.to);
      const A = pnt(oc, planeToWorld(plane, a.x, a.y)), B = pnt(oc, planeToWorld(plane, b.x, b.y));
      if (ed.entity.type === 'line') {
        mk.Add_1(new oc.BRepBuilderAPI_MakeEdge_3(A, B).Edge());
      } else if (ed.entity.type === 'spline') {
        const pts = splinePoints(s, plane, ed.entity); if (ed.reversed) pts.reverse();
        mk.Add_1(splineEdge(oc, pts, false));
      } else if (ed.entity.type === 'arc') {
        const arc = ed.entity; const c = getPoint(s, arc.center); const { a0, sweep } = loopArcAngles(s, ed);
        const tm = a0 + sweep / 2;
        const M = pnt(oc, planeToWorld(plane, c.x + arc.r * Math.cos(tm), c.y + arc.r * Math.sin(tm)));
        const mkArc = new oc.GC_MakeArcOfCircle_4(A, M, B);
        if (!mkArc.IsDone()) throw new Error('arco degenerado');
        const curve = new oc.Handle_Geom_Curve_2(mkArc.Value().get());
        mk.Add_1(new oc.BRepBuilderAPI_MakeEdge_24(curve).Edge());
      }
    }
  }
  if (!mk.IsDone()) throw new Error('contorno não fecha');
  return mk.Wire();
}

function profileToFace(oc: OC, s: Sketch, plane: Plane, prof: Profile): TopoDS_Face {
  const outer = loopToWire(oc, s, plane, prof.outer);
  const mkFace = new oc.BRepBuilderAPI_MakeFace_15(outer, true);
  if (!mkFace.IsDone()) throw new Error('não deu para formar uma face plana com esse contorno');
  let face = mkFace.Face();
  for (const h of prof.holes) {
    const w = loopToWire(oc, s, plane, h);
    const mf = new oc.BRepBuilderAPI_MakeFace_22(face, oc.TopoDS.Wire_1(w.Reversed()));
    if (!mf.IsDone()) throw new Error('furo inválido no contorno');
    face = mf.Face();
  }
  const fix = new oc.ShapeFix_Face_2(face); fix.Perform(); face = fix.Face();
  return face;
}

/** Faces planas (uma por perfil fechado) de um esboço, no espaço 3D. */
export function sketchFaces(oc: OC, doc: ForjaDocument, sketchId: Id, profilePoint?: [number, number], planeOverride?: Plane): { faces: TopoDS_Face[]; plane: Plane } {
  const sk = getSketch(doc, sketchId); const plane = planeOverride ?? getPlane(doc, sk.plane);
  let profiles = extractProfiles(sk);
  if (!profiles.length) throw new Error('o esboço não tem contorno fechado');
  if (profilePoint) { const pt = { x: profilePoint[0], y: profilePoint[1] }; profiles = profiles.filter((p) => profileContainsPoint(sk, p, pt)); if (!profiles.length) throw new Error('a região escolhida não existe mais no esboço'); }
  return { faces: profiles.map((p) => profileToFace(oc, sk, plane, p)), plane };
}

// ---------- Operações ----------

function hasSolid(oc: OC, sh: TopoDS_Shape): boolean {
  if (sh.IsNull()) return false;
  const ex = new oc.TopExp_Explorer_2(sh, oc.TopAbs_ShapeEnum.TopAbs_SOLID as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never);
  const ok = ex.More(); ex.delete(); return ok;
}

export function boolOp(oc: OC, kind: 'fuse' | 'cut' | 'common', a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape {
  const pr = new oc.Message_ProgressRange_1();
  const op = kind === 'fuse' ? new oc.BRepAlgoAPI_Fuse_3(a, b, pr) : kind === 'cut' ? new oc.BRepAlgoAPI_Cut_3(a, b, pr) : new oc.BRepAlgoAPI_Common_3(a, b, pr);
  op.Build(new oc.Message_ProgressRange_1());
  if (op.HasErrors() || !op.IsDone()) throw new Error('operação booleana falhou');
  const sh = op.Shape();
  if (!hasSolid(oc, sh)) throw new Error(kind === 'cut' ? 'o corte removeu o corpo inteiro' : kind === 'common' ? 'os corpos não se cruzam' : 'resultado vazio');
  return sh;
}

export function extrudeFaces(oc: OC, faces: TopoDS_Face[], dir: V3, depth: number, symmetric: boolean): TopoDS_Shape {
  if (!(depth > 0)) throw new Error('profundidade inválida');
  let result: TopoDS_Shape | null = null;
  for (const face of faces) {
    let base: TopoDS_Shape = face;
    if (symmetric) {
      const t = new oc.gp_Trsf_1(); t.SetTranslation_1(new oc.gp_Vec_4(-dir[0] * depth / 2, -dir[1] * depth / 2, -dir[2] * depth / 2));
      base = new oc.BRepBuilderAPI_Transform_2(face, t, true).Shape();
    }
    const prism = new oc.BRepPrimAPI_MakePrism_1(base, new oc.gp_Vec_4(dir[0] * depth, dir[1] * depth, dir[2] * depth), false, true);
    const solid = prism.Shape();
    if (!hasSolid(oc, solid)) throw new Error('a extrusão não gerou um sólido');
    result = result ? boolOp(oc, 'fuse', result, solid) : solid;
  }
  return result!;
}

/** Eixo de revolução em 3D a partir do esboço: usa a linha referenciada se ainda existir, senão ponto + direção. */
export function resolveAxis(sk: Sketch, plane: Plane, axis: SketchAxis): { p: V3; d: V3; p2: [number, number]; d2: [number, number] } {
  let p2 = axis.p, d2 = axis.d;
  const line = axis.line ? findEntity(sk, axis.line) : undefined;
  if (line && line.type === 'line') { const a = getPoint(sk, line.a), b = getPoint(sk, line.b); p2 = [a.x, a.y]; d2 = [b.x - a.x, b.y - a.y]; }
  const L = Math.hypot(d2[0], d2[1]); if (L < 1e-9) throw new Error('eixo de revolução degenerado');
  d2 = [d2[0] / L, d2[1] / L];
  const p = planeToWorld(plane, p2[0], p2[1]);
  const d: V3 = [plane.u[0] * d2[0] + plane.v[0] * d2[1], plane.u[1] * d2[0] + plane.v[1] * d2[1], plane.u[2] * d2[0] + plane.v[2] * d2[1]];
  return { p, d, p2, d2 };
}

/** O perfil fica inteiro de um lado do eixo? (pode encostar, não pode cruzar) */
function profileCrossesAxis(sk: Sketch, p: [number, number], d: [number, number]): boolean {
  let pos = false, neg = false;
  const test = (x: number, y: number) => { const s = d[0] * (y - p[1]) - d[1] * (x - p[0]); if (s > 1e-6) pos = true; else if (s < -1e-6) neg = true; };
  for (const e of sk.entities) {
    if (e.construction) continue;
    if (e.type === 'line') { const a = getPoint(sk, e.a), b = getPoint(sk, e.b); test(a.x, a.y); test(b.x, b.y); }
    else if (e.type === 'circle' || e.type === 'arc') { const c = getPoint(sk, e.center); const px = -d[1], py = d[0]; test(c.x + px * e.r, c.y + py * e.r); test(c.x - px * e.r, c.y - py * e.r); if (e.type === 'arc') { const s = getPoint(sk, e.start), en = getPoint(sk, e.end); test(s.x, s.y); test(en.x, en.y); } }
    else for (const q of sampleEntity(sk, e)) test(q.x, q.y);
  }
  return pos && neg;
}

export function revolveFaces(oc: OC, faces: TopoDS_Face[], p: V3, d: V3, angleDeg: number): TopoDS_Shape {
  const full = Math.abs(angleDeg) >= 360 - 1e-6;
  const ax = new oc.gp_Ax1_2(pnt(oc, p), new oc.gp_Dir_4(d[0], d[1], d[2]));
  let result: TopoDS_Shape | null = null;
  for (const face of faces) {
    const mk = full ? new oc.BRepPrimAPI_MakeRevol_2(face, ax, true) : new oc.BRepPrimAPI_MakeRevol_1(face, ax, (angleDeg * Math.PI) / 180, true);
    const solid = mk.Shape();
    if (!hasSolid(oc, solid)) throw new Error('a revolução não gerou um sólido');
    result = result ? boolOp(oc, 'fuse', result, solid) : solid;
  }
  return result!;
}

export function bbox(oc: OC, shape: TopoDS_Shape): [V3, V3] {
  const box = new oc.Bnd_Box_1(); oc.BRepBndLib.Add(shape, box, true);
  const mn = box.CornerMin(), mx = box.CornerMax();
  const out: [V3, V3] = [[mn.X(), mn.Y(), mn.Z()], [mx.X(), mx.Y(), mx.Z()]];
  mn.delete(); mx.delete(); box.delete();
  return out;
}

interface EdgeInfo { edge: TopoDS_Edge; mid: V3; len: number; curve: BRepAdaptor_Curve; /** Posição no mapa de arestas do shape (1-based), para casar com as faces. */ mapIndex: number; }

function enumerateEdges(oc: OC, shape: TopoDS_Shape): EdgeInfo[] {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE as never, map);
  const out: EdgeInfo[] = [];
  for (let i = 1; i <= map.Size(); i++) {
    const edge = oc.TopoDS.Edge_1(map.FindKey(i));
    if (oc.BRep_Tool.Degenerated(edge)) continue;
    const curve = new oc.BRepAdaptor_Curve_2(edge);
    const f = curve.FirstParameter(), l = curve.LastParameter();
    const m = curve.Value((f + l) / 2); const mid: V3 = [m.X(), m.Y(), m.Z()]; m.delete();
    const len = oc.GCPnts_AbscissaPoint.Length_1(curve);
    out.push({ edge, mid, len, curve, mapIndex: i });
  }
  map.delete();
  return out;
}

/** Acha a aresta que corresponde a uma referência geométrica. */
export function matchEdge(edges: EdgeInfo[], ref: EdgeRef): EdgeInfo | null {
  let best: EdgeInfo | null = null; let bd = Infinity;
  const tol = Math.max(0.05, ref.len * 0.02);
  for (const e of edges) {
    if (Math.abs(e.len - ref.len) > Math.max(0.05, ref.len * 0.1)) continue;
    const d = dist3(e.mid, ref.mid);
    if (d < tol && d < bd) { bd = d; best = e; }
  }
  return best;
}

export function applyFillet(oc: OC, f: FilletFeature, shape: TopoDS_Shape): TopoDS_Shape {
  const edges = enumerateEdges(oc, shape);
  const picked: TopoDS_Edge[] = [];
  for (const ref of f.edges) { const m = matchEdge(edges, ref); if (!m) throw new Error('aresta não encontrada (a geometria mudou)'); picked.push(m.edge); }
  if (!picked.length) throw new Error('nenhuma aresta');
  const pr = new oc.Message_ProgressRange_1();
  let result: TopoDS_Shape;
  if (f.type === 'fillet') {
    const mk = new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational as never);
    for (const e of picked) mk.Add_2(f.radius, e);
    mk.Build(pr);
    if (!mk.IsDone()) throw new Error('filete impossível com esse raio nessas arestas');
    result = mk.Shape();
  } else {
    const mk = new oc.BRepFilletAPI_MakeChamfer(shape);
    for (const e of picked) mk.Add_2(f.radius, e);
    mk.Build(pr);
    if (!mk.IsDone()) throw new Error('chanfro impossível com essa distância nessas arestas');
    result = mk.Shape();
  }
  for (const e of edges) e.curve.delete();
  if (!hasSolid(oc, result)) throw new Error('o resultado não é um sólido');
  return result;
}

interface FaceInfo { face: TopoDS_Face; center: V3; normal: V3; area: number; u: V3; v: V3; }

/** Faces planas de uma forma com centro, normal para fora e área. */
export function planarFaces(oc: OC, shape: TopoDS_Shape): FaceInfo[] {
  const out: FaceInfo[] = [];
  const fmap = new oc.TopTools_IndexedMapOfShape_1(); oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE as never, fmap);
  const REVERSED = enumVal(oc.TopAbs_Orientation.TopAbs_REVERSED); const PLANE = enumVal(oc.GeomAbs_SurfaceType.GeomAbs_Plane);
  for (let i = 1; i <= fmap.Size(); i++) {
    const face = oc.TopoDS.Face_1(fmap.FindKey(i));
    const surf = new oc.BRepAdaptor_Surface_2(face, true);
    if (enumVal(surf.GetType()) !== PLANE) { surf.delete(); continue; }
    const sgn = enumVal(face.Orientation_1()) === REVERSED ? -1 : 1;
    const pln = surf.Plane(); const n = pln.Axis().Direction(); const ux = pln.XAxis().Direction();
    const props = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(face, props, false, false); const c = props.CentreOfMass();
    const normal: V3 = [sgn * n.X(), sgn * n.Y(), sgn * n.Z()]; const u: V3 = [ux.X(), ux.Y(), ux.Z()]; const v = cross3(normal, u);
    out.push({ face, center: [c.X(), c.Y(), c.Z()], normal, area: props.Mass(), u, v });
    c.delete(); props.delete(); n.delete(); ux.delete(); pln.delete(); surf.delete();
  }
  fmap.delete();
  return out;
}

/** Acha a face plana que corresponde a uma referência (centro, normal, área). */
export function matchFace(faces: FaceInfo[], ref: FaceRef): FaceInfo | null {
  let best: FaceInfo | null = null; let bd = Infinity;
  const tol = Math.max(0.5, Math.sqrt(ref.area) * 0.05);
  for (const f of faces) {
    if (f.normal[0] * ref.normal[0] + f.normal[1] * ref.normal[1] + f.normal[2] * ref.normal[2] < 0.95) continue;
    if (Math.abs(f.area - ref.area) > Math.max(1, ref.area * 0.25)) continue;
    const d = dist3(f.center, ref.center);
    if (d < tol && d < bd) { bd = d; best = f; }
  }
  return best;
}

/** Puxa (distância > 0, funde) ou empurra (< 0, corta) uma face plana do corpo. */
export function pushPull(oc: OC, shape: TopoDS_Shape, ref: FaceRef, distance: number): TopoDS_Shape {
  if (!(Math.abs(distance) > 1e-6)) throw new Error('distância nula');
  const faces = planarFaces(oc, shape);
  const f = matchFace(faces, ref); if (!f) throw new Error('face não encontrada (a geometria mudou)');
  const n = f.normal; const d = distance;
  const prism = new oc.BRepPrimAPI_MakePrism_1(f.face, new oc.gp_Vec_4(n[0] * d, n[1] * d, n[2] * d), false, true).Shape();
  if (!hasSolid(oc, prism)) throw new Error('não deu para puxar essa face');
  return boolOp(oc, d > 0 ? 'fuse' : 'cut', shape, prism);
}

/** Recalcula todos os corpos do documento, feature por feature. Erros não param o resto. */
export function rebuildDocument(oc: OC, doc: ForjaDocument): RebuildShapes {
  const bodies = new Map<Id, TopoDS_Shape>(); const order: Id[] = []; const errors: FeatureError[] = [];
  for (const f of doc.features) {
    try {
      const place = (op: ExtrudeOp, targetId: Id | undefined, tool: TopoDS_Shape) => {
        if (op === 'new') { bodies.set(f.id, tool); order.push(f.id); return; }
        const target = targetId ? bodies.get(targetId) : undefined; if (!target) throw new Error('o corpo alvo não existe mais');
        bodies.set(targetId!, boolOp(oc, op === 'add' ? 'fuse' : 'cut', target, tool));
      };
      if (f.type === 'extrude' || f.type === 'revolve') {
        if (f.visible === false) continue;
        const { faces, plane } = sketchFaces(oc, doc, f.sketch, f.type === 'extrude' ? f.profilePoint : undefined);
        const target = f.op !== 'new' && f.target ? bodies.get(f.target) : undefined;
        if (f.op !== 'new' && !target) throw new Error('o corpo alvo não existe mais');
        let tool: TopoDS_Shape;
        if (f.type === 'extrude') {
          let dir = planeNormal(plane); if (f.flip) dir = neg(dir);
          let depth = f.depth;
          if (f.throughAll && target) { const [mn, mx] = bbox(oc, target); depth = dist3(mn, mx) * 2 + depth; }
          tool = extrudeFaces(oc, faces, dir, depth, !!f.symmetric);
        } else {
          const sk = getSketch(doc, f.sketch);
          const ax = resolveAxis(sk, plane, f.axis);
          if (profileCrossesAxis(sk, ax.p2, ax.d2)) throw new Error('o perfil cruza o eixo de revolução');
          tool = revolveFaces(oc, faces, ax.p, f.flip ? neg(ax.d) : ax.d, f.angle);
        }
        if (f.pattern) tool = applyPattern(oc, tool, f.pattern);
        // Mesmo esboço em outras faces do corpo alvo: o perfil vai para o plano de cada face (origem no centro dela).
        if (f.type === 'extrude' && f.onFaces?.length && target) {
          const infos = planarFaces(oc, target);
          for (const ref of f.onFaces) {
            const fi = matchFace(infos, ref); if (!fi) throw new Error('uma das faces do rasgo não foi encontrada');
            const facePlane: Plane = { id: 'tmp', name: '', origin: fi.center, u: fi.u, v: fi.v };
            const { faces: ff } = sketchFaces(oc, doc, f.sketch, f.profilePoint, facePlane);
            let depth = f.depth; if (f.throughAll) { const [mn, mx] = bbox(oc, target); depth = dist3(mn, mx) * 2 + depth; }
            const dir = f.op === 'cut' ? neg(fi.normal) : fi.normal;
            let t2 = extrudeFaces(oc, ff, dir, depth, !!f.symmetric); if (f.pattern) t2 = applyPattern(oc, t2, f.pattern);
            tool = boolOp(oc, 'fuse', tool, t2);
          }
        }
        place(f.op, f.target, tool);
      } else if (f.type === 'sweep') {
        const wire = sketchWire(oc, doc, f.paths?.length ? f.paths : [f.path]);
        if (f.tube) place(f.op, f.target, tubeAlongPath(oc, wire, f.tube.outer / 2, f.tube.inner / 2));
        else { const { faces } = sketchFaces(oc, doc, f.profile); place(f.op, f.target, sweepFaces(oc, faces, wire)); }
      } else if (f.type === 'loft') {
        place(f.op, f.target, loftSketches(oc, doc, f.sketches, f.ruled));
      } else if (f.type === 'import') {
        bodies.set(f.id, importSTEP(oc, f.step)); order.push(f.id);
      } else if (f.type === 'shell') {
        const shape = bodies.get(f.body); if (!shape) throw new Error('o corpo não existe mais');
        bodies.set(f.body, shellBody(oc, shape, f.thickness, f.openFaces));
      } else if (f.type === 'mirror') {
        const shape = bodies.get(f.body); if (!shape) throw new Error('o corpo não existe mais');
        const copy = mirrorShape(oc, shape, f.origin, f.normal);
        if (f.join) bodies.set(f.body, boolOp(oc, 'fuse', shape, copy)); else { bodies.set(f.id, copy); order.push(f.id); }
      } else if (f.type === 'transform') {
        const shape = bodies.get(f.body); if (!shape) throw new Error('o corpo não existe mais');
        bodies.set(f.body, transformBody(oc, shape, f.translate, f.axisPoint, f.axisDir, f.angle, f.scale));
      } else if (f.type === 'split') {
        const shape = bodies.get(f.body); if (!shape) throw new Error('o corpo não existe mais');
        const { front, back } = splitBody(oc, shape, f.origin, f.normal);
        if (f.keep === 'front') { if (!front) throw new Error('nada sobra desse lado'); bodies.set(f.body, front); }
        else if (f.keep === 'back') { if (!back) throw new Error('nada sobra desse lado'); bodies.set(f.body, back); }
        else { if (!front || !back) throw new Error('o plano não corta o corpo'); bodies.set(f.body, front); bodies.set(f.id, back); order.push(f.id); }
      } else if (f.type === 'pushpull') {
        let shape = bodies.get(f.body); if (!shape) throw new Error('o corpo não existe mais');
        for (const ref of [f.face, ...(f.faces ?? [])]) shape = pushPull(oc, shape, ref, f.distance);
        bodies.set(f.body, shape);
      } else if (f.type === 'fillet' || f.type === 'chamfer') {
        const shape = bodies.get(f.body); if (!shape) throw new Error('o corpo não existe mais');
        bodies.set(f.body, applyFillet(oc, f, shape));
      } else if (f.type === 'boolean') {
        const a = bodies.get(f.body), b = bodies.get(f.tool);
        if (!a || !b) throw new Error('um dos corpos não existe mais');
        bodies.set(f.body, boolOp(oc, f.op === 'union' ? 'fuse' : f.op === 'subtract' ? 'cut' : 'common', a, b));
        bodies.delete(f.tool); const i = order.indexOf(f.tool); if (i >= 0) order.splice(i, 1);
      }
    } catch (e) {
      errors.push({ feature: f.id, message: errorMessage(oc, e) });
    }
  }
  return { bodies: order.filter((id) => bodies.has(id)).map((id) => ({ id, shape: bodies.get(id)! })), errors };
}

// ---------- Malha ----------

/** Gera malha, faces e arestas de um corpo. `quality` maior = mais fino. */
export function tessellate(oc: OC, body: BuiltBody, name: string, quality = 1): BodyData {
  const shape = body.shape;
  const bb = bbox(oc, shape); const diag = dist3(bb[0], bb[1]) || 1;
  const lin = Math.max(0.005, (diag * 0.0012) / quality);
  const mesher = new oc.BRepMesh_IncrementalMesh_2(shape, lin, false, 0.3 / quality, false); mesher.delete();

  const positions: number[] = [], normals: number[] = [], indices: number[] = [], triFace: number[] = [];
  const faces: FaceData[] = []; const faceShapes: [number, TopoDS_Face][] = [];
  const fmap = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE as never, fmap);
  const REVERSED = enumVal(oc.TopAbs_Orientation.TopAbs_REVERSED);
  const ST = oc.GeomAbs_SurfaceType;
  const typeOf = (v: number): FaceType => v === enumVal(ST.GeomAbs_Plane) ? 'plane' : v === enumVal(ST.GeomAbs_Cylinder) ? 'cylinder' : v === enumVal(ST.GeomAbs_Cone) ? 'cone' : v === enumVal(ST.GeomAbs_Sphere) ? 'sphere' : v === enumVal(ST.GeomAbs_Torus) ? 'torus' : 'other';
  for (let i = 1; i <= fmap.Size(); i++) {
    const face = oc.TopoDS.Face_1(fmap.FindKey(i));
    const loc = new oc.TopLoc_Location_1();
    const triH = oc.BRep_Tool.Triangulation(face, loc, 0 as never);
    if (triH.IsNull()) { loc.delete(); continue; }
    const tri = triH.get();
    if (!tri.HasNormals()) tri.ComputeNormals();
    const ident = loc.IsIdentity(); const trsf = loc.Transformation();
    const reversed = enumVal(face.Orientation_1()) === REVERSED; const sgn = reversed ? -1 : 1;
    const base = positions.length / 3; const nn = tri.NbNodes();
    let cx = 0, cy = 0, cz = 0;
    for (let k = 1; k <= nn; k++) {
      let p = tri.Node(k); if (!ident) { const q = p.Transformed(trsf); p.delete(); p = q; }
      positions.push(p.X(), p.Y(), p.Z()); cx += p.X(); cy += p.Y(); cz += p.Z(); p.delete();
      let n = tri.Normal_1(k); if (!ident) { const q = n.Transformed(trsf); n.delete(); n = q; }
      normals.push(sgn * n.X(), sgn * n.Y(), sgn * n.Z()); n.delete();
    }
    const triStart = indices.length / 3; const nt = tri.NbTriangles();
    for (let k = 1; k <= nt; k++) {
      const t = tri.Triangle(k); let a = t.Value(1), b = t.Value(2), c = t.Value(3); t.delete();
      if (reversed) { const tmp = b; b = c; c = tmp; }
      indices.push(base + a - 1, base + b - 1, base + c - 1); triFace.push(faces.length);
    }
    const fd: FaceData = { index: faces.length, type: 'other', area: 0, triStart, triCount: nt, center: [cx / nn, cy / nn, cz / nn] };
    const surf = new oc.BRepAdaptor_Surface_2(face, true);
    fd.type = typeOf(enumVal(surf.GetType()));
    if (fd.type === 'plane') {
      const pln = surf.Plane(); const o = pln.Location(); const n = pln.Axis().Direction(); const ux = pln.XAxis().Direction(), vy = pln.YAxis().Direction();
      fd.origin = [o.X(), o.Y(), o.Z()]; fd.normal = [sgn * n.X(), sgn * n.Y(), sgn * n.Z()];
      fd.u = [ux.X(), ux.Y(), ux.Z()]; fd.v = [sgn * vy.X(), sgn * vy.Y(), sgn * vy.Z()];
      o.delete(); n.delete(); ux.delete(); vy.delete(); pln.delete();
    } else if (fd.type === 'cylinder') {
      const cyl = surf.Cylinder(); const ax = cyl.Axis(); const o = ax.Location(), dn = ax.Direction();
      fd.axisOrigin = [o.X(), o.Y(), o.Z()]; fd.axisDir = [dn.X(), dn.Y(), dn.Z()]; fd.radius = cyl.Radius();
      o.delete(); dn.delete(); ax.delete(); cyl.delete();
    }
    const props = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(face, props, false, false); fd.area = props.Mass();
    const cm = props.CentreOfMass(); if (Number.isFinite(cm.X())) fd.center = [cm.X(), cm.Y(), cm.Z()]; cm.delete(); props.delete();
    surf.delete(); trsf.delete(); loc.delete();
    faceShapes.push([faces.length, face]); faces.push(fd);
  }

  const edges: EdgeData[] = []; const edgeByMap = new Map<number, number>();
  for (const e of enumerateEdges(oc, shape)) {
    const disc = new oc.GCPnts_TangentialDeflection_2(e.curve, 0.25 / quality, Math.max(0.01, lin * 2), 2, 1e-9, 1e-7);
    const n = disc.NbPoints(); const pts = new Float32Array(n * 3);
    for (let k = 1; k <= n; k++) { const p = disc.Value(k); pts[(k - 1) * 3] = p.X(); pts[(k - 1) * 3 + 1] = p.Y(); pts[(k - 1) * 3 + 2] = p.Z(); p.delete(); }
    disc.delete(); e.curve.delete();
    edgeByMap.set(e.mapIndex, edges.length);
    edges.push({ index: edges.length, points: pts, mid: e.mid, len: e.len });
  }
  // Quais arestas contornam cada face (para projetar uma face inteira no esboço).
  const emap = new oc.TopTools_IndexedMapOfShape_1(); oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE as never, emap);
  for (const [fi, face] of faceShapes) {
    const ex = new oc.TopExp_Explorer_2(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never); const set = new Set<number>();
    for (; ex.More(); ex.Next()) { const k = edgeByMap.get(emap.FindIndex(ex.Current())); if (k != null) set.add(k); }
    ex.delete(); faces[fi].edges = [...set];
  }
  emap.delete(); fmap.delete();

  const vp = new oc.GProp_GProps_1(); oc.BRepGProp.VolumeProperties_1(shape, vp, false, false, false); const volume = vp.Mass(); vp.delete();
  const sp = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(shape, sp, false, false); const area = sp.Mass(); sp.delete();

  return {
    id: body.id, name,
    positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices), triFace: Uint32Array.from(triFace),
    faces, edges, volume, area, bbox: bb,
  };
}

// ---------- STEP ----------

export function exportSTEP(oc: OC, bodies: BuiltBody[]): string {
  const w = new oc.STEPControl_Writer_1();
  for (const b of bodies) w.Transfer(b.shape, oc.STEPControl_StepModelType.STEPControl_AsIs as never, true, new oc.Message_ProgressRange_1());
  const name = '/forja.step';
  w.Write(name);
  const text = oc.FS.readFile(name, { encoding: 'utf8' }) as string;
  try { oc.FS.unlink(name); } catch { /* ignore */ }
  w.delete();
  return text;
}

// ---------- Projeções para desenho técnico (HLR) ----------

const norm3 = (v: V3): V3 => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function collectEdges(oc: OC, comp: TopoDS_Shape, hidden: boolean, polys: Float32Array[], circles: ProjCircle[], bb: number[]): void {
  if (comp.IsNull()) return;
  oc.BRepLib.BuildCurves3d_2(comp);
  const ex = new oc.TopExp_Explorer_2(comp, oc.TopAbs_ShapeEnum.TopAbs_EDGE as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never);
  const circleType = enumVal(oc.GeomAbs_CurveType.GeomAbs_Circle);
  for (; ex.More(); ex.Next()) {
    const edge = oc.TopoDS.Edge_1(ex.Current());
    let c: BRepAdaptor_Curve;
    try { c = new oc.BRepAdaptor_Curve_2(edge); } catch { continue; }
    const f = c.FirstParameter(), l = c.LastParameter();
    if (!Number.isFinite(f) || !Number.isFinite(l)) { c.delete(); continue; }
    if (enumVal(c.GetType()) === circleType && Math.abs(l - f) >= 2 * Math.PI - 1e-6) {
      const circ = c.Circle(); const loc = circ.Location();
      circles.push({ cx: loc.X(), cy: loc.Y(), r: circ.Radius(), hidden }); loc.delete(); circ.delete();
    }
    const disc = new oc.GCPnts_TangentialDeflection_2(c, 0.08, 0.01, 2, 1e-9, 1e-7);
    const n = disc.NbPoints(); if (n < 2) { disc.delete(); c.delete(); continue; }
    const pts = new Float32Array(n * 2);
    for (let k = 1; k <= n; k++) {
      const p = disc.Value(k); const x = p.X(), y = p.Y(); p.delete();
      pts[(k - 1) * 2] = x; pts[(k - 1) * 2 + 1] = y;
      if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y;
    }
    polys.push(pts); disc.delete(); c.delete();
  }
  ex.delete();
}

/** Distância de um ponto a uma polilinha 2D. */
function distToPolyline(x: number, y: number, pts: Float32Array): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
    const dx = bx - ax, dy = by - ay; const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
    if (d < best) best = d;
  }
  return best;
}

/** Remove linhas ocultas que coincidem com linhas visíveis (arestas de trás alinhadas com o contorno). */
export function dropCoveredHidden(visible: Float32Array[], hidden: Float32Array[], tol = 0.02): Float32Array[] {
  const covered = (x: number, y: number) => { for (const v of visible) if (distToPolyline(x, y, v) <= tol) return true; return false; };
  return hidden.filter((h) => {
    // Testa pontas e meios de cada trecho: uma oculta que só encosta no contorno pelas pontas continua oculta.
    for (let i = 0; i + 1 < h.length; i += 2) {
      if (!covered(h[i], h[i + 1])) return true;
      if (i + 3 < h.length && !covered((h[i] + h[i + 2]) / 2, (h[i + 1] + h[i + 3]) / 2)) return true;
    }
    return false;
  });
}

/** Projeta os corpos em cada vista com remoção de linhas ocultas. Coordenadas no plano da vista (mm). */
export function projectViews(oc: OC, shapes: TopoDS_Shape[], specs: ViewSpec[]): ProjectedView[] {
  return specs.map((spec) => {
    const n = norm3(spec.n); const r = norm3(cross3(spec.up, n));
    const algo = new oc.HLRBRep_Algo_1();
    for (const s of shapes) algo.Add_2(s, 0);
    const ax = new oc.gp_Ax2_2(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(n[0], n[1], n[2]), new oc.gp_Dir_4(r[0], r[1], r[2]));
    const proj = new oc.HLRAlgo_Projector_2(ax);
    algo.Projector_1(proj); algo.Update(); algo.Hide_1();
    const ts = new oc.HLRBRep_HLRToShape(new oc.Handle_HLRBRep_Algo_2(algo));
    const visible: Float32Array[] = [], hidden: Float32Array[] = [], tangent: Float32Array[] = [], circles: ProjCircle[] = [];
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    collectEdges(oc, ts.VCompound_1(), false, visible, circles, bb);
    collectEdges(oc, ts.OutLineVCompound_1(), false, visible, circles, bb);
    collectEdges(oc, ts.Rg1LineVCompound_1(), false, tangent, [], bb);
    collectEdges(oc, ts.HCompound_1(), true, hidden, circles, bb);
    collectEdges(oc, ts.OutLineHCompound_1(), true, hidden, circles, bb);
    ts.delete(); algo.delete();
    if (!Number.isFinite(bb[0])) bb.splice(0, 4, 0, 0, 0, 0);
    const hiddenClean = dropCoveredHidden(visible, hidden);
    const circlesClean = circles.filter((c, i) => !circles.some((o, j) => j < i && Math.abs(o.cx - c.cx) < 1e-4 && Math.abs(o.cy - c.cy) < 1e-4 && Math.abs(o.r - c.r) < 1e-4));
    return { name: spec.name, visible, hidden: hiddenClean, tangent, circles: circlesClean, bbox: bb as [number, number, number, number] };
  });
}

// ---------- Montagens ----------

/** Aplica uma matriz 4×4 (linha-maior) a uma forma. */
export function transformShape(oc: OC, shape: TopoDS_Shape, m: number[]): TopoDS_Shape {
  const t = new oc.gp_Trsf_1();
  t.SetValues(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11]);
  const out = new oc.BRepBuilderAPI_Transform_2(shape, t, true).Shape(); t.delete();
  return out;
}

/** Recalcula cada peça uma vez (com cache por conteúdo) e devolve as formas de todas as instâncias no mundo. */
export function assemblyShapes(oc: OC, parts: { id: Id; doc: ForjaDocument }[], instances: { part: Id; matrix: number[] }[], cache: Map<string, TopoDS_Shape[]>): TopoDS_Shape[] {
  const byPart = new Map<Id, TopoDS_Shape[]>();
  for (const p of parts) {
    const key = JSON.stringify({ s: p.doc.sketches, f: p.doc.features, p: p.doc.planes });
    let shapes = cache.get(key);
    if (!shapes) { shapes = rebuildDocument(oc, p.doc).bodies.map((b) => b.shape); cache.set(key, shapes); }
    byPart.set(p.id, shapes);
  }
  const out: TopoDS_Shape[] = [];
  for (const inst of instances) for (const sh of byPart.get(inst.part) ?? []) out.push(transformShape(oc, sh, inst.matrix));
  return out;
}

/** Volume comum entre pares de instâncias em cada passo do movimento (0 quando só encostam). */
export function interferences(oc: OC, parts: { id: Id; doc: ForjaDocument }[], steps: { part: Id; matrix: number[] }[][], cache: Map<string, TopoDS_Shape[]>, minVolume = 0.01): InterferenceHit[] {
  const hits: InterferenceHit[] = [];
  steps.forEach((instances, step) => {
    // Uma forma (composta) por instância, já no mundo.
    const perInst: TopoDS_Shape[][] = instances.map((inst) => assemblyShapes(oc, parts, [inst], cache));
    const boxes = perInst.map((shapes) => { const box = new oc.Bnd_Box_1(); for (const sh of shapes) oc.BRepBndLib.Add(sh, box, false); return box; });
    for (let a = 0; a < perInst.length; a++) for (let b = a + 1; b < perInst.length; b++) {
      if (boxes[a].IsOut_4(boxes[b])) continue;
      let volume = 0;
      for (const sa of perInst[a]) for (const sb of perInst[b]) {
        try {
          const op = new oc.BRepAlgoAPI_Common_3(sa, sb, new oc.Message_ProgressRange_1()); op.Build(new oc.Message_ProgressRange_1());
          if (!op.HasErrors() && hasSolid(oc, op.Shape())) { const props = new oc.GProp_GProps_1(); oc.BRepGProp.VolumeProperties_1(op.Shape(), props, false, false, false); volume += Math.abs(props.Mass()); props.delete(); }
          op.delete();
        } catch { /* par problemático: segue */ }
      }
      if (volume > minVolume) hits.push({ step, a, b, volume });
    }
    for (const box of boxes) box.delete();
  });
  return hits;
}

// ---------- Padrão, casca, espelho, transformação, divisão, varredura, loft, importação ----------

function transformWithTrsf(oc: OC, shape: TopoDS_Shape, t: gp_Trsf): TopoDS_Shape { return new oc.BRepBuilderAPI_Transform_2(shape, t, true).Shape(); }

/** Repete a forma-ferramenta: cópias fundidas numa só. */
export function applyPattern(oc: OC, tool: TopoDS_Shape, spec: PatternSpec): TopoDS_Shape {
  const count = Math.max(2, Math.min(200, Math.round(spec.count)));
  let result = tool;
  for (let i = 1; i < count; i++) {
    const t = new oc.gp_Trsf_1();
    if (spec.kind === 'linear') t.SetTranslation_1(new oc.gp_Vec_4(spec.step[0] * i, spec.step[1] * i, spec.step[2] * i));
    else { const ax = new oc.gp_Ax1_2(pnt(oc, spec.axisPoint), new oc.gp_Dir_4(spec.axisDir[0], spec.axisDir[1], spec.axisDir[2])); const full = Math.abs(spec.angle) >= 360 - 1e-6; const stepAng = full ? (360 / count) : spec.angle / (count - 1); t.SetRotation_1(ax, (stepAng * i * Math.PI) / 180); }
    result = boolOp(oc, 'fuse', result, transformWithTrsf(oc, tool, t));
  }
  return result;
}

/** Casca com paredes de `thickness`; faces em `openFaces` são removidas (abertura). Sem faces: corpo oco fechado. */
export function shellBody(oc: OC, shape: TopoDS_Shape, thickness: number, openFaces: FaceRef[]): TopoDS_Shape {
  const mk = new oc.BRepOffsetAPI_MakeThickSolid();
  if (!openFaces.length) {
    mk.MakeThickSolidBySimple(shape, -Math.abs(thickness));
  } else {
    const faces = planarFaces(oc, shape); const list = new oc.TopTools_ListOfShape_1();
    for (const ref of openFaces) { const f = matchFace(faces, ref); if (!f) throw new Error('face da abertura não encontrada'); list.Append_1(f.face); }
    mk.MakeThickSolidByJoin(shape, list, -Math.abs(thickness), 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin as never, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc as never, false, new oc.Message_ProgressRange_1());
  }
  const out = mk.Shape();
  if (!hasSolid(oc, out)) throw new Error('não deu para fazer a casca com essa espessura');
  return out;
}

export function mirrorShape(oc: OC, shape: TopoDS_Shape, origin: V3, normal: V3): TopoDS_Shape {
  const t = new oc.gp_Trsf_1(); t.SetMirror_3(new oc.gp_Ax2_3(pnt(oc, origin), new oc.gp_Dir_4(normal[0], normal[1], normal[2])));
  return transformWithTrsf(oc, shape, t);
}

export function transformBody(oc: OC, shape: TopoDS_Shape, translate: V3, axisPoint: V3, axisDir: V3, angleDeg: number, scale: number): TopoDS_Shape {
  const T = new oc.gp_Trsf_1(); T.SetTranslation_1(new oc.gp_Vec_4(translate[0], translate[1], translate[2]));
  if (Math.abs(angleDeg) > 1e-9) { const R = new oc.gp_Trsf_1(); R.SetRotation_1(new oc.gp_Ax1_2(pnt(oc, axisPoint), new oc.gp_Dir_4(axisDir[0], axisDir[1], axisDir[2])), (angleDeg * Math.PI) / 180); T.Multiply(R); }
  if (Math.abs(scale - 1) > 1e-9) { if (!(scale > 0)) throw new Error('escala inválida'); const [mn, mx] = bbox(oc, shape); const S = new oc.gp_Trsf_1(); S.SetScale(pnt(oc, [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2]), scale); T.Multiply(S); }
  return transformWithTrsf(oc, shape, T);
}

/** Divide por um plano: `front` fica do lado da normal, `back` do lado oposto (null quando vazio). */
export function splitBody(oc: OC, shape: TopoDS_Shape, origin: V3, normal: V3): { front: TopoDS_Shape | null; back: TopoDS_Shape | null } {
  const n = norm3(normal);
  const pln = new oc.gp_Pln_3(pnt(oc, origin), new oc.gp_Dir_4(n[0], n[1], n[2]));
  const face = new oc.BRepBuilderAPI_MakeFace_9(pln, -1e5, 1e5, -1e5, 1e5).Face();
  const half = new oc.BRepPrimAPI_MakeHalfSpace_1(face, pnt(oc, [origin[0] - n[0] * 10, origin[1] - n[1] * 10, origin[2] - n[2] * 10])).Solid();
  const tryOp = (kind: 'cut' | 'common') => { try { return boolOp(oc, kind, shape, half); } catch { return null; } };
  return { front: tryOp('cut'), back: tryOp('common') };
}

/** Caminho: linhas e arcos (não construção) de um ou mais esboços, emendados num fio aberto ou fechado (pode ser 3D). */
export function sketchWire(oc: OC, doc: ForjaDocument, sketchIds: Id | Id[]): TopoDS_Wire {
  const ids = Array.isArray(sketchIds) ? sketchIds : [sketchIds];
  const mk = new oc.BRepBuilderAPI_MakeWire_1(); let n = 0;
  for (const sketchId of ids) {
  const s = getSketch(doc, sketchId); const plane = getPlane(doc, s.plane);
  for (const e of s.entities) {
    if (e.construction) continue;
    if (e.type === 'line') { const a = getPoint(s, e.a), b = getPoint(s, e.b); mk.Add_1(new oc.BRepBuilderAPI_MakeEdge_3(pnt(oc, planeToWorld(plane, a.x, a.y)), pnt(oc, planeToWorld(plane, b.x, b.y))).Edge()); n++; }
    else if (e.type === 'arc') {
      const c = getPoint(s, e.center), a = getPoint(s, e.start), b = getPoint(s, e.end);
      const a0 = Math.atan2(a.y - c.y, a.x - c.x); let sweep = Math.atan2(b.y - c.y, b.x - c.x) - a0; while (sweep <= 0) sweep += 2 * Math.PI;
      const tm = a0 + sweep / 2; const M = pnt(oc, planeToWorld(plane, c.x + e.r * Math.cos(tm), c.y + e.r * Math.sin(tm)));
      const arc = new oc.GC_MakeArcOfCircle_4(pnt(oc, planeToWorld(plane, a.x, a.y)), M, pnt(oc, planeToWorld(plane, b.x, b.y)));
      mk.Add_1(new oc.BRepBuilderAPI_MakeEdge_24(new oc.Handle_Geom_Curve_2(arc.Value().get())).Edge()); n++;
    }
    else if (e.type === 'spline') { mk.Add_1(splineEdge(oc, splinePoints(s, plane, e), !!e.closed)); n++; }
  }
  }
  if (!n) throw new Error('o caminho não tem linhas nem arcos');
  if (!mk.IsDone()) throw new Error('o caminho não está conectado de ponta a ponta');
  return mk.Wire();
}

/** Tubo (ou vareta maciça, com innerR = 0) de seção circular ao longo do caminho, começando perpendicular ao primeiro trecho. */
export function tubeAlongPath(oc: OC, path: TopoDS_Wire, outerR: number, innerR = 0): TopoDS_Shape {
  if (!(outerR > 0) || innerR >= outerR) throw new Error('diâmetros inválidos');
  // Ponto e tangente no começo do fio: primeira aresta na ordem do fio.
  const ex = new oc.BRepTools_WireExplorer_2(path); if (!ex.More()) throw new Error('caminho vazio');
  const first = ex.Current(); const c = new oc.BRepAdaptor_Curve_2(first);
  const reversed = enumVal(first.Orientation_1()) === enumVal(oc.TopAbs_Orientation.TopAbs_REVERSED);
  const u0 = reversed ? c.LastParameter() : c.FirstParameter();
  const p = new oc.gp_Pnt_1(); const v = new oc.gp_Vec_1(); c.D1(u0, p, v); if (reversed) v.Reverse();
  const ax = new oc.gp_Ax2_3(p, new oc.gp_Dir_2(v));
  const outerWire = new oc.BRepBuilderAPI_MakeWire_2(new oc.BRepBuilderAPI_MakeEdge_8(new oc.gp_Circ_2(ax, outerR)).Edge()).Wire();
  let face = new oc.BRepBuilderAPI_MakeFace_15(outerWire, true).Face();
  if (innerR > 0) { const innerWire = new oc.BRepBuilderAPI_MakeWire_2(new oc.BRepBuilderAPI_MakeEdge_8(new oc.gp_Circ_2(ax, innerR)).Edge()).Wire(); face = new oc.BRepBuilderAPI_MakeFace_22(face, oc.TopoDS.Wire_1(innerWire.Reversed())).Face(); const fix = new oc.ShapeFix_Face_2(face); fix.Perform(); face = fix.Face(); }
  ex.delete(); c.delete();
  return sweepFaces(oc, [face], path);
}

/** Sólido varrendo um fio fechado ao longo do caminho; cantos vivos do caminho viram cotovelos arredondados. */
function pipeWire(oc: OC, spine: TopoDS_Wire, profile: TopoDS_Wire): TopoDS_Shape {
  const mk = new oc.BRepOffsetAPI_MakePipeShell(spine);
  mk.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner as never);
  mk.Add_1(profile, false, false);
  mk.Build(new oc.Message_ProgressRange_1());
  if (!mk.IsDone()) throw new Error('a varredura não fechou (perfil deve estar no começo do caminho e o caminho ser contínuo)');
  mk.MakeSolid();
  const sh = mk.Shape(); if (!hasSolid(oc, sh)) throw new Error('a varredura não gerou um sólido');
  return sh;
}

export function sweepFaces(oc: OC, faces: TopoDS_Face[], path: TopoDS_Wire): TopoDS_Shape {
  let result: TopoDS_Shape | null = null;
  for (const face of faces) {
    const outer = oc.BRepTools.OuterWire(face);
    let solid = pipeWire(oc, path, outer);
    // Furos do perfil: varre cada contorno interno e subtrai (tubo com parede).
    const ex = new oc.TopExp_Explorer_2(face, oc.TopAbs_ShapeEnum.TopAbs_WIRE as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never);
    for (; ex.More(); ex.Next()) { const w = oc.TopoDS.Wire_1(ex.Current()); if (w.IsSame(outer)) continue; solid = boolOp(oc, 'cut', solid, pipeWire(oc, path, w)); }
    ex.delete();
    result = result ? boolOp(oc, 'fuse', result, solid) : solid;
  }
  return result!;
}

export function loftSketches(oc: OC, doc: ForjaDocument, sketchIds: Id[], ruled: boolean): TopoDS_Shape {
  if (sketchIds.length < 2) throw new Error('o loft precisa de dois esboços ou mais');
  const ts = new oc.BRepOffsetAPI_ThruSections(true, ruled, 1e-6);
  for (const id of sketchIds) { const { faces } = sketchFaces(oc, doc, id); ts.AddWire(oc.BRepTools.OuterWire(faces[0])); }
  ts.CheckCompatibility(true); ts.Build(new oc.Message_ProgressRange_1());
  const sh = ts.Shape(); if (!hasSolid(oc, sh)) throw new Error('o loft não gerou um sólido');
  return sh;
}

const stepCache = new Map<string, TopoDS_Shape>();
function hashText(t: string): string { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return `${t.length}:${h}`; }

/** Lê um STEP (texto) e devolve a forma (um corpo, possivelmente composto). */
export function importSTEP(oc: OC, text: string): TopoDS_Shape {
  const key = hashText(text); const cached = stepCache.get(key); if (cached) return cached;
  const name = '/in.step'; oc.FS.writeFile(name, text);
  const reader = new oc.STEPControl_Reader_1();
  const status = enumVal(reader.ReadFile(name));
  try { oc.FS.unlink(name); } catch { /* ignore */ }
  if (status !== enumVal(oc.IFSelect_ReturnStatus.IFSelect_RetDone)) throw new Error('não deu para ler o STEP');
  reader.TransferRoots(new oc.Message_ProgressRange_1());
  const shape = reader.OneShape();
  if (shape.IsNull() || !hasSolid(oc, shape)) throw new Error('o STEP não tem sólidos');
  if (stepCache.size > 20) stepCache.clear(); stepCache.set(key, shape);
  return shape;
}

export function exportIGES(oc: OC, bodies: BuiltBody[]): string {
  const w = new oc.IGESControl_Writer_2('MM', 0);
  for (const b of bodies) w.AddShape(b.shape, new oc.Message_ProgressRange_1());
  w.ComputeModel();
  const name = '/forja.igs'; w.Write_2(name, false);
  const text = oc.FS.readFile(name, { encoding: 'utf8' }) as string;
  try { oc.FS.unlink(name); } catch { /* ignore */ }
  return text;
}

/** Desloca um perfil fechado do esboço em `distance` mm (positivo para fora) e devolve linhas e arcos no plano. */
export function offsetProfile(oc: OC, doc: ForjaDocument, sketchId: Id, profilePoint: [number, number], distance: number): SketchEntity2D[] {
  const { faces, plane } = sketchFaces(oc, doc, sketchId, profilePoint);
  const wire = oc.BRepTools.OuterWire(faces[0]);
  const mk = new oc.BRepOffsetAPI_MakeOffset_1(); mk.Init_2(oc.GeomAbs_JoinType.GeomAbs_Arc as never, false); mk.AddWire(wire); mk.Perform(distance, 0);
  const out = mk.Shape(); if (out.IsNull()) throw new Error('não deu para deslocar esse contorno');
  const o = plane.origin;
  const toUV = (p: { X(): number; Y(): number; Z(): number }): [number, number] => { const d: V3 = [p.X() - o[0], p.Y() - o[1], p.Z() - o[2]]; return [d[0] * plane.u[0] + d[1] * plane.u[1] + d[2] * plane.u[2], d[0] * plane.v[0] + d[1] * plane.v[1] + d[2] * plane.v[2]]; };
  const ents: SketchEntity2D[] = [];
  const ex = new oc.TopExp_Explorer_2(out, oc.TopAbs_ShapeEnum.TopAbs_EDGE as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never);
  const LINE = enumVal(oc.GeomAbs_CurveType.GeomAbs_Line), CIRC = enumVal(oc.GeomAbs_CurveType.GeomAbs_Circle);
  for (; ex.More(); ex.Next()) {
    const edge = oc.TopoDS.Edge_1(ex.Current()); const c = new oc.BRepAdaptor_Curve_2(edge); const f = c.FirstParameter(), l = c.LastParameter();
    const t = enumVal(c.GetType()); const pa = c.Value(f), pb = c.Value(l);
    if (t === LINE) ents.push({ type: 'line', a: toUV(pa), b: toUV(pb) });
    else if (t === CIRC) {
      const circ = c.Circle(); const loc = circ.Location(); const cc = toUV(loc); const r = circ.Radius();
      if (Math.abs(l - f) >= 2 * Math.PI - 1e-6) ents.push({ type: 'circle', c: cc, r });
      else {
        // Sentido no plano: o arco vai de a para b passando pelo ponto médio; se o médio não está no lado anti-horário, inverte.
        const pm = c.Value((f + l) / 2); const a = toUV(pa), b = toUV(pb), m = toUV(pm);
        const ang = (q: [number, number]) => Math.atan2(q[1] - cc[1], q[0] - cc[0]);
        const sweepAB = ((ang(b) - ang(a)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI); const sweepAM = ((ang(m) - ang(a)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        ents.push(sweepAM < sweepAB ? { type: 'arc', c: cc, r, a, b } : { type: 'arc', c: cc, r, a: b, b: a });
        pm.delete();
      }
      loc.delete(); circ.delete();
    } else {
      // Outras curvas (raras no deslocamento de linhas e arcos): aproxima por segmentos.
      const disc = new oc.GCPnts_TangentialDeflection_2(c, 0.2, 0.05, 2, 1e-9, 1e-7);
      for (let k = 1; k < disc.NbPoints(); k++) { const p1 = disc.Value(k), p2 = disc.Value(k + 1); ents.push({ type: 'line', a: toUV(p1), b: toUV(p2) }); p1.delete(); p2.delete(); }
      disc.delete();
    }
    pa.delete(); pb.delete(); c.delete();
  }
  ex.delete();
  if (!ents.length) throw new Error('deslocamento vazio');
  return ents;
}
