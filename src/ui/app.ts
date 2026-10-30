// Aplicativo: ferramentas, gestos, painel lateral, desfazer, autosave, arquivos e o diálogo com o kernel 3D.

import * as THREE from 'three';
import { Viewport, emptySel3D, type Sel3D, type RenderBody } from './viewport';
import { SketchRenderer, emptySelection, type Selection, dimEndpoints, fmtDim } from './sketchRenderer';
import { icons, type IconName } from './icons';
import {
  createDocument, serialize, deserialize, getPlane, getSketch, addExtrude, addRevolve, addFillet, addBoolean, addFacePlane, pruneFacePlanes,
  bodyIds, bodyName, featuresOfBody, planeNormal,
  type ForjaDocument, type Plane, type Feature, type ExtrudeFeature, type ExtrudeOp, type V3, type SketchAxis,
} from '../core/document';
import * as M from '../core/sketch/model';
import type { Sketch, Entity, Id, ConstraintKind, DimensionKind } from '../core/sketch/model';
import { solveSketch, type SolveResult } from '../core/sketch/solver';
import { recognizeStroke, type Primitive } from '../core/sketch/recognizer';
import { buildAllBodies } from '../core/kernel/preview';
import { KernelClient, SupersededError } from '../core/kernel/occ/client';
import type { BodyData, FeatureError, RebuildResult } from '../core/kernel/occ/types';
import { toSTL, toOBJ, fromBody, fromGeometry, type MeshData } from '../core/export/mesh';
import { toGLB } from '../core/export/glb';
import { layoutDrawing, layoutAssemblyDrawing, projectPoint, viewSpecsFor, defaultDrawingSettings, SHEET_MM, STANDARD_SCALES, scaleLabel, type DrawingSettings, type BalloonAnchor } from '../core/drawing/layout';
import { createAssemblyDocument } from '../core/document';
import { addPart, addInstance, removeInstance, addJoint, removeJoint, jointOf, computeTransforms, frameFromFace, applyPoint, bomRows, JOINT_NAMES, type Assembly, type Frame, type JointType, type Mat4 } from '../core/assembly/model';
import { toPDF } from '../core/drawing/pdf';
import { toDXF } from '../core/drawing/dxf';
import { toSVG } from '../core/drawing/svg';
import type { ProjectedView, AssemblyPayload } from '../core/kernel/occ/types';
import { saveLocal, loadLocal, downloadFile, pickFile, safeFileName } from './storage';
import { type Vec2, v2, dist, distPointSegment, distPointArc, closestOnSegment, sub, add, scale, norm, angleOf, normAngle, TAU, round } from '../core/geom';

type Tool = 'select' | 'draw' | 'line' | 'rect' | 'circle' | 'dimension' | 'erase';

interface PointerInfo { id: number; type: string; x: number; y: number; startX: number; startY: number; moved: boolean; role: 'tool' | 'nav' | 'pan'; button: number; }
interface Hit { kind: 'point' | 'entity' | 'dimension'; id: Id; d: number; }

const H_V_SNAP_DEG = 6;
const TANGENT_SNAP_DEG = 12;

const v3sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];
const fmtMm3 = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2).replace('.', ',')} cm³` : `${v.toFixed(1).replace('.', ',')} mm³`);

export class App {
  readonly doc: { current: ForjaDocument };
  readonly vp: Viewport;
  readonly sk = new SketchRenderer();
  readonly inactiveSketches = new Map<Id, SketchRenderer>();
  readonly kernel = new KernelClient();
  private undoStack: string[] = []; private redoStack: string[] = [];
  mode: 'view' | 'sketch' = 'view';
  activeSketch: Id | null = null;
  tool: Tool = 'draw';
  touchDraws = false;
  sel: Selection = emptySelection();
  sel3d: Sel3D = emptySel3D();
  selectedFeature: Id | null = null;
  /** Corpos do último recálculo do kernel. */
  bodies: BodyData[] = [];
  featureErrors: FeatureError[] = [];
  // Montagem
  selectedInstance: Id | null = null;
  private asmCache = new Map<Id, { key: string; bodies: BodyData[]; geoms: THREE.BufferGeometry[] }>();
  private asmTransforms = new Map<Id, Mat4>();
  private jointFlow: { type: JointType; moving?: { inst: Id; frame: Frame; planar: boolean } } | null = null;
  private busy = 0;
  private pointers = new Map<number, PointerInfo>();
  private pinch: { d0: number; mid: { x: number; y: number } } | null = null;
  private stroke: Vec2[] = [];
  private dragPoint: Id | null = null;
  private toolStart: { uv: Vec2; pid?: Id } | null = null;
  private previewSketchBackup: Sketch | null = null;
  private pendingDimRefs: Id[] = [];
  private lastSolve: SolveResult | null = null;
  private hoverPlane: Id | null = null;

  // DOM
  private root: HTMLElement; private workspace!: HTMLElement; private overlay!: HTMLElement; private toolbar!: HTMLElement; private sidepanel!: HTMLElement;
  private statusEl!: HTMLElement; private titleEl!: HTMLInputElement; private toasts!: HTMLElement; private labelsEl!: HTMLElement;
  private labelNodes = new Map<string, HTMLElement>();

  constructor(root: HTMLElement) {
    this.root = root;
    const saved = loadLocal();
    let doc: ForjaDocument | null = null;
    if (saved) { try { doc = deserialize(saved); } catch (e) { console.warn('Autosave inválido', e); } }
    this.doc = { current: doc ?? createDocument() };
    this.buildDOM();
    this.vp = new Viewport(this.workspace);
    this.vp.scene.add(this.sk.group);
    this.vp.onAfterRender = () => this.placeLabels();
    this.bindPointer();
    this.bindKeys();
    this.kernel.onState = (s) => {
      this.renderStatus();
      if (s === 'ready') { this.toast(`Kernel 3D pronto (${(this.kernel.loadMs / 1000).toFixed(1)} s).`); void this.rebuild(); }
      else if (s === 'failed') this.toast(`Kernel 3D indisponível: ${this.kernel.failure}. Mostrando só a prévia.`, 'err');
    };
    this.refreshAll();
    this.vp.fitAll();
    window.addEventListener('beforeunload', () => this.autosave());
  }

  // ---------- DOM ----------
  private buildDOM(): void {
    this.root.innerHTML = '';
    const top = el('div', 'topbar');
    this.titleEl = el('input', 'title') as HTMLInputElement; this.titleEl.value = this.doc.current.name; this.titleEl.spellcheck = false;
    this.titleEl.addEventListener('change', () => { this.doc.current.name = this.titleEl.value.trim() || 'Peça'; this.autosave(); });
    top.append(this.titleEl);
    top.append(this.iconButton('undo', 'Desfazer', () => this.undo()), this.iconButton('redo', 'Refazer', () => this.redo()));
    const spacer = el('div', 'spacer'); top.append(spacer);
    this.statusEl = el('div', 'status'); top.append(this.statusEl);
    top.append(this.button('Novo', (ev) => this.newDocument(ev)), this.button('Abrir', () => this.openFile()), this.button('Salvar', () => this.saveFile()), this.button('Exportar', (ev) => this.exportMenu(ev)));
    this.root.append(top);
    this.workspace = el('div', 'workspace'); this.root.append(this.workspace);
    this.overlay = el('div', 'overlay'); this.workspace.append(this.overlay);
    this.labelsEl = el('div', 'overlay'); this.overlay.append(this.labelsEl);
    this.toolbar = el('div', 'toolbar'); this.toolbar.style.pointerEvents = 'auto'; this.overlay.append(this.toolbar);
    this.sidepanel = el('div', 'sidepanel'); this.sidepanel.style.pointerEvents = 'auto'; this.overlay.append(this.sidepanel);
    this.toasts = el('div', 'toasts'); this.overlay.append(this.toasts);
  }

  private iconButton(icon: IconName, label: string, onClick: (ev: MouseEvent) => void, cls = 'tool'): HTMLButtonElement {
    const b = document.createElement('button'); b.className = cls; b.innerHTML = `${icons[icon]}<span>${label}</span>`; b.title = label;
    b.addEventListener('click', onClick); return b;
  }
  private button(label: string, onClick: (ev: MouseEvent) => void, cls = 'btn'): HTMLButtonElement {
    const b = document.createElement('button'); b.className = cls; b.textContent = label; b.addEventListener('click', onClick); return b;
  }

  toast(msg: string, kind: '' | 'err' = ''): void {
    const t = el('div', `toast ${kind}`); t.textContent = msg; this.toasts.append(t); setTimeout(() => t.remove(), kind ? 5200 : 3300);
  }

  // ---------- Estado e render ----------
  private get sketch(): Sketch | null { return this.activeSketch ? getSketch(this.doc.current, this.activeSketch) : null; }
  private get plane(): Plane | null { const s = this.sketch; return s ? getPlane(this.doc.current, s.plane) : null; }
  get isAssembly(): boolean { return this.doc.current.kind === 'assembly' && !!this.doc.current.assembly; }
  private get asm(): Assembly | null { return this.isAssembly ? this.doc.current.assembly! : null; }
  /** Dados de malha de um corpo da cena: corpo da peça ou `instancia/corpo` de uma montagem. */
  private bodyOf(id: Id | null | undefined): BodyData | undefined {
    if (!id) return undefined;
    if (!this.isAssembly) return this.bodies.find((b) => b.id === id);
    const slash = id.indexOf('/'); if (slash < 0) return undefined;
    const inst = this.asm!.instances.find((i) => i.id === id.slice(0, slash)); const cache = inst && this.asmCache.get(inst.part);
    return cache?.bodies.find((b) => b.id === id.slice(slash + 1));
  }
  private instanceOf(renderId: Id | null | undefined): Id | null { if (!renderId || !this.isAssembly) return null; const i = renderId.indexOf('/'); return i < 0 ? null : renderId.slice(0, i); }

  private pushUndo(): void { this.undoStack.push(serialize(this.doc.current)); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }
  undo(): void {
    const s = this.undoStack.pop(); if (!s) return this.toast('Nada para desfazer');
    this.redoStack.push(serialize(this.doc.current)); this.doc.current = deserialize(s); this.afterDocReplace();
  }
  redo(): void {
    const s = this.redoStack.pop(); if (!s) return;
    this.undoStack.push(serialize(this.doc.current)); this.doc.current = deserialize(s); this.afterDocReplace();
  }
  private afterDocReplace(): void {
    if (this.activeSketch && !this.doc.current.sketches.some((s) => s.id === this.activeSketch)) this.exitSketch(false);
    this.sel = emptySelection(); this.titleEl.value = this.doc.current.name;
    if (this.sketch) this.solve();
    this.refreshAll();
  }

  private autosave(): void { saveLocal(serialize(this.doc.current)); }

  /** Recalcula tudo que depende do documento e redesenha. */
  refreshAll(rebuild = true): void {
    const doc = this.doc.current;
    this.vp.setPlanes(doc.planes);
    if (this.selectedFeature && !doc.features.some((f) => f.id === this.selectedFeature)) this.selectedFeature = null;
    if (rebuild) void this.rebuild();
    // Esboços inativos aparecem em 3D (para escolher e extrudar).
    for (const [id, r] of this.inactiveSketches) if (!doc.sketches.some((s) => s.id === id)) { this.vp.scene.remove(r.group); this.inactiveSketches.delete(id); }
    for (const s of doc.sketches) {
      let r = this.inactiveSketches.get(s.id);
      if (!r) { r = new SketchRenderer(); this.inactiveSketches.set(s.id, r); this.vp.scene.add(r.group); }
      r.group.visible = s.id !== this.activeSketch;
      if (r.group.visible) r.update(s, getPlane(doc, s.plane), emptySelection(), false, 1);
    }
    this.refreshSketch();
    this.renderToolbar(); this.renderSidePanel(); this.renderStatus();
    this.autosave();
    this.vp.requestRender();
  }
  private refreshSketch(): void {
    const s = this.sketch, p = this.plane;
    if (s && p) { this.sk.group.visible = true; this.sk.update(s, p, this.sel, true, this.vp.mmPerPixel()); }
    else { this.sk.group.visible = false; this.sk.labels = []; }
    this.vp.requestRender();
  }

  // ---------- Kernel 3D ----------
  /** Pede ao kernel os corpos atuais. Enquanto ele não está pronto, mostra a prévia em malha. */
  private async rebuild(): Promise<RebuildResult | null> {
    const doc = this.doc.current;
    if (this.isAssembly) { await this.rebuildAssembly(); return null; }
    if (this.kernel.state !== 'ready') {
      this.bodies = []; this.featureErrors = [];
      const preview = buildAllBodies(doc).map((b): RenderBody => ({ id: b.feature.id, name: bodyName(doc, b.feature.id), geometry: b.geometry }));
      this.vp.setBodies(preview, this.sel3d);
      return null;
    }
    this.busy++; this.renderStatus();
    try {
      const r = await this.kernel.rebuild(doc);
      this.bodies = r.bodies; this.featureErrors = r.errors;
      this.pruneSel3d();
      this.vp.setBodies(this.bodies.map(toRenderBody), this.sel3d);
      this.renderSidePanel(); this.renderToolbar();
      return r;
    } catch (e) {
      if (!(e instanceof SupersededError)) this.toast(`Kernel: ${(e as Error).message}`, 'err');
      return null;
    } finally { this.busy--; this.renderStatus(); }
  }

  private pruneSel3d(): void {
    const has = (id: Id | null) => !!this.bodyOf(id);
    if (!has(this.sel3d.body)) this.sel3d.body = null;
    if (this.sel3d.face && !(has(this.sel3d.face.body) && this.bodyOf(this.sel3d.face.body)!.faces.length > this.sel3d.face.index)) this.sel3d.face = null;
    this.sel3d.edges = this.sel3d.edges.filter((e) => has(e.body) && this.bodyOf(e.body)!.edges.length > e.index);
  }

  // ---------- Montagem ----------
  /** Recalcula cada peça uma vez (cache por conteúdo), posiciona as instâncias pelas juntas e redesenha. */
  private async rebuildAssembly(): Promise<void> {
    const asm = this.asm; if (!asm) return;
    if (this.kernel.state !== 'ready') { this.vp.setBodies([], this.sel3d); return; }
    this.busy++; this.renderStatus();
    try {
      for (const part of asm.parts) {
        const key = JSON.stringify({ s: part.doc.sketches, f: part.doc.features, p: part.doc.planes });
        const cached = this.asmCache.get(part.id);
        if (!cached || cached.key !== key) {
          const r = await this.kernel.rebuildOnce(part.doc);
          this.asmCache.set(part.id, { key, bodies: r.bodies, geoms: r.bodies.map((b) => toRenderBody(b).geometry) });
          if (r.errors.length) this.toast(`${part.name}: ${r.errors.length} feature${r.errors.length > 1 ? 's' : ''} com erro.`, 'err');
        }
      }
      for (const id of [...this.asmCache.keys()]) if (!asm.parts.some((p) => p.id === id)) this.asmCache.delete(id);
      this.asmTransforms = computeTransforms(asm);
      const list: RenderBody[] = [];
      for (const inst of asm.instances) {
        const cache = this.asmCache.get(inst.part); const m = this.asmTransforms.get(inst.id); if (!cache || !m) continue;
        cache.bodies.forEach((b, i) => list.push({ id: `${inst.id}/${b.id}`, name: inst.name, geometry: cache.geoms[i], data: b, matrix: m }));
      }
      this.bodies = []; this.featureErrors = [];
      this.pruneSel3d();
      this.vp.setBodies(list, this.sel3d);
      this.renderSidePanel(); this.renderToolbar();
    } catch (e) { this.toast(`Montagem: ${(e as Error).message}`, 'err'); }
    finally { this.busy--; this.renderStatus(); }
  }

  private assemblyPayload(): AssemblyPayload {
    const asm = this.asm!;
    return { parts: asm.parts.map((p) => ({ id: p.id, doc: p.doc })), instances: asm.instances.map((i) => ({ part: i.part, matrix: this.asmTransforms.get(i.id) ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })) };
  }

  /** Malhas de todas as instâncias já no espaço do mundo (para STL, OBJ e GLB). */
  private assemblyMeshes(): MeshData[] {
    const out: MeshData[] = []; const asm = this.asm!;
    for (const inst of asm.instances) {
      const cache = this.asmCache.get(inst.part); const m = this.asmTransforms.get(inst.id); if (!cache || !m) continue;
      for (const b of cache.bodies) {
        const md = fromBody(b); const pos = new Float32Array(md.positions.length); const nrm = md.normals ? new Float32Array(md.normals.length) : undefined;
        for (let i = 0; i < pos.length; i += 3) {
          const p = applyPoint(m, [md.positions[i], md.positions[i + 1], md.positions[i + 2]]); pos[i] = p[0]; pos[i + 1] = p[1]; pos[i + 2] = p[2];
          if (nrm && md.normals) { const n = md.normals; const d: V3 = [m[0] * n[i] + m[1] * n[i + 1] + m[2] * n[i + 2], m[4] * n[i] + m[5] * n[i + 1] + m[6] * n[i + 2], m[8] * n[i] + m[9] * n[i + 1] + m[10] * n[i + 2]]; nrm[i] = d[0]; nrm[i + 1] = d[1]; nrm[i + 2] = d[2]; }
        }
        out.push({ ...md, name: `${inst.name} ${b.name}`, positions: pos, normals: nrm });
      }
    }
    return out;
  }

  newAssembly(withCurrent: boolean): void {
    const cur = this.doc.current;
    const go = () => {
      const d = createAssemblyDocument(withCurrent ? `Montagem de ${cur.name}` : undefined);
      if (withCurrent) { const part = addPart(d.assembly!, deserialize(serialize(cur)), cur.name); addInstance(d.assembly!, part.id); }
      this.doc.current = d; this.undoStack = []; this.redoStack = []; this.activeSketch = null; this.mode = 'view'; this.selectedFeature = null; this.selectedInstance = null; this.sel = emptySelection(); this.sel3d = emptySel3D(); this.asmCache.clear();
      this.vp.exitSketch(); this.titleEl.value = d.name; this.refreshAll(); this.vp.fitAll();
    };
    if (this.isAssembly || cur.features.length || cur.sketches.length) this.confirm('Nova montagem', withCurrent ? 'A peça atual vira a primeira peça da montagem (uma cópia). Salve a peça antes se quiser mantê-la separada.' : 'Descartar o documento atual? O autosave será substituído.', go); else go();
  }

  async importPart(): Promise<void> {
    const asm = this.asm; if (!asm) return;
    const f = await pickFile('.forja,application/json'); if (!f) return;
    try {
      const d = deserialize(f.text);
      if (d.kind === 'assembly') return this.toast('Esse arquivo é uma montagem. Importe arquivos de peça.', 'err');
      if (!d.features.length) return this.toast('Essa peça não tem corpos.', 'err');
      this.pushUndo();
      const part = addPart(asm, d, d.name); const inst = addInstance(asm, part.id, this.freeSpot());
      this.selectedInstance = inst.id; this.refreshAll(); this.toast(`Peça "${part.name}" inserida.`);
    } catch (e) { this.toast(`Não abriu: ${(e as Error).message}`, 'err'); }
  }

  /** Posição livre ao lado das instâncias existentes, para a nova não nascer dentro de outra. */
  private freeSpot(): V3 {
    let maxX = 0;
    for (const inst of this.asm!.instances) { const c = this.asmCache.get(inst.part); const m = this.asmTransforms.get(inst.id); if (!c || !m) continue; for (const b of c.bodies) for (const x of [b.bbox[0][0], b.bbox[1][0]]) for (const y of [b.bbox[0][1], b.bbox[1][1]]) for (const z of [b.bbox[0][2], b.bbox[1][2]]) maxX = Math.max(maxX, applyPoint(m, [x, y, z])[0]); }
    return [this.asm!.instances.length ? maxX + 30 : 0, 0, 0];
  }

  insertInstance(partId: Id): void {
    const asm = this.asm; if (!asm) return;
    this.pushUndo(); const inst = addInstance(asm, partId, this.freeSpot()); this.selectedInstance = inst.id; this.refreshAll();
  }

  startJoint(type: JointType, moving?: { inst: Id; frame: Frame; planar: boolean }): void {
    this.jointFlow = { type, moving }; this.closeMenus();
    this.toast(moving ? `${JOINT_NAMES[type]}: agora toque na face da peça base.` : `${JOINT_NAMES[type]}: toque na face da peça que vai se mover.`);
    this.renderStatus(); this.renderToolbar();
  }
  private cancelJoint(): void { this.jointFlow = null; this.renderStatus(); this.renderToolbar(); }

  /** Toque numa face em modo montagem: passo do fluxo de junta ou seleção da instância. */
  private tapAssemblyFace(renderId: Id, faceIndex: number, x: number, y: number): void {
    const asm = this.asm!; const inst = this.instanceOf(renderId); const fd = this.bodyOf(renderId)?.faces[faceIndex]; if (!inst) return;
    const frame = fd ? frameFromFace(fd) : null; const planar = fd?.type === 'plane';
    if (this.jointFlow) {
      if (!frame) return this.toast('Use uma face plana ou cilíndrica para a junta.', 'err');
      if (!this.jointFlow.moving) { this.jointFlow.moving = { inst, frame, planar }; this.sel3d = { body: renderId, face: { body: renderId, index: faceIndex }, edges: [] }; this.vp.setSelection(this.sel3d); this.toast('Agora toque na face da peça base.'); this.renderStatus(); return; }
      if (this.jointFlow.moving.inst === inst) return this.toast('Escolha uma face de outra peça.', 'err');
      const { type, moving } = this.jointFlow;
      try {
        this.pushUndo();
        const j = addJoint(asm, type, moving.inst, moving.frame, inst, frame, moving.planar && planar);
        this.jointFlow = null; this.selectedInstance = moving.inst; this.sel3d = emptySel3D();
        this.refreshAll(); this.toast(`${j.name} criada. Ajuste ângulo ou curso no painel.`);
      } catch (e) { this.undoStack.pop(); this.toast((e as Error).message, 'err'); }
      return;
    }
    const same = this.selectedInstance === inst && this.sel3d.face?.body === renderId && this.sel3d.face.index === faceIndex;
    this.selectedInstance = inst;
    this.sel3d = same ? { body: renderId, face: null, edges: [] } : { body: renderId, face: { body: renderId, index: faceIndex }, edges: [] };
    this.vp.setSelection(this.sel3d); this.renderSidePanel(); this.renderToolbar();
    if (!same && frame && asm.instances.length > 1) {
      const items = (['fixed', 'revolute', 'slider', 'cylindrical'] as JointType[]).map((t) => ({ label: `${JOINT_NAMES[t]} a partir desta face`, action: () => this.startJoint(t, { inst, frame, planar }) }));
      this.menu(x + 10, y + 10, items);
    }
  }

  private deleteInstance(id: Id): void {
    const asm = this.asm; if (!asm) return;
    this.pushUndo(); removeInstance(asm, id); if (this.selectedInstance === id) this.selectedInstance = null; this.sel3d = emptySel3D(); this.refreshAll();
  }

  private renderAssemblyPanel(p: HTMLElement): void {
    const asm = this.asm!; const doc = this.doc.current;
    const numRow = (label: string, value: number, onChange: (v: number) => void, step = 1) => {
      const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = label;
      const inp = document.createElement('input'); inp.type = 'number'; inp.step = String(step); inp.value = String(Math.round(value * 100) / 100); inp.inputMode = 'decimal';
      inp.addEventListener('change', () => { const v = parseFloat(inp.value.replace(',', '.')); if (!isFinite(v)) return; onChange(v); });
      row.append(lab, inp); p.append(row);
    };
    if (this.jointFlow) {
      p.append(h3('Nova junta'));
      const d = el('div', 'hint'); d.textContent = `${JOINT_NAMES[this.jointFlow.type]}: ${this.jointFlow.moving ? 'toque na face da peça base.' : 'toque na face da peça que vai se mover.'} Faces planas encostam; faces cilíndricas alinham o eixo.`; p.append(d);
      const row = el('div', 'row'); row.append(this.button('Cancelar', () => this.cancelJoint())); p.append(row);
    }
    const inst = asm.instances.find((i) => i.id === this.selectedInstance);
    if (inst) {
      p.append(h3('Instância'));
      const nameRow = el('div', 'row'); const nameInp = document.createElement('input'); nameInp.type = 'text'; nameInp.value = inst.name; nameInp.spellcheck = false;
      nameInp.addEventListener('change', () => { this.pushUndo(); inst.name = nameInp.value.trim().slice(0, 60) || inst.name; this.refreshAll(); }); nameRow.append(nameInp); p.append(nameRow);
      const j = jointOf(asm, inst.id);
      if (j) {
        const base = asm.instances.find((i) => i.id === j.base);
        const d = el('div', 'hint'); d.textContent = `${j.name}, presa em ${base?.name ?? '?'}.`; p.append(d);
        if (j.type === 'revolute' || j.type === 'cylindrical') numRow('Ângulo (°)', j.angle, (v) => { this.pushUndo(); j.angle = v; this.refreshAll(); }, 5);
        if (j.type === 'slider' || j.type === 'cylindrical') numRow('Curso (mm)', j.distance, (v) => { this.pushUndo(); j.distance = v; this.refreshAll(); }, 1);
        const fr = el('div', 'row'); const fl = document.createElement('label'); fl.textContent = 'Inverter eixo'; const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = !!j.flip;
        chk.addEventListener('change', () => { this.pushUndo(); j.flip = chk.checked; this.refreshAll(); }); fr.append(fl, chk); p.append(fr);
        const row = el('div', 'row'); row.append(this.button('Remover junta', () => { this.pushUndo(); removeJoint(asm, j.id); this.refreshAll(); }, 'btn danger')); p.append(row);
      } else {
        const d = el('div', 'hint'); d.textContent = 'Instância livre. Posicione por números ou crie uma junta tocando numa face.'; p.append(d);
        (['X', 'Y', 'Z'] as const).forEach((ax, i) => numRow(`Posição ${ax} (mm)`, inst.pos[i], (v) => { this.pushUndo(); inst.pos[i] = v; this.refreshAll(); }));
        (['X', 'Y', 'Z'] as const).forEach((ax, i) => numRow(`Rotação ${ax} (°)`, inst.rot[i], (v) => { this.pushUndo(); inst.rot[i] = v; this.refreshAll(); }, 15));
      }
      const row = el('div', 'row');
      row.append(this.button('Duplicar', () => this.insertInstance(inst.part)), this.button('Apagar', () => this.deleteInstance(inst.id), 'btn danger'));
      p.append(row);
    }
    p.append(h3(`Peças (${asm.parts.length})`));
    const plist = el('div', 'list');
    for (const part of asm.parts) {
      const n = asm.instances.filter((i) => i.part === part.id).length;
      const it = listItem(part.name, `${n}× · +`); it.title = 'Toque para inserir mais uma';
      it.addEventListener('click', () => this.insertInstance(part.id)); plist.append(it);
    }
    const imp = this.button('Importar peça (.forja)', () => void this.importPart()); plist.append(imp);
    if (!asm.parts.length) { const d = el('div', 'hint'); d.textContent = 'Salve cada peça como .forja no modo peça e importe aqui. Ou use "Novo ▸ Nova montagem com esta peça".'; plist.append(d); }
    p.append(plist);
    p.append(h3(`Instâncias (${asm.instances.length})`));
    const ilist = el('div', 'list');
    for (const i of asm.instances) {
      const j = jointOf(asm, i.id);
      const it = listItem(i.name, j ? JOINT_NAMES[j.type] : 'livre'); if (this.selectedInstance === i.id) it.classList.add('active');
      it.addEventListener('click', () => { this.selectedInstance = this.selectedInstance === i.id ? null : i.id; this.sel3d = emptySel3D(); const c = this.asmCache.get(i.part); if (this.selectedInstance && c?.bodies[0]) this.sel3d.body = `${i.id}/${c.bodies[0].id}`; this.vp.setSelection(this.sel3d); this.renderSidePanel(); this.renderToolbar(); });
      ilist.append(it);
    }
    p.append(ilist);
    if (asm.joints.length) {
      p.append(h3(`Juntas (${asm.joints.length})`));
      const jl = el('div', 'list');
      for (const j of asm.joints) { const it = listItem(j.name, j.type === 'revolute' ? `${fmtDim('angle', j.angle)}` : j.type === 'slider' ? `${fmtDim('distance', j.distance)} mm` : j.type === 'cylindrical' ? `${fmtDim('angle', j.angle)} · ${fmtDim('distance', j.distance)} mm` : ''); it.addEventListener('click', () => { this.selectedInstance = j.moving; this.renderSidePanel(); }); jl.append(it); }
      p.append(jl);
    }
    const rows = bomRows(asm);
    if (rows.length) {
      p.append(h3('Lista de materiais'));
      const bl = el('div', 'list');
      for (const r of rows) { const vol = (this.asmCache.get(r.part)?.bodies ?? []).reduce((a, b) => a + b.volume, 0); bl.append(listItem(`${r.item}. ${r.name}`, `${r.qty}× · ${fmtMm3(vol)}${r.material ? ' · ' + r.material : ''}`)); }
      p.append(bl);
    }
    const info = el('div', 'hint'); info.textContent = `Montagem "${doc.name}": as peças ficam embutidas no arquivo .forja. "Desenho" gera o conjunto com balões e lista de materiais.`; p.append(info);
  }

  /** Aplica uma mudança de feature e desfaz sozinho se o kernel reprovar. */
  private async tryFeature(mutate: () => Feature | null, onOk?: (f: Feature) => void): Promise<void> {
    const snapshot = serialize(this.doc.current);
    this.pushUndo();
    const f = mutate();
    if (!f) { this.undoStack.pop(); return; }
    this.refreshAll(false);
    const r = await this.rebuild();
    if (!r) { onOk?.(f); return; } // kernel ausente: fica a prévia
    const err = r.errors.find((e) => e.feature === f.id);
    if (err) {
      this.doc.current = deserialize(snapshot); this.undoStack.pop();
      this.toast(`Não deu: ${err.message}.`, 'err');
      this.refreshAll();
      return;
    }
    onOk?.(f);
  }

  private renderStatus(): void {
    const s = this.sketch;
    if (!s && this.isAssembly) {
      const asm = this.asm!; let txt: string; let cls = 'status';
      if (this.jointFlow) { txt = this.jointFlow.moving ? 'Junta: toque na face da peça base' : 'Junta: toque na face da peça móvel'; cls = 'status warn'; }
      else if (this.busy) txt = 'Calculando…';
      else if (this.kernel.state !== 'ready') { txt = this.kernel.state === 'loading' ? 'Carregando kernel 3D…' : 'Kernel 3D indisponível'; cls = 'status err'; }
      else txt = asm.instances.length ? `Montagem: ${asm.instances.length} peça${asm.instances.length > 1 ? 's' : ''}, ${asm.joints.length} junta${asm.joints.length !== 1 ? 's' : ''}` : 'Montagem vazia: importe uma peça';
      this.statusEl.textContent = txt; this.statusEl.className = cls; return;
    }
    if (!s) {
      const n = this.bodies.length; const errs = this.featureErrors.length;
      let txt: string; let cls = 'status';
      if (this.busy) { txt = 'Calculando…'; }
      else if (this.kernel.state === 'loading') { txt = 'Carregando kernel 3D (50 MB, só na primeira vez)…'; cls = 'status warn'; }
      else if (this.kernel.state === 'failed') { txt = 'Kernel 3D indisponível: só prévia'; cls = 'status err'; }
      else if (!this.doc.current.features.length) txt = 'Toque em um plano para esboçar';
      else { txt = n ? `${n} corpo${n > 1 ? 's' : ''}` : 'Nenhum corpo'; if (errs) { txt += ` · ${errs} feature${errs > 1 ? 's' : ''} com erro`; cls = 'status warn'; } }
      this.statusEl.textContent = txt; this.statusEl.className = cls; return;
    }
    const r = this.lastSolve;
    if (!r) { this.statusEl.textContent = 'Esboço'; this.statusEl.className = 'status'; return; }
    if (!r.converged) { this.statusEl.textContent = 'Restrições em conflito'; this.statusEl.className = 'status err'; }
    else if (r.overConstrained) { this.statusEl.textContent = 'Sobre-restrito (redundância)'; this.statusEl.className = 'status warn'; }
    else if (r.dof === 0) { this.statusEl.textContent = 'Totalmente definido'; this.statusEl.className = 'status ok'; }
    else { this.statusEl.textContent = `Faltam ${r.dof} grau${r.dof > 1 ? 's' : ''} de liberdade`; this.statusEl.className = 'status warn'; }
  }

  private renderToolbar(): void {
    this.toolbar.innerHTML = '';
    const g1 = el('div', 'group'); const g2 = el('div', 'group'); const g3 = el('div', 'group');
    if (this.mode === 'sketch') {
      const tools: [Tool, IconName, string][] = [['select', 'select', 'Selecionar'], ['draw', 'draw', 'Caneta'], ['line', 'line', 'Linha'], ['rect', 'rect', 'Retângulo'], ['circle', 'circle', 'Círculo'], ['dimension', 'dimension', 'Cota'], ['erase', 'erase', 'Apagar']];
      for (const [t, ic, label] of tools) { const b = this.iconButton(ic, label, () => this.setTool(t)); if (this.tool === t) b.classList.add('active'); g1.append(b); }
      const touch = this.iconButton('touch', 'Dedo desenha', () => { this.touchDraws = !this.touchDraws; this.renderToolbar(); }); if (this.touchDraws) touch.classList.add('active'); g2.append(touch);
      g2.append(this.iconButton('fit', 'Enquadrar', () => this.vp.fitAll()));
      g3.append(this.iconButton('extrude', 'Extrudar', () => this.extrudeActive()));
      g3.append(this.iconButton('revolve', 'Revolucionar', () => this.revolveActive()));
      g3.append(this.iconButton('done', 'Concluir', () => this.exitSketch(true)));
      this.toolbar.append(g1, g2, g3);
    } else if (this.isAssembly) {
      const asm = this.asm!;
      g1.append(this.iconButton('plus', 'Inserir', (ev) => { const items = asm.parts.map((p) => ({ label: `Inserir ${p.name}`, action: () => this.insertInstance(p.id) })); items.push({ label: 'Importar peça (.forja)…', action: () => void this.importPart() }); this.menu(ev.clientX, ev.clientY, items); }));
      const jb = this.iconButton('joint', this.jointFlow ? 'Cancelar junta' : 'Junta', (ev) => { if (this.jointFlow) return this.cancelJoint(); this.menu(ev.clientX, ev.clientY, (['fixed', 'revolute', 'slider', 'cylindrical'] as JointType[]).map((t) => ({ label: JOINT_NAMES[t], action: () => this.startJoint(t) }))); });
      jb.disabled = asm.instances.length < 2 && !this.jointFlow; if (this.jointFlow) jb.classList.add('active'); g1.append(jb);
      g2.append(this.iconButton('drawing', 'Desenho', () => void this.drawingDialog()));
      g2.append(this.iconButton('view', 'Vistas', (ev) => this.viewMenu(ev)));
      g2.append(this.iconButton('fit', 'Enquadrar', () => this.vp.fitAll()));
      this.toolbar.append(g1, g2);
    } else {
      g1.append(this.iconButton('sketch', 'Esboço', (ev) => this.newSketchMenu(ev)));
      g1.append(this.iconButton('extrude', 'Extrudar', (ev) => this.extrudeMenu(ev)));
      const hasEdges = this.sel3d.edges.length > 0;
      const fil = this.iconButton('fillet', 'Filete', () => this.filletSelected('fillet')); fil.disabled = !hasEdges; g1.append(fil);
      const cha = this.iconButton('chamfer', 'Chanfro', () => this.filletSelected('chamfer')); cha.disabled = !hasEdges; g1.append(cha);
      if (this.sel3d.face && this.faceIsPlanar(this.sel3d.face)) g1.append(this.iconButton('face', 'Esboçar na face', () => this.createSketchOnFace(this.sel3d.face!.body, this.sel3d.face!.index)));
      if (this.sel3d.body && bodyIds(this.doc.current).length > 1) g1.append(this.iconButton('boolean', 'Combinar', (ev) => this.booleanMenu(ev)));
      g2.append(this.iconButton('drawing', 'Desenho', () => void this.drawingDialog()));
      g2.append(this.iconButton('view', 'Vistas', (ev) => this.viewMenu(ev)));
      g2.append(this.iconButton('fit', 'Enquadrar', () => this.vp.fitAll()));
      this.toolbar.append(g1, g2);
    }
  }

  private faceIsPlanar(ref: { body: Id; index: number }): boolean {
    const f = this.bodyOf(ref.body)?.faces[ref.index]; return !!f && f.type === 'plane';
  }

  private renderSidePanel(): void {
    const p = this.sidepanel; p.innerHTML = '';
    const doc = this.doc.current;
    if (this.mode === 'sketch' && this.sketch) {
      const s = this.sketch;
      p.append(h3(s.name));
      const hint = el('div', 'hint');
      hint.textContent = this.tool === 'draw' ? 'Risque com a caneta: o traço vira linha, arco ou círculo. Um dedo arrasta, dois dedos aproximam.'
        : this.tool === 'dimension' ? (this.pendingDimRefs.length ? 'Toque no segundo elemento, ou em área vazia para cotar só este.' : 'Toque numa linha, círculo, arco ou ponto. Para ângulo, toque em duas linhas.')
        : this.tool === 'select' ? 'Toque para selecionar. Arraste pontos para ajustar. Selecione elementos para ver restrições possíveis.'
        : this.tool === 'erase' ? 'Toque no que quer apagar.' : 'Arraste para desenhar. Pontas próximas se juntam sozinhas.';
      p.append(hint);
      const cons = this.applicableConstraints();
      if (cons.length) {
        p.append(h3('Restrições'));
        const grid = el('div', 'list');
        for (const c of cons) grid.append(this.button(c.label, () => this.applyConstraint(c.kind, c.refs)));
        p.append(grid);
      }
      if (this.sel.entities.size || this.sel.points.size || this.sel.dimensions.size) {
        const row = el('div', 'row');
        if (this.sel.entities.size) row.append(this.button('Construção', () => this.toggleConstruction()));
        row.append(this.button('Apagar', () => this.deleteSelection(), 'btn danger'));
        p.append(row);
      }
      if (s.constraints.length) {
        p.append(h3(`Restrições (${s.constraints.length})`));
        const list = el('div', 'list');
        for (const k of s.constraints) {
          const it = listItem(constraintName(k.kind), '×');
          it.addEventListener('click', () => { this.pushUndo(); M.removeConstraint(s, k.id); this.solve(); this.refreshAll(false); });
          list.append(it);
        }
        p.append(list);
      }
      return;
    }

    if (this.isAssembly) { this.renderAssemblyPanel(p); return; }

    // ----- Modo vista -----
    this.renderSelectionPanel(p);

    p.append(h3('Esboços'));
    const list = el('div', 'list');
    if (!doc.sketches.length) { const d = el('div', 'hint'); d.textContent = 'Nenhum esboço ainda. Toque em "Esboço" e escolha um plano, ou toque direto num plano.'; list.append(d); }
    for (const s of doc.sketches) {
      const pl = getPlane(doc, s.plane);
      const it = listItem(s.name, pl.name);
      it.addEventListener('click', () => this.enterSketch(s.id));
      list.append(it);
    }
    p.append(list);

    p.append(h3(`Features (${doc.features.length})`));
    const flist = el('div', 'list');
    if (!doc.features.length) { const d = el('div', 'hint'); d.textContent = 'Extrude um esboço fechado para criar o primeiro corpo.'; flist.append(d); }
    for (const f of doc.features) {
      const err = this.featureErrors.find((e) => e.feature === f.id);
      const it = listItem(`${err ? '⚠ ' : ''}${f.name}`, featureMini(f));
      if (err) it.title = err.message;
      if (this.selectedFeature === f.id) it.classList.add('active');
      it.addEventListener('click', () => { this.selectedFeature = this.selectedFeature === f.id ? null : f.id; this.sel3d = emptySel3D(); if (this.selectedFeature) this.sel3d.body = bodyOfFeature(f); this.vp.setSelection(this.sel3d); this.renderSidePanel(); this.renderToolbar(); });
      flist.append(it);
    }
    p.append(flist);
    const f = doc.features.find((x) => x.id === this.selectedFeature);
    if (f) this.renderFeatureEditor(p, f);

    const info = el('div', 'hint'); info.textContent = 'Unidades em milímetros. Autosave ligado neste aparelho. Use "Salvar" para gerar o arquivo .forja.'; p.append(info);
  }

  private renderSelectionPanel(p: HTMLElement): void {
    const doc = this.doc.current; const s3 = this.sel3d;
    if (!s3.body && !s3.face && !s3.edges.length) return;
    p.append(h3('Seleção'));
    const body = this.bodies.find((b) => b.id === (s3.face?.body ?? s3.edges[0]?.body ?? s3.body));
    if (s3.edges.length) {
      const d = el('div', 'hint'); d.textContent = `${s3.edges.length} aresta${s3.edges.length > 1 ? 's' : ''} de ${body?.name ?? 'corpo'}. Toque em outras para somar.`; p.append(d);
      const row = el('div', 'row');
      row.append(this.button('Filete…', () => this.filletSelected('fillet')), this.button('Chanfro…', () => this.filletSelected('chamfer')), this.button('Limpar', () => this.clearSel3d()));
      p.append(row);
    } else if (s3.face && body) {
      const f = body.faces[s3.face.index];
      const d = el('div', 'hint'); d.textContent = f ? `Face ${faceTypeName(f.type)} de ${body.name}, ${f.area.toFixed(0)} mm².` : body.name; p.append(d);
      const row = el('div', 'row');
      if (f?.type === 'plane') row.append(this.button('Esboçar nesta face', () => this.createSketchOnFace(body.id, s3.face!.index), 'btn primary'));
      row.append(this.button('Limpar', () => this.clearSel3d()));
      p.append(row);
    } else if (s3.body && body) {
      const d = el('div', 'hint'); d.textContent = `${body.name}: volume ${fmtMm3(body.volume)}, ${body.faces.length} faces, ${body.edges.length} arestas.`; p.append(d);
      const row = el('div', 'row');
      if (bodyIds(doc).length > 1) row.append(this.button('Combinar…', (ev) => this.booleanMenu(ev)));
      row.append(this.button('Apagar corpo', () => this.deleteBody(body.id), 'btn danger'));
      row.append(this.button('Limpar', () => this.clearSel3d()));
      p.append(row);
    }
  }

  private renderFeatureEditor(p: HTMLElement, f: Feature): void {
    const doc = this.doc.current;
    p.append(h3(f.name));
    const err = this.featureErrors.find((e) => e.feature === f.id);
    if (err) { const d = el('div', 'hint err'); d.textContent = `Erro: ${err.message}`; p.append(d); }
    const numRow = (label: string, value: number, onChange: (v: number) => void) => {
      const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = label;
      const inp = document.createElement('input'); inp.type = 'number'; inp.step = '0.5'; inp.value = String(value); inp.inputMode = 'decimal';
      inp.addEventListener('change', () => { const v = parseFloat(inp.value.replace(',', '.')); if (!isFinite(v) || v <= 0) return; onChange(v); });
      row.append(lab, inp); p.append(row);
    };
    const checkRow = (label: string, value: boolean, onChange: (v: boolean) => void) => {
      const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = label;
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = value; chk.addEventListener('change', () => onChange(chk.checked));
      row.append(lab, chk); p.append(row);
    };
    const selectRow = (label: string, options: [string, string][], value: string, onChange: (v: string) => void) => {
      const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = label;
      const sel = document.createElement('select'); for (const [v, t] of options) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); }
      sel.value = value; sel.addEventListener('change', () => onChange(sel.value)); row.append(lab, sel); p.append(row);
    };
    const edit = (mut: () => void) => { void this.tryFeature(() => { mut(); return f; }); };
    if (f.type === 'extrude') {
      numRow('Profundidade (mm)', f.depth, (v) => edit(() => { f.depth = v; }));
      const others = bodyIds(doc).filter((id) => id !== f.id);
      const opOptions: [string, string][] = [['new', 'Novo corpo']]; if (others.length) opOptions.push(['add', 'Adicionar a corpo'], ['cut', 'Cortar corpo']);
      selectRow('Operação', opOptions, f.op, (v) => edit(() => { f.op = v as ExtrudeOp; if (f.op === 'new') f.target = undefined; else if (!f.target || !others.includes(f.target)) f.target = others[0]; }));
      if (f.op !== 'new' && others.length > 1) selectRow('Corpo alvo', others.map((id) => [id, bodyName(doc, id)]), f.target ?? others[0], (v) => edit(() => { f.target = v; }));
      checkRow('Simétrico ao plano', !!f.symmetric, (v) => edit(() => { f.symmetric = v; }));
      checkRow('Inverter sentido', !!f.flip, (v) => edit(() => { f.flip = v; }));
      if (f.op === 'cut') checkRow('Atravessar tudo', !!f.throughAll, (v) => edit(() => { f.throughAll = v; }));
      const row3 = el('div', 'row');
      row3.append(this.button('Editar esboço', () => this.enterSketch(f.sketch)));
      row3.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger'));
      p.append(row3);
    } else if (f.type === 'revolve') {
      numRow('Ângulo (°)', f.angle, (v) => edit(() => { f.angle = Math.min(360, v); }));
      const axes = this.axisOptions(getSketch(doc, f.sketch));
      const cur = axes.find((a) => (f.axis.line ? a.axis.line === f.axis.line : !a.axis.line && a.axis.p[0] === f.axis.p[0] && a.axis.p[1] === f.axis.p[1] && a.axis.d[0] === f.axis.d[0] && a.axis.d[1] === f.axis.d[1]));
      selectRow('Eixo', axes.map((a) => [a.key, a.label]), cur?.key ?? axes[0].key, (v) => edit(() => { const a = axes.find((x) => x.key === v); if (a) f.axis = a.axis; }));
      const others = bodyIds(doc).filter((id) => id !== f.id);
      const opOptions: [string, string][] = [['new', 'Novo corpo']]; if (others.length) opOptions.push(['add', 'Adicionar a corpo'], ['cut', 'Cortar corpo']);
      selectRow('Operação', opOptions, f.op, (v) => edit(() => { f.op = v as ExtrudeOp; if (f.op === 'new') f.target = undefined; else if (!f.target || !others.includes(f.target)) f.target = others[0]; }));
      if (f.op !== 'new' && others.length > 1) selectRow('Corpo alvo', others.map((id) => [id, bodyName(doc, id)]), f.target ?? others[0], (v) => edit(() => { f.target = v; }));
      checkRow('Sentido contrário', !!f.flip, (v) => edit(() => { f.flip = v; }));
      const row3 = el('div', 'row');
      row3.append(this.button('Editar esboço', () => this.enterSketch(f.sketch)));
      row3.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger'));
      p.append(row3);
    } else if (f.type === 'fillet' || f.type === 'chamfer') {
      numRow(f.type === 'fillet' ? 'Raio (mm)' : 'Distância (mm)', f.radius, (v) => edit(() => { f.radius = v; }));
      const d = el('div', 'hint'); d.textContent = `${f.edges.length} aresta${f.edges.length > 1 ? 's' : ''} em ${bodyName(doc, f.body)}.`; p.append(d);
      const row = el('div', 'row'); row.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger')); p.append(row);
    } else if (f.type === 'boolean') {
      selectRow('Operação', [['union', 'União'], ['subtract', 'Subtração'], ['intersect', 'Interseção']], f.op, (v) => edit(() => { f.op = v as typeof f.op; }));
      const d = el('div', 'hint'); d.textContent = `${bodyName(doc, f.body)} com ${bodyName(doc, f.tool)}.`; p.append(d);
      const row = el('div', 'row'); row.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger')); p.append(row);
    }
  }

  private deleteFeature(f: Feature): void {
    const doc = this.doc.current;
    const go = () => {
      this.pushUndo();
      const victims = new Set<Id>([f.id]);
      if (f.type === 'extrude' && f.op === 'new') for (const d of featuresOfBody(doc, f.id)) victims.add(d.id);
      doc.features = doc.features.filter((x) => !victims.has(x.id));
      this.selectedFeature = null; this.sel3d = emptySel3D(); this.refreshAll();
    };
    const deps = f.type === 'extrude' && f.op === 'new' ? featuresOfBody(doc, f.id).length - 1 : 0;
    if (deps > 0) this.confirm('Apagar corpo', `Apagar "${f.name}" remove também ${deps} feature${deps > 1 ? 's' : ''} que dependem desse corpo (cortes, filetes, combinações).`, go);
    else go();
  }
  private deleteBody(body: Id): void {
    const f = this.doc.current.features.find((x) => x.id === body); if (f) this.deleteFeature(f);
  }
  private clearSel3d(): void { this.sel3d = emptySel3D(); this.vp.setSelection(this.sel3d); this.renderSidePanel(); this.renderToolbar(); }

  // ---------- Rótulos (HTML sobre a cena) ----------
  private placeLabels(): void {
    const plane = this.plane; const labels = plane ? this.sk.labels : [];
    const seen = new Set<string>();
    for (const l of labels) {
      const key = `${l.kind}:${l.id}`; seen.add(key);
      let node = this.labelNodes.get(key);
      if (!node) {
        node = el('div', l.kind === 'dimension' ? 'dim-label' : 'tag');
        if (l.kind === 'dimension') node.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.editDimension(l.id); });
        this.labelsEl.append(node); this.labelNodes.set(key, node);
      }
      node.textContent = l.text; node.className = l.kind === 'dimension' ? `dim-label ${l.selected ? 'selected' : ''}` : 'tag';
      const s = this.vp.planeToScreen(plane!, l.u, l.v); node.style.left = `${s.x}px`; node.style.top = `${s.y}px`;
    }
    for (const [key, node] of this.labelNodes) if (!seen.has(key)) { node.remove(); this.labelNodes.delete(key); }
  }

  // ---------- Modo esboço ----------
  newSketchMenu(ev: MouseEvent): void {
    const doc = this.doc.current;
    this.menu(ev.clientX, ev.clientY, doc.planes.filter((p) => p.kind !== 'face').map((p) => ({ label: `Esboço em ${p.name}`, action: () => this.createSketchOn(p.id) })));
  }
  createSketchOn(planeId: Id, withUndo = true): void {
    if (withUndo) this.pushUndo();
    const n = this.doc.current.sketches.length + 1;
    const s = M.createSketch(planeId, `Esboço ${n}`); this.doc.current.sketches.push(s);
    this.enterSketch(s.id);
  }
  /** Cria um plano a partir de uma face plana de um corpo e abre um esboço nele. */
  createSketchOnFace(body: Id, faceIndex: number): void {
    const doc = this.doc.current;
    const data = this.bodies.find((b) => b.id === body); const f = data?.faces[faceIndex];
    if (!data || !f || f.type !== 'plane' || !f.normal || !f.u || !f.v || !f.origin) { this.toast('Só dá para esboçar em faces planas.', 'err'); return; }
    const n = f.normal; const d = v3dot(v3sub(f.center, f.origin), n);
    const origin: V3 = [f.center[0] - n[0] * d, f.center[1] - n[1] * d, f.center[2] - n[2] * d];
    let u = f.u, v = f.v; if (v3dot(v3cross(u, v), n) < 0) v = v3neg(v);
    this.pushUndo();
    const plane = addFacePlane(doc, `Face de ${data.name}`, origin, u, v, body);
    this.createSketchOn(plane.id, false);
  }
  enterSketch(id: Id): void {
    this.activeSketch = id; this.mode = 'sketch'; this.tool = 'draw'; this.sel = emptySelection(); this.pendingDimRefs = []; this.selectedFeature = null; this.sel3d = emptySel3D();
    const p = this.plane!; this.vp.enterSketch(p); this.vp.setSelection(this.sel3d);
    this.solve(); this.refreshAll(false); this.vp.fitAll();
  }
  exitSketch(removeEmpty: boolean): void {
    const s = this.sketch;
    if (s && removeEmpty && !s.entities.length) this.doc.current.sketches = this.doc.current.sketches.filter((x) => x.id !== s.id);
    pruneFacePlanes(this.doc.current);
    this.activeSketch = null; this.mode = 'view'; this.sel = emptySelection(); this.pendingDimRefs = []; this.lastSolve = null;
    this.vp.exitSketch(); this.refreshAll(); this.vp.fitAll();
  }
  setTool(t: Tool): void { this.tool = t; this.pendingDimRefs = []; if (t !== 'select') this.sel = emptySelection(); this.refreshAll(false); }

  private solve(opts?: { drag?: { point: Id; x: number; y: number } }): SolveResult | null {
    const s = this.sketch; if (!s) return null;
    this.lastSolve = solveSketch(s, opts); return this.lastSolve;
  }

  /** Tolerância de toque em mm, conforme o tipo de ponteiro. */
  private tolMm(type: string): number { return this.vp.mmPerPixel() * (type === 'touch' ? 16 : 10); }

  private hitTest(uv: Vec2, tol: number, s: Sketch): Hit | null {
    let best: Hit | null = null;
    for (const p of s.points) { const d = dist(uv, p); if (d < tol && (!best || d < best.d)) best = { kind: 'point', id: p.id, d }; }
    if (best) return best;
    for (const e of s.entities) {
      const d = this.entityDistance(uv, e, s);
      if (d < tol && (!best || d < best.d)) best = { kind: 'entity', id: e.id, d };
    }
    return best;
  }
  private entityDistance(uv: Vec2, e: Entity, s: Sketch): number {
    if (e.type === 'line') return distPointSegment(uv, M.getPoint(s, e.a), M.getPoint(s, e.b));
    const c = M.getPoint(s, e.center);
    if (e.type === 'circle') return Math.abs(dist(uv, c) - e.r);
    const { start, end } = M.arcAngles(s, e); return distPointArc(uv, c, e.r, start, end);
  }

  /** Procura ponto existente perto de uv; se não houver, cria. Pode também grudar numa entidade. */
  private snapPoint(s: Sketch, uv: Vec2, tol: number, exclude: Set<Id> = new Set()): { id: Id; created: boolean; onEntity?: Entity } {
    let bestP: M.SketchPoint | null = null; let bd = tol;
    for (const p of s.points) { if (exclude.has(p.id)) continue; const d = dist(uv, p); if (d < bd) { bd = d; bestP = p; } }
    if (bestP) return { id: bestP.id, created: false };
    if (dist(uv, v2(0, 0)) < tol) { const p = M.addPoint(s, 0, 0); M.addConstraint(s, 'fixed', [p.id]); return { id: p.id, created: true }; }
    let bestE: Entity | null = null; let be = tol;
    for (const e of s.entities) { if (exclude.has(e.id)) continue; const d = this.entityDistance(uv, e, s); if (d < be) { be = d; bestE = e; } }
    if (bestE) {
      let q = uv;
      if (bestE.type === 'line') q = closestOnSegment(uv, M.getPoint(s, bestE.a), M.getPoint(s, bestE.b));
      else { const c = M.getPoint(s, bestE.center); const dir = norm(sub(uv, c)); q = add(v2(c.x, c.y), scale(dir, bestE.r)); }
      const p = M.addPoint(s, q.x, q.y);
      M.addConstraint(s, bestE.type === 'line' ? 'pointOnLine' : 'pointOnCircle', [p.id, bestE.id]);
      return { id: p.id, created: true, onEntity: bestE };
    }
    const p = M.addPoint(s, uv.x, uv.y); return { id: p.id, created: true };
  }

  /** Insere primitivas reconhecidas no esboço com encaixes automáticos. */
  private insertPrimitives(prims: Primitive[], tol: number): void {
    const s = this.sketch; if (!s || !prims.length) return;
    this.pushUndo();
    const before = M.cloneSketch(s);
    const autoCons: Id[] = [];
    const jointIds = new Map<string, Id>();
    const key = (p: Vec2) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
    const pointFor = (p: Vec2): Id => {
      const k = key(p); const ex = jointIds.get(k); if (ex) return ex;
      const sn = this.snapPoint(s, p, tol); jointIds.set(k, sn.id); return sn.id;
    };
    const created: Entity[] = [];
    for (const pr of prims) {
      if (pr.type === 'circle') {
        const c = M.addPoint(s, pr.c.x, pr.c.y);
        const other = s.entities.find((e) => e.type !== 'line' && dist(M.getPoint(s, e.center), pr.c) < tol * 1.5);
        const e = M.addCircle(s, c.id, pr.r); created.push(e);
        if (other) autoCons.push(M.addConstraint(s, 'concentric', [e.id, other.id]).id);
        continue;
      }
      if (pr.type === 'line') {
        const a = pointFor(pr.a), b = pointFor(pr.b);
        if (a === b) continue;
        const e = M.addLine(s, a, b); created.push(e);
        const ang = Math.abs(((angleOf(sub(pr.b, pr.a)) * 180) / Math.PI) % 180);
        const dev = Math.min(ang, 180 - ang);
        if (dev < H_V_SNAP_DEG) autoCons.push(M.addConstraint(s, 'horizontal', [e.id]).id);
        else if (Math.abs(dev - 90) < H_V_SNAP_DEG) autoCons.push(M.addConstraint(s, 'vertical', [e.id]).id);
        continue;
      }
      const a = pointFor(pr.a), b = pointFor(pr.b);
      if (a === b) continue;
      const c = M.addPoint(s, pr.c.x, pr.c.y);
      const e = pr.ccw ? M.addArc(s, c.id, a, b, pr.r) : M.addArc(s, c.id, b, a, pr.r); created.push(e);
    }
    for (const e of created) {
      if (e.type !== 'arc') continue;
      for (const pid of [e.start, e.end]) {
        const lines = s.entities.filter((o): o is M.LineEntity => o.type === 'line' && (o.a === pid || o.b === pid));
        for (const l of lines) {
          const c = M.getPoint(s, e.center), p = M.getPoint(s, pid);
          const radial = norm(sub(p, c)); const other = M.getPoint(s, l.a === pid ? l.b : l.a); const ldir = norm(sub(other, p));
          const cosang = Math.abs(radial.x * ldir.x + radial.y * ldir.y);
          if (Math.asin(Math.min(1, cosang)) * 180 / Math.PI < TANGENT_SNAP_DEG && !s.constraints.some((k) => k.kind === 'tangent' && k.refs.includes(l.id) && k.refs.includes(e.id)))
            autoCons.push(M.addConstraint(s, 'tangent', [l.id, e.id]).id);
        }
      }
    }
    let r = this.solve();
    if (!r || !r.converged) {
      s.constraints = s.constraints.filter((k) => !autoCons.includes(k.id));
      r = this.solve();
      if (!r || !r.converged) { Object.assign(s, before); this.solve(); this.toast('Não consegui encaixar esse traço. Tente de novo.', 'err'); }
      else this.toast('Encaixes automáticos removidos para fechar a geometria.');
    }
    this.refreshAll(false);
  }

  // ---------- Entrada ----------
  private bindPointer(): void {
    const c = this.vp.renderer.domElement;
    c.addEventListener('pointerdown', (ev) => this.onDown(ev));
    c.addEventListener('pointermove', (ev) => this.onMove(ev));
    c.addEventListener('pointerup', (ev) => this.onUp(ev));
    c.addEventListener('pointercancel', (ev) => this.onUp(ev, true));
    c.addEventListener('wheel', (ev) => { ev.preventDefault(); const f = Math.exp(-ev.deltaY * 0.0015); this.vp.zoom(f, this.local(ev)); this.refreshSketch(); }, { passive: false });
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
    c.addEventListener('dblclick', () => this.vp.fitAll());
  }
  private local(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.vp.renderer.domElement.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  private roleFor(ev: PointerEvent): PointerInfo['role'] {
    if (ev.pointerType === 'mouse') { if (ev.button === 1 || ev.button === 2) return 'pan'; return this.mode === 'sketch' ? 'tool' : 'nav'; }
    if (ev.pointerType === 'pen') return this.mode === 'sketch' ? 'tool' : 'nav';
    if (this.mode === 'sketch' && this.touchDraws) return 'tool';
    return 'nav';
  }

  private onDown(ev: PointerEvent): void {
    this.closeMenus();
    const { x, y } = this.local(ev);
    const info: PointerInfo = { id: ev.pointerId, type: ev.pointerType, x, y, startX: x, startY: y, moved: false, role: this.roleFor(ev), button: ev.button };
    this.pointers.set(ev.pointerId, info);
    this.vp.renderer.domElement.setPointerCapture(ev.pointerId);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      if (this.stroke.length && a.type === 'touch' && b.type === 'touch') { this.stroke = []; this.sk.setStroke(null, []); this.toolStart = null; }
      return;
    }
    if (this.pointers.size > 2) return;
    if (info.role === 'tool' && this.mode === 'sketch') this.toolDown(info);
  }

  private onMove(ev: PointerEvent): void {
    const info = this.pointers.get(ev.pointerId); if (!info) { this.hover(ev); return; }
    const { x, y } = this.local(ev); const dx = x - info.x, dy = y - info.y;
    info.x = x; info.y = y;
    if (!info.moved && Math.hypot(x - info.startX, y - info.startY) > 5) info.moved = true;
    if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y); const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (this.pinch.d0 > 0) this.vp.zoom(d / this.pinch.d0, mid);
      this.vp.pan(mid.x - this.pinch.mid.x, mid.y - this.pinch.mid.y);
      this.pinch = { d0: d, mid }; this.refreshSketch(); return;
    }
    if (this.pointers.size !== 1) return;
    if (info.role === 'nav') { if (this.mode === 'sketch') this.vp.pan(dx, dy); else this.vp.orbit(dx, dy); this.refreshSketch(); return; }
    if (info.role === 'pan') { this.vp.pan(dx, dy); this.refreshSketch(); return; }
    if (this.mode === 'sketch') this.toolMove(info, ev);
  }

  private onUp(ev: PointerEvent, cancelled = false): void {
    const info = this.pointers.get(ev.pointerId); if (!info) return;
    this.pointers.delete(ev.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (info.role === 'nav' && !info.moved && !cancelled) { this.tapView(info); return; }
    if (info.role === 'tool' && this.mode === 'sketch') this.toolUp(info, cancelled);
  }

  private hover(ev: PointerEvent): void {
    if (this.mode !== 'view') return;
    const { x, y } = this.local(ev); const id = this.vp.pickPlane(x, y);
    if (id !== this.hoverPlane) { this.hoverPlane = id; this.vp.highlightPlane(id); }
  }

  /** Toque simples em modo vista: aresta, face, corpo de prévia, plano ou vazio. */
  private tapView(info: PointerInfo): void {
    if (this.mode !== 'view') return;
    const faceHit = this.vp.pickFace(info.x, info.y);
    if (this.isAssembly) {
      if (faceHit && faceHit.index >= 0) { this.tapAssemblyFace(faceHit.body, faceHit.index, info.x, info.y); return; }
      if (this.jointFlow) return;
      if (this.selectedInstance || this.sel3d.body) { this.selectedInstance = null; this.clearSel3d(); }
      return;
    }
    const edgeHit = this.vp.pickEdge(info.x, info.y, info.type === 'touch' ? 14 : 9, faceHit);
    if (edgeHit) {
      if (this.sel3d.edges.length && this.sel3d.edges[0].body !== edgeHit.body) this.sel3d.edges = [];
      const i = this.sel3d.edges.findIndex((e) => e.body === edgeHit.body && e.index === edgeHit.index);
      if (i >= 0) this.sel3d.edges.splice(i, 1); else this.sel3d.edges.push({ body: edgeHit.body, index: edgeHit.index });
      this.sel3d.face = null; this.sel3d.body = this.sel3d.edges.length ? edgeHit.body : null; this.selectedFeature = null;
      this.vp.setSelection(this.sel3d); this.renderSidePanel(); this.renderToolbar();
      if (this.sel3d.edges.length) this.menu(info.x + 10, info.y + 10, [
        { label: `Filete nas ${this.sel3d.edges.length} aresta${this.sel3d.edges.length > 1 ? 's' : ''}…`, action: () => this.filletSelected('fillet') },
        { label: 'Chanfro…', action: () => this.filletSelected('chamfer') },
      ]);
      return;
    }
    if (faceHit) {
      this.selectedFeature = null;
      if (faceHit.index < 0) { this.sel3d = { body: faceHit.body, face: null, edges: [] }; }
      else {
        const same = this.sel3d.face && this.sel3d.face.body === faceHit.body && this.sel3d.face.index === faceHit.index;
        this.sel3d = same ? { body: faceHit.body, face: null, edges: [] } : { body: faceHit.body, face: { body: faceHit.body, index: faceHit.index }, edges: [] };
        if (this.sel3d.face && this.faceIsPlanar(this.sel3d.face)) {
          const items = [{ label: 'Esboçar nesta face', action: () => this.createSketchOnFace(faceHit.body, faceHit.index) }];
          const sketchesHere = this.doc.current.sketches.filter((s) => getPlane(this.doc.current, s.plane).body === faceHit.body);
          for (const s of sketchesHere) items.push({ label: `Extrudar ${s.name}`, action: () => this.extrudeSketch(s.id) });
          this.menu(info.x + 10, info.y + 10, items);
        }
      }
      this.vp.setSelection(this.sel3d); this.renderSidePanel(); this.renderToolbar();
      return;
    }
    const plane = this.vp.pickPlane(info.x, info.y);
    if (plane) { const p = getPlane(this.doc.current, plane); this.menu(info.x + 8, info.y + 8, [{ label: `Novo esboço em ${p.name}`, action: () => this.createSketchOn(plane) }]); return; }
    if (this.selectedFeature || this.sel3d.body || this.sel3d.face || this.sel3d.edges.length) { this.selectedFeature = null; this.clearSel3d(); }
  }

  // ---------- Ferramentas de esboço ----------
  private uvOf(info: { x: number; y: number }): Vec2 | null { const p = this.plane; return p ? this.vp.screenToPlane(info.x, info.y, p) : null; }

  private toolDown(info: PointerInfo): void {
    const s = this.sketch; const uv = this.uvOf(info); if (!s || !uv) return;
    const tol = this.tolMm(info.type);
    switch (this.tool) {
      case 'draw': this.stroke = [uv]; this.sk.setStroke(this.plane, this.stroke); this.vp.requestRender(); break;
      case 'line': case 'rect': case 'circle': {
        this.pushUndo(); this.previewSketchBackup = M.cloneSketch(s);
        this.toolStart = { uv }; break;
      }
      case 'select': {
        const hit = this.hitTest(uv, tol, s);
        if (hit?.kind === 'point') { this.pushUndo(); this.dragPoint = hit.id; this.sel = emptySelection(); this.sel.points.add(hit.id); this.refreshSketch(); this.renderSidePanel(); }
        break;
      }
      default: break;
    }
  }

  private toolMove(info: PointerInfo, _ev: PointerEvent): void {
    const s = this.sketch; const uv = this.uvOf(info); if (!s || !uv) return;
    switch (this.tool) {
      case 'draw': if (this.stroke.length) { this.stroke.push(uv); this.sk.setStroke(this.plane, this.stroke); this.vp.requestRender(); } break;
      case 'line': case 'rect': case 'circle': {
        if (!this.toolStart || !this.previewSketchBackup) return;
        Object.assign(s, M.cloneSketch(this.previewSketchBackup));
        this.buildShape(s, this.toolStart.uv, uv, this.tolMm(info.type), true);
        this.refreshSketch(); break;
      }
      case 'select': {
        if (this.dragPoint && info.moved) { this.solve({ drag: { point: this.dragPoint, x: uv.x, y: uv.y } }); this.refreshSketch(); this.renderStatus(); }
        break;
      }
      default: break;
    }
  }

  private toolUp(info: PointerInfo, cancelled: boolean): void {
    const s = this.sketch; const uv = this.uvOf(info) ?? v2(0, 0); if (!s) return;
    const tol = this.tolMm(info.type);
    switch (this.tool) {
      case 'draw': {
        const pts = this.stroke; this.stroke = []; this.sk.setStroke(null, []);
        if (cancelled || pts.length < 2) { this.vp.requestRender(); return; }
        const prims = recognizeStroke(pts, { tol: Math.max(tol * 0.45, this.vp.mmPerPixel() * 3.5), minRadius: tol });
        if (!prims.length) { this.toast('Traço curto demais.'); this.vp.requestRender(); return; }
        this.insertPrimitives(prims, tol);
        break;
      }
      case 'line': case 'rect': case 'circle': {
        if (!this.toolStart || !this.previewSketchBackup) return;
        Object.assign(s, M.cloneSketch(this.previewSketchBackup));
        if (!cancelled && info.moved) { this.buildShape(s, this.toolStart.uv, uv, tol, false); this.solve(); }
        else this.undoStack.pop();
        this.toolStart = null; this.previewSketchBackup = null; this.refreshAll(false);
        break;
      }
      case 'select': {
        if (this.dragPoint) { if (!info.moved) this.undoStack.pop(); this.dragPoint = null; this.solve(); this.refreshAll(false); return; }
        if (!info.moved) this.tapSelect(uv, tol, s);
        break;
      }
      case 'erase': {
        const hit = this.hitTest(uv, tol, s);
        if (hit?.kind === 'entity') { this.pushUndo(); M.removeEntities(s, [hit.id]); this.solve(); this.refreshAll(false); }
        else if (hit?.kind === 'point') { this.pushUndo(); const ents = s.entities.filter((e) => M.entityPoints(e).includes(hit.id)).map((e) => e.id); M.removeEntities(s, ents); this.solve(); this.refreshAll(false); }
        break;
      }
      case 'dimension': this.tapDimension(uv, tol, s); break;
    }
  }

  /** Cria linha, retângulo ou círculo entre dois pontos de tela (prévia e definitivo). */
  private buildShape(s: Sketch, a: Vec2, b: Vec2, tol: number, preview: boolean): void {
    const snapOrAdd = (p: Vec2, exclude: Set<Id>) => preview ? M.addPoint(s, p.x, p.y).id : this.snapPoint(s, p, tol, exclude).id;
    if (this.tool === 'line') {
      if (dist(a, b) < tol * 0.5) return;
      const pa = snapOrAdd(a, new Set()); const pb = snapOrAdd(b, new Set([pa]));
      if (pa === pb) return;
      const l = M.addLine(s, pa, pb);
      if (!preview) {
        const ang = Math.abs(((angleOf(sub(b, a)) * 180) / Math.PI) % 180); const dev = Math.min(ang, 180 - ang);
        if (dev < H_V_SNAP_DEG) M.addConstraint(s, 'horizontal', [l.id]); else if (Math.abs(dev - 90) < H_V_SNAP_DEG) M.addConstraint(s, 'vertical', [l.id]);
      }
    } else if (this.tool === 'rect') {
      if (Math.abs(a.x - b.x) < tol * 0.5 || Math.abs(a.y - b.y) < tol * 0.5) return;
      const p1 = snapOrAdd(a, new Set()), p2 = snapOrAdd(v2(b.x, a.y), new Set()), p3 = snapOrAdd(b, new Set()), p4 = snapOrAdd(v2(a.x, b.y), new Set());
      const l1 = M.addLine(s, p1, p2), l2 = M.addLine(s, p2, p3), l3 = M.addLine(s, p3, p4), l4 = M.addLine(s, p4, p1);
      M.addConstraint(s, 'horizontal', [l1.id]); M.addConstraint(s, 'vertical', [l2.id]); M.addConstraint(s, 'horizontal', [l3.id]); M.addConstraint(s, 'vertical', [l4.id]);
    } else if (this.tool === 'circle') {
      const r = dist(a, b); if (r < tol * 0.5) return;
      const c = preview ? M.addPoint(s, a.x, a.y).id : this.snapPoint(s, a, tol).id;
      M.addCircle(s, c, r);
    }
  }

  private tapSelect(uv: Vec2, tol: number, s: Sketch): void {
    const hit = this.hitTest(uv, tol, s);
    if (!hit) { this.sel = emptySelection(); this.refreshAll(false); return; }
    const set = hit.kind === 'point' ? this.sel.points : this.sel.entities;
    if (set.has(hit.id)) set.delete(hit.id); else set.add(hit.id);
    this.refreshAll(false);
  }

  private tapDimension(uv: Vec2, tol: number, s: Sketch): void {
    const hit = this.hitTest(uv, tol, s);
    if (!hit) {
      if (this.pendingDimRefs.length) { const refs = this.pendingDimRefs; this.pendingDimRefs = []; this.createDimension(refs, uv); }
      return;
    }
    const refs = [...this.pendingDimRefs, hit.id];
    const e = M.findEntity(s, hit.id);
    if (refs.length === 1 && e && e.type !== 'line') { this.pendingDimRefs = []; this.createDimension(refs, uv); return; }
    if (refs.length >= 2) { this.pendingDimRefs = []; this.createDimension(refs, uv); return; }
    this.pendingDimRefs = refs; this.sel = emptySelection(); if (e) this.sel.entities.add(hit.id); else this.sel.points.add(hit.id);
    this.refreshAll(false);
  }

  /** Decide o tipo de cota pelos elementos e abre a entrada de valor. */
  private createDimension(refs: Id[], at: Vec2): void {
    const s = this.sketch; if (!s) return;
    const ents = refs.map((r) => M.findEntity(s, r)); const pts = refs.map((r) => M.findPoint(s, r));
    let kind: DimensionKind | null = null; let value = 0; let finalRefs = refs;
    if (refs.length === 1) {
      const e = ents[0]; if (!e) return;
      if (e.type === 'line') { const a = M.getPoint(s, e.a), b = M.getPoint(s, e.b); const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y); const isH = s.constraints.some((k) => k.kind === 'horizontal' && k.refs[0] === e.id), isV = s.constraints.some((k) => k.kind === 'vertical' && k.refs[0] === e.id); kind = isH ? 'hdistance' : isV ? 'vdistance' : 'distance'; value = kind === 'hdistance' ? dx : kind === 'vdistance' ? dy : dist(a, b); }
      else if (e.type === 'circle') { kind = 'diameter'; value = e.r * 2; }
      else { kind = 'radius'; value = e.r; }
    } else {
      const [e1, e2] = ents; const [p1, p2] = pts;
      if (p1 && p2) { kind = 'distance'; value = dist(p1, p2); }
      else if (e1?.type === 'line' && e2?.type === 'line') { const d1 = sub(M.getPoint(s, e1.b), M.getPoint(s, e1.a)), d2 = sub(M.getPoint(s, e2.b), M.getPoint(s, e2.a)); kind = 'angle'; value = Math.atan2(Math.abs(d1.x * d2.y - d1.y * d2.x), d1.x * d2.x + d1.y * d2.y) * 180 / Math.PI; }
      else if ((p1 && e2?.type === 'line') || (p2 && e1?.type === 'line')) { const p = p1 ?? p2!; const l = (e2?.type === 'line' ? e2 : e1) as M.LineEntity; finalRefs = [p.id, l.id]; kind = 'distance'; const a = M.getPoint(s, l.a), b = M.getPoint(s, l.b); const ab = sub(b, a); const L = Math.hypot(ab.x, ab.y) || 1; value = Math.abs(ab.x * (p.y - a.y) - ab.y * (p.x - a.x)) / L; }
      else if ((p1 && e2 && e2.type !== 'line') || (p2 && e1 && e1.type !== 'line')) { const p = p1 ?? p2!; const c = (e2 && e2.type !== 'line' ? e2 : e1) as M.CircleEntity; finalRefs = [p.id, c.center]; kind = 'distance'; value = dist(p, M.getPoint(s, c.center)); }
      else if (e1 && e2 && e1.type !== 'line' && e2.type !== 'line') { finalRefs = [e1.center, e2.center]; kind = 'distance'; value = dist(M.getPoint(s, e1.center), M.getPoint(s, e2.center)); }
    }
    if (!kind) { this.toast('Combinação sem cota possível.'); this.sel = emptySelection(); this.refreshAll(false); return; }
    const k = kind; const v0 = round(value, 2);
    const screen = this.vp.planeToScreen(this.plane!, at.x, at.y);
    this.valuePopover(screen.x, screen.y, v0, k === 'angle' ? '°' : 'mm', (v) => {
      this.pushUndo();
      let offset: Vec2 = { x: 0, y: 8 };
      if (k === 'distance' || k === 'hdistance' || k === 'vdistance') {
        const [a, b] = dimEndpoints(s, { kind: k, refs: finalRefs });
        if (a && b) { const dir = k === 'hdistance' ? v2(1, 0) : k === 'vdistance' ? v2(0, 1) : norm(sub(b, a)); const nrm = v2(-dir.y, dir.x); const mid = v2((a.x + b.x) / 2, (a.y + b.y) / 2); const off = (at.x - mid.x) * nrm.x + (at.y - mid.y) * nrm.y; offset = scale(nrm, Math.abs(off) < 2 ? 8 : off); }
      } else if (k === 'radius' || k === 'diameter') { const e = M.findEntity(s, finalRefs[0]); if (e && e.type !== 'line') { const c = M.getPoint(s, e.center); offset = norm(sub(at, c)); } }
      const d = M.addDimension(s, k, finalRefs, v, offset);
      const r = this.solve();
      if (!r?.converged) { M.removeDimension(s, d.id); this.solve(); this.toast('Essa cota conflita com as restrições existentes.', 'err'); }
      this.sel = emptySelection(); this.refreshAll(false);
    });
  }

  editDimension(id: Id): void {
    const s = this.sketch; if (!s) return; const d = s.dimensions.find((x) => x.id === id); if (!d) return;
    this.sel = emptySelection(); this.sel.dimensions.add(id); this.refreshSketch();
    const lab = this.sk.labels.find((l) => l.id === id); const scr = lab ? this.vp.planeToScreen(this.plane!, lab.u, lab.v) : { x: this.vp.width / 2, y: this.vp.height / 2 };
    this.valuePopover(scr.x, scr.y, d.value, d.kind === 'angle' ? '°' : 'mm', (v) => {
      this.pushUndo(); const old = d.value; d.value = v;
      const r = this.solve();
      if (!r?.converged) { d.value = old; this.solve(); this.toast('Valor incompatível com as restrições.', 'err'); }
      this.sel = emptySelection(); this.refreshAll(false);
    }, () => { this.pushUndo(); M.removeDimension(s, id); this.solve(); this.sel = emptySelection(); this.refreshAll(false); });
  }

  private applicableConstraints(): { kind: ConstraintKind; label: string; refs: Id[] }[] {
    const s = this.sketch; if (!s) return [];
    const ents = [...this.sel.entities].map((id) => M.getEntity(s, id)); const pts = [...this.sel.points];
    const out: { kind: ConstraintKind; label: string; refs: Id[] }[] = [];
    const lines = ents.filter((e): e is M.LineEntity => e.type === 'line'); const rounds = ents.filter((e) => e.type !== 'line');
    if (ents.length === 1 && lines.length === 1 && !pts.length) { out.push({ kind: 'horizontal', label: 'Horizontal', refs: [lines[0].id] }, { kind: 'vertical', label: 'Vertical', refs: [lines[0].id] }); }
    if (lines.length === 2 && ents.length === 2 && !pts.length) { const r = [lines[0].id, lines[1].id]; out.push({ kind: 'parallel', label: 'Paralelas', refs: r }, { kind: 'perpendicular', label: 'Perpendiculares', refs: r }, { kind: 'equal', label: 'Iguais', refs: r }); }
    if (lines.length === 1 && rounds.length === 1 && !pts.length) out.push({ kind: 'tangent', label: 'Tangentes', refs: [lines[0].id, rounds[0].id] });
    if (rounds.length === 2 && ents.length === 2 && !pts.length) { const r = [rounds[0].id, rounds[1].id]; out.push({ kind: 'concentric', label: 'Concêntricos', refs: r }, { kind: 'equal', label: 'Raios iguais', refs: r }, { kind: 'tangent', label: 'Tangentes', refs: r }); }
    if (pts.length === 2 && !ents.length) out.push({ kind: 'horizontal', label: 'Alinhar horizontal', refs: pts }, { kind: 'vertical', label: 'Alinhar vertical', refs: pts }, { kind: 'fixed', label: 'Coincidir (fundir)', refs: pts });
    if (pts.length === 1 && lines.length === 1 && ents.length === 1) out.push({ kind: 'pointOnLine', label: 'Ponto na linha', refs: [pts[0], lines[0].id] }, { kind: 'midpoint', label: 'Ponto médio', refs: [pts[0], lines[0].id] });
    if (pts.length === 1 && rounds.length === 1 && ents.length === 1) out.push({ kind: 'pointOnCircle', label: 'Ponto no círculo', refs: [pts[0], rounds[0].id] });
    if (pts.length === 1 && !ents.length) out.push({ kind: 'fixed', label: 'Fixar ponto', refs: [pts[0]] });
    return out;
  }

  private applyConstraint(kind: ConstraintKind, refs: Id[]): void {
    const s = this.sketch; if (!s) return;
    this.pushUndo(); const before = M.cloneSketch(s);
    if (kind === 'fixed' && refs.length === 2) { M.mergePoints(s, refs[1], refs[0]); }
    else if ((kind === 'horizontal' || kind === 'vertical') && refs.length === 2) {
      const l = M.addLine(s, refs[0], refs[1]); l.construction = true; M.addConstraint(s, kind, [l.id]);
    } else M.addConstraint(s, kind, refs);
    const r = this.solve();
    if (!r?.converged) { Object.assign(s, before); this.solve(); this.toast('Restrição conflita com as existentes.', 'err'); }
    this.sel = emptySelection(); this.refreshAll(false);
  }

  private toggleConstruction(): void {
    const s = this.sketch; if (!s) return; this.pushUndo();
    for (const id of this.sel.entities) { const e = M.getEntity(s, id); e.construction = !e.construction; }
    this.refreshAll(false);
  }
  private deleteSelection(): void {
    const s = this.sketch; if (!s) return; this.pushUndo();
    const ents = new Set(this.sel.entities);
    for (const pid of this.sel.points) for (const e of s.entities) if (M.entityPoints(e).includes(pid)) ents.add(e.id);
    for (const did of this.sel.dimensions) M.removeDimension(s, did);
    M.removeEntities(s, [...ents]);
    this.sel = emptySelection(); this.solve(); this.refreshAll(false);
  }

  // ---------- Extrusão, filete, booleanas ----------
  private extrudeActive(): void {
    const s = this.sketch; if (!s) return;
    const id = s.id; this.exitSketch(true);
    if (this.doc.current.sketches.some((x) => x.id === id)) this.extrudeSketch(id);
  }
  private extrudeMenu(ev: MouseEvent): void {
    const doc = this.doc.current;
    if (!doc.sketches.length) return this.toast('Crie um esboço fechado primeiro.');
    const items: { label: string; action: () => void }[] = [];
    for (const s of doc.sketches) { items.push({ label: `Extrudar ${s.name}`, action: () => this.extrudeSketch(s.id) }); items.push({ label: `Revolucionar ${s.name}`, action: () => this.revolveSketch(s.id) }); }
    this.menu(ev.clientX, ev.clientY, items);
  }

  /** Diálogo de extrusão: operação, profundidade, alvo e sentido. */
  private extrudeSketch(sketchId: Id): void {
    const doc = this.doc.current;
    const sk = getSketch(doc, sketchId); const plane = getPlane(doc, sk.plane);
    const bodies = bodyIds(doc);
    const faceBody = plane.kind === 'face' && plane.body && bodies.includes(plane.body) ? plane.body : null;
    const kernelOk = this.kernel.state === 'ready';
    const state = { op: (faceBody && kernelOk ? 'cut' : 'new') as ExtrudeOp, depth: 10, target: faceBody ?? bodies[0] ?? '', symmetric: false, flip: !!faceBody, throughAll: false, flipTouched: false };

    const back = el('div', 'dialog-backdrop'); const d = el('div', 'dialog');
    const hh = document.createElement('h2'); hh.textContent = `Extrudar ${sk.name}`; d.append(hh);
    const seg = el('div', 'segmented');
    const ops: [ExtrudeOp, string][] = [['new', 'Novo corpo'], ['add', 'Adicionar'], ['cut', 'Cortar']];
    const render = () => {
      seg.innerHTML = '';
      for (const [op, label] of ops) {
        const b = this.button(label, () => { state.op = op; if (!state.flipTouched) state.flip = op === 'cut' && !!faceBody; render(); }, `btn ${state.op === op ? 'primary' : ''}`);
        b.disabled = op !== 'new' && (!bodies.length || !kernelOk); seg.append(b);
      }
      targetRow.style.display = state.op !== 'new' && bodies.length > 1 ? '' : 'none';
      throughRow.style.display = state.op === 'cut' ? '' : 'none';
      flipChk.checked = state.flip;
    };
    d.append(seg);
    if (!kernelOk) { const hint = el('div', 'hint'); hint.textContent = this.kernel.state === 'loading' ? 'Adicionar e cortar ficam disponíveis quando o kernel 3D terminar de carregar.' : 'Kernel 3D indisponível: só corpo novo (prévia).'; d.append(hint); }
    const depthRow = el('div', 'row'); const dl = document.createElement('label'); dl.textContent = 'Profundidade (mm)';
    const depthInp = document.createElement('input'); depthInp.type = 'text'; depthInp.inputMode = 'decimal'; depthInp.value = '10'; depthRow.append(dl, depthInp); d.append(depthRow);
    const targetRow = el('div', 'row'); const tl = document.createElement('label'); tl.textContent = 'Corpo alvo';
    const targetSel = document.createElement('select'); for (const id of bodies) { const o = document.createElement('option'); o.value = id; o.textContent = bodyName(doc, id); targetSel.append(o); } targetSel.value = state.target;
    targetSel.addEventListener('change', () => { state.target = targetSel.value; }); targetRow.append(tl, targetSel); d.append(targetRow);
    const symRow = el('div', 'row'); const sl = document.createElement('label'); sl.textContent = 'Simétrico ao plano'; const symChk = document.createElement('input'); symChk.type = 'checkbox'; symChk.addEventListener('change', () => { state.symmetric = symChk.checked; }); symRow.append(sl, symChk); d.append(symRow);
    const flipRow = el('div', 'row'); const fl = document.createElement('label'); fl.textContent = 'Inverter sentido'; const flipChk = document.createElement('input'); flipChk.type = 'checkbox'; flipChk.addEventListener('change', () => { state.flip = flipChk.checked; state.flipTouched = true; }); flipRow.append(fl, flipChk); d.append(flipRow);
    const throughRow = el('div', 'row'); const trl = document.createElement('label'); trl.textContent = 'Atravessar tudo'; const thrChk = document.createElement('input'); thrChk.type = 'checkbox'; thrChk.addEventListener('change', () => { state.throughAll = thrChk.checked; }); throughRow.append(trl, thrChk); d.append(throughRow);
    const acts = el('div', 'actions');
    const ok = () => {
      const depth = parseFloat(depthInp.value.replace(',', '.'));
      if (!isFinite(depth) || depth <= 0) { this.toast('Profundidade inválida.', 'err'); return; }
      back.remove();
      void this.tryFeature(() => addExtrude(doc, sketchId, depth, { op: state.op, target: state.op === 'new' ? undefined : state.target, symmetric: state.symmetric, flip: state.flip, throughAll: state.op === 'cut' && state.throughAll }),
        (f) => { this.selectedFeature = f.id; this.sel3d = emptySel3D(); this.sel3d.body = bodyOfFeature(f); this.vp.setSelection(this.sel3d); this.renderSidePanel(); this.vp.fitAll(); });
    };
    acts.append(this.button('Cancelar', () => back.remove()), this.button('Extrudar', ok, 'btn primary')); d.append(acts);
    depthInp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ok(); if (ev.key === 'Escape') back.remove(); });
    render();
    back.append(d); this.overlay.append(back);
    setTimeout(() => { depthInp.focus(); depthInp.select(); }, 30);
  }

  /** Eixos possíveis para revolução: eixos do esboço e cada linha dele (construção primeiro). */
  private axisOptions(sk: Sketch): { key: string; label: string; axis: SketchAxis }[] {
    const out: { key: string; label: string; axis: SketchAxis }[] = [
      { key: 'v', label: 'Eixo vertical do esboço', axis: { p: [0, 0], d: [0, 1] } },
      { key: 'u', label: 'Eixo horizontal do esboço', axis: { p: [0, 0], d: [1, 0] } },
    ];
    const lines = sk.entities.filter((e): e is M.LineEntity => e.type === 'line').sort((a, b) => Number(!!b.construction) - Number(!!a.construction));
    lines.forEach((l, i) => {
      const a = M.getPoint(sk, l.a), b = M.getPoint(sk, l.b);
      out.push({ key: l.id, label: `${l.construction ? 'Construção' : 'Linha'} ${i + 1} (${fmtDim('distance', a.x)}, ${fmtDim('distance', a.y)}) → (${fmtDim('distance', b.x)}, ${fmtDim('distance', b.y)})`, axis: { line: l.id, p: [a.x, a.y], d: [b.x - a.x, b.y - a.y] } });
    });
    return out;
  }

  private revolveActive(): void {
    const s = this.sketch; if (!s) return;
    const id = s.id;
    const selLine = [...this.sel.entities].map((e) => M.findEntity(s, e)).find((e) => e?.type === 'line')?.id;
    this.exitSketch(true);
    if (this.doc.current.sketches.some((x) => x.id === id)) this.revolveSketch(id, selLine);
  }

  /** Diálogo de revolução: eixo, ângulo, operação, alvo e sentido. */
  private revolveSketch(sketchId: Id, preferredLine?: Id): void {
    const doc = this.doc.current;
    const sk = getSketch(doc, sketchId);
    const bodies = bodyIds(doc);
    const kernelOk = this.kernel.state === 'ready';
    if (!kernelOk) return this.toast(this.kernel.state === 'loading' ? 'A revolução precisa do kernel 3D, que ainda está carregando.' : 'Kernel 3D indisponível: revolução não está disponível.', 'err');
    const axes = this.axisOptions(sk);
    const firstConstruction = sk.entities.find((e): e is M.LineEntity => e.type === 'line' && !!e.construction);
    const state = { op: 'new' as ExtrudeOp, angle: 360, target: bodies[0] ?? '', flip: false, axisKey: preferredLine ?? firstConstruction?.id ?? 'v' };

    const back = el('div', 'dialog-backdrop'); const d = el('div', 'dialog');
    const hh = document.createElement('h2'); hh.textContent = `Revolucionar ${sk.name}`; d.append(hh);
    const seg = el('div', 'segmented');
    const ops: [ExtrudeOp, string][] = [['new', 'Novo corpo'], ['add', 'Adicionar'], ['cut', 'Cortar']];
    const render = () => {
      seg.innerHTML = '';
      for (const [op, label] of ops) { const b = this.button(label, () => { state.op = op; render(); }, `btn ${state.op === op ? 'primary' : ''}`); b.disabled = op !== 'new' && !bodies.length; seg.append(b); }
      targetRow.style.display = state.op !== 'new' && bodies.length > 1 ? '' : 'none';
    };
    d.append(seg);
    const axisRow = el('div', 'row'); const al = document.createElement('label'); al.textContent = 'Eixo';
    const axisSel = document.createElement('select'); for (const a of axes) { const o = document.createElement('option'); o.value = a.key; o.textContent = a.label; axisSel.append(o); } axisSel.value = state.axisKey;
    axisSel.addEventListener('change', () => { state.axisKey = axisSel.value; }); axisRow.append(al, axisSel); d.append(axisRow);
    const angRow = el('div', 'row'); const gl = document.createElement('label'); gl.textContent = 'Ângulo (°)';
    const angInp = document.createElement('input'); angInp.type = 'text'; angInp.inputMode = 'decimal'; angInp.value = '360'; angRow.append(gl, angInp); d.append(angRow);
    const targetRow = el('div', 'row'); const tl = document.createElement('label'); tl.textContent = 'Corpo alvo';
    const targetSel = document.createElement('select'); for (const id of bodies) { const o = document.createElement('option'); o.value = id; o.textContent = bodyName(doc, id); targetSel.append(o); } targetSel.value = state.target;
    targetSel.addEventListener('change', () => { state.target = targetSel.value; }); targetRow.append(tl, targetSel); d.append(targetRow);
    const flipRow = el('div', 'row'); const fl = document.createElement('label'); fl.textContent = 'Sentido contrário'; const flipChk = document.createElement('input'); flipChk.type = 'checkbox'; flipChk.addEventListener('change', () => { state.flip = flipChk.checked; }); flipRow.append(fl, flipChk); d.append(flipRow);
    const hint = el('div', 'hint'); hint.textContent = 'O perfil precisa ficar todo de um lado do eixo (pode encostar nele). Dica: desenhe o eixo como linha de construção.'; d.append(hint);
    const acts = el('div', 'actions');
    const ok = () => {
      const angle = parseFloat(angInp.value.replace(',', '.'));
      if (!isFinite(angle) || angle <= 0 || angle > 360) { this.toast('Ângulo inválido (0 a 360).', 'err'); return; }
      const axis = axes.find((a) => a.key === state.axisKey)?.axis ?? axes[0].axis;
      back.remove();
      void this.tryFeature(() => addRevolve(doc, sketchId, axis, angle, { op: state.op, target: state.op === 'new' ? undefined : state.target, flip: state.flip }),
        (f) => { this.selectedFeature = f.id; this.sel3d = emptySel3D(); this.sel3d.body = bodyOfFeature(f); this.vp.setSelection(this.sel3d); this.renderSidePanel(); this.vp.fitAll(); });
    };
    acts.append(this.button('Cancelar', () => back.remove()), this.button('Revolucionar', ok, 'btn primary')); d.append(acts);
    angInp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ok(); if (ev.key === 'Escape') back.remove(); });
    render();
    back.append(d); this.overlay.append(back);
    setTimeout(() => { angInp.focus(); angInp.select(); }, 30);
  }

  private filletSelected(kind: 'fillet' | 'chamfer'): void {
    const edges = this.sel3d.edges; if (!edges.length) return this.toast('Toque nas arestas primeiro.');
    const body = this.bodies.find((b) => b.id === edges[0].body); if (!body) return;
    const refs = edges.map((e) => body.edges[e.index]).filter(Boolean).map((e) => ({ mid: e.mid, len: e.len }));
    const minLen = Math.min(...refs.map((r) => r.len));
    const def = Math.max(0.5, Math.min(kind === 'fillet' ? 2 : 1, round(minLen / 4, 1)));
    this.valuePopover(this.vp.width / 2, this.vp.height / 2, def, 'mm', (r) => {
      void this.tryFeature(() => addFillet(this.doc.current, kind, body.id, refs, r), (f) => { this.sel3d = emptySel3D(); this.sel3d.body = body.id; this.selectedFeature = f.id; this.vp.setSelection(this.sel3d); this.renderSidePanel(); this.renderToolbar(); });
    });
  }

  private booleanMenu(ev: MouseEvent): void {
    const doc = this.doc.current; const body = this.sel3d.body; if (!body) return;
    const others = bodyIds(doc).filter((id) => id !== body);
    if (!others.length) return this.toast('Precisa de outro corpo para combinar.');
    const items: { label: string; action: () => void }[] = [];
    for (const o of others) {
      const n = bodyName(doc, o);
      items.push({ label: `Unir com ${n}`, action: () => this.addBooleanFeature('union', body, o) });
      items.push({ label: `Subtrair ${n}`, action: () => this.addBooleanFeature('subtract', body, o) });
      items.push({ label: `Interseção com ${n}`, action: () => this.addBooleanFeature('intersect', body, o) });
    }
    this.menu(ev.clientX, ev.clientY, items);
  }
  private addBooleanFeature(op: 'union' | 'subtract' | 'intersect', body: Id, tool: Id): void {
    void this.tryFeature(() => addBoolean(this.doc.current, op, body, tool), (f) => { this.selectedFeature = f.id; this.sel3d = emptySel3D(); this.sel3d.body = body; this.vp.setSelection(this.sel3d); this.renderSidePanel(); this.renderToolbar(); });
  }

  // ---------- Arquivos ----------
  newDocument(ev?: MouseEvent): void {
    const items = [
      { label: 'Nova peça', action: () => this.confirm('Nova peça', 'Descartar o documento atual? O autosave será substituído. Salve antes se precisar.', () => {
        this.doc.current = createDocument(); this.undoStack = []; this.redoStack = []; this.activeSketch = null; this.mode = 'view'; this.selectedFeature = null; this.selectedInstance = null; this.sel = emptySelection(); this.sel3d = emptySel3D(); this.asmCache.clear(); this.vp.exitSketch(); this.titleEl.value = this.doc.current.name; this.refreshAll(); this.vp.fitAll();
      }) },
      { label: 'Nova montagem vazia', action: () => this.newAssembly(false) },
    ];
    if (!this.isAssembly && this.doc.current.features.length) items.push({ label: 'Nova montagem com esta peça', action: () => this.newAssembly(true) });
    if (ev) this.menu(ev.clientX, ev.clientY, items); else items[0].action();
  }
  async openFile(): Promise<void> {
    const f = await pickFile('.forja,application/json'); if (!f) return;
    try { const d = deserialize(f.text); this.doc.current = d; this.undoStack = []; this.redoStack = []; this.activeSketch = null; this.mode = 'view'; this.selectedFeature = null; this.selectedInstance = null; this.sel3d = emptySel3D(); this.asmCache.clear(); this.jointFlow = null; this.vp.exitSketch(); this.titleEl.value = d.name; this.refreshAll(); this.vp.fitAll(); this.toast(`Aberto: ${f.name}${d.kind === 'assembly' ? ' (montagem)' : ''}`); }
    catch (e) { this.toast(`Não abriu: ${(e as Error).message}`, 'err'); }
  }
  saveFile(): void { downloadFile(`${safeFileName(this.doc.current.name)}.forja`, serialize(this.doc.current), 'application/json'); this.toast('Arquivo .forja gerado.'); }
  exportMenu(ev: MouseEvent): void {
    this.menu(ev.clientX, ev.clientY, [
      { label: 'STEP (SolidWorks, Fusion, fornecedores)', action: () => void this.exportStep() },
      { label: 'STL (impressão, visualizadores)', action: () => this.exportMesh('stl') },
      { label: 'OBJ (ZBrush, polygroups por face)', action: () => this.exportMesh('obj') },
      { label: 'GLB (visualizadores 3D, realidade aumentada)', action: () => void this.exportGlb() },
    ]);
  }
  private async exportGlb(): Promise<void> {
    const meshes = this.exportMeshes();
    if (!meshes.length) return this.toast('Nenhum corpo para exportar. Extrude um esboço antes.', 'err');
    try {
      const buf = await toGLB(meshes, this.doc.current.name);
      downloadFile(`${safeFileName(this.doc.current.name)}.glb`, buf, 'model/gltf-binary');
      this.toast('GLB gerado (em metros, como manda o formato).');
    } catch (e) { this.toast(`GLB falhou: ${(e as Error).message}`, 'err'); }
  }
  private exportMeshes(): MeshData[] {
    if (this.isAssembly) return this.assemblyMeshes();
    if (this.bodies.length) return this.bodies.map(fromBody);
    return buildAllBodies(this.doc.current).map((b) => fromGeometry(bodyName(this.doc.current, b.feature.id), b.geometry));
  }
  private exportMesh(fmt: 'stl' | 'obj'): void {
    const meshes = this.exportMeshes();
    if (!meshes.length) return this.toast('Nenhum corpo para exportar. Extrude um esboço antes.', 'err');
    const base = safeFileName(this.doc.current.name);
    if (fmt === 'stl') downloadFile(`${base}.stl`, toSTL(meshes), 'model/stl'); else downloadFile(`${base}.obj`, toOBJ(meshes), 'model/obj');
    this.toast(`${fmt.toUpperCase()} gerado${this.bodies.length ? '' : ' (da prévia)'}.`);
  }
  private async exportStep(): Promise<void> {
    if (this.kernel.state !== 'ready') return this.toast('O STEP precisa do kernel 3D carregado.', 'err');
    if (!this.isAssembly && !this.bodies.length) return this.toast('Nenhum corpo para exportar.', 'err');
    if (this.isAssembly && !this.asm!.instances.length) return this.toast('Montagem vazia.', 'err');
    try {
      const text = this.isAssembly ? await this.kernel.exportStepAssembly(this.assemblyPayload()) : await this.kernel.exportStep();
      downloadFile(`${safeFileName(this.doc.current.name)}.step`, text, 'application/step');
      this.toast('STEP gerado.');
    } catch (e) { this.toast(`STEP falhou: ${(e as Error).message}`, 'err'); }
  }

  // ---------- Desenho técnico ----------
  /** Diálogo do desenho técnico: prévia ao vivo, opções da folha e exportação em PDF ou DXF. */
  private async drawingDialog(): Promise<void> {
    if (this.kernel.state !== 'ready') return this.toast('O desenho técnico precisa do kernel 3D carregado.', 'err');
    if (!this.isAssembly && !this.bodies.length) return this.toast('Crie um corpo antes de gerar o desenho.', 'err');
    if (this.isAssembly && !this.asm!.instances.length) return this.toast('Insira peças na montagem antes de gerar o desenho.', 'err');
    const doc = this.doc.current;
    const settings: DrawingSettings = doc.drawing ?? { ...defaultDrawingSettings(doc.name), dimensions: !this.isAssembly };
    doc.drawing = settings;
    const back = el('div', 'dialog-backdrop'); const d = el('div', 'dialog wide');
    const hh = document.createElement('h2'); hh.textContent = 'Desenho técnico'; d.append(hh);
    const body = el('div', 'drawing-body'); const preview = el('div', 'drawing-preview'); const form = el('div', 'drawing-form'); body.append(preview, form); d.append(body);
    const status = el('div', 'hint'); status.textContent = 'Projetando vistas…'; d.append(status);
    const acts = el('div', 'actions');
    const btnPdf = this.button('Gerar PDF', () => void exportAs('pdf'), 'btn primary'); const btnDxf = this.button('Gerar DXF', () => void exportAs('dxf'));
    acts.append(this.button('Fechar', () => back.remove()), btnDxf, btnPdf); d.append(acts);
    back.append(d); this.overlay.append(back);

    let views: ProjectedView[] = []; let viewsKey = ''; let drawing: ReturnType<typeof layoutDrawing> | null = null; let busy = false; let dirty = false;
    const meta = () => ({ date: new Date().toLocaleDateString('pt-BR'), docName: doc.name });
    const render = async () => {
      if (busy) { dirty = true; return; }
      busy = true;
      try {
        const specs = viewSpecsFor(settings); const key = JSON.stringify(specs);
        if (key !== viewsKey) { status.textContent = 'Projetando vistas…'; views = this.isAssembly ? await this.kernel.projectAssembly(this.assemblyPayload(), specs) : await this.kernel.project(specs); viewsKey = key; }
        if (this.isAssembly) {
          const asm = this.asm!; const rows = bomRows(asm);
          const balloonView = specs.find((v) => v.name === 'iso') ?? specs[0];
          const anchors: BalloonAnchor[] = [];
          if (balloonView) for (const r of rows) for (const instId of r.instances) {
            const inst = asm.instances.find((i) => i.id === instId); const c = inst && this.asmCache.get(inst.part); const m = inst && this.asmTransforms.get(inst.id); if (!c || !m || !c.bodies.length) continue;
            let sx = 0, sy = 0, sz = 0, n = 0;
            for (const b of c.bodies) { const q = applyPoint(m, [(b.bbox[0][0] + b.bbox[1][0]) / 2, (b.bbox[0][1] + b.bbox[1][1]) / 2, (b.bbox[0][2] + b.bbox[1][2]) / 2]); sx += q[0]; sy += q[1]; sz += q[2]; n++; }
            const [X, Y] = projectPoint(balloonView, [sx / n, sy / n, sz / n]); anchors.push({ item: r.item, view: balloonView.name, X, Y });
          }
          drawing = layoutAssemblyDrawing(views, settings, meta(), rows, anchors);
        } else drawing = layoutDrawing(views, settings, meta());
        const svgDoc = new DOMParser().parseFromString(toSVG(drawing), 'image/svg+xml');
        preview.innerHTML = ''; preview.append(document.importNode(svgDoc.documentElement, true));
        status.textContent = `${settings.sheet} paisagem · escala ${scaleLabel(drawing.scale)} · ${settings.projection === 'first' ? '1º' : '3º'} diedro · ${views.reduce((a, v) => a + v.visible.length + v.hidden.length, 0)} arestas projetadas`;
        this.autosave();
      } catch (e) { status.textContent = `Falhou: ${(e as Error).message}`; }
      finally { busy = false; if (dirty) { dirty = false; void render(); } }
    };
    const exportAs = async (kind: 'pdf' | 'dxf') => {
      if (!drawing) return;
      const base = safeFileName(settings.title || doc.name);
      if (kind === 'pdf') { const bytes = toPDF(drawing); downloadFile(`${base}.pdf`, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'application/pdf'); this.toast('PDF gerado.'); }
      else { downloadFile(`${base}.dxf`, toDXF(drawing), 'application/dxf'); this.toast('DXF gerado (coordenadas da folha, em mm).'); }
    };

    const h3f = (t: string) => { const h = document.createElement('h3'); h.textContent = t; form.append(h); };
    const selectRow = (label: string, options: [string, string][], value: string, onChange: (v: string) => void) => {
      const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = label;
      const sel = document.createElement('select'); for (const [v, t] of options) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); }
      sel.value = value; sel.addEventListener('change', () => { onChange(sel.value); void render(); }); row.append(lab, sel); form.append(row);
    };
    const checkRow = (label: string, key: keyof DrawingSettings) => {
      const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = label;
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = !!settings[key];
      chk.addEventListener('change', () => { (settings as unknown as Record<string, unknown>)[key] = chk.checked; void render(); }); row.append(lab, chk); form.append(row);
    };
    const textRow = (label: string, key: keyof DrawingSettings) => {
      const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = label;
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = String(settings[key] ?? ''); inp.spellcheck = false;
      inp.addEventListener('change', () => { (settings as unknown as Record<string, unknown>)[key] = inp.value.trim().slice(0, 120); void render(); }); row.append(lab, inp); form.append(row);
    };
    h3f('Folha');
    selectRow('Formato', (Object.keys(SHEET_MM) as DrawingSettings['sheet'][]).map((k) => [k, `${k} (${SHEET_MM[k][0]}×${SHEET_MM[k][1]} mm)`]), settings.sheet, (v) => { settings.sheet = v as DrawingSettings['sheet']; });
    selectRow('Projeção', [['first', '1º diedro (ABNT)'], ['third', '3º diedro (EUA)']], settings.projection, (v) => { settings.projection = v as DrawingSettings['projection']; });
    selectRow('Escala', [['auto', 'Automática'], ...STANDARD_SCALES.map((sc): [string, string] => [String(sc), scaleLabel(sc)])], settings.scale === 'auto' ? 'auto' : String(settings.scale), (v) => { settings.scale = v === 'auto' ? 'auto' : Number(v); });
    h3f('Vistas');
    checkRow('Frente', 'front'); checkRow('Topo', 'top'); checkRow(settings.projection === 'first' ? 'Lateral esquerda' : 'Lateral direita', 'side'); checkRow('Isométrica', 'iso');
    checkRow('Linhas ocultas', 'hidden'); checkRow('Arestas tangentes', 'tangent'); checkRow('Cotas automáticas', 'dimensions');
    h3f('Legenda');
    textRow('Título', 'title'); textRow('Nº do desenho', 'number'); textRow('Material', 'material'); textRow('Desenhou', 'author'); textRow('Empresa', 'company');
    await render();
  }

  // ---------- Menus, popovers, diálogos ----------
  private menus: HTMLElement[] = [];
  private closeMenus(): void { for (const m of this.menus) m.remove(); this.menus = []; }
  private menu(x: number, y: number, items: { label: string; action: () => void }[]): void {
    this.closeMenus();
    const m = el('div', 'menu'); const r = this.overlay.getBoundingClientRect();
    const lx = Math.min(Math.max(8, x - (x > r.width ? r.left : 0)), r.width - 230), ly = Math.min(Math.max(8, y - (y > r.height ? r.top : 0)), r.height - 60 - items.length * 40);
    m.style.left = `${lx}px`; m.style.top = `${ly}px`;
    for (const it of items) { const b = document.createElement('button'); b.textContent = it.label; b.addEventListener('click', () => { this.closeMenus(); it.action(); }); m.append(b); }
    this.overlay.append(m); this.menus.push(m);
  }
  private valuePopover(x: number, y: number, value: number, unit: string, onOk: (v: number) => void, onDelete?: () => void): void {
    this.closeMenus();
    const pop = el('div', 'popover'); pop.style.left = `${Math.min(Math.max(90, x), this.vp.width - 90)}px`; pop.style.top = `${Math.max(60, Math.min(y - 12, this.vp.height - 20))}px`;
    const inp = document.createElement('input'); inp.type = 'text'; inp.inputMode = 'decimal'; inp.value = String(round(value, 2)).replace('.', ',');
    const u = el('span', 'unit'); u.textContent = unit;
    const ok = this.button('OK', () => commit(), 'btn primary');
    pop.append(inp, u, ok);
    if (onDelete) pop.append(this.button('Apagar', () => { pop.remove(); onDelete(); }, 'btn danger'));
    pop.append(this.button('✕', () => pop.remove()));
    const commit = () => { const v = parseFloat(inp.value.replace(',', '.')); if (!isFinite(v) || v <= 0) { this.toast('Valor inválido.', 'err'); return; } pop.remove(); onOk(v); };
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') pop.remove(); });
    this.overlay.append(pop); this.menus.push(pop);
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  }
  private confirm(title: string, text: string, onYes: () => void): void {
    const back = el('div', 'dialog-backdrop'); const d = el('div', 'dialog');
    const hh = document.createElement('h2'); hh.textContent = title; const tx = el('div'); tx.textContent = text; d.append(hh, tx);
    const acts = el('div', 'actions'); acts.append(this.button('Cancelar', () => back.remove()), this.button('Confirmar', () => { back.remove(); onYes(); }, 'btn primary')); d.append(acts);
    back.append(d); this.overlay.append(back);
  }
  private viewMenu(ev: MouseEvent): void {
    this.menu(ev.clientX, ev.clientY, [
      { label: 'Isométrica', action: () => this.vp.setViewPreset('iso') }, { label: 'Frente', action: () => this.vp.setViewPreset('front') },
      { label: 'Topo', action: () => this.vp.setViewPreset('top') }, { label: 'Lateral direita', action: () => this.vp.setViewPreset('right') },
    ]);
  }

  // ---------- Teclado (Mac) ----------
  private bindKeys(): void {
    window.addEventListener('keydown', (ev) => {
      const t = ev.target as HTMLElement; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const meta = ev.metaKey || ev.ctrlKey;
      if (meta && ev.key.toLowerCase() === 'z') { ev.preventDefault(); if (ev.shiftKey) this.redo(); else this.undo(); return; }
      if (meta && ev.key.toLowerCase() === 's') { ev.preventDefault(); this.saveFile(); return; }
      if (this.mode !== 'sketch') {
        if (ev.key === 'Escape') { this.closeMenus(); this.selectedFeature = null; this.clearSel3d(); }
        else if ((ev.key === 'Backspace' || ev.key === 'Delete') && this.selectedFeature) { const f = this.doc.current.features.find((x) => x.id === this.selectedFeature); if (f) this.deleteFeature(f); }
        else if (ev.key.toLowerCase() === 'f' && this.sel3d.edges.length) this.filletSelected('fillet');
        return;
      }
      const map: Record<string, Tool> = { v: 'select', p: 'draw', l: 'line', r: 'rect', c: 'circle', d: 'dimension', x: 'erase' };
      const k = ev.key.toLowerCase();
      if (map[k]) this.setTool(map[k]);
      else if (ev.key === 'Escape') { if (this.tool !== 'select') this.setTool('select'); else { this.sel = emptySelection(); this.refreshAll(false); } }
      else if (ev.key === 'Backspace' || ev.key === 'Delete') this.deleteSelection();
      else if (ev.key === 'Enter') this.exitSketch(true);
    });
  }
}

function toRenderBody(b: BodyData): RenderBody {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
  g.setIndex(new THREE.BufferAttribute(b.indices, 1));
  return { id: b.id, name: b.name, geometry: g, data: b };
}
function bodyOfFeature(f: Feature): Id | null {
  if (f.type === 'extrude' || f.type === 'revolve') return f.op === 'new' ? f.id : f.target ?? null;
  if (f.type === 'boolean') return f.body;
  return f.body;
}
function featureMini(f: Feature): string {
  if (f.type === 'extrude') return `${f.op === 'cut' ? 'corte ' : f.op === 'add' ? 'adição ' : ''}${f.throughAll ? '∞' : `${fmtDim('distance', f.depth)} mm`}`;
  if (f.type === 'revolve') return `${f.op === 'cut' ? 'corte ' : f.op === 'add' ? 'adição ' : ''}${fmtDim('angle', f.angle)}`;
  if (f.type === 'fillet') return `R${fmtDim('distance', f.radius)} · ${f.edges.length}`;
  if (f.type === 'chamfer') return `${fmtDim('distance', f.radius)} mm · ${f.edges.length}`;
  if (f.type === 'boolean') return f.op === 'union' ? 'união' : f.op === 'subtract' ? 'subtração' : 'interseção';
  return '';
}
function faceTypeName(t: string): string {
  return ({ plane: 'plana', cylinder: 'cilíndrica', cone: 'cônica', sphere: 'esférica', torus: 'toroidal', other: 'curva' } as Record<string, string>)[t] ?? t;
}
function el(tag: string, cls = ''): HTMLElement { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function h3(text: string): HTMLElement { const h = document.createElement('h3'); h.textContent = text; return h; }
function listItem(name: string, mini: string): HTMLElement {
  const it = el('div', 'item'); const n = el('span', 'name'); n.textContent = name; const m = el('span', 'mini'); m.textContent = mini; it.append(n, m); return it;
}
function constraintName(k: ConstraintKind): string {
  return ({ horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Paralelas', perpendicular: 'Perpendiculares', equal: 'Iguais', tangent: 'Tangentes', concentric: 'Concêntricos', pointOnLine: 'Ponto na linha', pointOnCircle: 'Ponto no círculo', midpoint: 'Ponto médio', fixed: 'Fixo' } as Record<ConstraintKind, string>)[k];
}
export { THREE, normAngle, TAU, planeNormal, type ExtrudeFeature };
