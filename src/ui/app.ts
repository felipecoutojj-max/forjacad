// Aplicativo: ferramentas, gestos, painel lateral, desfazer, autosave e arquivos.

import * as THREE from 'three';
import { Viewport } from './viewport';
import { SketchRenderer, emptySelection, type Selection, dimEndpoints, fmtDim } from './sketchRenderer';
import { icons, type IconName } from './icons';
import { createDocument, serialize, deserialize, getPlane, getSketch, addExtrude, type ForjaDocument, type Plane } from '../core/document';
import * as M from '../core/sketch/model';
import type { Sketch, Entity, Id, ConstraintKind, DimensionKind } from '../core/sketch/model';
import { solveSketch, type SolveResult } from '../core/sketch/solver';
import { recognizeStroke, type Primitive } from '../core/sketch/recognizer';
import { buildAllBodies } from '../core/kernel/preview';
import { toSTL, toOBJ } from '../core/export/mesh';
import { saveLocal, loadLocal, downloadFile, pickFile, safeFileName } from './storage';
import { type Vec2, v2, dist, distPointSegment, distPointArc, closestOnSegment, sub, add, scale, norm, angleOf, normAngle, TAU, round } from '../core/geom';

type Tool = 'select' | 'draw' | 'line' | 'rect' | 'circle' | 'dimension' | 'erase';

interface PointerInfo { id: number; type: string; x: number; y: number; startX: number; startY: number; moved: boolean; role: 'tool' | 'nav' | 'pan'; button: number; }
interface Hit { kind: 'point' | 'entity' | 'dimension'; id: Id; d: number; }

const H_V_SNAP_DEG = 6;
const TANGENT_SNAP_DEG = 12;

export class App {
  readonly doc: { current: ForjaDocument };
  readonly vp: Viewport;
  readonly sk = new SketchRenderer();
  readonly inactiveSketches = new Map<Id, SketchRenderer>();
  private undoStack: string[] = []; private redoStack: string[] = [];
  mode: 'view' | 'sketch' = 'view';
  activeSketch: Id | null = null;
  tool: Tool = 'draw';
  touchDraws = false;
  sel: Selection = emptySelection();
  selectedFeature: Id | null = null;
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
    top.append(this.button('Novo', () => this.newDocument()), this.button('Abrir', () => this.openFile()), this.button('Salvar', () => this.saveFile()), this.button('Exportar', (ev) => this.exportMenu(ev)));
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
    const t = el('div', `toast ${kind}`); t.textContent = msg; this.toasts.append(t); setTimeout(() => t.remove(), 3300);
  }

  // ---------- Estado e render ----------
  private get sketch(): Sketch | null { return this.activeSketch ? getSketch(this.doc.current, this.activeSketch) : null; }
  private get plane(): Plane | null { const s = this.sketch; return s ? getPlane(this.doc.current, s.plane) : null; }

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
  refreshAll(): void {
    const doc = this.doc.current;
    this.vp.setPlanes(doc.planes);
    this.vp.setBodies(buildAllBodies(doc), this.selectedFeature);
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

  private renderStatus(): void {
    const s = this.sketch;
    if (!s) { const n = this.doc.current.features.length; this.statusEl.textContent = n ? `${n} corpo${n > 1 ? 's' : ''}` : 'Toque em um plano para esboçar'; this.statusEl.className = 'status'; return; }
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
      g3.append(this.iconButton('done', 'Concluir', () => this.exitSketch(true)));
      this.toolbar.append(g1, g2, g3);
    } else {
      g1.append(this.iconButton('sketch', 'Esboço', (ev) => this.newSketchMenu(ev)));
      g1.append(this.iconButton('extrude', 'Extrudar', (ev) => this.extrudeMenu(ev)));
      g2.append(this.iconButton('view', 'Vistas', (ev) => this.viewMenu(ev)));
      g2.append(this.iconButton('fit', 'Enquadrar', () => this.vp.fitAll()));
      this.toolbar.append(g1, g2);
    }
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
      // Restrições aplicáveis à seleção.
      const cons = this.applicableConstraints();
      if (cons.length) {
        p.append(h3('Restrições'));
        const grid = el('div', 'list');
        for (const c of cons) grid.append(this.button(c.label, () => this.applyConstraint(c.kind, c.refs)));
        p.append(grid);
      }
      // Seleção: alternar construção, apagar.
      if (this.sel.entities.size || this.sel.points.size || this.sel.dimensions.size) {
        const row = el('div', 'row');
        if (this.sel.entities.size) row.append(this.button('Construção', () => this.toggleConstruction()));
        row.append(this.button('Apagar', () => this.deleteSelection(), 'btn danger'));
        p.append(row);
      }
      // Lista de restrições existentes.
      if (s.constraints.length) {
        p.append(h3(`Restrições (${s.constraints.length})`));
        const list = el('div', 'list');
        for (const k of s.constraints) {
          const it = el('div', 'item'); it.innerHTML = `<span class="name">${constraintName(k.kind)}</span><span class="mini">×</span>`;
          it.addEventListener('click', () => { this.pushUndo(); M.removeConstraint(s, k.id); this.solve(); this.refreshAll(); });
          list.append(it);
        }
        p.append(list);
      }
    } else {
      p.append(h3('Esboços'));
      const list = el('div', 'list');
      if (!doc.sketches.length) { const d = el('div', 'hint'); d.textContent = 'Nenhum esboço ainda. Toque em "Esboço" e escolha um plano, ou toque direto num plano.'; list.append(d); }
      for (const s of doc.sketches) {
        const it = el('div', 'item'); const pl = getPlane(doc, s.plane);
        it.innerHTML = `<span class="name">${s.name}</span><span class="mini">${pl.name}</span>`;
        it.addEventListener('click', () => this.enterSketch(s.id));
        list.append(it);
      }
      p.append(list);
      p.append(h3('Corpos'));
      const flist = el('div', 'list');
      if (!doc.features.length) { const d = el('div', 'hint'); d.textContent = 'Extrude um esboço fechado para criar o primeiro corpo.'; flist.append(d); }
      for (const f of doc.features) {
        const it = el('div', `item ${this.selectedFeature === f.id ? 'active' : ''}`);
        it.innerHTML = `<span class="name">${f.name}</span><span class="mini">${fmtDim('distance', f.depth)} mm</span>`;
        it.addEventListener('click', () => { this.selectedFeature = this.selectedFeature === f.id ? null : f.id; this.refreshAll(); });
        flist.append(it);
      }
      p.append(flist);
      const f = doc.features.find((x) => x.id === this.selectedFeature);
      if (f) {
        p.append(h3(f.name));
        const row = el('div', 'row'); const lab = document.createElement('label'); lab.textContent = 'Profundidade (mm)';
        const inp = document.createElement('input'); inp.type = 'number'; inp.step = '0.5'; inp.value = String(f.depth); inp.inputMode = 'decimal';
        inp.addEventListener('change', () => { const v = parseFloat(inp.value.replace(',', '.')); if (!isFinite(v) || v === 0) return; this.pushUndo(); f.depth = v; this.refreshAll(); });
        row.append(lab, inp); p.append(row);
        const row2 = el('div', 'row'); const lab2 = document.createElement('label'); lab2.textContent = 'Simétrico ao plano';
        const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = !!f.symmetric; chk.addEventListener('change', () => { this.pushUndo(); f.symmetric = chk.checked; this.refreshAll(); });
        row2.append(lab2, chk); p.append(row2);
        const row3 = el('div', 'row');
        row3.append(this.button('Editar esboço', () => this.enterSketch(f.sketch)));
        row3.append(this.button('Apagar', () => { this.pushUndo(); doc.features = doc.features.filter((x) => x.id !== f.id); this.selectedFeature = null; this.refreshAll(); }, 'btn danger'));
        p.append(row3);
      }
      const info = el('div', 'hint'); info.textContent = 'Unidades em milímetros. Autosave ligado neste aparelho. Use "Salvar" para gerar o arquivo .forja.'; p.append(info);
    }
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
    this.menu(ev.clientX, ev.clientY, doc.planes.map((p) => ({ label: `Esboço em ${p.name}`, action: () => this.createSketchOn(p.id) })));
  }
  createSketchOn(planeId: Id): void {
    this.pushUndo();
    const n = this.doc.current.sketches.length + 1;
    const s = M.createSketch(planeId, `Esboço ${n}`); this.doc.current.sketches.push(s);
    this.enterSketch(s.id);
  }
  enterSketch(id: Id): void {
    this.activeSketch = id; this.mode = 'sketch'; this.tool = 'draw'; this.sel = emptySelection(); this.pendingDimRefs = []; this.selectedFeature = null;
    const p = this.plane!; this.vp.enterSketch(p);
    this.solve(); this.refreshAll(); this.vp.fitAll();
  }
  exitSketch(removeEmpty: boolean): void {
    const s = this.sketch;
    if (s && removeEmpty && !s.entities.length) this.doc.current.sketches = this.doc.current.sketches.filter((x) => x.id !== s.id);
    this.activeSketch = null; this.mode = 'view'; this.sel = emptySelection(); this.pendingDimRefs = []; this.lastSolve = null;
    this.vp.exitSketch(); this.refreshAll(); this.vp.fitAll();
  }
  setTool(t: Tool): void { this.tool = t; this.pendingDimRefs = []; if (t !== 'select') this.sel = emptySelection(); this.refreshAll(); }

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
    // origem
    if (dist(uv, v2(0, 0)) < tol) { const p = M.addPoint(s, 0, 0); M.addConstraint(s, 'fixed', [p.id]); return { id: p.id, created: true }; }
    // sobre entidade
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
        // Centro perto de outro centro → concêntrico.
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
      // arco
      const a = pointFor(pr.a), b = pointFor(pr.b);
      if (a === b) continue;
      const c = M.addPoint(s, pr.c.x, pr.c.y);
      const e = pr.ccw ? M.addArc(s, c.id, a, b, pr.r) : M.addArc(s, c.id, b, a, pr.r); created.push(e);
    }
    // Tangência automática entre arcos e linhas que se encontram quase tangentes.
    for (const e of created) {
      if (e.type !== 'arc') continue;
      for (const pid of [e.start, e.end]) {
        const lines = s.entities.filter((o): o is M.LineEntity => o.type === 'line' && (o.a === pid || o.b === pid));
        for (const l of lines) {
          const c = M.getPoint(s, e.center), p = M.getPoint(s, pid);
          const radial = norm(sub(p, c)); const other = M.getPoint(s, l.a === pid ? l.b : l.a); const ldir = norm(sub(other, p));
          const cosang = Math.abs(radial.x * ldir.x + radial.y * ldir.y); // 0 = tangente
          if (Math.asin(Math.min(1, cosang)) * 180 / Math.PI < TANGENT_SNAP_DEG && !s.constraints.some((k) => k.kind === 'tangent' && k.refs.includes(l.id) && k.refs.includes(e.id)))
            autoCons.push(M.addConstraint(s, 'tangent', [l.id, e.id]).id);
        }
      }
    }
    let r = this.solve();
    if (!r || !r.converged) {
      // Restrições automáticas em conflito: remove e tenta sem elas.
      s.constraints = s.constraints.filter((k) => !autoCons.includes(k.id));
      r = this.solve();
      if (!r || !r.converged) { Object.assign(s, before); this.solve(); this.toast('Não consegui encaixar esse traço. Tente de novo.', 'err'); }
      else this.toast('Encaixes automáticos removidos para fechar a geometria.');
    }
    this.refreshAll();
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
    // dedo
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
      // Dois dedos: cancela traço iniciado por dedo.
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

  /** Toque simples em modo vista: escolhe plano (novo esboço) ou seleciona corpo. */
  private tapView(info: PointerInfo): void {
    if (this.mode !== 'view') return;
    const body = this.vp.pickBody(info.x, info.y);
    if (body) { this.selectedFeature = this.selectedFeature === body ? null : body; this.refreshAll(); return; }
    const plane = this.vp.pickPlane(info.x, info.y);
    if (plane) { const p = getPlane(this.doc.current, plane); this.menu(info.x + 8, info.y + 8, [{ label: `Novo esboço em ${p.name}`, action: () => this.createSketchOn(plane) }]); return; }
    if (this.selectedFeature) { this.selectedFeature = null; this.refreshAll(); }
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
        this.toolStart = null; this.previewSketchBackup = null; this.refreshAll();
        break;
      }
      case 'select': {
        if (this.dragPoint) { if (!info.moved) this.undoStack.pop(); this.dragPoint = null; this.solve(); this.refreshAll(); return; }
        if (!info.moved) this.tapSelect(uv, tol, s);
        break;
      }
      case 'erase': {
        const hit = this.hitTest(uv, tol, s);
        if (hit?.kind === 'entity') { this.pushUndo(); M.removeEntities(s, [hit.id]); this.solve(); this.refreshAll(); }
        else if (hit?.kind === 'point') { this.pushUndo(); const ents = s.entities.filter((e) => M.entityPoints(e).includes(hit.id)).map((e) => e.id); M.removeEntities(s, ents); this.solve(); this.refreshAll(); }
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
    if (!hit) { this.sel = emptySelection(); this.refreshAll(); return; }
    const set = hit.kind === 'point' ? this.sel.points : this.sel.entities;
    if (set.has(hit.id)) set.delete(hit.id); else set.add(hit.id);
    this.refreshAll();
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
    this.refreshAll();
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
      else if ((p1 && e2?.type === 'line') || (p2 && e1?.type === 'line')) { const p = p1 ?? p2!; const l = (e2?.type === 'line' ? e2 : e1) as M.LineEntity; finalRefs = [p.id, l.id]; kind = 'distance'; value = distPointSegment(p, M.getPoint(s, l.a), M.getPoint(s, l.b)); const a = M.getPoint(s, l.a), b = M.getPoint(s, l.b); const ab = sub(b, a); const L = Math.hypot(ab.x, ab.y) || 1; value = Math.abs(ab.x * (p.y - a.y) - ab.y * (p.x - a.x)) / L; }
      else if ((p1 && e2 && e2.type !== 'line') || (p2 && e1 && e1.type !== 'line')) { const p = p1 ?? p2!; const c = (e2 && e2.type !== 'line' ? e2 : e1) as M.CircleEntity; finalRefs = [p.id, c.center]; kind = 'distance'; value = dist(p, M.getPoint(s, c.center)); }
      else if (e1 && e2 && e1.type !== 'line' && e2.type !== 'line') { finalRefs = [e1.center, e2.center]; kind = 'distance'; value = dist(M.getPoint(s, e1.center), M.getPoint(s, e2.center)); }
    }
    if (!kind) { this.toast('Combinação sem cota possível.'); this.sel = emptySelection(); this.refreshAll(); return; }
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
      this.sel = emptySelection(); this.refreshAll();
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
      this.sel = emptySelection(); this.refreshAll();
    }, () => { this.pushUndo(); M.removeDimension(s, id); this.solve(); this.sel = emptySelection(); this.refreshAll(); });
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
      // Alinhar dois pontos: linha de construção entre eles com a restrição.
      const l = M.addLine(s, refs[0], refs[1]); l.construction = true; M.addConstraint(s, kind, [l.id]);
    } else M.addConstraint(s, kind, refs);
    const r = this.solve();
    if (!r?.converged) { Object.assign(s, before); this.solve(); this.toast('Restrição conflita com as existentes.', 'err'); }
    this.sel = emptySelection(); this.refreshAll();
  }

  private toggleConstruction(): void {
    const s = this.sketch; if (!s) return; this.pushUndo();
    for (const id of this.sel.entities) { const e = M.getEntity(s, id); e.construction = !e.construction; }
    this.refreshAll();
  }
  private deleteSelection(): void {
    const s = this.sketch; if (!s) return; this.pushUndo();
    const ents = new Set(this.sel.entities);
    for (const pid of this.sel.points) for (const e of s.entities) if (M.entityPoints(e).includes(pid)) ents.add(e.id);
    for (const did of this.sel.dimensions) M.removeDimension(s, did);
    M.removeEntities(s, [...ents]);
    this.sel = emptySelection(); this.solve(); this.refreshAll();
  }

  // ---------- Extrusão ----------
  private extrudeActive(): void {
    const s = this.sketch; if (!s) return;
    const id = s.id; this.exitSketch(true);
    if (this.doc.current.sketches.some((x) => x.id === id)) this.extrudeSketch(id);
  }
  private extrudeMenu(ev: MouseEvent): void {
    const doc = this.doc.current;
    if (!doc.sketches.length) return this.toast('Crie um esboço fechado primeiro.');
    this.menu(ev.clientX, ev.clientY, doc.sketches.map((s) => ({ label: `Extrudar ${s.name}`, action: () => this.extrudeSketch(s.id) })));
  }
  private extrudeSketch(id: Id): void {
    const doc = this.doc.current;
    this.valuePopover(this.vp.width / 2, this.vp.height / 2, 10, 'mm', (depth) => {
      this.pushUndo();
      const f = addExtrude(doc, id, depth);
      const bodies = buildAllBodies(doc);
      if (!bodies.some((b) => b.feature.id === f.id)) { doc.features = doc.features.filter((x) => x.id !== f.id); this.undoStack.pop(); this.toast('O esboço não tem contorno fechado para extrudar.', 'err'); return; }
      this.selectedFeature = f.id; this.refreshAll(); this.vp.fitAll();
    });
  }

  // ---------- Arquivos ----------
  newDocument(): void {
    this.confirm('Novo documento', 'Descartar o documento atual? O autosave será substituído. Salve antes se precisar.', () => {
      this.doc.current = createDocument(); this.undoStack = []; this.redoStack = []; this.activeSketch = null; this.mode = 'view'; this.selectedFeature = null; this.sel = emptySelection(); this.vp.exitSketch(); this.titleEl.value = this.doc.current.name; this.refreshAll(); this.vp.fitAll();
    });
  }
  async openFile(): Promise<void> {
    const f = await pickFile('.forja,application/json'); if (!f) return;
    try { const d = deserialize(f.text); this.doc.current = d; this.undoStack = []; this.redoStack = []; this.activeSketch = null; this.mode = 'view'; this.selectedFeature = null; this.vp.exitSketch(); this.titleEl.value = d.name; this.refreshAll(); this.vp.fitAll(); this.toast(`Aberto: ${f.name}`); }
    catch (e) { this.toast(`Não abriu: ${(e as Error).message}`, 'err'); }
  }
  saveFile(): void { downloadFile(`${safeFileName(this.doc.current.name)}.forja`, serialize(this.doc.current), 'application/json'); this.toast('Arquivo .forja gerado.'); }
  exportMenu(ev: MouseEvent): void {
    this.menu(ev.clientX, ev.clientY, [
      { label: 'STL (impressão, visualizadores)', action: () => this.exportMesh('stl') },
      { label: 'OBJ (ZBrush, com grupos)', action: () => this.exportMesh('obj') },
    ]);
  }
  private exportMesh(fmt: 'stl' | 'obj'): void {
    const bodies = buildAllBodies(this.doc.current);
    if (!bodies.length) return this.toast('Nenhum corpo para exportar. Extrude um esboço antes.', 'err');
    const named = bodies.map((b) => ({ name: b.feature.name, geometry: b.geometry }));
    const base = safeFileName(this.doc.current.name);
    if (fmt === 'stl') downloadFile(`${base}.stl`, toSTL(named), 'model/stl'); else downloadFile(`${base}.obj`, toOBJ(named), 'model/obj');
    this.toast(`${fmt.toUpperCase()} gerado.`);
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
    d.innerHTML = `<h2>${title}</h2><div>${text}</div>`;
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
      const t = ev.target as HTMLElement; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const meta = ev.metaKey || ev.ctrlKey;
      if (meta && ev.key.toLowerCase() === 'z') { ev.preventDefault(); if (ev.shiftKey) this.redo(); else this.undo(); return; }
      if (meta && ev.key.toLowerCase() === 's') { ev.preventDefault(); this.saveFile(); return; }
      if (this.mode !== 'sketch') return;
      const map: Record<string, Tool> = { v: 'select', p: 'draw', l: 'line', r: 'rect', c: 'circle', d: 'dimension', x: 'erase' };
      const k = ev.key.toLowerCase();
      if (map[k]) this.setTool(map[k]);
      else if (ev.key === 'Escape') { if (this.tool !== 'select') this.setTool('select'); else { this.sel = emptySelection(); this.refreshAll(); } }
      else if (ev.key === 'Backspace' || ev.key === 'Delete') this.deleteSelection();
      else if (ev.key === 'Enter') this.exitSketch(true);
    });
  }
}

function el(tag: string, cls = ''): HTMLElement { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function h3(text: string): HTMLElement { const h = document.createElement('h3'); h.textContent = text; return h; }
function constraintName(k: ConstraintKind): string {
  return ({ horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Paralelas', perpendicular: 'Perpendiculares', equal: 'Iguais', tangent: 'Tangentes', concentric: 'Concêntricos', pointOnLine: 'Ponto na linha', pointOnCircle: 'Ponto no círculo', midpoint: 'Ponto médio', fixed: 'Fixo' } as Record<ConstraintKind, string>)[k];
}
export { THREE, normAngle, TAU };
