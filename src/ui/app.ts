// Aplicativo: ferramentas, gestos, painel lateral, desfazer, autosave, arquivos e o diálogo com o kernel 3D.

import * as THREE from 'three';
import { Viewport, emptySel3D, type Sel3D, type RenderBody, type RegionDef, type Hover, type BoxKind } from './viewport';
import { SketchRenderer, emptySelection, setSketchTheme, type Selection, dimEndpoints, fmtDim } from './sketchRenderer';
import { icons, type IconName } from './icons';
import {
  createDocument, serialize, deserialize, getPlane, getSketch, addExtrude, addRevolve, addFillet, addBoolean, addFacePlane, pruneFacePlanes, addPushPull, planeToWorld,
  addShell, addMirror, addTransform, addSplit, addSweep, addLoft, addImport, addOffsetPlane, addReplaceFace, type PatternSpec, type FaceRef, type ReplaceTarget,
  bodyIds, bodyName, featuresOfBody, planeNormal, isHidden, setHidden, renameBody,
  type ForjaDocument, type Plane, type Feature, type ExtrudeFeature, type RevolveFeature, type ExtrudeOp, type V3, type SketchAxis,
} from '../core/document';
import * as M from '../core/sketch/model';
import type { Sketch, Entity, Id, ConstraintKind, DimensionKind } from '../core/sketch/model';
import { solveSketch, type SolveResult, type SolveOptions } from '../core/sketch/solver';
import { recognizeStroke, type Primitive } from '../core/sketch/recognizer';
import { isTrimmable, trimSegmentAt, applyTrim, type TrimSegment, type Trimmable } from '../core/sketch/trim';
import { projectPolylines } from '../core/sketch/project';
import { buildAllBodies, buildExtrude, extractProfiles, profileInnerPoint, profileContainsPoint, profileToShape, planeMatrix } from '../core/kernel/preview';
import { KernelClient, SupersededError } from '../core/kernel/occ/client';
import type { BodyData, FeatureError, RebuildResult } from '../core/kernel/occ/types';
import { toSTL, toOBJ, fromBody, fromGeometry, type MeshData } from '../core/export/mesh';
import { toGLB } from '../core/export/glb';
import { layoutDrawing, layoutAssemblyDrawing, projectPoint, viewSpecsFor, defaultDrawingSettings, SHEET_MM, STANDARD_SCALES, scaleLabel, type DrawingSettings, type BalloonAnchor } from '../core/drawing/layout';
import { createAssemblyDocument } from '../core/document';
import { addPart, addInstance, removeInstance, addJoint, removeJoint, jointOf, computeTransforms, computeTransformsAt, syncTracks, frameFromFace, applyPoint, bomRows, JOINT_NAMES, MOTION_NAMES, type Assembly, type Frame, type JointType, type Mat4, type MotionMode } from '../core/assembly/model';
import { toPDF } from '../core/drawing/pdf';
import { toDXF } from '../core/drawing/dxf';
import { toSVG } from '../core/drawing/svg';
import type { ProjectedView, AssemblyPayload, InterferenceHit } from '../core/kernel/occ/types';
import { saveLocal, loadLocal, downloadFile, pickFile, safeFileName } from './storage';
import { type Vec2, v2, dist, distPointSegment, distPointArc, closestOnSegment, sub, add, scale, norm, perp, angleOf, normAngle, TAU, round, intersectSegments, intersectLineCircle, intersectCircles } from '../core/geom';

type Tool = 'select' | 'draw' | 'line' | 'rect' | 'circle' | 'ellipse' | 'spline' | 'polygon' | 'slot' | 'dimension' | 'project' | 'trim' | 'erase';
interface FormField { key: string; label: string; type: 'number' | 'text' | 'select' | 'check'; value: unknown; options?: [string, string][]; step?: number; }

interface PointerInfo { id: number; type: string; x: number; y: number; startX: number; startY: number; moved: boolean; role: 'tool' | 'nav' | 'pan'; button: number; shift?: boolean; /** Toque longo já consumiu este ponteiro. */ handled?: boolean; }
type SelFilter = 'all' | 'bodies' | 'faces' | 'edges';
const FILTER_LABEL: Record<SelFilter, string> = { all: 'Tudo', bodies: 'Corpos', faces: 'Faces', edges: 'Arestas' };
interface Hit { kind: 'point' | 'entity' | 'dimension'; id: Id; d: number; }
/** Encaixe candidato: onde a caneta vai grudar e como materializar o ponto no esboço. */
interface SnapHit { uv: Vec2; kind: 'point' | 'origin' | 'intersection' | 'midpoint' | 'entity'; apply: () => Id; }
type ViewDrag =
  | { kind: 'extrude'; sketch: Id; profilePoint: [number, number]; plane: Plane; start: THREE.Vector3; normal: THREE.Vector3; depth: number }
  | { kind: 'pull'; body: Id; index: number; fd: BodyData['faces'][number]; origin: THREE.Vector3; normal: THREE.Vector3; dist: number; t0: number }
  | { kind: 'edge'; body: Id; index: number; created: Id | null; radius: number; /** Sentido "para fora do corpo" na tela: arrastar nele arredonda, contra ele chanfra. */ out: { x: number; y: number } | null; shape: 'fillet' | 'chamfer' }
  | { kind: 'gmove'; body: Id; axis: THREE.Vector3; axisIndex: 0 | 1 | 2; origin: THREE.Vector3; t0: number; dist: number }
  | { kind: 'grot'; body: Id; axis: THREE.Vector3; axisIndex: 0 | 1 | 2; center: THREE.Vector3; a0: number; angle: number }
  | { kind: 'box'; el: HTMLElement | null }
  | { kind: 'draw'; body: Id; index: number; started: boolean }
  | { kind: 'moveInst'; inst: Id; startPos: V3; lastGood: V3; hit: THREE.Vector3; normal: THREE.Vector3; checking: boolean; pending: V3 | null };
const snapMm = (v: number) => (Math.abs(v) < 20 ? Math.round(v * 2) / 2 : Math.round(v));
/** Família de cor de cada ícone: esboço (lilás), sólidos (laranja de aço), saídas (verde-água), vista (grafite). */
const ICON_FAMILY: Partial<Record<IconName, 'sketch' | 'solid' | 'out' | 'view'>> = {
  sketch: 'sketch', draw: 'sketch', line: 'sketch', rect: 'sketch', circle: 'sketch', dimension: 'sketch', erase: 'sketch', select: 'sketch', construction: 'sketch',
  extrude: 'solid', revolve: 'solid', fillet: 'solid', chamfer: 'solid', face: 'solid', boolean: 'solid', cut: 'solid', joint: 'solid', plus: 'solid',
  drawing: 'out', play: 'out', pause: 'out', record: 'out', collide: 'out', measure: 'out', section: 'out',
  polygon: 'sketch', slot: 'sketch', mirror: 'sketch', offset: 'sketch', body: 'solid', spline: 'sketch', ellipse: 'sketch',
  view: 'view', fit: 'view', touch: 'view', undo: 'view', redo: 'view', done: 'view', menu: 'view', trash: 'view', theme: 'view',
  eye: 'view', eyeOff: 'view', items: 'view', more: 'view', rename: 'view', move: 'solid', rotate: 'solid', shell: 'solid', split: 'solid', pattern: 'solid', plane: 'sketch', axis: 'sketch', xray: 'view',
};

const H_V_SNAP_DEG = 10;
const PERP_SNAP_DEG = 8;
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
  // Animação
  private anim = { open: false, playing: false, t: 0, raf: 0, lastTs: 0, recorder: null as MediaRecorder | null, hits: [] as InterferenceHit[], hitSteps: 1, checking: false };
  private timeline!: HTMLElement;
  private doneFab!: HTMLButtonElement;
  /** Paleta de ferramentas: horizontal no topo (padrão) ou vertical à esquerda; muda arrastando pela alça. */
  toolbarHorizontal = true;
  private busy = 0;
  private pointers = new Map<number, PointerInfo>();
  private pinch: { d0: number; mid: { x: number; y: number } } | null = null;
  private stroke: Vec2[] = [];
  /** Substituir face em andamento: face plana escolhida, esperando o toque na face de destino. */
  private replaceFlow: { body: Id; face: FaceRef } | null = null;
  /** Varredura da ferramenta Aparar em andamento: quantos trechos já sumiram. */
  private trimRun: { count: number } | null = null;
  private dragPoint: Id | null = null;
  private toolStart: { uv: Vec2; pid?: Id } | null = null;
  private previewSketchBackup: Sketch | null = null;
  private pendingDimRefs: Id[] = [];
  private lastSolve: SolveResult | null = null;
  private hoverPlane: Id | null = null;
  // Modelagem direta (vista 3D)
  private drag: ViewDrag | null = null;
  /** Forma ao arrastar uma aresta: 'auto' decide pelo sentido (para fora = filete, para dentro = chanfro). */
  edgeDragKind: 'fillet' | 'chamfer' | 'auto' = 'auto';
  /** Região fechada de esboço selecionada na vista (toque): a barra de ações oferece extrudar, furar, revolucionar. */
  selRegion: { sketch: Id; index: number } | null = null;
  private actionbar!: HTMLElement;
  private pressTimer = 0;
  private lastTap = { t: 0, x: 0, y: 0 };
  /** Filtro de seleção (toque e caixa): tudo, só corpos, só faces ou só arestas. Tab alterna; B, F, E escolhem. */
  selFilter: SelFilter = 'all';
  /** Ver através: corpos translúcidos e toques repetidos no mesmo ponto vão passando para a face de trás. */
  xray = false;
  private cycle = { x: -1, y: -1, i: 0 };
  /** Gizmo só aparece quando a pessoa pediu o corpo (duplo toque, Itens, caixa, botão Mover/Girar), não depois de cada feature. */
  private gizmoWanted = false;
  private liveTimer = 0;
  private chipEl: HTMLElement | null = null; private chipTimer = 0;
  private polygonSides = 6;
  /** Modo construção: tudo que for desenhado vira linha de referência tracejada. */
  constructionMode = false;
  private measure: { on: boolean; first: { kind: 'face' | 'edge'; body: Id; index: number } | null } = { on: false, first: null };
  private section: { on: boolean; origin: V3; normal: V3; offset: number } = { on: false, origin: [0, 0, 0], normal: [0, -1, 0], offset: 0 };
  private mirrorPending = false;
  /** Montagem: com colisão ligada, uma peça arrastada para e não atravessa as outras. */
  collision = true;
  // Manipulação direta no esboço
  private sketchDrag: { kind: 'line'; id: Id; a: Id; b: Id; a0: Vec2; b0: Vec2; start: Vec2 } | { kind: 'radius'; id: Id; center: Id } | { kind: 'move'; points: { id: Id; x0: number; y0: number }[]; start: Vec2 } | null = null;

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
    this.applyTheme(this.loadTheme());
    this.kernel.onState = (s) => {
      this.renderStatus();
      if (s === 'ready') { this.toast(`Kernel 3D pronto (${(this.kernel.loadMs / 1000).toFixed(1)} s).`); void this.rebuild(); }
      else if (s === 'failed') this.toast(`Kernel 3D indisponível: ${this.kernel.failure}. Mostrando só a prévia.`, 'err');
    };
    this.refreshAll();
    this.vp.fitAll();
    window.addEventListener('beforeunload', () => this.autosave());
  }

  // ---------- Paleta de ferramentas ----------
  private loadToolbarLayout(): boolean { try { return localStorage.getItem('forjacad.toolbar') !== 'vertical'; } catch { return true; } }
  private applyToolbarLayout(): void {
    this.toolbar.classList.toggle('horizontal', this.toolbarHorizontal);
    try { localStorage.setItem('forjacad.toolbar', this.toolbarHorizontal ? 'horizontal' : 'vertical'); } catch { /* ignore */ }
  }
  /** Alça da paleta: arrastar para a faixa de cima deixa horizontal; para o lado, vertical. */
  private toolbarGrip(): HTMLElement {
    const grip = el('div', 'grip'); grip.title = 'Arraste para mudar a posição da paleta';
    grip.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); ev.stopPropagation(); grip.setPointerCapture(ev.pointerId);
      const start = { x: ev.clientX, y: ev.clientY }; const r0 = this.toolbar.getBoundingClientRect(); const ws = this.workspace.getBoundingClientRect();
      this.toolbar.classList.add('dragging');
      const move = (e: PointerEvent) => { this.toolbar.style.left = `${r0.left - ws.left + e.clientX - start.x}px`; this.toolbar.style.top = `${r0.top - ws.top + e.clientY - start.y}px`; this.toolbar.style.transform = 'none'; };
      const up = (e: PointerEvent) => {
        grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
        this.toolbar.classList.remove('dragging'); this.toolbar.style.left = ''; this.toolbar.style.top = ''; this.toolbar.style.transform = '';
        const yRel = e.clientY - ws.top; const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12;
        if (moved) { this.toolbarHorizontal = yRel < 140; this.applyToolbarLayout(); this.toast(this.toolbarHorizontal ? 'Paleta no topo.' : 'Paleta na lateral.'); }
      };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    return grip;
  }

  // ---------- Aparência ----------
  private loadTheme(): 'light' | 'dark' { try { return localStorage.getItem('forjacad.theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } }
  /** Tema claro por padrão (oficina à luz do dia); o escuro é escolha explícita e fica gravado. */
  applyTheme(name: 'light' | 'dark'): void {
    document.documentElement.dataset.theme = name;
    try { localStorage.setItem('forjacad.theme', name); } catch { /* ignore */ }
    this.vp.applyTheme(name); setSketchTheme(name);
    this.refreshSketch(); if (this.doc.current.sketches.length) this.refreshAll(false);
  }
  toggleTheme(): void { this.applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }

  // ---------- DOM ----------
  private buildDOM(): void {
    this.root.innerHTML = '';
    const top = el('div', 'topbar');
    const brand = el('div', 'brand'); const mark = el('span', 'mark'); const name = el('span', 'name'); name.innerHTML = 'Forja<b>CAD</b>'; brand.append(mark, name); top.append(brand);
    this.titleEl = el('input', 'title') as HTMLInputElement; this.titleEl.value = this.doc.current.name; this.titleEl.spellcheck = false;
    this.titleEl.addEventListener('change', () => { this.doc.current.name = this.titleEl.value.trim() || 'Peça'; this.autosave(); });
    top.append(this.titleEl);
    top.append(this.iconButton('undo', 'Desfazer', () => this.undo()), this.iconButton('redo', 'Refazer', () => this.redo()));
    const spacer = el('div', 'spacer'); top.append(spacer);
    this.statusEl = el('div', 'status'); top.append(this.statusEl);
    const themeBtn = this.iconButton('theme', 'Aparência', () => this.toggleTheme()); top.append(themeBtn);
    top.append(this.button('Novo', (ev) => this.newDocument(ev)), this.button('Abrir', () => this.openFile()), this.button('Salvar', () => this.saveFile()), this.button('Exportar', (ev) => this.exportMenu(ev)));
    this.root.append(top);
    this.workspace = el('div', 'workspace'); this.root.append(this.workspace);
    this.overlay = el('div', 'overlay'); this.workspace.append(this.overlay);
    this.labelsEl = el('div', 'overlay'); this.overlay.append(this.labelsEl);
    this.toolbar = el('div', 'toolbar'); this.toolbar.style.pointerEvents = 'auto'; this.overlay.append(this.toolbar);
    this.toolbarHorizontal = this.loadToolbarLayout(); this.applyToolbarLayout();
    this.sidepanel = el('div', 'sidepanel'); this.sidepanel.style.pointerEvents = 'auto'; this.overlay.append(this.sidepanel);
    this.toasts = el('div', 'toasts'); this.overlay.append(this.toasts);
    this.timeline = el('div', 'timeline'); this.timeline.style.display = 'none'; this.overlay.append(this.timeline);
    this.doneFab = this.button('Concluir esboço', () => this.exitSketch(true), 'btn primary done-fab'); this.doneFab.style.display = 'none'; this.overlay.append(this.doneFab);
    this.actionbar = el('div', 'actionbar'); this.actionbar.style.display = 'none'; this.overlay.append(this.actionbar);
  }

  private iconButton(icon: IconName, label: string, onClick: (ev: MouseEvent) => void, cls = 'tool'): HTMLButtonElement {
    const fam = ICON_FAMILY[icon] ?? 'view';
    const b = document.createElement('button'); b.className = `${cls} c-${fam}`; b.innerHTML = `${icons[icon]}<span>${label}</span>`; b.title = label;
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
    if (!this.isAssembly) this.closeTimelineIfOpen();
    if (this.activeSketch && !this.doc.current.sketches.some((s) => s.id === this.activeSketch)) this.exitSketch(false);
    this.sel = emptySelection(); this.titleEl.value = this.doc.current.name;
    if (this.sketch) this.solve();
    this.refreshAll();
  }

  private autosave(): void { saveLocal(serialize(this.doc.current)); }

  /** Recalcula tudo que depende do documento e redesenha. */
  refreshAll(rebuild = true): void {
    const doc = this.doc.current;
    this.vp.setPlanes(doc.planes.filter((p) => !isHidden(doc, p.id)));
    if (this.selectedFeature && !doc.features.some((f) => f.id === this.selectedFeature)) this.selectedFeature = null;
    if (this.selRegion && !this.regionValid(this.selRegion)) { this.selRegion = null; this.vp.setRegionSelected(null); }
    if (rebuild) void this.rebuild();
    // Esboços inativos aparecem em 3D (para escolher e extrudar).
    for (const [id, r] of this.inactiveSketches) if (!doc.sketches.some((s) => s.id === id)) { this.vp.scene.remove(r.group); this.inactiveSketches.delete(id); }
    for (const s of doc.sketches) {
      let r = this.inactiveSketches.get(s.id);
      if (!r) { r = new SketchRenderer(); this.inactiveSketches.set(s.id, r); this.vp.scene.add(r.group); }
      r.group.visible = s.id !== this.activeSketch && !isHidden(doc, s.id);
      if (r.group.visible) r.update(s, getPlane(doc, s.plane), emptySelection(), false, 1);
    }
    this.vp.setRegions(this.isAssembly ? [] : this.computeRegions());
    this.refreshSketch();
    this.renderToolbar(); this.renderSidePanel(); this.renderStatus();
    this.autosave();
    this.vp.requestRender();
  }
  /** Regiões fechadas de todos os esboços, como malhas finas sobre seus planos. */
  private computeRegions(): RegionDef[] {
    const doc = this.doc.current; const out: RegionDef[] = [];
    for (const s of doc.sketches) {
      if (isHidden(doc, s.id)) continue;
      let plane: Plane; try { plane = getPlane(doc, s.plane); } catch { continue; }
      const m = planeMatrix(plane).multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.05));
      // Regiões já viradas em extrusão ou revolução somem: a face do corpo passa a responder à caneta.
      const consumed = this.consumedProfiles(s);
      extractProfiles(s).forEach((prof, i) => {
        if (consumed[i]) return;
        try { const g = new THREE.ShapeGeometry(profileToShape(s, prof), 24); g.applyMatrix4(m); out.push({ sketch: s.id, index: i, geometry: g }); } catch { /* perfil ruim: ignora */ }
      });
    }
    return out;
  }
  /** Para cada perfil fechado do esboço: já virou extrusão ou revolução? */
  private consumedProfiles(s: Sketch): boolean[] {
    const users = this.doc.current.features.filter((f): f is ExtrudeFeature | RevolveFeature => (f.type === 'extrude' || f.type === 'revolve') && f.sketch === s.id);
    return extractProfiles(s).map((prof) => users.some((f) => f.type === 'revolve' || !f.profilePoint || profileContainsPoint(s, prof, { x: f.profilePoint[0], y: f.profilePoint[1] })));
  }
  /** Como no Shapr3D: quando todos os contornos de um esboço viraram corpo, o esboço se esconde sozinho. */
  private autoHideSketch(sketchId: Id): void {
    const doc = this.doc.current; const s = doc.sketches.find((x) => x.id === sketchId); if (!s || isHidden(doc, s.id)) return;
    const c = this.consumedProfiles(s); if (c.length && c.every(Boolean)) { setHidden(doc, s.id, true); this.refreshAll(false); }
  }
  private regionValid(r: { sketch: Id; index: number }): boolean {
    const doc = this.doc.current; const s = doc.sketches.find((x) => x.id === r.sketch); if (!s || isHidden(doc, s.id)) return false;
    const c = this.consumedProfiles(s); return r.index < c.length && !c[r.index];
  }
  /** Redesenha os corpos (sem recalcular): aplica ocultos e seleção. */
  private redrawBodies(): void {
    const doc = this.doc.current;
    this.vp.setBodies(this.bodies.filter((b) => !isHidden(doc, b.id)).map(toRenderBody), this.sel3d); if (this.xray) this.vp.setXray(true); this.updateFaceHandle();
  }
  toggleXray(): void {
    this.xray = !this.xray; this.vp.setXray(this.xray); this.vp.setSelection(this.sel3d); this.renderToolbar();
    this.toast(this.xray ? 'Ver através: a peça fica translúcida e cada toque no mesmo ponto passa para a face de trás.' : 'Ver através desligado.');
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
      const preview = buildAllBodies(doc).filter((b) => !isHidden(doc, b.feature.id)).map((b): RenderBody => ({ id: b.feature.id, name: bodyName(doc, b.feature.id), geometry: b.geometry }));
      this.vp.setBodies(preview, this.sel3d);
      return null;
    }
    this.busy++; this.renderStatus();
    try {
      const r = await this.kernel.rebuild(doc);
      this.bodies = r.bodies; this.featureErrors = r.errors;
      this.pruneSel3d();
      this.redrawBodies();
      this.renderSidePanel(); this.renderToolbar();
      return r;
    } catch (e) {
      if (!(e instanceof SupersededError)) this.toast(`Kernel: ${(e as Error).message}`, 'err');
      return null;
    } finally { this.busy--; this.renderStatus(); }
  }

  private pruneSel3d(): void {
    const has = (id: Id | null) => !!this.bodyOf(id) && !(id && !this.isAssembly && isHidden(this.doc.current, id));
    if (this.sel3d.bodies) { this.sel3d.bodies = this.sel3d.bodies.filter(has); if (!this.sel3d.bodies.length) delete this.sel3d.bodies; }
    if (!has(this.sel3d.body)) { this.sel3d.body = this.sel3d.bodies?.shift() ?? null; if (this.sel3d.bodies && !this.sel3d.bodies.length) delete this.sel3d.bodies; }
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
      if (this.anim.open) this.applyAnimT(this.anim.t);
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
      this.closeTimelineIfOpen();
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
      if (!this.jointFlow.moving) { this.jointFlow.moving = { inst, frame, planar }; this.sel3d = { body: renderId, face: { body: renderId, index: faceIndex }, edges: [] }; this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.toast('Agora toque na face da peça base.'); this.renderStatus(); return; }
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
    this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar();
    if (!same && frame && asm.instances.length > 1) {
      const items = (['fixed', 'revolute', 'slider', 'cylindrical'] as JointType[]).map((t) => ({ label: `${JOINT_NAMES[t]} a partir desta face`, action: () => this.startJoint(t, { inst, frame, planar }) }));
      this.menu(x + 10, y + 10, items);
    }
  }

  private closeTimelineIfOpen(): void { if (this.anim.open) { this.pause(); this.anim.open = false; this.timeline.style.display = 'none'; } }

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
    if (this.anim.open) this.renderMotionsPanel(p);
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
        const d = el('div', 'hint'); d.textContent = 'Instância livre: arraste com a caneta direto na peça (ou ajuste por números). Com "Colisão" ligada, ela para ao encostar em outra.'; p.append(d);
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
      it.addEventListener('click', () => { this.selectedInstance = this.selectedInstance === i.id ? null : i.id; this.sel3d = emptySel3D(); const c = this.asmCache.get(i.part); if (this.selectedInstance && c?.bodies[0]) this.sel3d.body = `${i.id}/${c.bodies[0].id}`; this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar(); });
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
    if ((f.type === 'extrude' || f.type === 'revolve') && this.mode === 'view') this.autoHideSketch(f.sketch);
    if (f.type !== 'transform') { this.gizmoWanted = false; this.updateGizmo(); }
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
      if (this.replaceFlow) { txt = 'Substituir face: toque na face de destino (plana ou cilíndrica)'; cls = 'status warn'; }
      else if (this.busy) { txt = 'Calculando…'; }
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
    this.toolbar.innerHTML = ''; this.toolbar.append(this.toolbarGrip());
    const g1 = el('div', 'group'); const g2 = el('div', 'group'); const g3 = el('div', 'group');
    if (this.mode === 'sketch') {
      const tools: [Tool, IconName, string][] = [['select', 'select', 'Selecionar'], ['draw', 'draw', 'Caneta'], ['line', 'line', 'Linha'], ['rect', 'rect', 'Retângulo'], ['circle', 'circle', 'Círculo'], ['ellipse', 'ellipse', 'Elipse'], ['spline', 'spline', 'Spline'], ['polygon', 'polygon', 'Polígono'], ['slot', 'slot', 'Rasgo'], ['dimension', 'dimension', 'Cota'], ['project', 'project', 'Projetar'], ['trim', 'trim', 'Aparar'], ['erase', 'erase', 'Apagar']];
      for (const [t, ic, label] of tools) { const b = this.iconButton(ic, label, () => { if (t === 'polygon' && this.tool !== 'polygon') this.valuePopover(this.vp.width / 2, 80, this.polygonSides, 'lados', (v) => { this.polygonSides = Math.max(3, Math.min(24, Math.round(v))); this.setTool('polygon'); }); else this.setTool(t); }); if (this.tool === t) b.classList.add('active'); g1.append(b); }
      const cons = this.iconButton('construction', 'Construção', () => { this.constructionMode = !this.constructionMode; this.renderToolbar(); this.toast(this.constructionMode ? 'Construção ligada: o que você riscar vira linha de referência tracejada (serve para centralizar e encaixar).' : 'Construção desligada.'); }); if (this.constructionMode) cons.classList.add('active'); g1.append(cons);
      const touch = this.iconButton('touch', 'Dedo desenha', () => { this.touchDraws = !this.touchDraws; this.renderToolbar(); }); if (this.touchDraws) touch.classList.add('active'); g2.append(touch);
      const persp = this.iconButton('view', this.vp.sketchPerspective ? 'Vista reta' : 'Vista 3D', () => { this.vp.setSketchPerspective(!this.vp.sketchPerspective); this.refreshSketch(); this.renderToolbar(); if (!this.vp.sketchPerspective) this.vp.fitAll(); }); if (this.vp.sketchPerspective) persp.classList.add('active'); g2.append(persp);
      g2.append(this.iconButton('fit', 'Enquadrar', () => this.vp.fitAll()));
      g3.append(this.iconButton('extrude', 'Extrudar', () => this.extrudeActive()));
      g3.append(this.iconButton('cut', 'Furo passante', () => this.cutThroughActive()));
      g3.append(this.iconButton('revolve', 'Revolucionar', () => this.revolveActive()));
      g3.append(this.iconButton('done', 'Concluir', () => this.exitSketch(true)));
      this.toolbar.append(g1, g2, g3);
      this.doneFab.style.display = '';
    } else if (this.isAssembly) {
      this.doneFab.style.display = 'none';
      const asm = this.asm!;
      g1.append(this.iconButton('plus', 'Inserir', (ev) => { const items = asm.parts.map((p) => ({ label: `Inserir ${p.name}`, action: () => this.insertInstance(p.id) })); items.push({ label: 'Importar peça (.forja)…', action: () => void this.importPart() }); this.menu(ev.clientX, ev.clientY, items); }));
      const jb = this.iconButton('joint', this.jointFlow ? 'Cancelar junta' : 'Junta', (ev) => { if (this.jointFlow) return this.cancelJoint(); this.menu(ev.clientX, ev.clientY, (['fixed', 'revolute', 'slider', 'cylindrical'] as JointType[]).map((t) => ({ label: JOINT_NAMES[t], action: () => this.startJoint(t) }))); });
      jb.disabled = asm.instances.length < 2 && !this.jointFlow; if (this.jointFlow) jb.classList.add('active'); g1.append(jb);
      const ab = this.iconButton('play', 'Animar', () => this.toggleTimeline()); ab.disabled = !asm.joints.some((j) => j.type !== 'fixed') && !this.anim.open; if (this.anim.open) ab.classList.add('active'); g1.append(ab);
      const cb = this.iconButton('collide', 'Colisão', () => { this.collision = !this.collision; this.renderToolbar(); this.toast(this.collision ? 'Colisão ligada: a peça arrastada para ao encostar.' : 'Colisão desligada: as peças atravessam e ficam translúcidas onde se sobrepõem.'); if (this.selectedInstance) void this.settleCollision(this.selectedInstance); else this.vp.setTranslucent(new Set()); }); if (this.collision) cb.classList.add('active'); g2.append(cb);
      g2.append(this.iconButton('drawing', 'Desenho', () => void this.drawingDialog()));
      g2.append(this.iconButton('view', 'Vistas', (ev) => this.viewMenu(ev)));
      g2.append(this.iconButton('fit', 'Enquadrar', () => this.vp.fitAll()));
      this.toolbar.append(g1, g2);
    } else {
      this.doneFab.style.display = 'none';
      g1.append(this.iconButton('sketch', 'Esboço', (ev) => this.newSketchMenu(ev)));
      g1.append(this.iconButton('extrude', 'Extrudar', (ev) => this.extrudeMenu(ev)));
      const hasEdges = this.sel3d.edges.length > 0;
      const fil = this.iconButton('fillet', 'Filete', () => (hasEdges ? this.filletSelected('fillet') : this.setEdgeKind('fillet'))); if (this.edgeDragKind === 'fillet') fil.classList.add('active'); g1.append(fil);
      const cha = this.iconButton('chamfer', 'Chanfro', () => (hasEdges ? this.filletSelected('chamfer') : this.setEdgeKind('chamfer'))); if (this.edgeDragKind === 'chamfer') cha.classList.add('active'); g1.append(cha);
      g1.append(this.iconButton('body', 'Corpo', (ev) => this.bodyMenu(ev)));
      const mb = this.iconButton('measure', 'Medir', () => this.toggleMeasure()); if (this.measure.on) mb.classList.add('active'); g2.append(mb);
      const sb = this.iconButton('section', 'Corte', () => this.toggleSection()); if (this.section.on) sb.classList.add('active'); g2.append(sb);
      g2.append(this.iconButton('drawing', 'Desenho', () => void this.drawingDialog()));
      const xb = this.iconButton('xray', 'Através', () => this.toggleXray()); xb.title = 'Ver através (T): translúcido, toque cicla as faces de trás'; if (this.xray) xb.classList.add('active'); g2.append(xb);
      const fb = this.iconButton('select', FILTER_LABEL[this.selFilter], (ev) => this.menu(ev.clientX, ev.clientY, (['all', 'bodies', 'faces', 'edges'] as SelFilter[]).map((f) => ({ label: `Selecionar: ${FILTER_LABEL[f]}`, action: () => this.setFilter(f) })))); fb.title = 'Filtro de seleção (Tab alterna; B, F, E)'; if (this.selFilter !== 'all') fb.classList.add('active'); g2.append(fb);
      g2.append(this.iconButton('view', 'Vistas', (ev) => this.viewMenu(ev)));
      g2.append(this.iconButton('fit', 'Enquadrar', () => this.vp.fitAll()));
      this.toolbar.append(g1, g2);
    }
    this.renderActionBar();
  }

  private setEdgeKind(kind: 'fillet' | 'chamfer'): void {
    this.edgeDragKind = this.edgeDragKind === kind ? 'auto' : kind; this.renderToolbar();
    if (this.edgeDragKind === 'auto') this.toast('Automático: arraste a aresta para fora da peça para arredondar, para dentro para chanfrar.');
    else this.toast(kind === 'fillet' ? 'Só filete: arraste uma aresta e o raio segue a caneta.' : 'Só chanfro: arraste uma aresta e a distância segue a caneta.');
  }

  /** Barra adaptativa (ideia do menu adaptativo do Shapr3D): só as ferramentas válidas para o que está selecionado. */
  private renderActionBar(): void {
    const bar = this.actionbar; bar.innerHTML = '';
    const doc = this.doc.current; const s3 = this.sel3d;
    if (this.mode !== 'view' || this.isAssembly || this.measure.on) { bar.style.display = 'none'; return; }
    const region = this.selRegion && this.regionValid(this.selRegion) ? this.selRegion : null;
    const bodyId = s3.face?.body ?? s3.edges[0]?.body ?? s3.body; const bd = this.bodyOf(bodyId);
    const items: HTMLElement[] = []; let who = '';
    const btn = (icon: IconName, label: string, fn: (ev: MouseEvent) => void, primary = false) => { const b = this.iconButton(icon, label, fn); if (primary) b.classList.add('primary'); items.push(b); };
    if (region) {
      const sk = getSketch(doc, region.sketch); who = `Região de ${sk.name}`;
      btn('extrude', 'Extrudar', () => this.extrudeSketch(sk.id), true);
      if (bodyIds(doc).length) btn('cut', 'Furo passante', () => this.cutThroughSketch(sk.id));
      btn('revolve', 'Revolucionar', () => this.revolveSketch(sk.id));
      btn('sketch', 'Editar esboço', () => this.enterSketch(sk.id));
    } else if (s3.edges.length && bd) {
      who = `${s3.edges.length} aresta${s3.edges.length > 1 ? 's' : ''} · ${bodyName(doc, bd.id)}`;
      btn('fillet', 'Filete', () => this.filletSelected('fillet'), true);
      btn('chamfer', 'Chanfro', () => this.filletSelected('chamfer'));
      btn('body', 'Corpo', () => this.selectBody(bd.id));
    } else if (s3.face && bd) {
      const f = bd.faces[s3.face.index]; const n = 1 + (s3.faces?.length ?? 0); const planar = f?.type === 'plane';
      who = n > 1 ? `${n} faces · ${bodyName(doc, bd.id)}` : `Face ${faceTypeName(f?.type ?? 'other')} · ${bodyName(doc, bd.id)}`;
      if (planar) { btn('face', 'Esboçar', () => this.createSketchOnFace(bd.id, s3.face!.index), true); btn('extrude', n > 1 ? 'Puxar juntas' : 'Puxar', () => this.pushPullNumeric()); btn('replace', 'Substituir', () => this.startReplaceFace()); btn('plane', 'Plano', () => this.offsetPlaneFromFace()); }
      btn('shell', 'Casca', () => this.shellSelected());
      if (planar) btn('mirror', 'Espelhar', () => this.mirrorSelected());
      btn('body', 'Corpo', () => this.selectBody(bd.id));
    } else if (s3.body && bd && (s3.bodies?.length ?? 0) > 0) {
      const ids = this.selBodies(); who = `${ids.length} corpos`;
      btn('move', 'Mover/Girar', () => this.moveRotateAction(), true);
      btn('boolean', 'Unir todos', () => this.uniteBodies(ids));
      btn('eyeOff', 'Ocultar', () => this.hideBodies(ids));
      btn('trash', 'Apagar', () => this.deleteBodies(ids));
    } else if (s3.body && bd) {
      who = bodyName(doc, bd.id);
      btn('move', 'Mover/Girar', () => this.moveRotateAction(), true);
      btn('mirror', 'Espelhar', () => this.mirrorSelected());
      btn('shell', 'Casca', () => this.shellSelected());
      btn('split', 'Dividir', () => this.splitSelected());
      const sf = this.selectedFeatureObj(); if (sf && (sf.type === 'extrude' || sf.type === 'revolve')) btn('pattern', 'Padrão', () => this.patternSelected(sf));
      if (bodyIds(doc).length > 1) btn('boolean', 'Combinar', (ev) => this.booleanMenu(ev));
      btn('eyeOff', 'Ocultar', () => this.toggleHidden(bd.id));
      btn('trash', 'Apagar', () => this.deleteBody(bd.id));
    } else { bar.style.display = 'none'; return; }
    if (!region) btn('more', 'Mais', (ev) => this.bodyMenu(ev));
    const w = el('span', 'who'); w.textContent = who; bar.append(w, ...items); bar.style.display = '';
  }

  /** Puxar/empurrar a face selecionada digitando o valor (a seta laranja faz o mesmo por gesto). */
  private pushPullNumeric(): void {
    const fs = this.sel3d.face; const fd = fs ? this.bodyOf(fs.body)?.faces[fs.index] : undefined; if (!fs || !fd || fd.type !== 'plane' || !fd.normal) return;
    const sc = this.vp.worldToScreen(new THREE.Vector3(...fd.center));
    this.valuePopover(sc.x, sc.y, 10, 'mm', (v) => {
      const ref: FaceRef = { center: fd.center, normal: fd.normal!, area: fd.area };
      const more = (this.sel3d.faces ?? []).filter((f) => f.body === fs.body && f.index !== fs.index).map((f) => this.faceRefOf(f)).filter((x): x is FaceRef => !!x);
      void this.tryFeature(() => addPushPull(this.doc.current, fs.body, ref, v, more), (f) => { this.selectedFeature = f.id; this.selectBody(fs.body); });
    });
  }

  /** Substituir face (como no Shapr3D): a face plana selecionada passa a ficar rente à face que você tocar em seguida. */
  private startReplaceFace(): void {
    const fs = this.sel3d.face; const ref = this.faceRefOf(fs); if (!fs || !ref) { this.toast('Selecione uma face plana para substituir.'); return; }
    this.replaceFlow = { body: fs.body, face: ref }; this.renderStatus();
    this.toast('Agora toque na face de destino: plana ou cilíndrica, deste corpo ou de outro. A face selecionada passa a ficar rente a ela.');
  }
  private cancelReplaceFace(): void { this.replaceFlow = null; this.renderStatus(); this.toast('Substituir face cancelado.'); }
  /** Normal da malha na face (primeiro triângulo): diz se um cilindro é ressalto (normal para fora do eixo) ou furo. */
  private faceMeshNormal(data: BodyData, index: number): V3 | null {
    const k = data.triFace.indexOf(index); if (k < 0) return null; const vi = data.indices[k * 3];
    return [data.normals[vi * 3], data.normals[vi * 3 + 1], data.normals[vi * 3 + 2]];
  }
  private finishReplaceFace(body: Id, index: number): void {
    const flow = this.replaceFlow; if (!flow) return;
    const data = this.bodyOf(body); const fd = data?.faces[index]; if (!data || !fd) return;
    if (body === flow.body && fd.type === 'plane' && fd.normal && Math.hypot(fd.center[0] - flow.face.center[0], fd.center[1] - flow.face.center[1], fd.center[2] - flow.face.center[2]) < 1e-6) { this.toast('Essa é a própria face: toque na face de destino.'); return; }
    let target: ReplaceTarget | null = null;
    const m = this.vp.bodyMatrixOf(body); const tp = (p: V3): V3 => { const v = new THREE.Vector3(...p).applyMatrix4(m); return [v.x, v.y, v.z]; }; const td = (d: V3): V3 => { const v = new THREE.Vector3(...d).transformDirection(m); return [v.x, v.y, v.z]; };
    if (fd.type === 'plane' && fd.normal) target = { kind: 'plane', origin: tp(fd.origin ?? fd.center), normal: td(fd.normal) };
    else if (fd.type === 'cylinder' && fd.axisOrigin && fd.axisDir && fd.radius) {
      const n = this.faceMeshNormal(data, index); const o = fd.axisOrigin, d = fd.axisDir, c = fd.center;
      const t = (c[0] - o[0]) * d[0] + (c[1] - o[1]) * d[1] + (c[2] - o[2]) * d[2]; const radial: V3 = [c[0] - o[0] - d[0] * t, c[1] - o[1] - d[1] * t, c[2] - o[2] - d[2] * t];
      const inside = !n || n[0] * radial[0] + n[1] * radial[1] + n[2] * radial[2] >= 0;
      target = { kind: 'cylinder', origin: tp(o), dir: td(d), radius: fd.radius, inside };
    }
    if (!target) { this.toast('O destino precisa ser uma face plana ou cilíndrica.', 'err'); return; }
    this.replaceFlow = null; this.renderStatus();
    void this.tryFeature(() => addReplaceFace(this.doc.current, flow.body, flow.face, target!), (f) => { this.selectedFeature = f.id; this.selectBody(flow.body); this.toast(target!.kind === 'plane' ? 'Face rente ao plano de destino.' : 'Face rente ao cilindro de destino.'); });
  }

  /** Botão Mover/Girar: primeiro mostra o gizmo; com o gizmo já na tela, abre os campos para digitar. */
  private moveRotateAction(): void {
    if (!this.gizmoWanted) { this.gizmoWanted = true; this.updateGizmo(); this.toast('Arraste uma seta para mover, um anel para girar. Toque de novo em Mover/Girar para digitar valores.'); }
    else this.transformSelected();
  }
  /** Seleciona um corpo inteiro: aparece o gizmo de mover e girar. */
  selectBody(id: Id): void {
    this.selectedFeature = null; this.selRegion = null; this.vp.setRegionSelected(null); this.gizmoWanted = true;
    this.sel3d = { body: id, face: null, faces: [], edges: [] };
    this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar();
  }
  private selectRegion(sketch: Id, index: number): void {
    this.selectedFeature = null; this.sel3d = emptySel3D(); this.selRegion = { sketch, index }; this.vp.setRegionSelected(this.selRegion);
    this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar();
  }
  /** Toque numa aresta soma à seleção (mesmo corpo); tocar de novo tira. */
  private selectEdge(body: Id, index: number, additive = true): void {
    if (!additive || (this.sel3d.edges.length && this.sel3d.edges[0].body !== body)) this.sel3d.edges = [];
    const i = this.sel3d.edges.findIndex((e) => e.body === body && e.index === index);
    if (i >= 0) this.sel3d.edges.splice(i, 1); else this.sel3d.edges.push({ body, index });
    this.sel3d.face = null; this.sel3d.faces = []; delete this.sel3d.bodies; this.sel3d.body = this.sel3d.edges.length ? body : null; this.selectedFeature = null; this.selRegion = null; this.vp.setRegionSelected(null);
    this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar();
  }
  /** Toque numa face soma à seleção (mesmo corpo); tocar de novo tira. */
  private selectFace(body: Id, index: number, additive = true): void {
    const all = additive ? [...(this.sel3d.face ? [this.sel3d.face] : []), ...(this.sel3d.faces ?? [])] : [];
    const idx = all.findIndex((f) => f.body === body && f.index === index);
    const next = idx >= 0 ? all.filter((_, i) => i !== idx) : (all.length && all[0].body !== body ? [] : all).concat([{ body, index }]);
    const primary = next[next.length - 1] ?? null;
    this.selectedFeature = null; this.selRegion = null; this.vp.setRegionSelected(null);
    this.sel3d = { body, face: primary, faces: primary ? next.slice(0, -1) : [], edges: [] };
    this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar();
  }
  private uniteBodies(ids: Id[]): void {
    if (ids.length < 2) return;
    void this.tryFeature(() => { let last: Feature | null = null; for (const o of ids.slice(1)) last = addBoolean(this.doc.current, 'union', ids[0], o); return last; }, (f) => { this.selectedFeature = f.id; this.selectBody(ids[0]); });
  }
  private hideBodies(ids: Id[]): void {
    const doc = this.doc.current; this.pushUndo(); for (const id of ids) setHidden(doc, id, true);
    this.sel3d = emptySel3D(); this.selectedFeature = null; this.refreshAll(false); this.redrawBodies();
  }
  private deleteBodies(ids: Id[]): void {
    const doc = this.doc.current;
    const victims = new Set<Id>(); for (const id of ids) { victims.add(id); for (const d of featuresOfBody(doc, id)) victims.add(d.id); }
    this.confirm('Apagar corpos', `Apagar ${ids.length} corpos e ${victims.size - ids.length} feature${victims.size - ids.length === 1 ? '' : 's'} que dependem deles.`, () => {
      this.pushUndo(); doc.features = doc.features.filter((x) => !victims.has(x.id)); this.selectedFeature = null; this.sel3d = emptySel3D(); this.refreshAll();
    });
  }
  toggleHidden(id: Id): void {
    const doc = this.doc.current; this.pushUndo(); const hide = !isHidden(doc, id); setHidden(doc, id, hide);
    if (hide && (this.sel3d.body === id || this.sel3d.face?.body === id || this.sel3d.edges[0]?.body === id || this.selRegion?.sketch === id)) { this.sel3d = emptySel3D(); this.selRegion = null; this.vp.setRegionSelected(null); this.selectedFeature = null; }
    this.refreshAll(false); this.redrawBodies();
  }
  private invertHidden(): void {
    const doc = this.doc.current; this.pushUndo();
    for (const id of [...bodyIds(doc), ...doc.sketches.map((s) => s.id)]) setHidden(doc, id, !isHidden(doc, id));
    this.sel3d = emptySel3D(); this.selRegion = null; this.vp.setRegionSelected(null); this.selectedFeature = null;
    this.refreshAll(false); this.redrawBodies();
  }
  private renameItem(kind: 'body' | 'sketch' | 'plane', id: Id): void {
    const doc = this.doc.current;
    const cur = kind === 'body' ? bodyName(doc, id) : kind === 'sketch' ? getSketch(doc, id).name : getPlane(doc, id).name;
    this.formDialog('Renomear', [{ key: 'name', label: 'Nome', type: 'text', value: cur }], 'Renomear', (v) => {
      const name = String(v.name ?? '').trim(); if (!name) return;
      this.pushUndo();
      if (kind === 'body') renameBody(doc, id, name); else if (kind === 'sketch') getSketch(doc, id).name = name; else getPlane(doc, id).name = name;
      this.refreshAll(kind === 'body');
    });
  }
  private zoomTo(kind: 'body' | 'sketch', id: Id): void {
    const doc = this.doc.current; const box = new THREE.Box3();
    if (kind === 'body') { const b = this.bodyOf(id); if (!b) return; box.set(new THREE.Vector3(...b.bbox[0]), new THREE.Vector3(...b.bbox[1])); }
    else { const s = getSketch(doc, id); const pl = getPlane(doc, s.plane); if (!s.points.length) box.setFromCenterAndSize(new THREE.Vector3(...pl.origin), new THREE.Vector3(60, 60, 60)); else for (const pt of s.points) box.expandByPoint(new THREE.Vector3(...planeToWorld(pl, pt.x, pt.y))); }
    this.vp.fitBox(box);
  }
  private deleteSketch(id: Id): void {
    const doc = this.doc.current;
    const uses = (f: Feature) => (f.type === 'extrude' || f.type === 'revolve') ? f.sketch === id : f.type === 'sweep' ? f.profile === id || f.path === id || !!f.paths?.includes(id) : f.type === 'loft' ? f.sketches.includes(id) : false;
    const victims = new Set<Id>(); for (const f of doc.features) if (uses(f)) { victims.add(f.id); if ((f.type === 'extrude' || f.type === 'revolve') && f.op === 'new') for (const d of featuresOfBody(doc, f.id)) victims.add(d.id); }
    const go = () => {
      this.pushUndo();
      doc.features = doc.features.filter((f) => !victims.has(f.id)); doc.sketches = doc.sketches.filter((s) => s.id !== id); setHidden(doc, id, false); pruneFacePlanes(doc);
      this.selectedFeature = null; this.sel3d = emptySel3D(); this.selRegion = null; this.vp.setRegionSelected(null); this.refreshAll();
    };
    if (victims.size) this.confirm('Apagar esboço', `Este esboço é usado por ${victims.size} feature${victims.size > 1 ? 's' : ''} (corpos, cortes, varreduras). Elas somem junto.`, go); else go();
  }
  private deletePlane(id: Id): void {
    const doc = this.doc.current; if (doc.sketches.some((s) => s.plane === id)) return this.toast('Há esboços neste plano. Apague-os antes.', 'err');
    this.pushUndo(); doc.planes = doc.planes.filter((p) => p.id !== id); setHidden(doc, id, false); this.refreshAll(false);
  }
  /** Itens do projeto (como o Items Manager do Shapr3D): corpos, esboços e planos com olho de visibilidade; segurar ou clicar com o direito renomeia, enquadra, apaga. */
  private renderItems(p: HTMLElement): void {
    const doc = this.doc.current;
    p.append(h3('Itens'));
    const list = el('div', 'list');
    type MenuItems = () => { label: string; action: () => void }[];
    const row = (icon: IconName, fam: string, name: string, mini: string, id: Id, active: boolean, onTap: () => void, menuItems: MenuItems) => {
      const hidden = isHidden(doc, id);
      const it = el('div', `item${hidden ? ' off' : ''}${active ? ' active' : ''}`);
      const k = el('span', `kind c-${fam}`); k.innerHTML = icons[icon];
      const n = el('span', 'name'); n.textContent = name; const m = el('span', 'mini'); m.textContent = mini;
      const eye = document.createElement('button'); eye.className = 'eye'; eye.title = hidden ? 'Mostrar' : 'Ocultar'; eye.innerHTML = hidden ? icons.eyeOff : icons.eye;
      eye.addEventListener('click', (ev) => { ev.stopPropagation(); this.toggleHidden(id); });
      it.append(k, n, m, eye);
      const openMenu = (cx: number, cy: number) => { const o = this.overlay.getBoundingClientRect(); this.menu(cx - o.left, cy - o.top, menuItems()); };
      let pressed = 0; let longFired = false;
      it.addEventListener('click', () => { if (longFired) { longFired = false; return; } onTap(); });
      it.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openMenu(ev.clientX, ev.clientY); });
      it.addEventListener('pointerdown', (ev) => { if (ev.pointerType === 'mouse') return; pressed = window.setTimeout(() => { pressed = 0; longFired = true; openMenu(ev.clientX, ev.clientY); }, 480); });
      for (const evn of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove'] as const) it.addEventListener(evn, (ev) => { if (pressed && (evn !== 'pointermove' || Math.hypot((ev as PointerEvent).movementX, (ev as PointerEvent).movementY) > 2)) { clearTimeout(pressed); pressed = 0; } });
      list.append(it);
    };
    const ids = bodyIds(doc);
    for (const id of ids) {
      const b = this.bodies.find((x) => x.id === id); const active = this.selBodies().includes(id) && !this.sel3d.face && !this.sel3d.edges.length;
      row('body', 'solid', bodyName(doc, id), b ? fmtMm3(b.volume) : '', id, active, () => (isHidden(doc, id) ? this.toggleHidden(id) : this.selectBody(id)), () => [
        { label: 'Renomear…', action: () => this.renameItem('body', id) }, { label: 'Enquadrar', action: () => this.zoomTo('body', id) },
        { label: isHidden(doc, id) ? 'Mostrar' : 'Ocultar', action: () => this.toggleHidden(id) }, { label: 'Apagar', action: () => this.deleteBody(id) },
      ]);
    }
    for (const s of doc.sketches) {
      let plName = ''; try { plName = getPlane(doc, s.plane).name; } catch { /* plano sumiu */ }
      row('sketch', 'sketch', s.name, plName, s.id, false, () => this.enterSketch(s.id), () => [
        { label: 'Editar esboço', action: () => this.enterSketch(s.id) }, { label: 'Extrudar…', action: () => this.extrudeSketch(s.id) },
        { label: 'Renomear…', action: () => this.renameItem('sketch', s.id) }, { label: 'Enquadrar', action: () => this.zoomTo('sketch', s.id) },
        { label: isHidden(doc, s.id) ? 'Mostrar' : 'Ocultar', action: () => this.toggleHidden(s.id) }, { label: 'Apagar', action: () => this.deleteSketch(s.id) },
      ]);
    }
    for (const pl of doc.planes.filter((x) => x.kind !== 'face')) {
      row('plane', 'plane', pl.name, pl.kind === 'offset' ? 'deslocado' : '', pl.id, false, () => this.createSketchOn(pl.id), () => [
        { label: 'Novo esboço aqui', action: () => this.createSketchOn(pl.id) }, { label: 'Renomear…', action: () => this.renameItem('plane', pl.id) },
        { label: isHidden(doc, pl.id) ? 'Mostrar' : 'Ocultar', action: () => this.toggleHidden(pl.id) }, ...(pl.kind === 'offset' ? [{ label: 'Apagar', action: () => this.deletePlane(pl.id) }] : []),
      ]);
    }
    if (!ids.length && !doc.sketches.length) { const d = el('div', 'hint'); d.textContent = 'Nenhum esboço ainda. Toque num plano ou em "Esboço".'; list.append(d); }
    p.append(list);
    const tools = el('div', 'row tools'); const hiddenCount = (doc.hidden ?? []).length;
    if (hiddenCount) tools.append(this.button(`Mostrar ocultos (${hiddenCount})`, () => { this.pushUndo(); delete doc.hidden; this.refreshAll(false); this.redrawBodies(); }));
    if (ids.length + doc.sketches.length) tools.append(this.button('Inverter visibilidade', () => this.invertHidden()));
    if (tools.childElementCount) p.append(tools);
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
      hint.textContent = this.tool === 'draw' ? 'Risque com a caneta: o traço vira linha, arco, círculo, elipse ou spline (curva livre). Um dedo arrasta, dois dedos aproximam.'
        : this.tool === 'spline' ? 'Toque ponto a ponto; a curva passa por todos. Toque no primeiro ponto para fechar; trocar de ferramenta termina. Arraste os pontos depois para ajustar.'
        : this.tool === 'ellipse' ? 'Arraste do centro: o arrasto dá o eixo maior e a inclinação. Toque na elipse para digitar os dois eixos.'
        : this.tool === 'dimension' ? (this.pendingDimRefs.length ? 'Toque no segundo elemento, ou em área vazia para cotar só este.' : 'Toque numa linha, círculo, arco ou ponto. Para ângulo, toque em duas linhas.')
        : this.tool === 'select' ? 'Toque para selecionar. Arraste pontos para ajustar. Selecione elementos para ver restrições possíveis.'
        : this.tool === 'project' ? 'Toque numa aresta ou numa face de um corpo: o contorno cai neste plano como linhas, círculos e arcos do esboço (com Construção ligada, como referência tracejada).'
        : this.tool === 'trim' ? 'Toque no trecho que quer tirar: ele some até os cruzamentos vizinhos. Arraste a caneta para aparar vários de uma vez.'
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
        const row2 = el('div', 'row'); row2.style.flexWrap = 'wrap';
        if (this.sel.entities.size === 1) row2.append(this.button('Deslocar contorno…', (ev) => this.offsetContourMenu(ev)));
        if (this.sel.entities.size) row2.append(this.button(this.mirrorPending ? 'Toque na linha-espelho…' : 'Espelhar…', () => this.startMirrorSketch()));
        if (this.filletCornerCandidate()) row2.append(this.button('Filete 2D…', () => this.fillet2D()));
        if (this.splitLineCandidate()) row2.append(this.button('Dividir corpo por esta linha', () => this.splitBySketchLine()));
        p.append(row2);
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
    this.renderSectionPanel(p);
    this.renderSelectionPanel(p);
    if (!this.sel3d.body && !this.sel3d.face && !this.sel3d.edges.length && this.bodies.length) {
      const d = el('div', 'hint'); d.textContent = 'Caneta: risque numa face para esboçar nela. Arraste uma região sombreada para extrudar. Toque numa face, aresta ou região e a barra embaixo mostra o que dá para fazer. Toque duas vezes num corpo para movê-lo pelas setas; segure a caneta para escolher entre itens sobrepostos.'; p.append(d);
    }

    this.renderItems(p);

    p.append(h3(`Histórico (${doc.features.length})`));
    const flist = el('div', 'list');
    if (!doc.features.length) { const d = el('div', 'hint'); d.textContent = 'Extrude um esboço fechado para criar o primeiro corpo.'; flist.append(d); }
    for (const f of doc.features) {
      const err = this.featureErrors.find((e) => e.feature === f.id);
      const it = listItem(`${err ? '⚠ ' : ''}${f.name}`, featureMini(f));
      if (err) it.title = err.message;
      if (this.selectedFeature === f.id) it.classList.add('active');
      it.addEventListener('click', () => { this.selectedFeature = this.selectedFeature === f.id ? null : f.id; this.sel3d = emptySel3D(); if (this.selectedFeature) this.sel3d.body = bodyOfFeature(f); this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar(); });
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
    const nm = body ? bodyName(doc, body.id) : 'corpo';
    const d = el('div', 'hint');
    if (s3.edges.length) d.textContent = `${s3.edges.length} aresta${s3.edges.length > 1 ? 's' : ''} de ${nm}. Toque em outras para somar; arraste uma para fora (filete) ou para dentro (chanfro).`;
    else if (s3.face && body) { const f = body.faces[s3.face.index]; const extra = s3.faces?.length ?? 0; d.textContent = extra ? `${extra + 1} faces de ${nm}. A seta puxa todas juntas; Furo passante com um esboço repete o mesmo rasgo nelas.` : f ? `Face ${faceTypeName(f.type)} de ${nm}, ${f.area.toFixed(0)} mm². Toque em outras faces para somar.` : nm; }
    else if (body) d.textContent = `${nm}: volume ${fmtMm3(body.volume)}, ${body.faces.length} faces, ${body.edges.length} arestas. Setas movem, anéis giram.`;
    p.append(d);
    const row = el('div', 'row'); row.append(this.button('Limpar seleção', () => this.clearSel3d())); p.append(row);
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
      this.renderPatternRows(p, f, edit);
      if (f.onFaces?.length) { const fr = el('div', 'row'); const fh = el('div', 'hint'); fh.style.flex = '1'; fh.textContent = `Repetido em mais ${f.onFaces.length} face${f.onFaces.length > 1 ? 's' : ''}.`; fr.append(fh, this.button('Só a original', () => edit(() => { delete f.onFaces; }))); p.append(fr); }
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
      this.renderPatternRows(p, f, edit);
      const row3 = el('div', 'row');
      row3.append(this.button('Editar esboço', () => this.enterSketch(f.sketch)));
      row3.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger'));
      p.append(row3);
    } else if (f.type === 'shell') {
      numRow('Espessura (mm)', f.thickness, (v) => edit(() => { f.thickness = v; }));
      const d = el('div', 'hint'); d.textContent = f.openFaces.length ? `${f.openFaces.length} face${f.openFaces.length > 1 ? 's' : ''} aberta${f.openFaces.length > 1 ? 's' : ''}.` : 'Corpo oco fechado.'; p.append(d);
      const row = el('div', 'row'); row.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger')); p.append(row);
    } else if (f.type === 'mirror') {
      checkRow('Fundir com o original', f.join, (v) => edit(() => { f.join = v; }));
      const row = el('div', 'row'); row.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger')); p.append(row);
    } else if (f.type === 'transform') {
      (['X', 'Y', 'Z'] as const).forEach((ax, i) => { const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = `Mover ${ax} (mm)`; const inp = document.createElement('input'); inp.type = 'number'; inp.step = '1'; inp.value = String(f.translate[i]); inp.addEventListener('change', () => { const v = parseFloat(inp.value.replace(',', '.')); if (isFinite(v)) edit(() => { f.translate[i] = v; }); }); row.append(lab, inp); p.append(row); });
      const rr = el('div', 'row'); const rl = document.createElement('label'); rl.textContent = 'Girar (°)'; const ri = document.createElement('input'); ri.type = 'number'; ri.step = '5'; ri.value = String(f.angle); ri.addEventListener('change', () => { const v = parseFloat(ri.value.replace(',', '.')); if (isFinite(v)) edit(() => { f.angle = v; }); }); rr.append(rl, ri); p.append(rr);
      selectRow('Eixo do giro', [['x', 'X'], ['y', 'Y'], ['z', 'Z']], f.axisDir[0] ? 'x' : f.axisDir[1] ? 'y' : 'z', (v) => edit(() => { f.axisDir = v === 'x' ? [1, 0, 0] : v === 'y' ? [0, 1, 0] : [0, 0, 1]; }));
      numRow('Escala (×)', f.scale, (v) => edit(() => { f.scale = v; }));
      const row = el('div', 'row'); row.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger')); p.append(row);
    } else if (f.type === 'replaceFace') {
      const d = el('div', 'hint'); d.textContent = `Face de ${bodyName(doc, f.body)} (${f.face.area.toFixed(0)} mm²) rente a ${f.with.kind === 'plane' ? 'um plano' : `um cilindro Ø${fmtDim('distance', f.with.radius * 2)}`}. Para mudar o destino, apague e refaça.`; p.append(d);
      const row = el('div', 'row'); row.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger')); p.append(row);
    } else if (f.type === 'split') {
      selectRow('Manter', [['both', 'Os dois lados'], ['front', 'Lado da normal'], ['back', 'Lado oposto']], f.keep, (v) => edit(() => { f.keep = v as typeof f.keep; }));
      const row = el('div', 'row'); row.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger')); p.append(row);
    } else if (f.type === 'sweep' || f.type === 'loft') {
      const others = bodyIds(doc).filter((id) => id !== f.id);
      const opOptions: [string, string][] = [['new', 'Novo corpo']]; if (others.length) opOptions.push(['add', 'Adicionar a corpo'], ['cut', 'Cortar corpo']);
      selectRow('Operação', opOptions, f.op, (v) => edit(() => { f.op = v as ExtrudeOp; if (f.op === 'new') f.target = undefined; else if (!f.target || !others.includes(f.target)) f.target = others[0]; }));
      if (f.type === 'loft') checkRow('Faces retas (regrado)', f.ruled, (v) => edit(() => { f.ruled = v; }));
      if (f.type === 'sweep' && f.tube) { const tb = f.tube; numRow('Diâmetro externo (mm)', tb.outer, (v) => edit(() => { tb.outer = v; if (tb.inner >= v) tb.inner = 0; })); const wallRow = el('div', 'row'); const wl = document.createElement('label'); wl.textContent = 'Parede (mm, 0 = maciço)'; const wi = document.createElement('input'); wi.type = 'number'; wi.step = '0.5'; wi.value = String(tb.inner > 0 ? (tb.outer - tb.inner) / 2 : 0); wi.addEventListener('change', () => { const w = parseFloat(wi.value.replace(',', '.')); if (isFinite(w) && w >= 0 && w * 2 < tb.outer) edit(() => { tb.inner = w > 0 ? tb.outer - 2 * w : 0; }); }); wallRow.append(wl, wi); p.append(wallRow); }
      const d = el('div', 'hint'); d.textContent = f.type === 'sweep' ? (f.tube ? `Tubo em ${(f.paths ?? [f.path]).map((id) => doc.sketches.find((s) => s.id === id)?.name ?? '?').join(' + ')}.` : `Perfil ${getSketch(doc, f.profile).name} ao longo de ${(f.paths ?? [f.path]).map((id) => doc.sketches.find((s) => s.id === id)?.name ?? '?').join(' + ')}.`) : `${f.sketches.length} esboços.`; p.append(d);
      const row = el('div', 'row'); row.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger')); p.append(row);
    } else if (f.type === 'import') {
      const d = el('div', 'hint'); d.textContent = `STEP com ${(f.step.length / 1024).toFixed(0)} KB embutido no documento.`; p.append(d);
      const row = el('div', 'row'); row.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger')); p.append(row);
    } else if (f.type === 'pushpull') {
      const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = 'Distância (mm, − empurra)';
      const inp = document.createElement('input'); inp.type = 'number'; inp.step = '0.5'; inp.value = String(f.distance); inp.inputMode = 'decimal';
      inp.addEventListener('change', () => { const v = parseFloat(inp.value.replace(',', '.')); if (!isFinite(v) || v === 0) return; edit(() => { f.distance = v; f.name = f.name.replace(/^(Puxar|Empurrar)/, v >= 0 ? 'Puxar' : 'Empurrar'); }); });
      row.append(lab, inp); p.append(row);
      const d = el('div', 'hint'); d.textContent = `Face de ${bodyName(doc, f.body)}, ${f.face.area.toFixed(0)} mm².`; p.append(d);
      const row2 = el('div', 'row'); row2.append(this.button('Apagar', () => this.deleteFeature(f), 'btn danger')); p.append(row2);
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
  private clearSel3d(): void { this.gizmoWanted = false; this.sel3d = emptySel3D(); this.selRegion = null; this.vp.setRegionSelected(null); this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar(); }
  /** Seta de puxar acompanha a face plana selecionada (modo peça). */
  private updateFaceHandle(): void {
    const f = this.sel3d.face; const fd = f && !this.isAssembly ? this.bodyOf(f.body)?.faces[f.index] : undefined;
    if (fd?.type === 'plane' && fd.normal && this.mode === 'view') this.vp.setFaceHandle(new THREE.Vector3(...fd.center), new THREE.Vector3(...fd.normal)); else this.vp.setFaceHandle(null);
    this.updateGizmo();
  }
  /** Gizmo de mover/girar aparece quando um corpo inteiro está selecionado (sem face nem aresta). */
  private updateGizmo(): void {
    const bs = this.gizmoWanted && !this.sel3d.face && !this.sel3d.edges.length && this.mode === 'view' && !this.isAssembly ? this.selBodies().map((id) => this.bodyOf(id)).filter((b): b is BodyData => !!b) : [];
    if (!bs.length) { this.vp.setGizmo(null); return; }
    const mn: V3 = [Infinity, Infinity, Infinity], mx: V3 = [-Infinity, -Infinity, -Infinity];
    for (const b of bs) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], b.bbox[0][i]); mx[i] = Math.max(mx[i], b.bbox[1][i]); }
    this.vp.setGizmo(new THREE.Vector3((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2));
  }
  /** Ângulo do cursor em volta de um eixo (plano perpendicular ao eixo pelo centro). */
  private gizmoAngle(center: THREE.Vector3, axis: THREE.Vector3, x: number, y: number): number {
    const p = this.vp.rayOnPlane(center, axis, x, y); if (!p) return 0;
    const u = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3().crossVectors(axis, u).normalize(); const b = new THREE.Vector3().crossVectors(axis, a).normalize();
    const v = p.clone().sub(center); return Math.atan2(v.dot(b), v.dot(a));
  }

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
  /** Abre um esboço. Em face de corpo, fica na vista 3D para a peça continuar visível; nos planos base, vista reta. */
  enterSketch(id: Id, perspective?: boolean): void {
    if (isHidden(this.doc.current, id)) setHidden(this.doc.current, id, false);
    this.selRegion = null; this.vp.setRegionSelected(null);
    this.activeSketch = id; this.mode = 'sketch'; this.tool = 'draw'; this.sel = emptySelection(); this.pendingDimRefs = []; this.selectedFeature = null; this.sel3d = emptySel3D();
    const p = this.plane!; const persp = perspective ?? (p.kind === 'face' && this.vp.mode === 'view');
    this.vp.enterSketch(p, persp); this.vp.setSelection(this.sel3d); this.updateFaceHandle();
    this.solve(); this.refreshAll(false); if (!persp) this.vp.fitAll();
  }
  exitSketch(removeEmpty: boolean): void {
    this.finishSplineDraft();
    const s = this.sketch;
    if (s && removeEmpty && !s.entities.length) this.doc.current.sketches = this.doc.current.sketches.filter((x) => x.id !== s.id);
    pruneFacePlanes(this.doc.current);
    this.activeSketch = null; this.mode = 'view'; this.sel = emptySelection(); this.pendingDimRefs = []; this.lastSolve = null;
    this.vp.exitSketch(); this.refreshAll(); this.vp.fitAll();
  }
  setTool(t: Tool): void { if (this.splineDraft && t !== 'spline') this.finishSplineDraft(); if (this.tool === 'trim') this.sk.setHint(null, null, [], 1); if (this.tool === 'project') this.vp.setHover(null); this.tool = t; this.pendingDimRefs = []; if (t !== 'select') this.sel = emptySelection(); this.refreshAll(false); }

  private solve(opts?: SolveOptions): SolveResult | null {
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
    if (e.type === 'spline' || e.type === 'ellipse') return this.polylineDistance(uv, M.sampleEntity(s, e)).d;
    const c = M.getPoint(s, e.center);
    if (e.type === 'circle') return Math.abs(dist(uv, c) - e.r);
    const { start, end } = M.arcAngles(s, e); return distPointArc(uv, c, e.r, start, end);
  }

  /** Distância e ponto mais próximo numa polilinha. */
  private polylineDistance(uv: Vec2, pts: Vec2[]): { d: number; q: Vec2 } {
    let best = { d: Infinity, q: uv };
    for (let i = 1; i < pts.length; i++) { const q = closestOnSegment(uv, pts[i - 1], pts[i]); const d = dist(uv, q); if (d < best.d) best = { d, q }; }
    if (pts.length === 1) best = { d: dist(uv, pts[0]), q: pts[0] };
    return best;
  }
  /** Spline toque a toque: cada toque põe um ponto; tocar no primeiro ponto fecha; trocar de ferramenta termina. */
  private splineDraft: Id | null = null;
  private addSplinePoint(s: Sketch, uv: Vec2, tol: number): void {
    const draft = this.splineDraft ? s.entities.find((e): e is M.SplineEntity => e.type === 'spline' && e.id === this.splineDraft) : undefined;
    if (draft && draft.points.length >= 3) {
      const first = M.getPoint(s, draft.points[0]);
      if (dist(uv, first) < tol * 1.6) { this.pushUndo(); draft.closed = true; this.splineDraft = null; this.solve(); this.refreshAll(false); this.toast('Spline fechada.'); return; }
    }
    this.pushUndo();
    const pid = this.snapPoint(s, uv, tol, new Set(draft?.points ?? [])).id;
    if (draft) { if (draft.points[draft.points.length - 1] !== pid) draft.points.push(pid); }
    else { const e = M.addSpline(s, [pid]); if (this.constructionMode) e.construction = true; this.splineDraft = e.id; this.toast('Toque para pôr os próximos pontos; toque no primeiro ponto para fechar. Trocar de ferramenta termina.'); }
    this.solve(); this.refreshAll(false);
  }
  /** Termina a spline em andamento (remove se ficou com um ponto só). */
  private finishSplineDraft(): void {
    const s = this.sketch; const id = this.splineDraft; this.splineDraft = null; if (!s || !id) return;
    const e = s.entities.find((x) => x.id === id);
    if (e && e.type === 'spline' && e.points.length < 2) M.removeEntities(s, [id]);
  }
  /** Campos da elipse: eixos maior e menor e inclinação. */
  private ellipseDialog(e: M.EllipseEntity): void {
    this.formDialog('Elipse', [
      { key: 'a', label: 'Eixo maior (mm)', type: 'number', value: App.niceMm(e.rx * 2) }, { key: 'b', label: 'Eixo menor (mm)', type: 'number', value: App.niceMm(e.ry * 2) },
      { key: 'ang', label: 'Inclinação (°)', type: 'number', value: Math.round((e.angle * 180) / Math.PI * 10) / 10 },
    ], 'Aplicar', (v) => {
      const a = v.a as number, b = v.b as number; if (!(a > 0) || !(b > 0)) return this.toast('Eixos têm que ser maiores que zero.', 'err');
      this.pushUndo(); e.rx = a / 2; e.ry = b / 2; e.angle = ((v.ang as number) * Math.PI) / 180; this.solve(); this.refreshAll(false);
    });
  }
  /** Onde a caneta encaixa perto de `uv`: canto existente, origem do plano, cruzamento de linhas, meio de linha ou sobre uma entidade. */
  private findSnap(s: Sketch, uv: Vec2, tol: number, exclude: Set<Id> = new Set()): SnapHit | null {
    // 1) Cantos e pontos existentes têm preferência (tolerância maior).
    let bestP: M.SketchPoint | null = null; let bd = tol * 1.6;
    for (const p of s.points) { if (exclude.has(p.id)) continue; const d = dist(uv, p); if (d < bd) { bd = d; bestP = p; } }
    if (bestP) { const id = bestP.id; return { uv: v2(bestP.x, bestP.y), kind: 'point', apply: () => id }; }
    // 2) Origem do plano.
    if (dist(uv, v2(0, 0)) < tol * 1.2) return { uv: v2(0, 0), kind: 'origin', apply: () => { const ex = s.points.find((p) => Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9); if (ex) return ex.id; const p = M.addPoint(s, 0, 0); M.addConstraint(s, 'fixed', [p.id]); return p.id; } };
    // 3) Cruzamentos de entidades (inclusive linhas de construção: o centro do X).
    const ents = s.entities.filter((e) => !exclude.has(e.id)); const P = (id: Id) => M.getPoint(s, id);
    let bestX: { uv: Vec2; a: Entity; b: Entity } | null = null; let bx = tol;
    for (let i = 0; i < ents.length; i++) for (let j = i + 1; j < ents.length; j++) {
      const a = ents[i], b = ents[j]; let cands: Vec2[] = [];
      // Só linhas, círculos e arcos têm cruzamento calculado; elipses e splines ficam de fora.
      if (!(a.type === 'line' || M.isRound(a)) || !(b.type === 'line' || M.isRound(b))) continue;
      if (a.type === 'line' && b.type === 'line') { const q = intersectSegments(P(a.a), P(a.b), P(b.a), P(b.b)); if (q) cands = [q]; }
      else if (a.type === 'line' || b.type === 'line') { const l = (a.type === 'line' ? a : b) as M.LineEntity, c = (a.type === 'line' ? b : a) as M.CircleEntity | M.ArcEntity; cands = intersectLineCircle(P(l.a), P(l.b), P(c.center), c.r).filter((q) => distPointSegment(q, P(l.a), P(l.b)) < 1e-6 && this.entityDistance(q, c, s) < 1e-6); }
      else { const c1 = a as M.CircleEntity | M.ArcEntity, c2 = b as M.CircleEntity | M.ArcEntity; cands = intersectCircles(P(c1.center), c1.r, P(c2.center), c2.r).filter((q) => this.entityDistance(q, c1, s) < 1e-6 && this.entityDistance(q, c2, s) < 1e-6); }
      for (const q of cands) { if (s.points.some((p) => dist(p, q) < 1e-6)) continue; const d = dist(uv, q); if (d < bx) { bx = d; bestX = { uv: q, a, b }; } }
    }
    if (bestX) { const { uv: q, a, b } = bestX; return { uv: q, kind: 'intersection', apply: () => { const p = M.addPoint(s, q.x, q.y); for (const e of [a, b]) M.addConstraint(s, e.type === 'line' ? 'pointOnLine' : 'pointOnCircle', [p.id, e.id]); return p.id; } }; }
    // 4) Meio de uma linha.
    let bestM: { uv: Vec2; l: M.LineEntity } | null = null; let bm = tol * 0.9;
    for (const e of ents) if (e.type === 'line') { const a = P(e.a), b = P(e.b); const m = v2((a.x + b.x) / 2, (a.y + b.y) / 2); const d = dist(uv, m); if (d < bm) { bm = d; bestM = { uv: m, l: e }; } }
    if (bestM) { const { uv: q, l } = bestM; return { uv: q, kind: 'midpoint', apply: () => { const p = M.addPoint(s, q.x, q.y); M.addConstraint(s, 'midpoint', [p.id, l.id]); return p.id; } }; }
    // 5) Sobre uma entidade.
    let bestE: Entity | null = null; let be = tol;
    for (const e of ents) { const d = this.entityDistance(uv, e, s); if (d < be) { be = d; bestE = e; } }
    if (bestE) {
      const e = bestE; let q = uv;
      if (e.type === 'line') q = closestOnSegment(uv, P(e.a), P(e.b));
      else if (M.isRound(e)) { const c = P(e.center); q = add(v2(c.x, c.y), scale(norm(sub(uv, c)), e.r)); }
      else q = this.polylineDistance(uv, M.sampleEntity(s, e)).q;
      return { uv: q, kind: 'entity', apply: () => { const p = M.addPoint(s, q.x, q.y); if (e.type === 'line' || M.isRound(e)) M.addConstraint(s, e.type === 'line' ? 'pointOnLine' : 'pointOnCircle', [p.id, e.id]); return p.id; } };
    }
    return null;
  }

  /** Ponto do esboço em `uv`: encaixa (canto, origem, cruzamento, meio, entidade) ou cria livre. */
  private snapPoint(s: Sketch, uv: Vec2, tol: number, exclude: Set<Id> = new Set()): { id: Id; created: boolean; onEntity?: Entity } {
    const sn = this.findSnap(s, uv, tol, exclude);
    if (sn) return { id: sn.apply(), created: sn.kind !== 'point' };
    const p = M.addPoint(s, uv.x, uv.y); return { id: p.id, created: true };
  }
  /** Mostra o anel de encaixe para a posição atual da caneta. */
  private showSnap(s: Sketch, uv: Vec2, tol: number): Vec2 {
    const sn = this.findSnap(s, uv, tol); this.sk.setSnap(this.plane, sn ? sn.uv : null, this.vp.mmPerPixel()); return sn ? sn.uv : uv;
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
      if (pr.type === 'ellipse') { const c = M.addPoint(s, pr.c.x, pr.c.y); created.push(M.addEllipse(s, c.id, pr.rx, pr.ry, pr.angle)); continue; }
      if (pr.type === 'spline') {
        const ids = pr.pts.map((p, i) => (!pr.closed && (i === 0 || i === pr.pts.length - 1)) ? pointFor(p) : M.addPoint(s, p.x, p.y).id);
        const e = M.addSpline(s, ids.filter((id, i) => i === 0 || id !== ids[i - 1]), pr.closed); if (e.points.length >= 2) created.push(e); else M.removeEntities(s, [e.id]);
        continue;
      }
      if (pr.type === 'circle') {
        const c = M.addPoint(s, pr.c.x, pr.c.y);
        const other = s.entities.find((e) => (M.isRound(e) || e.type === 'ellipse') && dist(M.getPoint(s, e.center), pr.c) < tol * 1.5);
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
    // Ângulo reto automático: linha nova que nasce de outra linha oblíqua e fica a ~90° dela.
    const hasHV = (l: Id) => s.constraints.some((k) => (k.kind === 'horizontal' || k.kind === 'vertical') && k.refs[0] === l);
    for (const e of created) {
      if (e.type !== 'line' || hasHV(e.id)) continue;
      for (const pid of [e.a, e.b]) {
        for (const o of s.entities) {
          if (o.type !== 'line' || o.id === e.id || o.construction || hasHV(o.id) || !(o.a === pid || o.b === pid)) continue;
          if (s.constraints.some((k) => k.kind === 'perpendicular' && k.refs.includes(e.id) && k.refs.includes(o.id))) continue;
          const d1 = norm(sub(M.getPoint(s, e.b), M.getPoint(s, e.a))), d2 = norm(sub(M.getPoint(s, o.b), M.getPoint(s, o.a)));
          const ang = Math.acos(Math.min(1, Math.abs(d1.x * d2.x + d1.y * d2.y))) * 180 / Math.PI;
          if (Math.abs(ang - 90) < PERP_SNAP_DEG) autoCons.push(M.addConstraint(s, 'perpendicular', [e.id, o.id]).id);
        }
      }
    }
    if (this.constructionMode) for (const e of created) e.construction = true;
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
    c.addEventListener('wheel', (ev) => { ev.preventDefault(); const f = Math.exp(-ev.deltaY * 0.0015); this.vp.zoom(f, this.local(ev)); this.refreshSketch(); this.vp.refreshHandles(); }, { passive: false });
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }
  private local(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.vp.renderer.domElement.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  private roleFor(ev: PointerEvent): PointerInfo['role'] {
    const direct = true;
    if (ev.pointerType === 'mouse') { if (ev.button === 1 || ev.button === 2) return 'pan'; return direct ? 'tool' : 'nav'; }
    if (ev.pointerType === 'pen') return direct ? 'tool' : 'nav';
    if (this.mode === 'sketch' && this.touchDraws) return 'tool';
    return 'nav';
  }

  private onDown(ev: PointerEvent): void {
    this.closeMenus();
    const { x, y } = this.local(ev);
    const info: PointerInfo = { id: ev.pointerId, type: ev.pointerType, x, y, startX: x, startY: y, moved: false, role: this.roleFor(ev), button: ev.button, shift: ev.shiftKey };
    this.pointers.set(ev.pointerId, info);
    try { this.vp.renderer.domElement.setPointerCapture(ev.pointerId); } catch { /* ponteiro sintético (testes) */ }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      if (this.stroke.length && a.type === 'touch' && b.type === 'touch') { this.stroke = []; this.sk.setStroke(null, []); this.toolStart = null; }
      return;
    }
    if (this.pointers.size > 2) return;
    this.hideChip(); this.vp.setHover(null);
    if (info.role === 'tool' && this.mode === 'sketch') this.toolDown(info);
    else if (info.role === 'tool' && this.mode === 'view') this.viewDown(info);
  }

  private onMove(ev: PointerEvent): void {
    const info = this.pointers.get(ev.pointerId); if (!info) { this.hover(ev); return; }
    const { x, y } = this.local(ev); const dx = x - info.x, dy = y - info.y;
    info.x = x; info.y = y;
    if (!info.moved && Math.hypot(x - info.startX, y - info.startY) > (info.type === 'mouse' ? 5 : 9)) info.moved = true;
    if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y); const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (this.pinch.d0 > 0) this.vp.zoom(d / this.pinch.d0, mid);
      this.vp.pan(mid.x - this.pinch.mid.x, mid.y - this.pinch.mid.y);
      this.pinch = { d0: d, mid }; this.refreshSketch(); return;
    }
    if (this.pointers.size !== 1) return;
    if (info.role === 'nav') { if (this.mode === 'sketch' && !this.vp.sketchPerspective) this.vp.pan(dx, dy); else this.vp.orbit(dx, dy); this.refreshSketch(); return; }
    if (info.role === 'pan') { this.vp.pan(dx, dy); this.refreshSketch(); return; }
    if (this.mode === 'sketch') this.toolMove(info, ev);
    else if (info.role === 'tool') this.viewMove(info);
  }

  private onUp(ev: PointerEvent, cancelled = false): void {
    const info = this.pointers.get(ev.pointerId); if (!info) return;
    this.pointers.delete(ev.pointerId);
    this.cancelPress();
    if (this.pointers.size < 2) this.pinch = null;
    if (info.handled) { this.drag = null; return; }
    if ((info.role === 'nav' || info.role === 'pan') && info.moved && this.mode === 'view') this.vp.refreshHandles();
    if (info.role === 'pan' && info.button === 2 && !info.moved && !cancelled && this.mode === 'view' && !this.isAssembly) { this.selectThrough(info.x, info.y); return; }
    if (info.role === 'nav' && !info.moved && !cancelled) { this.tapView(info); return; }
    if (info.role === 'tool' && this.mode === 'sketch') { this.toolUp(info, cancelled); return; }
    if (info.role === 'tool' && this.mode === 'view') this.viewUp(info, cancelled);
  }

  // ---------- Modelagem direta: gestos da caneta na vista 3D ----------
  /** Caneta (ou botão esquerdo) tocou a cena: decide o que vai ser arrastado. */
  private viewDown(info: PointerInfo): void {
    const doc = this.doc.current; const { x, y } = info;
    if (this.isAssembly) {
      const asm = this.asm!; const fh = this.vp.pickFace(x, y); const inst = fh ? this.instanceOf(fh.body) : null; const instObj = inst ? asm.instances.find((i) => i.id === inst) : undefined;
      if (!fh || !inst || !instObj || this.jointFlow || this.measure.on) { info.role = 'nav'; return; }
      if (jointOf(asm, inst)) { info.role = 'nav'; return; }
      this.pushUndo();
      this.drag = { kind: 'moveInst', inst, startPos: [...instObj.pos] as V3, lastGood: [...instObj.pos] as V3, hit: fh.point.clone(), normal: this.vp.persp.getWorldDirection(new THREE.Vector3()), checking: false, pending: null };
      return;
    }
    // Gizmo do corpo selecionado: setas movem no eixo, anéis giram em volta dele.
    const gz = this.vp.gizmoAt; const gp = gz && this.sel3d.body ? this.vp.pickGizmo(x, y, info.type === 'touch' ? 22 : 14) : null;
    if (gz && gp && this.sel3d.body) {
      const axis = new THREE.Vector3(gp.axis === 0 ? 1 : 0, gp.axis === 1 ? 1 : 0, gp.axis === 2 ? 1 : 0);
      if (gp.kind === 'move') this.drag = { kind: 'gmove', body: this.sel3d.body, axis, axisIndex: gp.axis, origin: gz, t0: this.vp.axisDragDistance(gz, axis, x, y), dist: 0 };
      else this.drag = { kind: 'grot', body: this.sel3d.body, axis, axisIndex: gp.axis, center: gz, a0: this.gizmoAngle(gz, axis, x, y), angle: 0 };
      return;
    }
    this.startPress(info);
    // Seta da face selecionada: arrastar puxa ou empurra a face.
    if (this.sel3d.face && this.vp.handleDistancePx(x, y) < (info.type === 'touch' ? 26 : 18)) {
      const fd = this.bodyOf(this.sel3d.face.body)?.faces[this.sel3d.face.index];
      if (fd?.type === 'plane' && fd.normal) { const origin = new THREE.Vector3(...fd.center), normal = new THREE.Vector3(...fd.normal); this.drag = { kind: 'pull', body: this.sel3d.face.body, index: this.sel3d.face.index, fd, origin, normal, dist: 0, t0: this.vp.axisDragDistance(origin, normal, x, y) }; return; }
    }
    const faceHit = this.vp.pickFace(x, y);
    let regionHit = this.vp.pickRegion(x, y); if (regionHit && faceHit && regionHit.distance > faceHit.distance + 0.5) regionHit = null;
    const tol = info.type === 'touch' ? 18 : info.type === 'pen' ? 12 : 9;
    const edgeHit = regionHit ? null : this.vp.pickEdge(x, y, tol, faceHit);
    if (regionHit) {
      const sk = getSketch(doc, regionHit.sketch); const plane = getPlane(doc, sk.plane); const prof = extractProfiles(sk)[regionHit.index]; if (!prof) { info.role = 'nav'; return; }
      const ip = profileInnerPoint(sk, prof);
      this.drag = { kind: 'extrude', sketch: sk.id, profilePoint: [ip.x, ip.y], plane, start: regionHit.point.clone(), normal: new THREE.Vector3(...planeNormal(plane)), depth: 0 };
      return;
    }
    if (edgeHit) { this.drag = { kind: 'edge', body: edgeHit.body, index: edgeHit.index, created: null, radius: 0, out: null, shape: 'fillet' }; return; }
    if (faceHit && faceHit.index >= 0) {
      const fd = this.bodyOf(faceHit.body)?.faces[faceHit.index];
      if (fd?.type === 'plane' && fd.normal) { this.drag = { kind: 'draw', body: faceHit.body, index: faceHit.index, started: false }; return; }
    }
    // Caneta no vazio (ou mouse com Shift): caixa de seleção. Dedo e mouse simples orbitam.
    if (!faceHit && (info.type === 'pen' || (info.type === 'mouse' && info.shift))) { this.cancelPress(); this.drag = { kind: 'box', el: null }; return; }
    info.role = 'nav';
  }

  /** Seleção por caixa, como no Shapr3D: da esquerda para a direita pega só o que está inteiro dentro; da direita para a esquerda, tudo o que a caixa encosta. */
  private finishBox(info: PointerInfo): void {
    const mode: 'contain' | 'touch' = info.x >= info.startX ? 'contain' : 'touch';
    const kind: BoxKind = this.selFilter === 'faces' || this.selFilter === 'edges' ? this.selFilter : 'bodies';
    const hits = this.vp.boxSelect(info.startX, info.startY, info.x, info.y, mode, kind);
    if (!hits.length) { this.clearSel3d(); return; }
    if (kind === 'bodies') { this.selectBodies(hits.map((h) => h.body)); return; }
    // Faces e arestas ficam num corpo só: o que tiver mais itens na caixa.
    const count = new Map<Id, number>(); for (const h of hits) count.set(h.body, (count.get(h.body) ?? 0) + 1);
    const body = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0]; const mine = hits.filter((h) => h.body === body);
    this.selectedFeature = null; this.selRegion = null; this.vp.setRegionSelected(null);
    if (kind === 'edges') this.sel3d = { body, face: null, faces: [], edges: mine.map((h) => ({ body, index: h.index })) };
    else this.sel3d = { body, face: mine[mine.length - 1] ? { body, index: mine[mine.length - 1].index } : null, faces: mine.slice(0, -1).map((h) => ({ body, index: h.index })), edges: [] };
    this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar();
    this.toast(`${mine.length} ${kind === 'edges' ? 'aresta' : 'face'}${mine.length > 1 ? 's' : ''} de ${bodyName(this.doc.current, body)}.`);
  }
  /** Todos os corpos selecionados (principal + extras). */
  private selBodies(): Id[] { const s = this.sel3d; return s.body ? [s.body, ...(s.bodies ?? []).filter((b) => b !== s.body)] : []; }
  selectBodies(ids: Id[]): void {
    if (!ids.length) return this.clearSel3d();
    this.selectedFeature = null; this.selRegion = null; this.vp.setRegionSelected(null); this.gizmoWanted = true;
    this.sel3d = { body: ids[0], bodies: ids.slice(1), face: null, faces: [], edges: [] };
    this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar();
    if (ids.length > 1) this.toast(`${ids.length} corpos selecionados: as setas movem todos juntos.`);
  }
  setFilter(f: SelFilter): void {
    this.selFilter = f; this.renderToolbar();
    this.toast(f === 'all' ? 'Seleção: tudo.' : f === 'bodies' ? 'Seleção: só corpos (toque numa face pega o corpo inteiro).' : f === 'faces' ? 'Seleção: só faces.' : 'Seleção: só arestas.');
  }
  private cycleFilter(): void { const order: SelFilter[] = ['all', 'bodies', 'faces', 'edges']; this.setFilter(order[(order.indexOf(this.selFilter) + 1) % order.length]); }

  private viewMove(info: PointerInfo): void {
    if (info.moved) this.cancelPress();
    const d = this.drag; if (!d) return;
    const doc = this.doc.current;
    if (d.kind === 'extrude') {
      const t = snapMm(this.vp.axisDragDistance(d.start, d.normal, info.x, info.y)); d.depth = t;
      if (Math.abs(t) < 0.01) this.vp.setGhost(null);
      else { const tmp: ExtrudeFeature = { id: 'tmp', type: 'extrude', name: '', sketch: d.sketch, depth: Math.abs(t), op: 'new', flip: t < 0, profilePoint: d.profilePoint }; this.vp.setGhost(buildExtrude(doc, tmp)); }
      this.updateChip(info.x, info.y, `${fmtDim('distance', Math.abs(t))} mm${t < 0 ? ' (corte)' : ''}`);
    } else if (d.kind === 'box') {
      if (!info.moved) return;
      if (!d.el) { d.el = el('div', 'marquee'); this.overlay.append(d.el); }
      const touch = info.x < info.startX; d.el.classList.toggle('touch', touch);
      d.el.style.left = `${Math.min(info.x, info.startX)}px`; d.el.style.top = `${Math.min(info.y, info.startY)}px`; d.el.style.width = `${Math.abs(info.x - info.startX)}px`; d.el.style.height = `${Math.abs(info.y - info.startY)}px`;
      this.updateChip(info.x, info.y, `${touch ? 'Tocar' : 'Conter'} · ${FILTER_LABEL[this.selFilter]}`);
    } else if (d.kind === 'gmove') {
      const t = snapMm(this.vp.axisDragDistance(d.origin, d.axis, info.x, info.y) - d.t0); d.dist = t;
      const m = new THREE.Matrix4().makeTranslation(d.axis.x * t, d.axis.y * t, d.axis.z * t); for (const id of this.selBodies()) this.vp.previewBodyMatrix(id, m);
      this.vp.setGizmo(d.origin.clone().add(d.axis.clone().multiplyScalar(t)));
      this.updateChip(info.x, info.y, `${t >= 0 ? '+' : '−'}${fmtDim('distance', Math.abs(t))} mm em ${'XYZ'[d.axisIndex]}`);
    } else if (d.kind === 'grot') {
      let ang = ((this.gizmoAngle(d.center, d.axis, info.x, info.y) - d.a0) * 180) / Math.PI;
      ang = ((ang + 540) % 360) - 180; ang = Math.round(ang / 5) * 5; d.angle = ang;
      const c = d.center; const m = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationAxis(d.axis, (ang * Math.PI) / 180)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
      for (const id of this.selBodies()) this.vp.previewBodyMatrix(id, m);
      this.updateChip(info.x, info.y, `${ang >= 0 ? '' : '−'}${Math.abs(ang)}° em ${'XYZ'[d.axisIndex]}`);
    } else if (d.kind === 'pull') {
      const t = snapMm(this.vp.axisDragDistance(d.origin, d.normal, info.x, info.y) - d.t0); d.dist = t;
      let g: THREE.BufferGeometry | null = null;
      if (Math.abs(t) >= 0.01) {
        const parts: THREE.BufferGeometry[] = [];
        for (const fs of [{ body: d.body, index: d.index }, ...(this.sel3d.faces ?? []).filter((f) => f.body === d.body)]) { const fg = this.vp.faceGeometry(fs.body, fs.index); const fd = this.bodyOf(fs.body)?.faces[fs.index]; if (fg && fd?.normal) { fg.translate(fd.normal[0] * t, fd.normal[1] * t, fd.normal[2] * t); parts.push(fg.toNonIndexed()); } }
        if (parts.length) { const pos: number[] = []; for (const pg of parts) pos.push(...(pg.getAttribute('position').array as Float32Array)); g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); }
      }
      this.vp.setGhost(g);
      this.updateChip(info.x, info.y, `${t >= 0 ? '+' : '−'}${fmtDim('distance', Math.abs(t))} mm`);
    } else if (d.kind === 'edge') {
      const body = this.bodyOf(d.body); const ed = body?.edges[d.index]; if (!body || !ed) return;
      // Sentido do arrasto decide a forma (como no Shapr3D): para fora do corpo arredonda, para dentro chanfra.
      if (!d.out) {
        const c = body.bbox; const cs = this.vp.worldToScreen(new THREE.Vector3((c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2, (c[0][2] + c[1][2]) / 2)); const es = this.vp.worldToScreen(new THREE.Vector3(...ed.mid));
        const len = Math.hypot(es.x - cs.x, es.y - cs.y); d.out = len > 1 ? { x: (es.x - cs.x) / len, y: (es.y - cs.y) / len } : { x: 0, y: -1 };
      }
      const proj = (info.x - info.startX) * d.out.x + (info.y - info.startY) * d.out.y;
      const shape: 'fillet' | 'chamfer' = this.edgeDragKind === 'auto' ? (proj >= 0 ? 'fillet' : 'chamfer') : this.edgeDragKind;
      const r = snapMm((this.edgeDragKind === 'auto' ? Math.abs(proj) : Math.hypot(info.x - info.startX, info.y - info.startY)) * this.vp.worldPerPixel()); d.radius = r; d.shape = shape;
      if (r >= 0.5) {
        if (!d.created) { this.pushUndo(); const f = addFillet(doc, shape, body.id, [{ mid: ed.mid, len: ed.len }], r); d.created = f.id; this.selectedFeature = f.id; }
        else { const f = doc.features.find((x) => x.id === d.created); if (f && (f.type === 'fillet' || f.type === 'chamfer')) { f.radius = r; if (f.type !== shape) { f.type = shape; f.name = f.name.replace(/^(Filete|Chanfro)/, shape === 'fillet' ? 'Filete' : 'Chanfro'); } } }
        this.scheduleLive();
      }
      this.updateChip(info.x, info.y, `${shape === 'fillet' ? 'Filete R' : 'Chanfro '}${fmtDim('distance', Math.max(r, 0))} mm`);
    } else if (d.kind === 'moveInst') {
      const asm = this.asm!; const inst = asm.instances.find((i) => i.id === d.inst); if (!inst) return;
      const p = this.vp.rayOnPlane(d.hit, d.normal, info.x, info.y); if (!p) return;
      const proposed: V3 = [snapMm(d.startPos[0] + p.x - d.hit.x), snapMm(d.startPos[1] + p.y - d.hit.y), snapMm(d.startPos[2] + p.z - d.hit.z)];
      this.applyInstancePos(inst, proposed);
      const overlaps = this.aabbOverlaps(inst.id);
      if (!this.collision) { this.markOverlaps(overlaps); if (!overlaps.length) d.lastGood = proposed; return; }
      if (!overlaps.length) { d.lastGood = proposed; this.vp.setTranslucent(new Set()); return; }
      // Caixas se cruzam: o kernel decide até onde a peça pode ir (com atraso curto; pedidos coalescem).
      d.pending = proposed;
      if (!d.checking) void this.resolveCollision(d, inst);
    } else if (d.kind === 'draw' && !d.started) {
      // Riscar numa face abre um esboço nela e o traço continua como desenho.
      d.started = true;
      this.createSketchOnFace(d.body, d.index);
      this.tool = 'draw';
      const uv0 = this.uvOf({ x: info.startX, y: info.startY }), uv = this.uvOf(info);
      if (uv0 && uv) { this.stroke = [uv0, uv]; this.sk.setStroke(this.plane, this.stroke); this.vp.requestRender(); }
      this.drag = null;
    }
  }

  private viewUp(info: PointerInfo, cancelled: boolean): void {
    const d = this.drag; this.drag = null; this.vp.setGhost(null); this.hideChip();
    const doc = this.doc.current;
    if (d?.kind === 'moveInst') {
      const asm = this.asm!; const inst = asm.instances.find((i) => i.id === d.inst);
      if (!info.moved || cancelled || !inst) { this.undoStack.pop(); if (inst) this.applyInstancePos(inst, d.startPos); if (!cancelled && !info.moved) this.tapView(info); return; }
      d.pending = null;
      if (this.collision && this.aabbOverlaps(inst.id).length) this.applyInstancePos(inst, d.lastGood);
      this.vp.setTranslucent(new Set());
      this.refreshAll();
      void this.settleCollision(inst.id);
      return;
    }
    if (d?.kind === 'box') { d.el?.remove(); if (info.moved && !cancelled) this.finishBox(info); else if (!cancelled) this.tapView(info); return; }
    if (d && (d.kind === 'gmove' || d.kind === 'grot') && (!info.moved || cancelled)) { for (const id of this.selBodies()) this.vp.previewBodyMatrix(id, null); this.updateGizmo(); return; }
    if (!d || !info.moved || cancelled) {
      if (d?.kind === 'edge' && d.created) { this.undo(); }
      if (!cancelled) this.tapView(info);
      return;
    }
    if (d.kind === 'gmove' || d.kind === 'grot') {
      const bodies = this.selBodies(); for (const id of bodies) this.vp.previewBodyMatrix(id, null);
      const isMove = d.kind === 'gmove';
      if (isMove ? Math.abs(d.dist) < 0.3 : Math.abs(d.angle) < 0.5) { this.updateGizmo(); return; }
      const amount = isMove ? d.dist : d.angle; const sgn = Math.sign(amount) || 1;
      const axisDir: V3 = [d.axis.x, d.axis.y, d.axis.z]; const center = d.kind === 'grot' ? d.center : d.origin;
      const apply = (f: Feature, v: number) => { if (f.type !== 'transform') return; if (isMove) f.translate = [axisDir[0] * v, axisDir[1] * v, axisDir[2] * v]; else f.angle = v; };
      const created: Feature[] = [];
      void this.tryFeature(() => {
        for (const body of bodies) { const f = addTransform(doc, body, { translate: [0, 0, 0], axisPoint: [center.x, center.y, center.z], axisDir, angle: 0 }); apply(f, amount); if (!isMove) f.name = f.name.replace(/^Mover/, 'Girar'); created.push(f); }
        return created[created.length - 1] ?? null;
      }, (f) => {
        this.selectedFeature = f.id; this.selectBodies(bodies);
        this.showChip(info.x, info.y, `${isMove ? `${fmtDim('distance', Math.abs(amount))} mm` : `${Math.abs(amount)}°`} ✎`, () => this.valuePopover(info.x, info.y, Math.abs(amount), isMove ? 'mm' : '°', (v) => { void this.tryFeature(() => { for (const c of created) apply(c, sgn * v); return f; }); }));
      });
      return;
    }
    if (d.kind === 'extrude') {
      const t = d.depth; if (Math.abs(t) < 0.3) return;
      const faceBody = d.plane.kind === 'face' && d.plane.body && bodyIds(doc).includes(d.plane.body) ? d.plane.body : null;
      const op: ExtrudeOp = faceBody ? (t > 0 ? 'add' : 'cut') : 'new';
      void this.tryFeature(() => addExtrude(doc, d.sketch, Math.abs(t), { op, target: faceBody ?? undefined, flip: t < 0, profilePoint: d.profilePoint }), (f) => {
        this.selectedFeature = f.id; this.sel3d = emptySel3D(); this.sel3d.body = bodyOfFeature(f); this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel();
        this.showChip(info.x, info.y, `${fmtDim('distance', Math.abs(t))} mm ✎`, () => this.valuePopover(info.x, info.y, Math.abs(t), 'mm', (v) => { void this.tryFeature(() => { (f as ExtrudeFeature).depth = v; return f; }); }));
      });
    } else if (d.kind === 'pull') {
      const t = d.dist; if (Math.abs(t) < 0.3) return;
      const ref = { center: d.fd.center, normal: d.fd.normal!, area: d.fd.area };
      const more = (this.sel3d.faces ?? []).filter((f) => f.body === d.body && f.index !== d.index).map((f) => this.faceRefOf(f)).filter((x): x is FaceRef => !!x);
      void this.tryFeature(() => addPushPull(doc, d.body, ref, t, more), (f) => {
        this.selectedFeature = f.id; this.sel3d = emptySel3D(); this.sel3d.body = d.body; this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel();
        this.showChip(info.x, info.y, `${t >= 0 ? '+' : '−'}${fmtDim('distance', Math.abs(t))} mm ✎`, () => this.valuePopover(info.x, info.y, Math.abs(t), 'mm', (v) => { void this.tryFeature(() => { if (f.type === 'pushpull') f.distance = Math.sign(t) * v; return f; }); }));
      });
    } else if (d.kind === 'edge') {
      if (!d.created) { this.tapView(info); return; }
      if (d.radius < 0.5) { this.undo(); return; }
      if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = 0; }
      this.refreshAll(false);
      void this.rebuild().then((r) => {
        const err = r?.errors.find((e) => e.feature === d.created);
        if (err) { this.undo(); this.toast(`Não deu: ${err.message}.`, 'err'); return; }
        const f = doc.features.find((x) => x.id === d.created); if (!f || (f.type !== 'fillet' && f.type !== 'chamfer')) return;
        this.showChip(info.x, info.y, `${f.type === 'fillet' ? 'R' : ''}${fmtDim('distance', f.radius)} mm ✎`, () => this.menu(info.x, info.y, [
          { label: 'Editar valor…', action: () => this.valuePopover(info.x, info.y, f.radius, 'mm', (v) => { void this.tryFeature(() => { f.radius = v; return f; }); }) },
          { label: f.type === 'fillet' ? 'Trocar para chanfro' : 'Trocar para filete', action: () => { void this.tryFeature(() => { f.type = f.type === 'fillet' ? 'chamfer' : 'fillet'; f.name = f.name.replace(/^(Filete|Chanfro)/, f.type === 'fillet' ? 'Filete' : 'Chanfro'); return f; }); } },
          { label: 'Apagar', action: () => this.deleteFeature(f) },
        ]));
      });
    }
  }

  // ---------- Montagem: arrastar peças e colisão ----------
  private applyInstancePos(inst: { id: Id; pos: V3 }, pos: V3): void {
    inst.pos = [...pos] as V3; const asm = this.asm!;
    this.asmTransforms = computeTransforms(asm);
    const map = new Map<Id, number[]>();
    for (const i of asm.instances) { const m = this.asmTransforms.get(i.id); const c = this.asmCache.get(i.part); if (!m || !c) continue; for (const b of c.bodies) map.set(`${i.id}/${b.id}`, m); }
    this.vp.updateMatrices(map);
  }
  /** Caixa envolvente no mundo de uma instância. */
  private instanceAabb(instId: Id): [V3, V3] | null {
    const asm = this.asm!; const inst = asm.instances.find((i) => i.id === instId); const c = inst && this.asmCache.get(inst.part); const m = this.asmTransforms.get(instId); if (!inst || !c || !m) return null;
    const mn: V3 = [Infinity, Infinity, Infinity], mx: V3 = [-Infinity, -Infinity, -Infinity];
    for (const b of c.bodies) for (const x of [b.bbox[0][0], b.bbox[1][0]]) for (const y of [b.bbox[0][1], b.bbox[1][1]]) for (const z of [b.bbox[0][2], b.bbox[1][2]]) { const q = applyPoint(m, [x, y, z]); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q[k]); mx[k] = Math.max(mx[k], q[k]); } }
    return [mn, mx];
  }
  /** Instâncias cujas caixas cruzam a da instância dada (teste rápido, antes do kernel). */
  private aabbOverlaps(instId: Id): Id[] {
    const a = this.instanceAabb(instId); if (!a) return [];
    const out: Id[] = []; const eps = 0.01;
    for (const i of this.asm!.instances) { if (i.id === instId) continue; const b = this.instanceAabb(i.id); if (!b) continue; if (a[0][0] < b[1][0] - eps && a[1][0] > b[0][0] + eps && a[0][1] < b[1][1] - eps && a[1][1] > b[0][1] + eps && a[0][2] < b[1][2] - eps && a[1][2] > b[0][2] + eps) out.push(i.id); }
    return out;
  }
  private markOverlaps(instIds: Id[], colliding = false): void {
    const ids = new Set<Id>(); const asm = this.asm!;
    for (const id of instIds) { const inst = asm.instances.find((i) => i.id === id); const c = inst && this.asmCache.get(inst.part); if (!c) continue; for (const b of c.bodies) ids.add(`${id}/${b.id}`); }
    this.vp.setTranslucent(ids, colliding);
  }
  /** Passos da posição `from` até `to` da instância; devolve o índice do primeiro passo em que o kernel acusa interpenetração (−1 se nenhum). */
  private async firstCollidingStep(instId: Id, from: V3, to: V3, n: number): Promise<number> {
    const asm = this.asm!; const idx = asm.instances.findIndex((i) => i.id === instId); if (idx < 0) return -1;
    const inst = asm.instances[idx]; const saved = [...inst.pos] as V3; const steps: { part: Id; matrix: number[] }[][] = [];
    for (let k = 0; k < n; k++) { const t = k / (n - 1); inst.pos = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t]; const T = computeTransforms(asm); steps.push(asm.instances.map((i) => ({ part: i.part, matrix: T.get(i.id) ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }))); }
    inst.pos = saved;
    const hits = await this.kernel.interference(asm.parts.map((p) => ({ id: p.id, doc: p.doc })), steps);
    const mine = hits.filter((h) => h.a === idx || h.b === idx).map((h) => h.step);
    return mine.length ? Math.min(...mine) : -1;
  }
  private async resolveCollision(d: Extract<ViewDrag, { kind: 'moveInst' }>, inst: { id: Id; pos: V3 }): Promise<void> {
    d.checking = true;
    try {
      while (d.pending && this.drag === d) {
        const target = d.pending; d.pending = null;
        const first = await this.firstCollidingStep(inst.id, d.lastGood, target, 7);
        if (this.drag !== d) break;
        if (first < 0) { d.lastGood = target; if (!d.pending) this.applyInstancePos(inst, target); this.vp.setTranslucent(new Set()); }
        else {
          const k = Math.max(0, first - 1); const t = k / 6;
          const stop: V3 = [d.lastGood[0] + (target[0] - d.lastGood[0]) * t, d.lastGood[1] + (target[1] - d.lastGood[1]) * t, d.lastGood[2] + (target[2] - d.lastGood[2]) * t];
          d.lastGood = stop; this.applyInstancePos(inst, stop); this.markOverlaps(this.aabbOverlaps(inst.id), true);
        }
      }
    } catch (e) { this.toast(`Colisão: ${(e as Error).message}`, 'err'); }
    finally { d.checking = false; }
  }
  /** Depois de soltar: confere a pose final no kernel; com colisão ligada, recua se houver interpenetração; desligada, marca translúcido. */
  private async settleCollision(instId: Id): Promise<void> {
    const asm = this.asm; if (!asm || this.kernel.state !== 'ready' || asm.instances.length < 2) return;
    const idx = asm.instances.findIndex((i) => i.id === instId); if (idx < 0) return;
    const T = computeTransforms(asm);
    const hits = await this.kernel.interference(asm.parts.map((p) => ({ id: p.id, doc: p.doc })), [asm.instances.map((i) => ({ part: i.part, matrix: T.get(i.id) ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }))]);
    const mine = hits.filter((h) => h.a === idx || h.b === idx);
    if (!mine.length) { this.vp.setTranslucent(new Set()); return; }
    const others = mine.map((h) => asm.instances[h.a === idx ? h.b : h.a]?.id).filter((x): x is Id => !!x);
    if (this.collision) this.toast('As peças se tocam com sobreposição; com a colisão ligada, afaste um pouco ou desligue a colisão para atravessar.', 'err');
    this.markOverlaps([instId, ...others]);
  }

  /** Recalcula com atraso curto durante um arrasto (o kernel coalesce os pedidos). */
  private scheduleLive(): void {
    if (this.liveTimer) return;
    this.liveTimer = window.setTimeout(() => { this.liveTimer = 0; this.refreshAll(false); void this.rebuild(); }, 120);
  }

  private showChip(x: number, y: number, text: string, onTap?: () => void): void {
    this.hideChip();
    const c = el('div', `chip ${onTap ? 'tappable' : ''}`); c.textContent = text;
    c.style.left = `${Math.min(Math.max(16, x + 18), this.vp.width - 60)}px`; c.style.top = `${Math.max(16, y - 28)}px`;
    if (onTap) c.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.hideChip(); onTap(); });
    this.overlay.append(c); this.chipEl = c;
    if (onTap) this.chipTimer = window.setTimeout(() => this.hideChip(), 7000);
  }
  private updateChip(x: number, y: number, text: string): void {
    if (!this.chipEl || this.chipEl.classList.contains('tappable')) this.showChip(x, y, text);
    else { this.chipEl.textContent = text; this.chipEl.style.left = `${Math.min(Math.max(16, x + 18), this.vp.width - 60)}px`; this.chipEl.style.top = `${Math.max(16, y - 28)}px`; }
  }
  private hideChip(): void { if (this.chipTimer) { clearTimeout(this.chipTimer); this.chipTimer = 0; } this.chipEl?.remove(); this.chipEl = null; }

  private hover(ev: PointerEvent): void {
    if (this.mode === 'sketch') {
      if (this.tool === 'project') { const { x, y } = this.local(ev); this.vp.setHover(this.projectHit(x, y, ev.pointerType)); return; }
      if (this.tool !== 'trim' || !this.sketch || this.trimRun) return;
      const uv = this.uvOf(this.local(ev)); if (uv) this.trimHint(this.sketch, uv, this.tolMm(ev.pointerType));
      return;
    }
    if (this.mode !== 'view' || ev.pointerType === 'touch') return;
    const { x, y } = this.local(ev);
    let h: Hover = null;
    if (!this.isAssembly) {
      const faceHit = this.vp.pickFace(x, y);
      let regionHit = this.vp.pickRegion(x, y); if (regionHit && faceHit && regionHit.distance > faceHit.distance + 0.5) regionHit = null;
      const edgeHit = regionHit || this.selFilter === 'faces' || this.selFilter === 'bodies' ? null : this.vp.pickEdge(x, y, ev.pointerType === 'pen' ? 12 : 9, faceHit);
      if (regionHit) h = { kind: 'region', sketch: regionHit.sketch, index: regionHit.index };
      else if (edgeHit) h = { kind: 'edge', body: edgeHit.body, index: edgeHit.index };
      else if (faceHit && faceHit.index >= 0) h = { kind: 'face', body: faceHit.body, index: faceHit.index };
    }
    this.vp.setHover(h);
    const id = h ? null : this.vp.pickPlane(x, y);
    if (id !== this.hoverPlane) { this.hoverPlane = id; this.vp.highlightPlane(id); }
  }

  /** Toque simples em modo vista: aresta, face, corpo de prévia, plano ou vazio. */
  private tapView(info: PointerInfo): void {
    if (this.mode !== 'view') return;
    const faceHit = this.vp.pickFace(info.x, info.y);
    if (this.measure.on && !this.isAssembly) {
      const eh = this.vp.pickEdge(info.x, info.y, info.type === 'touch' ? 18 : 12, faceHit);
      if (eh) { this.measureTap({ kind: 'edge', body: eh.body, index: eh.index }, info.x, info.y); return; }
      if (faceHit && faceHit.index >= 0) { this.measureTap({ kind: 'face', body: faceHit.body, index: faceHit.index }, info.x, info.y); return; }
      return;
    }
    if (this.isAssembly) {
      if (faceHit && faceHit.index >= 0) { this.tapAssemblyFace(faceHit.body, faceHit.index, info.x, info.y); return; }
      if (this.jointFlow) return;
      if (this.selectedInstance || this.sel3d.body) { this.selectedInstance = null; this.clearSel3d(); }
      return;
    }
    if (this.replaceFlow) { if (faceHit && faceHit.index >= 0) this.finishReplaceFace(faceHit.body, faceHit.index); else this.cancelReplaceFace(); return; }
    // Duplo toque: numa face seleciona o corpo inteiro (gizmo); no vazio enquadra tudo.
    const now = performance.now(); const dbl = !this.xray && now - this.lastTap.t < 380 && Math.hypot(info.x - this.lastTap.x, info.y - this.lastTap.y) < 28;
    this.lastTap = { t: dbl ? 0 : now, x: info.x, y: info.y };
    if (dbl) { if (faceHit && faceHit.index >= 0) { this.selectBody(faceHit.body); this.toast('Corpo inteiro: arraste as setas para mover, os anéis para girar.'); } else if (!faceHit) this.vp.fitAll(); return; }
    const filter = this.selFilter;
    if (this.xray && filter !== 'edges') {
      // Ver através: lista tudo o que o raio atravessa; toques repetidos no mesmo lugar avançam para o item de trás.
      const through = this.vp.pickFacesThrough(info.x, info.y).filter((h) => h.index >= 0);
      if (through.length) {
        const same = Math.hypot(info.x - this.cycle.x, info.y - this.cycle.y) < 28;
        const i = same ? (this.cycle.i + 1) % through.length : 0; this.cycle = { x: info.x, y: info.y, i };
        const h = through[i];
        if (filter === 'bodies') this.selectBody(h.body); else this.selectFace(h.body, h.index, false);
        if (through.length > 1) this.toast(`${i + 1} de ${through.length} nesta linha: ${faceTypeName(this.bodyOf(h.body)?.faces[h.index]?.type ?? 'other')} de ${bodyName(this.doc.current, h.body)}. Toque de novo para a próxima.`);
        return;
      }
    }
    const edgeHit = filter === 'faces' || filter === 'bodies' ? null : this.vp.pickEdge(info.x, info.y, info.type === 'touch' ? 18 : info.type === 'pen' ? 12 : 9, faceHit, this.xray);
    if (edgeHit) { this.selectEdge(edgeHit.body, edgeHit.index); return; }
    let regionHit = this.vp.pickRegion(info.x, info.y); if (regionHit && faceHit && regionHit.distance > faceHit.distance + 0.5) regionHit = null;
    if (regionHit) { this.selectRegion(regionHit.sketch, regionHit.index); return; }
    if (faceHit && faceHit.index >= 0 && filter === 'bodies') { const ids = this.selBodies(); this.selectBodies(ids.includes(faceHit.body) ? ids.filter((b) => b !== faceHit.body) : [...ids, faceHit.body]); return; }
    if (faceHit && faceHit.index >= 0 && filter === 'edges') return;
    if (faceHit) {
      if (faceHit.index < 0) {
        this.selectedFeature = null; this.selRegion = null; this.vp.setRegionSelected(null);
        this.sel3d = { body: faceHit.body, face: null, faces: [], edges: [] };
        this.toast(this.kernel.state === 'loading' ? 'O kernel 3D ainda está carregando (50 MB na primeira vez). Faces e arestas ficam disponíveis quando terminar.' : 'Kernel 3D indisponível neste navegador: só a prévia.', 'err');
        this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar();
      } else this.selectFace(faceHit.body, faceHit.index);
      return;
    }
    const plane = this.vp.pickPlane(info.x, info.y);
    if (plane) { const p = getPlane(this.doc.current, plane); this.menu(info.x + 8, info.y + 8, [{ label: `Novo esboço em ${p.name}`, action: () => this.createSketchOn(plane) }]); return; }
    if (this.selectedFeature || this.sel3d.body || this.sel3d.face || this.sel3d.edges.length || this.selRegion) { this.selectedFeature = null; this.clearSel3d(); }
  }

  // ---------- Toque longo: escolher entre itens sobrepostos ----------
  private startPress(info: PointerInfo): void {
    this.cancelPress(); if (this.isAssembly || this.measure.on) return;
    this.pressTimer = window.setTimeout(() => {
      this.pressTimer = 0; if (info.moved || !this.pointers.has(info.id)) return;
      if (this.selectThrough(info.x, info.y)) { info.handled = true; this.drag = null; this.vp.setGhost(null); this.hideChip(); }
    }, 520);
  }
  private cancelPress(): void { if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = 0; } }
  /** Lista do que está sob a caneta (aresta, face, corpo, região, plano) para escolher com precisão. Devolve false se não há nada. */
  private selectThrough(x: number, y: number): boolean {
    const doc = this.doc.current; const faceHit = this.vp.pickFace(x, y);
    const items: { label: string; action: () => void }[] = [];
    const edgeVisible = this.vp.pickEdge(x, y, 14, faceHit); const edgeAny = this.vp.pickEdge(x, y, 14, faceHit, true);
    if (edgeVisible) items.push({ label: `Aresta de ${bodyName(doc, edgeVisible.body)}`, action: () => this.selectEdge(edgeVisible.body, edgeVisible.index, false) });
    if (edgeAny && (!edgeVisible || edgeAny.body !== edgeVisible.body || edgeAny.index !== edgeVisible.index)) items.push({ label: `Aresta escondida de ${bodyName(doc, edgeAny.body)}`, action: () => this.selectEdge(edgeAny.body, edgeAny.index, false) });
    // Tudo o que o raio atravessa, da frente para trás: faces e, uma vez cada, o corpo inteiro.
    const through = this.vp.pickFacesThrough(x, y).filter((h) => h.index >= 0).slice(0, 8); const bodiesSeen = new Set<Id>();
    through.forEach((h, i) => {
      const f = this.bodyOf(h.body)?.faces[h.index]; const depth = i === 0 ? '' : ` · ${fmtDim('distance', h.distance - through[0].distance)} mm atrás`;
      items.push({ label: `Face ${faceTypeName(f?.type ?? 'other')} de ${bodyName(doc, h.body)}${depth}`, action: () => this.selectFace(h.body, h.index, false) });
      if (!bodiesSeen.has(h.body)) { bodiesSeen.add(h.body); items.push({ label: `${bodyName(doc, h.body)} inteiro (mover/girar)`, action: () => this.selectBody(h.body) }); }
    });
    for (const rh of this.vp.pickRegionsThrough(x, y).slice(0, 4)) { const sk = getSketch(doc, rh.sketch); items.push({ label: `Região de ${sk.name}`, action: () => this.selectRegion(rh.sketch, rh.index) }, { label: `Editar ${sk.name}`, action: () => this.enterSketch(sk.id) }); }
    const plane = this.vp.pickPlane(x, y);
    if (plane) { const p = getPlane(doc, plane); items.push({ label: `Novo esboço em ${p.name}`, action: () => this.createSketchOn(plane) }); }
    if (!items.length) return false;
    items.push({ label: this.xray ? 'Desligar Ver através' : 'Ver através (translúcido)', action: () => this.toggleXray() });
    this.menu(x + 10, y + 10, items); return true;
  }

  // ---------- Projetar arestas ----------
  /** Aresta (de preferência) ou face de corpo sob o cursor, para projetar. */
  private projectHit(x: number, y: number, pointerType: string): Hover {
    const faceHit = this.vp.pickFace(x, y);
    const edgeHit = this.vp.pickEdge(x, y, pointerType === 'touch' ? 18 : 12, faceHit);
    if (edgeHit) return { kind: 'edge', body: edgeHit.body, index: edgeHit.index };
    if (faceHit && faceHit.index >= 0) return { kind: 'face', body: faceHit.body, index: faceHit.index };
    return null;
  }
  /** Projeta a aresta ou todas as arestas da face tocada no esboço ativo. */
  private projectAt(x: number, y: number, pointerType: string): void {
    const s = this.sketch, plane = this.plane; if (!s || !plane) return;
    const h = this.projectHit(x, y, pointerType);
    if (!h || h.kind === 'region') { this.toast('Toque numa aresta ou numa face de um corpo para projetar.'); return; }
    const data = this.vp.bodyDataOf(h.body); if (!data) return;
    const idx = h.kind === 'edge' ? [h.index] : data.faces[h.index]?.edges;
    if (!idx || !idx.length) { this.toast('Esta face não tem contorno para projetar.'); return; }
    const mat = this.vp.bodyMatrixOf(h.body); const v = new THREE.Vector3();
    const polys = idx.map((i) => { const pts = data.edges[i].points; const out: V3[] = []; for (let k = 0; k + 2 < pts.length; k += 3) { v.set(pts[k], pts[k + 1], pts[k + 2]).applyMatrix4(mat); out.push([v.x, v.y, v.z]); } return out; });
    this.pushUndo();
    const made = projectPolylines(s, plane, polys, { construction: this.constructionMode });
    if (!made.length) { this.undoStack.pop(); this.toast(h.kind === 'edge' ? 'Esta aresta está de ponta para o plano (ou já foi projetada): nada a desenhar.' : 'Nada novo para projetar desta face.'); return; }
    this.solve(); this.refreshAll(false);
    this.toast(made.length === 1 ? 'Aresta projetada no esboço.' : `${made.length} arestas projetadas no esboço.`);
  }

  // ---------- Aparar ----------
  /** Trecho que sumiria ao aparar em `uv` (entidade mais próxima que dá para aparar). */
  private trimTarget(s: Sketch, uv: Vec2, tol: number): TrimSegment | null {
    let best: { e: Trimmable; d: number } | null = null;
    for (const e of s.entities) { if (!isTrimmable(e)) continue; const d = this.entityDistance(uv, e, s); if (d < tol && (!best || d < best.d)) best = { e, d }; }
    return best ? trimSegmentAt(s, best.e, uv) : null;
  }
  /** Realça o trecho sob a caneta, com as marcas de onde vai cortar. */
  private trimHint(s: Sketch, uv: Vec2, tol: number): void {
    const seg = this.trimTarget(s, uv, tol);
    const poly = seg ? (seg.kind === 'all' ? M.sampleEntity(s, seg.entity) : seg.poly) : null;
    const ends = seg?.kind === 'segment' ? [seg.lo?.q, seg.hi?.q].filter((q): q is Vec2 => !!q) : [];
    this.sk.setHint(this.plane, poly, ends, this.vp.mmPerPixel()); this.vp.requestRender();
  }
  /** Apara o trecho sob a caneta (toque ou passagem da varredura). */
  private trimUnder(s: Sketch, uv: Vec2, tol: number): void {
    const seg = this.trimTarget(s, uv, tol); if (!seg) return;
    applyTrim(s, seg); if (this.trimRun) this.trimRun.count += 1;
    this.sk.setHint(null, null, [], 1); this.solve(); this.refreshSketch(); this.renderStatus();
  }

  // ---------- Ferramentas de esboço ----------
  private uvOf(info: { x: number; y: number }): Vec2 | null { const p = this.plane; return p ? this.vp.screenToPlane(info.x, info.y, p) : null; }

  private toolDown(info: PointerInfo): void {
    const s = this.sketch; const uv = this.uvOf(info); if (!s || !uv) return;
    const tol = this.tolMm(info.type);
    switch (this.tool) {
      case 'draw': {
        // Caneta sobre algo já selecionado: arrasta (ponto, linha inteira, raio ou centro) em vez de desenhar.
        const hit = this.hitTest(uv, tol, s);
        if (hit && (this.sel.points.has(hit.id) || this.sel.entities.has(hit.id))) {
          this.pushUndo();
          if (hit.kind === 'point') { this.dragPoint = hit.id; break; }
          const e = M.getEntity(s, hit.id);
          if (e.type === 'line') { const a = M.getPoint(s, e.a), b = M.getPoint(s, e.b); this.sketchDrag = { kind: 'line', id: e.id, a: e.a, b: e.b, a0: v2(a.x, a.y), b0: v2(b.x, b.y), start: uv }; }
          else if (M.isRound(e) && Math.abs(dist(uv, M.getPoint(s, e.center)) - e.r) < tol && dist(uv, M.getPoint(s, e.center)) > tol) this.sketchDrag = { kind: 'radius', id: e.id, center: e.center };
          else this.sketchDrag = { kind: 'move', points: M.entityPoints(e).map((pid) => { const q = M.getPoint(s, pid); return { id: pid, x0: q.x, y0: q.y }; }), start: uv };
          break;
        }
        this.stroke = [this.showSnap(s, uv, tol)]; this.sk.setStroke(this.plane, this.stroke); this.vp.requestRender(); break;
      }
      case 'line': case 'rect': case 'circle': case 'ellipse': case 'polygon': case 'slot': {
        this.pushUndo(); this.previewSketchBackup = M.cloneSketch(s);
        this.toolStart = { uv: this.showSnap(s, uv, tol) }; break;
      }
      case 'trim': { this.pushUndo(); this.trimRun = { count: 0 }; this.trimHint(s, uv, tol); break; }
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
      case 'draw': {
        if (this.dragPoint) { if (info.moved) { this.solve({ drag: { point: this.dragPoint, x: uv.x, y: uv.y } }); this.refreshSketch(); this.renderStatus(); } break; }
        const sd = this.sketchDrag;
        if (sd) {
          if (!info.moved) break;
          if (sd.kind === 'line') { const du = uv.x - sd.start.x, dv = uv.y - sd.start.y; this.solve({ drags: [{ point: sd.a, x: sd.a0.x + du, y: sd.a0.y + dv }, { point: sd.b, x: sd.b0.x + du, y: sd.b0.y + dv }] }); }
          else if (sd.kind === 'radius') { const c = M.getPoint(s, sd.center); this.solve({ dragRadius: { entity: sd.id, r: dist(uv, c) } }); }
          else { const du = uv.x - sd.start.x, dv = uv.y - sd.start.y; this.solve({ drags: sd.points.map((q) => ({ point: q.id, x: q.x0 + du, y: q.y0 + dv })) }); }
          this.refreshSketch(); this.renderStatus(); break;
        }
        if (this.stroke.length) { this.stroke.push(uv); this.sk.setStroke(this.plane, this.stroke); this.showSnap(s, uv, this.tolMm(info.type)); this.vp.requestRender(); }
        break;
      }
      case 'line': case 'rect': case 'circle': case 'ellipse': case 'polygon': case 'slot': {
        if (!this.toolStart || !this.previewSketchBackup) return;
        Object.assign(s, M.cloneSketch(this.previewSketchBackup));
        const snapped = this.showSnap(s, uv, this.tolMm(info.type));
        this.buildShape(s, this.toolStart.uv, snapped, this.tolMm(info.type), true);
        this.refreshSketch(); break;
      }
      case 'select': {
        if (this.dragPoint && info.moved) { this.solve({ drag: { point: this.dragPoint, x: uv.x, y: uv.y } }); this.refreshSketch(); this.renderStatus(); }
        break;
      }
      case 'trim': { const tol = this.tolMm(info.type); if (info.moved && this.trimRun) this.trimUnder(s, uv, tol); else this.trimHint(s, uv, tol); break; }
      default: break;
    }
  }

  private toolUp(info: PointerInfo, cancelled: boolean): void {
    const s = this.sketch; const uv = this.uvOf(info) ?? v2(0, 0); if (!s) return;
    const tol = this.tolMm(info.type);
    switch (this.tool) {
      case 'draw': {
        if (this.dragPoint || this.sketchDrag) {
          if (!info.moved) this.undoStack.pop();
          this.dragPoint = null; this.sketchDrag = null; this.solve(); this.refreshAll(false); return;
        }
        const pts = this.stroke; this.stroke = []; this.sk.setStroke(null, []); this.sk.setSnap(null, null, 1);
        if (cancelled) { this.vp.requestRender(); return; }
        // A ponta final do traço gruda no encaixe mais próximo, para o desenho fechar exatamente no canto.
        if (pts.length >= 2) { const end = this.findSnap(s, pts[pts.length - 1], tol); if (end) pts[pts.length - 1] = end.uv; }
        if (!info.moved || pts.length < 2) {
          // Toque: seleciona o que estiver embaixo e mostra a medida para editar; em vazio, limpa.
          const hit = this.hitTest(uv, tol, s);
          if (this.mirrorPending) { this.mirrorPending = false; if (hit?.kind === 'entity') this.mirrorSketchAbout(hit.id); else this.toast('Espelho cancelado.'); this.renderSidePanel(); return; }
          if (!hit) { this.sel = emptySelection(); this.refreshAll(false); return; }
          this.sel = emptySelection(); if (hit.kind === 'point') this.sel.points.add(hit.id); else this.sel.entities.add(hit.id);
          this.refreshAll(false);
          const e = hit.kind === 'entity' ? M.findEntity(s, hit.id) : undefined;
          if (e) this.quickDimension(e, uv);
          return;
        }
        const prims = recognizeStroke(pts, { tol: Math.max(tol * 0.45, this.vp.mmPerPixel() * 3.5), minRadius: tol });
        if (!prims.length) { this.toast('Traço curto demais.'); this.vp.requestRender(); return; }
        this.insertPrimitives(prims, tol);
        break;
      }
      case 'line': case 'rect': case 'circle': case 'ellipse': case 'polygon': case 'slot': {
        if (!this.toolStart || !this.previewSketchBackup) return;
        Object.assign(s, M.cloneSketch(this.previewSketchBackup)); this.sk.setSnap(null, null, 1);
        const before = s.entities.length;
        if (!cancelled && info.moved) { const end = this.findSnap(s, uv, tol); this.buildShape(s, this.toolStart.uv, end ? end.uv : uv, tol, false); this.solve(); }
        else this.undoStack.pop();
        this.toolStart = null; this.previewSketchBackup = null; this.refreshAll(false);
        // Elipse recém-criada: o eixo menor pode ser digitado na hora.
        const ell = s.entities.slice(before).find((e): e is M.EllipseEntity => e.type === 'ellipse');
        if (ell) this.showChip(info.x, info.y, `menor ${fmtDim('distance', ell.ry * 2)} mm ✎`, () => this.ellipseDialog(ell));
        break;
      }
      case 'spline': {
        if (cancelled || info.moved) break;
        this.addSplinePoint(s, uv, tol);
        break;
      }
      case 'select': {
        if (this.dragPoint) { if (!info.moved) this.undoStack.pop(); this.dragPoint = null; this.solve(); this.refreshAll(false); return; }
        if (!info.moved) this.tapSelect(uv, tol, s);
        break;
      }
      case 'project': { if (!cancelled && !info.moved) this.projectAt(info.x, info.y, info.type); break; }
      case 'trim': {
        if (!cancelled && !info.moved) this.trimUnder(s, uv, tol);
        const n = this.trimRun?.count ?? 0; this.trimRun = null; this.sk.setHint(null, null, [], 1);
        if (!n) { this.undoStack.pop(); if (!cancelled) this.toast('Nada para aparar aqui: toque em cima de uma linha, círculo ou arco.'); }
        this.solve(); this.refreshAll(false);
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
    const before = s.entities.length;
    this.buildShapeInner(s, a, b, tol, preview, snapOrAdd);
    if (preview) return;
    if (this.constructionMode) for (const e of s.entities.slice(before)) e.construction = true;
    else this.autoDimensions(s, s.entities.slice(before));
  }

  /** Valor "redondo" para a cota automática: meio milímetro acima de 10 mm, décimo abaixo. */
  private static niceMm(v: number): number { return v >= 10 ? Math.round(v * 2) / 2 : Math.round(v * 10) / 10; }

  /** Cotas automáticas das formas prontas (retângulo, círculo, rasgo, polígono), para digitar os milímetros em seguida. */
  private autoDimensions(s: Sketch, created: Entity[]): void {
    const added: Id[] = [];
    const nice = App.niceMm;
    const dimOf = (kind: DimensionKind, refs: Id[], value: number, offset: Vec2) => { added.push(M.addDimension(s, kind, refs, nice(value), offset).id); };
    if (this.tool === 'rect') {
      const lines = created.filter((e): e is M.LineEntity => e.type === 'line'); if (lines.length !== 4) return;
      const [l1, l2] = lines; const a = M.getPoint(s, l1.a), b = M.getPoint(s, l1.b), c = M.getPoint(s, l2.b);
      dimOf('hdistance', [l1.id], Math.abs(b.x - a.x), v2(0, a.y < c.y ? -8 : 8)); dimOf('vdistance', [l2.id], Math.abs(c.y - b.y), v2(b.x > a.x ? 8 : -8, 0));
    } else if (this.tool === 'circle') {
      const c = created.find((e): e is M.CircleEntity => e.type === 'circle'); if (!c) return; dimOf('diameter', [c.id], c.r * 2, v2(0.7, 0.7));
    } else if (this.tool === 'slot') {
      const arcs = created.filter((e): e is M.ArcEntity => e.type === 'arc'); if (arcs.length !== 2) return;
      const ca = M.getPoint(s, arcs[0].center), cb = M.getPoint(s, arcs[1].center);
      const d = norm(sub(cb, ca)); const n = perp(d);
      dimOf('distance', [arcs[0].center, arcs[1].center], dist(ca, cb), scale(n, -(arcs[0].r + 8)));
      dimOf('diameter', [arcs[0].id], arcs[0].r * 2, v2(-d.x, -d.y));
    } else if (this.tool === 'polygon') {
      const c = created.find((e): e is M.CircleEntity => e.type === 'circle' && !!e.construction) ?? s.entities.find((e): e is M.CircleEntity => e.type === 'circle' && !!e.construction && s.constraints.some((k) => k.kind === 'pointOnCircle' && k.refs[1] === e.id));
      if (c) dimOf('diameter', [c.id], c.r * 2, v2(0.7, 0.7));
    }
    if (!added.length) return;
    const r = this.solve();
    if (!r?.converged) { for (const id of added) M.removeDimension(s, id); this.solve(); }
  }

  private buildShapeInner(s: Sketch, a: Vec2, b: Vec2, tol: number, preview: boolean, snapOrAdd: (p: Vec2, exclude: Set<Id>) => Id): void {
    void tol;
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
    } else if (this.tool === 'ellipse') {
      // Elipse do centro: o arrasto dá o semieixo maior e a inclinação; o menor nasce com 60% e se digita depois.
      const rx = dist(a, b); if (rx < tol * 0.5) return;
      const c = preview ? M.addPoint(s, a.x, a.y).id : this.snapPoint(s, a, tol).id;
      let ang = angleOf(sub(b, a)); const deg = Math.abs(((ang * 180) / Math.PI) % 180); const dev = Math.min(deg, 180 - deg);
      if (!preview && dev < H_V_SNAP_DEG) ang = ang > Math.PI / 2 || ang < -Math.PI / 2 ? Math.PI : 0; else if (!preview && Math.abs(dev - 90) < H_V_SNAP_DEG) ang = ang > 0 ? Math.PI / 2 : -Math.PI / 2;
      M.addEllipse(s, c, rx, Math.max(tol, rx * 0.6), ang);
    } else if (this.tool === 'polygon') {
      // Polígono regular: vértices numa circunferência de construção, lados iguais.
      const r = dist(a, b); if (r < tol * 0.5) return; const n = this.polygonSides; const a0 = angleOf(sub(b, a));
      const pts: Id[] = []; for (let i = 0; i < n; i++) { const t = a0 + (i / n) * TAU; pts.push(M.addPoint(s, a.x + r * Math.cos(t), a.y + r * Math.sin(t)).id); }
      const lines: Id[] = []; for (let i = 0; i < n; i++) lines.push(M.addLine(s, pts[i], pts[(i + 1) % n]).id);
      if (!preview) {
        const c = this.snapPoint(s, a, tol).id; const circ = M.addCircle(s, c, r); circ.construction = true;
        for (const pid of pts) M.addConstraint(s, 'pointOnCircle', [pid, circ.id]);
        for (let i = 1; i < n; i++) M.addConstraint(s, 'equal', [lines[0], lines[i]]);
      }
    } else if (this.tool === 'slot') {
      // Rasgo (oblongo) entre dois centros; largura = um terço do comprimento, ajustável pela cota do raio.
      const L = dist(a, b); if (L < tol) return; const d = norm(sub(b, a)); const nrm = perp(d); const r = Math.max(tol, L / 6);
      const p1 = M.addPoint(s, a.x + nrm.x * r, a.y + nrm.y * r), p2 = M.addPoint(s, b.x + nrm.x * r, b.y + nrm.y * r), p3 = M.addPoint(s, b.x - nrm.x * r, b.y - nrm.y * r), p4 = M.addPoint(s, a.x - nrm.x * r, a.y - nrm.y * r);
      const ca = preview ? M.addPoint(s, a.x, a.y) : M.getPoint(s, this.snapPoint(s, a, tol).id), cb = preview ? M.addPoint(s, b.x, b.y) : M.getPoint(s, this.snapPoint(s, b, tol).id);
      const l1 = M.addLine(s, p1.id, p2.id), l2 = M.addLine(s, p3.id, p4.id);
      const arcB = M.addArc(s, cb.id, p3.id, p2.id, r), arcA = M.addArc(s, ca.id, p1.id, p4.id, r);
      if (!preview) {
        for (const [l, arc] of [[l1, arcA], [l1, arcB], [l2, arcA], [l2, arcB]] as const) M.addConstraint(s, 'tangent', [l.id, arc.id]);
        const ang = Math.abs(((angleOf(d) * 180) / Math.PI) % 180); const dev = Math.min(ang, 180 - ang);
        if (dev < H_V_SNAP_DEG) { M.addConstraint(s, 'horizontal', [l1.id]); M.addConstraint(s, 'horizontal', [l2.id]); } else if (Math.abs(dev - 90) < H_V_SNAP_DEG) { M.addConstraint(s, 'vertical', [l1.id]); M.addConstraint(s, 'vertical', [l2.id]); }
      }
    }
  }

  private tapSelect(uv: Vec2, tol: number, s: Sketch): void {
    const hit = this.hitTest(uv, tol, s);
    if (this.mirrorPending) { this.mirrorPending = false; if (hit?.kind === 'entity') this.mirrorSketchAbout(hit.id); else this.toast('Espelho cancelado.'); this.renderSidePanel(); return; }
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
      else if (e.type === 'arc') { kind = 'radius'; value = e.r; }
      else { this.toast('Elipses e splines se editam pelos pontos e pelo toque na curva.'); this.sel = emptySelection(); this.refreshAll(false); return; }
    } else {
      const [e1, e2] = ents; const [p1, p2] = pts;
      if (p1 && p2) { kind = 'distance'; value = dist(p1, p2); }
      else if (e1?.type === 'line' && e2?.type === 'line') { const d1 = sub(M.getPoint(s, e1.b), M.getPoint(s, e1.a)), d2 = sub(M.getPoint(s, e2.b), M.getPoint(s, e2.a)); kind = 'angle'; value = Math.atan2(Math.abs(d1.x * d2.y - d1.y * d2.x), d1.x * d2.x + d1.y * d2.y) * 180 / Math.PI; }
      else if ((p1 && e2?.type === 'line') || (p2 && e1?.type === 'line')) { const p = p1 ?? p2!; const l = (e2?.type === 'line' ? e2 : e1) as M.LineEntity; finalRefs = [p.id, l.id]; kind = 'distance'; const a = M.getPoint(s, l.a), b = M.getPoint(s, l.b); const ab = sub(b, a); const L = Math.hypot(ab.x, ab.y) || 1; value = Math.abs(ab.x * (p.y - a.y) - ab.y * (p.x - a.x)) / L; }
      else if ((p1 && M.isRound(e2)) || (p2 && M.isRound(e1))) { const p = p1 ?? p2!; const c = (M.isRound(e2) ? e2 : e1) as M.CircleEntity; finalRefs = [p.id, c.center]; kind = 'distance'; value = dist(p, M.getPoint(s, c.center)); }
      else if (M.isRound(e1) && M.isRound(e2)) { finalRefs = [e1.center, e2.center]; kind = 'distance'; value = dist(M.getPoint(s, e1.center), M.getPoint(s, e2.center)); }
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
      } else if (k === 'radius' || k === 'diameter') { const e = M.findEntity(s, finalRefs[0]); if (M.isRound(e)) { const c = M.getPoint(s, e.center); offset = norm(sub(at, c)); } }
      const d = M.addDimension(s, k, finalRefs, v, offset);
      const r = this.solve();
      if (!r?.converged) { M.removeDimension(s, d.id); this.solve(); this.toast('Essa cota conflita com as restrições existentes.', 'err'); }
      this.sel = emptySelection(); this.refreshAll(false);
    });
  }

  /** Cota dinâmica: toque numa entidade abre direto o valor para digitar (edita a cota existente ou cria uma). */
  private quickDimension(e: Entity, at: Vec2): void {
    const s = this.sketch; if (!s) return;
    if (e.type === 'ellipse') { this.ellipseDialog(e); return; }
    if (e.type === 'spline') return;
    const existing = s.dimensions.find((d) => d.refs.length === 1 && d.refs[0] === e.id) ?? s.dimensions.find((d) => e.type === 'line' && d.refs.length === 2 && d.refs.includes(e.a) && d.refs.includes(e.b));
    if (existing) { this.editDimension(existing.id); return; }
    this.createDimension([e.id], at);
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
    for (const s of doc.sketches) { items.push({ label: `Extrudar ${s.name}`, action: () => this.extrudeSketch(s.id) }); if (bodyIds(doc).length) items.push({ label: `Furo passante com ${s.name}`, action: () => this.cutThroughSketch(s.id) }); items.push({ label: `Revolucionar ${s.name}`, action: () => this.revolveSketch(s.id) }); }
    this.menu(ev.clientX, ev.clientY, items);
  }

  /** Um toque: corta o corpo atravessando com os contornos fechados do esboço ativo. */
  private cutThroughActive(): void {
    const s = this.sketch; if (!s) return;
    if (!extractProfiles(s).length) return this.toast('Feche um contorno antes de furar.', 'err');
    const id = s.id; this.exitSketch(true);
    if (this.doc.current.sketches.some((x) => x.id === id)) this.cutThroughSketch(id);
  }
  private cutThroughSketch(sketchId: Id): void {
    const doc = this.doc.current; const plane = getPlane(doc, getSketch(doc, sketchId).plane); const bodies = bodyIds(doc);
    if (!bodies.length) return this.toast('Não há corpo para furar.', 'err');
    const fromFace = plane.kind === 'face' && !!plane.body && bodies.includes(plane.body);
    const go = (target: Id) => {
      const extra = this.extraFacesFor(target, plane);
      void this.tryFeature(() => addExtrude(doc, sketchId, 10, { op: 'cut', target, throughAll: true, flip: fromFace, symmetric: !fromFace, onFaces: extra }), (f) => { this.selectedFeature = f.id; this.sel3d = emptySel3D(); this.sel3d.body = target; this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); if (extra.length) this.toast(`Rasgo aplicado em ${extra.length + 1} faces.`); });
    };
    if (fromFace) go(plane.body!); else if (bodies.length === 1) go(bodies[0]);
    else this.menu(this.vp.width / 2, this.vp.height / 2, bodies.map((b) => ({ label: `Furar ${bodyName(doc, b)}`, action: () => go(b) })));
  }

  /** Diálogo de extrusão: operação, profundidade, alvo e sentido. */
  private extrudeSketch(sketchId: Id): void {
    const doc = this.doc.current;
    const sk = getSketch(doc, sketchId); const plane = getPlane(doc, sk.plane);
    const bodies = bodyIds(doc);
    const faceBody = plane.kind === 'face' && plane.body && bodies.includes(plane.body) ? plane.body : null;
    const kernelOk = this.kernel.state === 'ready';
    const state = { op: (faceBody && kernelOk ? 'cut' : 'new') as ExtrudeOp, depth: 10, target: faceBody ?? bodies[0] ?? '', symmetric: false, flip: !!faceBody, throughAll: false, flipTouched: false, onFaces: true };
    const extraFaces = this.extraFacesFor(state.target, plane);

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
    if (extraFaces.length) { const fr2 = el('div', 'row'); const fl2 = document.createElement('label'); fl2.textContent = `Repetir nas ${extraFaces.length} outras faces selecionadas`; const fc = document.createElement('input'); fc.type = 'checkbox'; fc.checked = true; fc.addEventListener('change', () => { state.onFaces = fc.checked; }); fr2.append(fl2, fc); d.append(fr2); }
    const acts = el('div', 'actions');
    const ok = () => {
      const depth = parseFloat(depthInp.value.replace(',', '.'));
      if (!isFinite(depth) || depth <= 0) { this.toast('Profundidade inválida.', 'err'); return; }
      back.remove();
      void this.tryFeature(() => addExtrude(doc, sketchId, depth, { op: state.op, target: state.op === 'new' ? undefined : state.target, symmetric: state.symmetric, flip: state.flip, throughAll: state.op === 'cut' && state.throughAll, onFaces: state.op !== 'new' && state.onFaces ? extraFaces : undefined }),
        (f) => { this.selectedFeature = f.id; this.sel3d = emptySel3D(); this.sel3d.body = bodyOfFeature(f); this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.vp.fitAll(); });
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
        (f) => { this.selectedFeature = f.id; this.sel3d = emptySel3D(); this.sel3d.body = bodyOfFeature(f); this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.vp.fitAll(); });
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
      void this.tryFeature(() => addFillet(this.doc.current, kind, body.id, refs, r), (f) => { this.sel3d = emptySel3D(); this.sel3d.body = body.id; this.selectedFeature = f.id; this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar(); });
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
    void this.tryFeature(() => addBoolean(this.doc.current, op, body, tool), (f) => { this.selectedFeature = f.id; this.sel3d = emptySel3D(); this.sel3d.body = body; this.vp.setSelection(this.sel3d); this.updateFaceHandle(); this.renderSidePanel(); this.renderToolbar(); });
  }

  // ---------- Ferramentas de corpo (casca, espelho, padrão, mover, dividir, varredura, loft, plano, importar) ----------
  private bodyMenu(ev: MouseEvent): void {
    const doc = this.doc.current; const hasBody = !!this.sel3d.body; const sf = this.selectedFeatureObj();
    const items: { label: string; action: () => void }[] = [];
    if (hasBody) {
      items.push({ label: 'Casca (esvaziar)…', action: () => this.shellSelected() }, { label: 'Espelhar…', action: () => this.mirrorSelected() }, { label: 'Mover, girar, escalar…', action: () => this.transformSelected() }, { label: 'Dividir por plano…', action: () => this.splitSelected() });
    }
    if (sf && (sf.type === 'extrude' || sf.type === 'revolve')) items.push({ label: `Padrão de ${sf.name}…`, action: () => this.patternSelected(sf) });
    if (this.sel3d.face && this.faceIsPlanar(this.sel3d.face)) items.push({ label: 'Plano deslocado desta face…', action: () => this.offsetPlaneFromFace() });
    if (doc.sketches.length >= 1) items.push({ label: 'Tubo ao longo de um caminho…', action: () => this.tubeDialog() }, { label: 'Varredura (perfil + caminho)…', action: () => this.sweepDialog() });
    if (doc.sketches.length >= 2) items.push({ label: 'Loft entre esboços…', action: () => this.loftDialog() });
    items.push({ label: 'Importar STEP…', action: () => void this.importStep() });
    if (!hasBody) items.unshift({ label: 'Toque num corpo para casca, espelho, mover e dividir', action: () => {} });
    this.menu(ev.clientX, ev.clientY, items);
  }
  private selectedFeatureObj(): Feature | undefined { return this.doc.current.features.find((f) => f.id === this.selectedFeature); }
  /** Faces planas selecionadas no corpo `body`, fora a face onde o esboço foi desenhado: recebem o mesmo rasgo. */
  private extraFacesFor(body: Id, sketchPlane: Plane): FaceRef[] {
    const all = [...(this.sel3d.face ? [this.sel3d.face] : []), ...(this.sel3d.faces ?? [])].filter((f) => f.body === body);
    const n = planeNormal(sketchPlane); const out: FaceRef[] = [];
    for (const f of all) {
      const ref = this.faceRefOf(f); if (!ref) continue;
      const same = v3dot(ref.normal, n) > 0.99 && Math.abs(v3dot(v3sub(ref.center, sketchPlane.origin), n)) < 0.5;
      if (!same && !out.some((o) => v3dot(o.normal, ref.normal) > 0.999 && Math.hypot(...v3sub(o.center, ref.center)) < 1e-6)) out.push(ref);
    }
    return out;
  }
  private faceRefOf(ref: { body: Id; index: number } | null): FaceRef | null { const fd = ref ? this.bodyOf(ref.body)?.faces[ref.index] : undefined; return fd?.type === 'plane' && fd.normal ? { center: fd.center, normal: fd.normal, area: fd.area } : null; }
  /** Plano escolhido num diálogo: face plana selecionada ou um dos planos do mundo, com deslocamento. */
  private planeChoices(): [string, string][] { const out: [string, string][] = []; if (this.faceRefOf(this.sel3d.face)) out.push(['face', 'Face selecionada']); out.push(['xy', 'Plano XY (frente)'], ['xz', 'Plano XZ (topo)'], ['yz', 'Plano YZ (lateral)']); return out; }
  private planeFromChoice(choice: string, offset: number): { origin: V3; normal: V3 } {
    const fr = choice === 'face' ? this.faceRefOf(this.sel3d.face) : null;
    const n: V3 = fr ? fr.normal : choice === 'xy' ? [0, 0, 1] : choice === 'xz' ? [0, 1, 0] : [1, 0, 0];
    const c: V3 = fr ? fr.center : this.bodiesCenter();
    const o: V3 = fr ? fr.center : [choice === 'yz' ? 0 : c[0], choice === 'xz' ? 0 : c[1], choice === 'xy' ? 0 : c[2]];
    return { origin: [o[0] + n[0] * offset, o[1] + n[1] * offset, o[2] + n[2] * offset], normal: n };
  }
  private bodiesCenter(): V3 {
    const bs = this.bodies; if (!bs.length) return [0, 0, 0];
    const mn: V3 = [Infinity, Infinity, Infinity], mx: V3 = [-Infinity, -Infinity, -Infinity];
    for (const b of bs) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], b.bbox[0][i]); mx[i] = Math.max(mx[i], b.bbox[1][i]); }
    return [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  }

  /** Diálogo genérico de campos, no mesmo estilo dos demais. */
  private formDialog(title: string, fields: FormField[], okLabel: string, onOk: (v: Record<string, unknown>) => void, hint?: string): void {
    const back = el('div', 'dialog-backdrop'); const d = el('div', 'dialog');
    const hh = document.createElement('h2'); hh.textContent = title; d.append(hh);
    if (hint) { const h = el('div', 'hint'); h.textContent = hint; d.append(h); }
    const values: Record<string, unknown> = {}; const inputs: HTMLElement[] = [];
    for (const f of fields) {
      values[f.key] = f.value;
      const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = f.label; row.append(lab);
      if (f.type === 'select') { const sel = document.createElement('select'); for (const [v, t] of f.options ?? []) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); } sel.value = String(f.value); sel.addEventListener('change', () => { values[f.key] = sel.value; }); row.append(sel); inputs.push(sel); }
      else if (f.type === 'check') { const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!f.value; c.addEventListener('change', () => { values[f.key] = c.checked; }); row.append(c); }
      else { const inp = document.createElement('input'); inp.type = 'text'; inp.inputMode = f.type === 'number' ? 'decimal' : 'text'; inp.value = f.type === 'number' ? String(f.value).replace('.', ',') : String(f.value ?? ''); inp.addEventListener('input', () => { values[f.key] = f.type === 'number' ? parseFloat(inp.value.replace(',', '.')) : inp.value; }); inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ok(); if (ev.key === 'Escape') back.remove(); }); row.append(inp); inputs.push(inp); }
      d.append(row);
    }
    const acts = el('div', 'actions');
    const ok = () => { for (const f of fields) if (f.type === 'number' && !Number.isFinite(values[f.key] as number)) { this.toast(`Valor inválido em "${f.label}".`, 'err'); return; } back.remove(); onOk(values); };
    acts.append(this.button('Cancelar', () => back.remove()), this.button(okLabel, ok, 'btn primary')); d.append(acts);
    back.append(d); this.overlay.append(back);
    setTimeout(() => { const first = inputs[0] as HTMLInputElement | undefined; first?.focus?.(); first?.select?.(); }, 30);
  }

  private shellSelected(): void {
    const body = this.sel3d.body; if (!body) return; const open = this.faceRefOf(this.sel3d.face);
    this.formDialog('Casca', [{ key: 't', label: 'Espessura da parede (mm)', type: 'number', value: 2 }], 'Esvaziar', (v) => {
      void this.tryFeature(() => addShell(this.doc.current, body, Math.abs(v.t as number), open ? [open] : []), (f) => { this.selectedFeature = f.id; this.renderSidePanel(); });
    }, open ? 'A face selecionada fica aberta.' : 'Sem face selecionada o corpo fica oco e fechado. Selecione uma face antes para deixá-la aberta.');
  }
  private mirrorSelected(): void {
    const body = this.sel3d.body; if (!body) return; const choices = this.planeChoices();
    this.formDialog('Espelhar', [{ key: 'plane', label: 'Plano de espelho', type: 'select', value: choices[0][0], options: choices }, { key: 'off', label: 'Deslocamento do plano (mm)', type: 'number', value: 0 }, { key: 'join', label: 'Fundir com o original', type: 'check', value: true }], 'Espelhar', (v) => {
      const pl = this.planeFromChoice(v.plane as string, v.off as number);
      void this.tryFeature(() => addMirror(this.doc.current, body, pl.origin, pl.normal, !!v.join), (f) => { this.selectedFeature = f.id; this.renderSidePanel(); this.vp.fitAll(); });
    });
  }
  private transformSelected(): void {
    const body = this.sel3d.body; if (!body) return;
    this.formDialog('Mover, girar, escalar', [
      { key: 'x', label: 'Mover X (mm)', type: 'number', value: 0 }, { key: 'y', label: 'Mover Y (mm)', type: 'number', value: 0 }, { key: 'z', label: 'Mover Z (mm)', type: 'number', value: 0 },
      { key: 'axis', label: 'Eixo do giro', type: 'select', value: 'z', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']] }, { key: 'ang', label: 'Girar (°)', type: 'number', value: 0 }, { key: 'sc', label: 'Escala (×)', type: 'number', value: 1 },
    ], 'Aplicar', (v) => {
      const c = this.bodiesCenter();
      void this.tryFeature(() => addTransform(this.doc.current, body, { translate: [v.x as number, v.y as number, v.z as number], axisPoint: c, axisDir: v.axis === 'x' ? [1, 0, 0] : v.axis === 'y' ? [0, 1, 0] : [0, 0, 1], angle: v.ang as number, scale: (v.sc as number) || 1 }), (f) => { this.selectedFeature = f.id; this.renderSidePanel(); this.vp.fitAll(); });
    });
  }
  private splitSelected(): void {
    const body = this.sel3d.body; if (!body) return; const choices = this.planeChoices();
    this.formDialog('Dividir por plano', [{ key: 'plane', label: 'Plano de corte', type: 'select', value: choices[0][0], options: choices }, { key: 'off', label: 'Deslocamento (mm)', type: 'number', value: 0 }, { key: 'keep', label: 'Manter', type: 'select', value: 'both', options: [['both', 'Os dois lados'], ['front', 'Lado da normal'], ['back', 'Lado oposto']] }], 'Dividir', (v) => {
      const pl = this.planeFromChoice(v.plane as string, v.off as number);
      void this.tryFeature(() => addSplit(this.doc.current, body, pl.origin, pl.normal, v.keep as 'both' | 'front' | 'back'), (f) => { this.selectedFeature = f.id; this.renderSidePanel(); });
    });
  }
  private patternSelected(f: ExtrudeFeature | RevolveFeature): void {
    const cyl = this.sel3d.face ? this.bodyOf(this.sel3d.face.body)?.faces[this.sel3d.face.index] : undefined; const hasCyl = cyl?.type === 'cylinder' && !!cyl.axisDir;
    this.formDialog(`Padrão de ${f.name}`, [
      { key: 'kind', label: 'Tipo', type: 'select', value: 'linear', options: [['linear', 'Em linha'], ['circular', 'Em volta de um eixo']] },
      { key: 'count', label: 'Quantidade', type: 'number', value: 3 },
      { key: 'dx', label: 'Passo X (mm)', type: 'number', value: 20 }, { key: 'dy', label: 'Passo Y (mm)', type: 'number', value: 0 }, { key: 'dz', label: 'Passo Z (mm)', type: 'number', value: 0 },
      { key: 'axis', label: 'Eixo (circular)', type: 'select', value: hasCyl ? 'face' : 'z', options: [...(hasCyl ? [['face', 'Eixo da face cilíndrica selecionada'] as [string, string]] : []), ['x', 'X pelo centro'], ['y', 'Y pelo centro'], ['z', 'Z pelo centro']] },
      { key: 'ang', label: 'Ângulo total (°)', type: 'number', value: 360 },
    ], 'Repetir', (v) => {
      const count = Math.max(2, Math.round(v.count as number)); const c = this.bodiesCenter();
      const spec: PatternSpec = v.kind === 'linear' ? { kind: 'linear', count, step: [v.dx as number, v.dy as number, v.dz as number] }
        : { kind: 'circular', count, angle: v.ang as number, axisPoint: v.axis === 'face' && cyl ? cyl.axisOrigin! : c, axisDir: v.axis === 'face' && cyl ? cyl.axisDir! : v.axis === 'x' ? [1, 0, 0] : v.axis === 'y' ? [0, 1, 0] : [0, 0, 1] };
      void this.tryFeature(() => { f.pattern = spec; return f; }, () => this.renderSidePanel());
    });
  }
  private offsetPlaneFromFace(): void {
    const fr = this.faceRefOf(this.sel3d.face); const fd = this.sel3d.face ? this.bodyOf(this.sel3d.face.body)?.faces[this.sel3d.face.index] : undefined; if (!fr || !fd?.u || !fd.v) return;
    this.valuePopover(this.vp.width / 2, this.vp.height / 2, 10, 'mm', (d) => {
      this.pushUndo(); const n = fr.normal; const doc = this.doc.current; const k = doc.planes.filter((p) => p.kind === 'offset').length + 1;
      let u = fd.u!, v = fd.v!; if (v3dot(v3cross(u, v), n) < 0) v = v3neg(v);
      addOffsetPlane(doc, `Plano ${k} (+${fmtDim('distance', d)} mm)`, [fr.center[0] + n[0] * d, fr.center[1] + n[1] * d, fr.center[2] + n[2] * d], u, v);
      this.refreshAll(); this.toast('Plano criado. Ele aparece em "Esboço".');
    });
  }
  private sweepDialog(): void {
    const doc = this.doc.current; const sk: [string, string][] = doc.sketches.map((s) => [s.id, s.name]); const bodies = bodyIds(doc);
    const ops: [string, string][] = [['new', 'Novo corpo']]; if (bodies.length) ops.push(['add', 'Adicionar'], ['cut', 'Cortar']);
    const fields: FormField[] = [{ key: 'profile', label: 'Perfil (esboço fechado)', type: 'select', value: sk[0][0], options: sk }];
    for (const s of doc.sketches) fields.push({ key: `p:${s.id}`, label: `Caminho: ${s.name}`, type: 'check', value: s.id === doc.sketches[doc.sketches.length - 1].id });
    fields.push({ key: 'op', label: 'Operação', type: 'select', value: 'new', options: ops });
    this.formDialog('Varredura', fields, 'Varrer', (v) => {
      const paths = doc.sketches.filter((s) => v[`p:${s.id}`]).map((s) => s.id); if (!paths.length) return this.toast('Marque pelo menos um esboço de caminho.', 'err');
      void this.tryFeature(() => addSweep(doc, v.profile as string, paths[0], { paths, op: v.op as ExtrudeOp, target: bodies[0] }), (f) => { this.selectedFeature = f.id; this.renderSidePanel(); this.vp.fitAll(); });
    }, 'O perfil fica no começo do caminho. O caminho pode ter linhas e arcos em vários esboços emendados ponta a ponta, inclusive em planos diferentes (3D). Cantos vivos viram cotovelos arredondados.');
  }
  /** Tubo: só o caminho e os diâmetros; o perfil circular é gerado no começo do caminho. */
  private tubeDialog(): void {
    const doc = this.doc.current; const bodies = bodyIds(doc);
    const ops: [string, string][] = [['new', 'Novo corpo']]; if (bodies.length) ops.push(['add', 'Adicionar'], ['cut', 'Cortar']);
    const fields: FormField[] = [];
    for (const s of doc.sketches) fields.push({ key: `p:${s.id}`, label: `Caminho: ${s.name}`, type: 'check', value: true });
    fields.push({ key: 'outer', label: 'Diâmetro externo (mm)', type: 'number', value: 38 }, { key: 'wall', label: 'Parede (mm, 0 = maciço)', type: 'number', value: 1.5 }, { key: 'op', label: 'Operação', type: 'select', value: 'new', options: ops });
    this.formDialog('Tubo ao longo de um caminho', fields, 'Criar tubo', (v) => {
      const paths = doc.sketches.filter((s) => v[`p:${s.id}`]).map((s) => s.id); if (!paths.length) return this.toast('Marque o esboço do caminho.', 'err');
      const outer = v.outer as number, wall = Math.max(0, v.wall as number); if (!(outer > 0) || wall * 2 >= outer) return this.toast('Diâmetro e parede incompatíveis.', 'err');
      void this.tryFeature(() => addSweep(doc, paths[0], paths[0], { paths, tube: { outer, inner: wall > 0 ? outer - 2 * wall : 0 }, op: v.op as ExtrudeOp, target: bodies[0] }), (f) => { this.selectedFeature = f.id; this.renderSidePanel(); this.vp.fitAll(); });
    }, 'Desenhe o caminho com linhas e arcos (arcos nas curvas deixam o tubo suave). Pode emendar esboços em planos diferentes para curvas em 3D, como um escapamento.');
  }
  private loftDialog(): void {
    const doc = this.doc.current; const bodies = bodyIds(doc);
    const fields: FormField[] = doc.sketches.map((s) => ({ key: `s:${s.id}`, label: s.name, type: 'check' as const, value: true }));
    const ops: [string, string][] = [['new', 'Novo corpo']]; if (bodies.length) ops.push(['add', 'Adicionar'], ['cut', 'Cortar']);
    fields.push({ key: 'ruled', label: 'Faces retas (regrado)', type: 'check', value: false }, { key: 'op', label: 'Operação', type: 'select', value: 'new', options: ops });
    this.formDialog('Loft', fields, 'Criar loft', (v) => {
      const ids = doc.sketches.filter((s) => v[`s:${s.id}`]).map((s) => s.id); if (ids.length < 2) return this.toast('Escolha dois esboços ou mais.', 'err');
      void this.tryFeature(() => addLoft(doc, ids, { ruled: !!v.ruled, op: v.op as ExtrudeOp, target: bodies[0] }), (f) => { this.selectedFeature = f.id; this.renderSidePanel(); this.vp.fitAll(); });
    }, 'Marque os esboços na ordem em que foram criados; cada um entra com seu primeiro perfil fechado.');
  }
  async importStep(): Promise<void> {
    const f = await pickFile('.step,.stp,.STEP,.STP'); if (!f) return;
    if (!/ISO-10303-21/.test(f.text.slice(0, 200))) return this.toast('Esse arquivo não parece um STEP.', 'err');
    const name = f.name.replace(/\.(step|stp)$/i, '');
    await this.tryFeature(() => addImport(this.doc.current, name, f.text), (feat) => { this.selectedFeature = feat.id; this.renderSidePanel(); this.vp.fitAll(); this.toast(`"${name}" importado.`); });
  }
  private renderPatternRows(p: HTMLElement, f: ExtrudeFeature | RevolveFeature, edit: (mut: () => void) => void): void {
    if (!f.pattern) return;
    const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = f.pattern.kind === 'linear' ? 'Padrão em linha' : 'Padrão circular';
    const inp = document.createElement('input'); inp.type = 'number'; inp.step = '1'; inp.value = String(f.pattern.count); inp.title = 'Quantidade';
    inp.addEventListener('change', () => { const v = Math.round(parseFloat(inp.value)); if (v >= 2) edit(() => { f.pattern!.count = v; }); });
    row.append(lab, inp); p.append(row);
    const r2 = el('div', 'row'); r2.append(this.button('Remover padrão', () => edit(() => { delete f.pattern; }), 'btn danger')); p.append(r2);
  }

  // ---------- Medir e vista em corte ----------
  private toggleMeasure(): void { this.measure.on = !this.measure.on; this.measure.first = null; this.renderToolbar(); this.toast(this.measure.on ? 'Medir: toque numa face ou aresta, depois em outra.' : 'Medição desligada.'); }
  /** Em modo medir: um toque mostra a medida do elemento; o segundo mostra a distância entre os dois. */
  private measureTap(hit: { kind: 'face' | 'edge'; body: Id; index: number }, x: number, y: number): void {
    const data = (h: typeof hit) => this.bodyOf(h.body);
    const describe = (h: typeof hit) => { const b = data(h); if (!b) return ''; if (h.kind === 'edge') { const e = b.edges[h.index]; return `aresta ${fmtDim('distance', e.len)} mm`; } const f = b.faces[h.index]; return `face ${faceTypeName(f.type)} ${f.area.toFixed(0)} mm²${f.type === 'cylinder' && f.radius ? `, Ø${fmtDim('distance', f.radius * 2)}` : ''}`; };
    if (!this.measure.first) { this.measure.first = hit; this.sel3d = { body: hit.body, face: hit.kind === 'face' ? { body: hit.body, index: hit.index } : null, edges: hit.kind === 'edge' ? [{ body: hit.body, index: hit.index }] : [] }; this.vp.setSelection(this.sel3d); this.showChip(x, y, describe(hit)); this.toast('Agora toque no segundo elemento.'); return; }
    const a = this.measure.first, b = hit; this.measure.first = null;
    const A = data(a), B = data(b); if (!A || !B) return;
    const pointOf = (h: typeof hit, d: BodyData): V3 => (h.kind === 'edge' ? d.edges[h.index].mid : d.faces[h.index].center);
    const pa = pointOf(a, A), pb = pointOf(b, B);
    let dist = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]); let how = 'entre centros';
    const fa = a.kind === 'face' ? A.faces[a.index] : null, fb = b.kind === 'face' ? B.faces[b.index] : null;
    if (fa?.type === 'plane' && fa.normal && fb?.type === 'plane' && fb.normal && Math.abs(v3dot(fa.normal, fb.normal)) > 0.999) { dist = Math.abs(v3dot(v3sub(pb, pa), fa.normal)); how = 'entre planos paralelos'; }
    else if (fa?.type === 'plane' && fa.normal) { dist = Math.abs(v3dot(v3sub(pb, pa), fa.normal)); how = 'perpendicular ao plano'; }
    else if (fb?.type === 'plane' && fb.normal) { dist = Math.abs(v3dot(v3sub(pa, pb), fb.normal)); how = 'perpendicular ao plano'; }
    if (b.kind === 'edge') this.sel3d.edges.push({ body: b.body, index: b.index }); else this.sel3d.face = { body: b.body, index: b.index };
    this.vp.setSelection(this.sel3d);
    this.showChip(x, y, `${fmtDim('distance', dist)} mm`); this.toast(`Distância ${how}: ${fmtDim('distance', dist)} mm (${describe(a)} → ${describe(b)}).`);
  }
  private toggleSection(): void {
    if (this.section.on) { this.section.on = false; this.vp.setSection(null); this.renderToolbar(); this.renderSidePanel(); return; }
    const fr = this.faceRefOf(this.sel3d.face);
    if (fr) { this.section.origin = fr.center; this.section.normal = v3neg(fr.normal); }
    else { this.section.origin = this.bodiesCenter(); this.section.normal = [0, -1, 0]; }
    this.section.offset = 0; this.section.on = true; this.applySection(); this.renderToolbar(); this.renderSidePanel();
    this.toast(fr ? 'Corte pelo plano da face selecionada. Ajuste o deslocamento no painel.' : 'Corte horizontal pelo meio. Selecione uma face antes para cortar por ela.');
  }
  private applySection(): void {
    const { origin: o, normal: n, offset } = this.section;
    const plane = new THREE.Plane(new THREE.Vector3(...n), -(n[0] * (o[0] + n[0] * offset) + n[1] * (o[1] + n[1] * offset) + n[2] * (o[2] + n[2] * offset)));
    this.vp.setSection(plane);
  }
  private renderSectionPanel(p: HTMLElement): void {
    if (!this.section.on) return;
    p.append(h3('Vista em corte'));
    const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = 'Deslocamento (mm)';
    const inp = document.createElement('input'); inp.type = 'number'; inp.step = '1'; inp.value = String(this.section.offset); inp.addEventListener('change', () => { const v = parseFloat(inp.value.replace(',', '.')); if (isFinite(v)) { this.section.offset = v; this.applySection(); } }); row.append(lab, inp); p.append(row);
    const r2 = el('div', 'row'); r2.append(this.button('Inverter lado', () => { this.section.normal = v3neg(this.section.normal); this.section.offset = -this.section.offset; this.applySection(); this.renderSidePanel(); }), this.button('Desligar corte', () => this.toggleSection())); p.append(r2);
  }

  // ---------- Esboço: deslocar contorno, espelhar, filete 2D ----------
  private offsetContourMenu(ev: MouseEvent): void {
    this.menu(ev.clientX, ev.clientY, [{ label: 'Para fora…', action: () => this.offsetContour(1) }, { label: 'Para dentro…', action: () => this.offsetContour(-1) }]);
  }
  private offsetContour(sign: 1 | -1): void {
    const s = this.sketch; if (!s || this.kernel.state !== 'ready') return;
    const entId = [...this.sel.entities][0]; if (!entId) return;
    const prof = extractProfiles(s).find((pr) => (pr.outer.kind === 'circle' ? pr.outer.entity.id === entId : pr.outer.edges.some((e) => e.entity.id === entId)) || pr.holes.some((h) => (h.kind === 'circle' ? h.entity.id === entId : h.edges.some((e) => e.entity.id === entId))));
    if (!prof) return this.toast('Selecione uma linha ou arco de um contorno fechado.', 'err');
    const ip = profileInnerPoint(s, prof);
    this.valuePopover(this.vp.width / 2, this.vp.height / 2, 2, 'mm', (d) => {
      void this.kernel.offsetProfile(this.doc.current, s.id, [ip.x, ip.y], sign * d).then((ents) => {
        this.pushUndo();
        const joints = new Map<string, Id>(); const key = (p: [number, number]) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
        const pt = (p: [number, number]) => { const k = key(p); let id = joints.get(k); if (!id) { id = M.addPoint(s, p[0], p[1]).id; joints.set(k, id); } return id; };
        for (const e of ents) {
          if (e.type === 'line') M.addLine(s, pt(e.a), pt(e.b));
          else if (e.type === 'circle') M.addCircle(s, M.addPoint(s, e.c[0], e.c[1]).id, e.r);
          else M.addArc(s, M.addPoint(s, e.c[0], e.c[1]).id, pt(e.a), pt(e.b), e.r);
        }
        this.sel = emptySelection(); this.solve(); this.refreshAll(false); this.toast(`Contorno deslocado ${fmtDim('distance', d)} mm para ${sign > 0 ? 'fora' : 'dentro'}.`);
      }).catch((e) => this.toast(`Não deu: ${(e as Error).message}`, 'err'));
    });
  }
  private startMirrorSketch(): void { if (!this.sel.entities.size) return; this.mirrorPending = true; this.renderSidePanel(); this.toast('Toque na linha que serve de espelho.'); }
  private mirrorSketchAbout(lineId: Id): void {
    const s = this.sketch; if (!s) return; const l = M.findEntity(s, lineId); if (!l || l.type !== 'line') return this.toast('O espelho precisa ser uma linha.', 'err');
    const a = M.getPoint(s, l.a), b = M.getPoint(s, l.b); const d = norm(sub(b, a));
    const mirror = (p: { x: number; y: number }): Vec2 => { const rel = sub(p, a); const along = rel.x * d.x + rel.y * d.y; const px = a.x + d.x * along, py = a.y + d.y * along; return v2(2 * px - p.x, 2 * py - p.y); };
    this.pushUndo();
    const map = new Map<Id, Id>(); const mp = (pid: Id) => { let id = map.get(pid); if (!id) { const q = mirror(M.getPoint(s, pid)); id = M.addPoint(s, q.x, q.y).id; map.set(pid, id); } return id; };
    for (const id of [...this.sel.entities]) {
      const e = M.findEntity(s, id); if (!e || e.id === lineId) continue;
      if (e.type === 'line') M.addLine(s, mp(e.a), mp(e.b));
      else if (e.type === 'circle') M.addCircle(s, mp(e.center), e.r);
      else if (e.type === 'spline') M.addSpline(s, e.points.map(mp), e.closed);
      else if (e.type === 'ellipse') M.addEllipse(s, mp(e.center), e.rx, e.ry, 2 * angleOf(d) - e.angle);
      else M.addArc(s, mp(e.center), mp(e.end), mp(e.start), e.r); // espelho inverte o sentido
    }
    this.sel = emptySelection(); this.solve(); this.refreshAll(false); this.toast('Espelhado.');
  }
  /** Uma linha selecionada num esboço sobre face de corpo (ou plano com um só corpo) pode dividir o corpo. */
  private splitLineCandidate(): { line: M.LineEntity; body: Id } | null {
    const s = this.sketch; const plane = this.plane; if (!s || !plane || this.sel.entities.size !== 1) return null;
    const e = M.findEntity(s, [...this.sel.entities][0]); if (!e || e.type !== 'line') return null;
    const bodies = bodyIds(this.doc.current); const body = plane.kind === 'face' && plane.body && bodies.includes(plane.body) ? plane.body : bodies.length === 1 ? bodies[0] : null;
    return body ? { line: e, body } : null;
  }
  /** Divide o corpo pelo plano que contém a linha e é perpendicular ao plano do esboço. */
  private splitBySketchLine(): void {
    const c = this.splitLineCandidate(); const s = this.sketch; const plane = this.plane; if (!c || !s || !plane) return;
    const a = M.getPoint(s, c.line.a), b = M.getPoint(s, c.line.b);
    const A = planeToWorld(plane, a.x, a.y), B = planeToWorld(plane, b.x, b.y); const n = planeNormal(plane);
    const dir: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]; const L = Math.hypot(...dir) || 1; const d: V3 = [dir[0] / L, dir[1] / L, dir[2] / L];
    const normal = v3cross(d, n); const mid: V3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
    const body = c.body; this.exitSketch(true);
    void this.tryFeature(() => addSplit(this.doc.current, body, mid, normal, 'both'), (f) => { this.selectedFeature = f.id; this.renderSidePanel(); this.toast('Corpo dividido em dois pela linha.'); });
  }
  /** Duas linhas selecionadas que compartilham um ponto (canto) → candidatas a filete 2D. */
  private filletCornerCandidate(): { l1: M.LineEntity; l2: M.LineEntity; corner: Id } | null {
    const s = this.sketch; if (!s || this.sel.entities.size !== 2) return null;
    const [e1, e2] = [...this.sel.entities].map((id) => M.findEntity(s, id)); if (!e1 || !e2 || e1.type !== 'line' || e2.type !== 'line') return null;
    const shared = [e1.a, e1.b].find((p) => p === e2.a || p === e2.b); return shared ? { l1: e1, l2: e2, corner: shared } : null;
  }
  private fillet2D(): void {
    const s = this.sketch; const c = this.filletCornerCandidate(); if (!s || !c) return;
    this.valuePopover(this.vp.width / 2, this.vp.height / 2, 5, 'mm', (r) => {
      const P = M.getPoint(s, c.corner); const A = M.getPoint(s, c.l1.a === c.corner ? c.l1.b : c.l1.a), B = M.getPoint(s, c.l2.a === c.corner ? c.l2.b : c.l2.a);
      const d1 = norm(sub(A, P)), d2 = norm(sub(B, P)); const cosT = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y)); const theta = Math.acos(cosT);
      if (theta < 0.05 || theta > Math.PI - 0.05) return this.toast('As linhas estão quase alinhadas; não há canto para filetar.', 'err');
      const t = r / Math.tan(theta / 2); if (t > dist(P, A) - 1e-6 || t > dist(P, B) - 1e-6) return this.toast('Raio grande demais para essas linhas.', 'err');
      this.pushUndo();
      const p1 = add(v2(P.x, P.y), scale(d1, t)), p2 = add(v2(P.x, P.y), scale(d2, t));
      const bis = norm(add(d1, d2)); const C = add(v2(P.x, P.y), scale(bis, r / Math.sin(theta / 2)));
      const q1 = M.addPoint(s, p1.x, p1.y), q2 = M.addPoint(s, p2.x, p2.y), cc = M.addPoint(s, C.x, C.y);
      if (c.l1.a === c.corner) c.l1.a = q1.id; else c.l1.b = q1.id;
      if (c.l2.a === c.corner) c.l2.a = q2.id; else c.l2.b = q2.id;
      const cross = (p1.x - C.x) * (p2.y - C.y) - (p1.y - C.y) * (p2.x - C.x);
      const arc = cross > 0 ? M.addArc(s, cc.id, q1.id, q2.id, r) : M.addArc(s, cc.id, q2.id, q1.id, r);
      M.addConstraint(s, 'tangent', [c.l1.id, arc.id]); M.addConstraint(s, 'tangent', [c.l2.id, arc.id]);
      M.pruneOrphanPoints(s);
      const res = this.solve(); if (!res?.converged) this.toast('Filete criado, mas as restrições não fecharam; ajuste à mão.', 'err');
      this.sel = emptySelection(); this.refreshAll(false);
    });
  }

  // ---------- Arquivos ----------
  newDocument(ev?: MouseEvent): void {
    const items = [
      { label: 'Nova peça', action: () => this.confirm('Nova peça', 'Descartar o documento atual? O autosave será substituído. Salve antes se precisar.', () => {
        this.closeTimelineIfOpen(); this.doc.current = createDocument(); this.undoStack = []; this.redoStack = []; this.activeSketch = null; this.mode = 'view'; this.selectedFeature = null; this.selectedInstance = null; this.sel = emptySelection(); this.sel3d = emptySel3D(); this.asmCache.clear(); this.vp.exitSketch(); this.titleEl.value = this.doc.current.name; this.refreshAll(); this.vp.fitAll();
      }) },
      { label: 'Nova montagem vazia', action: () => this.newAssembly(false) },
    ];
    if (!this.isAssembly && this.doc.current.features.length) items.push({ label: 'Nova montagem com esta peça', action: () => this.newAssembly(true) });
    if (ev) this.menu(ev.clientX, ev.clientY, items); else items[0].action();
  }
  async openFile(): Promise<void> {
    const f = await pickFile('.forja,application/json'); if (!f) return;
    try { const d = deserialize(f.text); this.closeTimelineIfOpen(); this.doc.current = d; this.undoStack = []; this.redoStack = []; this.activeSketch = null; this.mode = 'view'; this.selectedFeature = null; this.selectedInstance = null; this.sel3d = emptySel3D(); this.asmCache.clear(); this.jointFlow = null; this.vp.exitSketch(); this.titleEl.value = d.name; this.refreshAll(); this.vp.fitAll(); this.toast(`Aberto: ${f.name}${d.kind === 'assembly' ? ' (montagem)' : ''}`); }
    catch (e) { this.toast(`Não abriu: ${(e as Error).message}`, 'err'); }
  }
  saveFile(): void { downloadFile(`${safeFileName(this.doc.current.name)}.forja`, serialize(this.doc.current), 'application/json'); this.toast('Arquivo .forja gerado.'); }
  exportMenu(ev: MouseEvent): void {
    this.menu(ev.clientX, ev.clientY, [
      { label: 'STEP (SolidWorks, Fusion, fornecedores)', action: () => void this.exportStep() },
      { label: 'IGES (CAM, máquinas antigas)', action: () => void this.exportStep('iges') },
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
  private async exportStep(format: 'step' | 'iges' = 'step'): Promise<void> {
    if (this.kernel.state !== 'ready') return this.toast('A exportação precisa do kernel 3D carregado.', 'err');
    if (!this.isAssembly && !this.bodies.length) return this.toast('Nenhum corpo para exportar.', 'err');
    if (this.isAssembly && !this.asm!.instances.length) return this.toast('Montagem vazia.', 'err');
    if (this.isAssembly && format === 'iges') return this.toast('IGES da montagem ainda não; use STEP.', 'err');
    try {
      const text = this.isAssembly ? await this.kernel.exportStepAssembly(this.assemblyPayload()) : await this.kernel.exportStep(format);
      downloadFile(`${safeFileName(this.doc.current.name)}.${format === 'iges' ? 'igs' : 'step'}`, text, format === 'iges' ? 'model/iges' : 'application/step');
      this.toast(`${format.toUpperCase()} gerado.`);
    } catch (e) { this.toast(`${format.toUpperCase()} falhou: ${(e as Error).message}`, 'err'); }
  }

  // ---------- Animação ----------
  toggleTimeline(): void {
    const asm = this.asm; if (!asm) return;
    if (this.anim.open) {
      this.pause(); this.anim.open = false; this.timeline.style.display = 'none';
      void this.rebuildAssembly(); this.renderToolbar(); this.renderSidePanel(); return;
    }
    syncTracks(asm); this.autosave();
    this.anim.open = true; this.anim.t = 0; this.anim.hits = [];
    this.timeline.style.display = ''; this.renderTimeline(); this.applyAnimT(0);
    this.renderToolbar(); this.renderSidePanel();
  }

  /** Posiciona as instâncias no instante t (0 a 1) sem mexer no documento. */
  private applyAnimT(t: number): void {
    const asm = this.asm; if (!asm) return;
    this.anim.t = t;
    const T = computeTransformsAt(asm, t); const map = new Map<Id, number[]>();
    for (const inst of asm.instances) { const m = T.get(inst.id); const c = this.asmCache.get(inst.part); if (!m || !c) continue; for (const b of c.bodies) map.set(`${inst.id}/${b.id}`, m); }
    this.vp.updateMatrices(map); this.vp.setSelection(this.sel3d); this.updateFaceHandle();
    const dur = asm.animation?.duration ?? 4;
    const slider = this.timeline.querySelector('input[type=range]') as HTMLInputElement | null; if (slider && document.activeElement !== slider) slider.value = String(Math.round(t * 1000));
    const time = this.timeline.querySelector('.time'); if (time) time.textContent = `${(t * dur).toFixed(1).replace('.', ',')} s / ${String(dur).replace('.', ',')} s`;
  }

  private play(): void {
    if (this.anim.playing) return;
    this.anim.playing = true; this.anim.lastTs = 0;
    const step = (ts: number) => {
      if (!this.anim.playing) return;
      const asm = this.asm; if (!asm) return;
      const dur = asm.animation?.duration ?? 4;
      if (this.anim.lastTs) {
        let t = this.anim.t + (ts - this.anim.lastTs) / 1000 / dur;
        if (t >= 1) {
          if (this.anim.recorder) { this.applyAnimT(1); this.stopRecording(); this.pause(); return; }
          if (asm.animation?.loop !== false) t -= Math.floor(t); else { this.applyAnimT(1); this.pause(); return; }
        }
        this.applyAnimT(t);
      }
      this.anim.lastTs = ts; this.anim.raf = requestAnimationFrame(step);
    };
    this.anim.raf = requestAnimationFrame(step); this.renderTimeline();
  }
  private pause(): void {
    this.anim.playing = false; if (this.anim.raf) cancelAnimationFrame(this.anim.raf); this.anim.raf = 0;
    if (this.anim.recorder) this.stopRecording();
    this.renderTimeline();
  }

  private renderTimeline(): void {
    const asm = this.asm; const tl = this.timeline; tl.innerHTML = ''; if (!asm) return;
    const anim = asm.animation ?? syncTracks(asm);
    tl.append(this.iconButton(this.anim.playing ? 'pause' : 'play', this.anim.playing ? 'Pausar' : 'Reproduzir', () => (this.anim.playing ? this.pause() : this.play())));
    const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '1000'; slider.value = String(Math.round(this.anim.t * 1000));
    slider.addEventListener('input', () => { if (this.anim.playing) this.pause(); this.applyAnimT(Number(slider.value) / 1000); });
    tl.append(slider);
    const time = el('span', 'time'); time.textContent = `${(this.anim.t * anim.duration).toFixed(1).replace('.', ',')} s / ${String(anim.duration).replace('.', ',')} s`; tl.append(time);
    const durLab = document.createElement('label'); durLab.textContent = 'Duração'; const dur = document.createElement('input'); dur.type = 'number'; dur.min = '0.5'; dur.step = '0.5'; dur.value = String(anim.duration);
    dur.addEventListener('change', () => { const v = parseFloat(dur.value.replace(',', '.')); if (isFinite(v) && v > 0) { anim.duration = Math.min(120, v); this.autosave(); this.applyAnimT(this.anim.t); } }); durLab.append(dur, document.createTextNode('s')); tl.append(durLab);
    const loopLab = document.createElement('label'); const loop = document.createElement('input'); loop.type = 'checkbox'; loop.checked = anim.loop; loop.addEventListener('change', () => { anim.loop = loop.checked; this.autosave(); }); loopLab.append(loop, document.createTextNode('Laço')); tl.append(loopLab);
    const rec = this.iconButton('record', this.anim.recorder ? 'Parar gravação' : 'Gravar vídeo', () => (this.anim.recorder ? this.pause() : this.recordVideo()), 'tool rec'); if (this.anim.recorder) rec.classList.add('active'); tl.append(rec);
    const col = this.iconButton('collide', 'Verificar interferências', () => void this.checkInterference()); col.disabled = this.anim.checking; tl.append(col);
    tl.append(this.iconButton('done', 'Fechar', () => this.toggleTimeline()));
  }

  private renderMotionsPanel(p: HTMLElement): void {
    const asm = this.asm!; const anim = asm.animation ?? syncTracks(asm);
    p.append(h3('Movimentos'));
    if (!anim.tracks.length) { const d = el('div', 'hint'); d.textContent = 'Crie juntas de pino, deslizante ou cilíndrica para animar.'; p.append(d); }
    for (const tr of anim.tracks) {
      const j = asm.joints.find((x) => x.id === tr.joint); if (!j) continue;
      const head = el('div', 'row'); const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = tr.enabled; chk.addEventListener('change', () => { tr.enabled = chk.checked; this.autosave(); this.applyAnimT(this.anim.t); });
      const lab = document.createElement('label'); lab.textContent = `${j.name} (${asm.instances.find((i) => i.id === j.moving)?.name ?? '?'})`; head.append(chk, lab); p.append(head);
      const modeRow = el('div', 'row'); const ml = document.createElement('label'); ml.textContent = 'Modo'; const sel = document.createElement('select');
      for (const m of Object.keys(MOTION_NAMES) as MotionMode[]) { if (m === 'spin' && j.type === 'slider') continue; const o = document.createElement('option'); o.value = m; o.textContent = MOTION_NAMES[m]; sel.append(o); }
      sel.value = tr.mode; sel.addEventListener('change', () => { tr.mode = sel.value as MotionMode; this.autosave(); this.applyAnimT(this.anim.t); this.renderSidePanel(); }); modeRow.append(ml, sel); p.append(modeRow);
      const num = (label: string, value: number, onChange: (v: number) => void) => {
        const row = el('div', 'row'); const l = document.createElement('label'); l.textContent = label; const inp = document.createElement('input'); inp.type = 'number'; inp.step = '5'; inp.value = String(value); inp.inputMode = 'decimal';
        inp.addEventListener('change', () => { const v = parseFloat(inp.value.replace(',', '.')); if (isFinite(v)) { onChange(v); this.autosave(); this.applyAnimT(this.anim.t); } }); row.append(l, inp); p.append(row);
      };
      if (j.type === 'revolute' || j.type === 'cylindrical') {
        if (tr.mode === 'spin') num('Giro total (°)', tr.angleTo, (v) => { tr.angleTo = v; });
        else { num('Ângulo inicial (°)', tr.angleFrom, (v) => { tr.angleFrom = v; }); num('Ângulo final (°)', tr.angleTo, (v) => { tr.angleTo = v; }); }
      }
      if (j.type === 'slider' || j.type === 'cylindrical') { num('Curso inicial (mm)', tr.distFrom, (v) => { tr.distFrom = v; }); num('Curso final (mm)', tr.distTo, (v) => { tr.distTo = v; }); }
    }
    if (this.anim.hits.length || this.anim.hitSteps > 1) {
      p.append(h3(`Interferências (${this.anim.hits.length})`));
      if (!this.anim.hits.length) { const d = el('div', 'hint'); d.textContent = `Nenhuma em ${this.anim.hitSteps} posições do movimento.`; p.append(d); }
      const list = el('div', 'list');
      for (const h of this.anim.hits) {
        const a = asm.instances[h.a], b = asm.instances[h.b]; const t = this.anim.hitSteps > 1 ? h.step / (this.anim.hitSteps - 1) : 0;
        const it = listItem(`${a?.name ?? '?'} × ${b?.name ?? '?'}`, `${Math.round(t * 100)}% · ${fmtMm3(h.volume)}`);
        it.addEventListener('click', () => { this.pause(); this.applyAnimT(t); this.selectedInstance = a?.id ?? null; const c = a && this.asmCache.get(a.part); this.sel3d = emptySel3D(); if (a && c?.bodies[0]) this.sel3d.body = `${a.id}/${c.bodies[0].id}`; this.vp.setSelection(this.sel3d); this.updateFaceHandle(); });
        list.append(it);
      }
      p.append(list);
    }
  }

  private recordVideo(): void {
    const stream = this.vp.captureStream(30);
    if (!stream || typeof MediaRecorder === 'undefined') return this.toast('Este navegador não grava vídeo do canvas.', 'err');
    const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return this.toast('Nenhum formato de vídeo disponível.', 'err');
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    rec.onstop = () => {
      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type: mime });
      void blob.arrayBuffer().then((buf) => { downloadFile(`${safeFileName(this.doc.current.name)}.${ext}`, buf, mime); this.toast(`Vídeo ${ext.toUpperCase()} gerado (${(blob.size / 1e6).toFixed(1).replace('.', ',')} MB).`); });
    };
    this.anim.recorder = rec; this.applyAnimT(0); rec.start(200); this.play();
    this.toast('Gravando um ciclo da animação…');
  }
  private stopRecording(): void {
    const rec = this.anim.recorder; if (!rec) return; this.anim.recorder = null;
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    this.renderTimeline();
  }

  /** Amostra o movimento e pede ao kernel o volume comum entre pares de peças. */
  private async checkInterference(): Promise<void> {
    const asm = this.asm; if (!asm || this.anim.checking) return;
    if (this.kernel.state !== 'ready') return this.toast('Kernel 3D ainda não está pronto.', 'err');
    if (asm.instances.length < 2) return this.toast('Precisa de duas peças ou mais.', 'err');
    const hasMotion = !!asm.animation?.tracks.some((t) => t.enabled);
    const N = hasMotion ? 13 : 1;
    const steps: { part: Id; matrix: number[] }[][] = [];
    for (let k = 0; k < N; k++) { const T = computeTransformsAt(asm, N > 1 ? k / (N - 1) : this.anim.t); steps.push(asm.instances.map((i) => ({ part: i.part, matrix: T.get(i.id) ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }))); }
    this.anim.checking = true; this.renderTimeline(); this.toast(`Verificando ${N} posição${N > 1 ? 'ões' : ''}…`);
    try {
      const hits = await this.kernel.interference(asm.parts.map((p) => ({ id: p.id, doc: p.doc })), steps);
      this.anim.hits = hits; this.anim.hitSteps = N;
      const pairs = new Set(hits.map((h) => `${h.a}-${h.b}`));
      this.toast(hits.length ? `${pairs.size} par${pairs.size > 1 ? 'es' : ''} de peças se interpenetram em ${new Set(hits.map((h) => h.step)).size} posição${hits.length > 1 ? 'ões' : ''}.` : 'Sem interferências no movimento.', hits.length ? 'err' : '');
    } catch (e) { this.toast(`Interferência: ${(e as Error).message}`, 'err'); }
    finally { this.anim.checking = false; this.renderTimeline(); this.renderSidePanel(); }
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
    const lx = Math.min(Math.max(8, x - (x > r.width ? r.left : 0)), r.width - 230), ly = Math.max(8, Math.min(Math.max(8, y - (y > r.height ? r.top : 0)), r.height - 60 - items.length * 40));
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
        if (ev.key === 'Escape') { if (this.replaceFlow) return this.cancelReplaceFace(); this.closeMenus(); this.selectedFeature = null; this.clearSel3d(); }
        else if ((ev.key === 'Backspace' || ev.key === 'Delete') && this.selectedFeature) { const f = this.doc.current.features.find((x) => x.id === this.selectedFeature); if (f) this.deleteFeature(f); }
        else if (ev.key.toLowerCase() === 'f' && this.sel3d.edges.length) this.filletSelected('fillet');
        else if (ev.key.toLowerCase() === 'h' && this.sel3d.body && !this.isAssembly) this.toggleHidden(this.sel3d.body);
        else if (ev.key === 'Tab' && !this.isAssembly) { ev.preventDefault(); this.cycleFilter(); }
        else if (!meta && ev.key.toLowerCase() === 't' && !this.isAssembly) this.toggleXray();
        else if (!meta && !this.isAssembly && ['b', 'f', 'e', 'a'].includes(ev.key.toLowerCase())) { const k = ev.key.toLowerCase(); this.setFilter(k === 'b' ? 'bodies' : k === 'f' ? 'faces' : k === 'e' ? 'edges' : 'all'); }
        return;
      }
      const map: Record<string, Tool> = { v: 'select', p: 'draw', l: 'line', r: 'rect', c: 'circle', g: 'polygon', o: 'slot', d: 'dimension', j: 'project', t: 'trim', x: 'erase' };
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
  if ('body' in f) return f.body;
  if (f.type === 'import') return f.id;
  return f.op === 'new' ? f.id : f.target ?? null;
}
function featureMini(f: Feature): string {
  if (f.type === 'extrude') return `${f.op === 'cut' ? 'corte ' : f.op === 'add' ? 'adição ' : ''}${f.throughAll ? '∞' : `${fmtDim('distance', f.depth)} mm`}`;
  if (f.type === 'revolve') return `${f.op === 'cut' ? 'corte ' : f.op === 'add' ? 'adição ' : ''}${fmtDim('angle', f.angle)}`;
  if (f.type === 'pushpull') return `${f.distance >= 0 ? '+' : '−'}${fmtDim('distance', Math.abs(f.distance))} mm`;
  if (f.type === 'shell') return `${fmtDim('distance', f.thickness)} mm`;
  if (f.type === 'mirror') return f.join ? 'fundido' : 'cópia';
  if (f.type === 'transform') return `${f.angle ? `${fmtDim('angle', f.angle)} ` : ''}${f.scale !== 1 ? `×${fmtDim('distance', f.scale)}` : ''}`.trim() || 'mover';
  if (f.type === 'split') return f.keep === 'both' ? '2 corpos' : 'um lado';
  if (f.type === 'replaceFace') return f.with.kind === 'plane' ? 'rente a plano' : 'rente a cilindro';
  if (f.type === 'sweep') return f.tube ? `Ø${fmtDim('distance', f.tube.outer)}${f.tube.inner > 0 ? ` parede ${fmtDim('distance', (f.tube.outer - f.tube.inner) / 2)}` : ''}` : 'varredura'; if (f.type === 'loft') return `${f.sketches.length} perfis`; if (f.type === 'import') return 'STEP';
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
