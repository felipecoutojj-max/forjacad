// Janela 3D: cena, câmeras, planos de trabalho, corpos e utilidades de projeção.
// Renderiza sob demanda (requestRender) para poupar bateria no iPad.

import * as THREE from 'three';
import type { Plane } from '../core/document';
import { planeNormal } from '../core/document';
import type { BodyData } from '../core/kernel/occ/types';
import type { Vec2 } from '../core/geom';
import type { Id } from '../core/sketch/model';

export type ViewMode = 'view' | 'sketch';

/** Corpo para desenhar: malha do kernel (com `data`) ou prévia (só geometria). */
export interface RenderBody { id: Id; name: string; geometry: THREE.BufferGeometry; data?: BodyData; /** 4×4 em linha-maior (instância de montagem). */ matrix?: number[]; }

/** Seleção em modo vista. Arestas selecionadas pertencem sempre a um único corpo. */
export interface Sel3D { body: Id | null; face: { body: Id; index: number } | null; edges: { body: Id; index: number }[]; }
export const emptySel3D = (): Sel3D => ({ body: null, face: null, edges: [] });

export interface FaceHit { body: Id; index: number; distance: number; point: THREE.Vector3; }
export interface EdgeHit { body: Id; index: number; px: number; }

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly persp: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  mode: ViewMode = 'view';
  readonly target = new THREE.Vector3(0, 0, 0);
  readonly bodies = new THREE.Group();
  readonly sketches = new THREE.Group();
  readonly helpers = new THREE.Group();
  readonly highlights = new THREE.Group();
  private planeMeshes = new Map<string, THREE.Mesh>();
  private bodyMeshes = new Map<Id, THREE.Mesh>();
  private bodyData = new Map<Id, BodyData>();
  private bodyMatrix = new Map<Id, THREE.Matrix4>();
  private grid: THREE.Object3D | null = null;
  private axes: THREE.Object3D | null = null;
  private pending = false;
  private sketchPlane: Plane | null = null;
  /** Em modo esboço: meio-tamanho da janela ortográfica em mm (zoom). */
  private orthoHalf = 80;
  private raycaster = new THREE.Raycaster();
  private bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa7b8, metalness: 0.35, roughness: 0.55, side: THREE.DoubleSide });
  private bodySelMaterial = new THREE.MeshStandardMaterial({ color: 0xc9a06a, metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide });
  private faceSelMaterial = new THREE.MeshBasicMaterial({ color: 0xf28c28, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  private edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2a2f38 });
  private edgeSelMaterial = new THREE.LineBasicMaterial({ color: 0xffb15c, depthTest: false });
  width = 1; height = 1;

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x14171c);
    container.appendChild(this.renderer.domElement);
    this.persp = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
    this.persp.position.set(160, 120, 200); this.persp.up.set(0, 1, 0); this.persp.lookAt(this.target);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
    this.scene.add(this.bodies, this.sketches, this.helpers, this.highlights);
    this.highlights.renderOrder = 5;
    const hemi = new THREE.HemisphereLight(0xdfe6f0, 0x2a2f38, 1.1); this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(200, 300, 250); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffe2c0, 0.5); fill.position.set(-250, 100, -150); this.scene.add(fill);
    this.buildHelpers();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  get camera(): THREE.Camera { return this.mode === 'sketch' ? this.ortho : this.persp; }

  private buildHelpers(): void {
    this.grid = new THREE.GridHelper(400, 40, 0x3a4150, 0x262b35); this.grid.position.y = -0.01; this.helpers.add(this.grid);
    const axes = new THREE.Group();
    const mk = (dir: [number, number, number], color: number) => { const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...dir).multiplyScalar(60)]); axes.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color }))); };
    mk([1, 0, 0], 0xef6b6b); mk([0, 1, 0], 0x5fcf80); mk([0, 0, 1], 0x4aa3ff);
    this.axes = axes; this.helpers.add(axes);
  }

  /** Desenha só os planos base; planos de face existem no documento mas não viram quadrados na cena. */
  setPlanes(planes: Plane[]): void {
    for (const m of this.planeMeshes.values()) this.helpers.remove(m);
    this.planeMeshes.clear();
    for (const p of planes) {
      if (p.kind === 'face') continue;
      const geo = new THREE.PlaneGeometry(120, 120);
      const mat = new THREE.MeshBasicMaterial({ color: 0x4aa3ff, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      const n = planeNormal(p);
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...p.u), new THREE.Vector3(...p.v), new THREE.Vector3(...n)); m.setPosition(new THREE.Vector3(...p.origin));
      mesh.applyMatrix4(m); mesh.userData.planeId = p.id; mesh.name = p.name;
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x4aa3ff, transparent: true, opacity: 0.35 }));
      mesh.add(edge);
      this.helpers.add(mesh); this.planeMeshes.set(p.id, mesh);
    }
    this.requestRender();
  }

  showPlanes(visible: boolean, except?: string): void {
    for (const [id, m] of this.planeMeshes) m.visible = visible || id === except;
    if (this.grid) this.grid.visible = visible;
    if (this.axes) this.axes.visible = visible;
    this.requestRender();
  }
  highlightPlane(id: string | null): void {
    for (const [pid, m] of this.planeMeshes) (m.material as THREE.MeshBasicMaterial).opacity = pid === id ? 0.18 : 0.06;
    this.requestRender();
  }

  /** Substitui os corpos da cena e aplica a seleção (corpo, face, arestas). */
  setBodies(list: RenderBody[], sel: Sel3D): void {
    this.bodies.clear(); this.bodyMeshes.clear(); this.bodyData.clear(); this.bodyMatrix.clear();
    // A grade vira piso: fica logo abaixo do ponto mais baixo dos corpos.
    let minY = 0;
    for (const b of list) {
      b.geometry.computeBoundingBox(); const bb = b.geometry.boundingBox?.clone(); if (!bb) continue;
      if (b.matrix) bb.applyMatrix4(new THREE.Matrix4().fromArray(b.matrix).transpose());
      minY = Math.min(minY, bb.min.y);
    }
    if (this.grid) this.grid.position.y = minY - 0.5;
    for (const b of list) {
      const mesh = new THREE.Mesh(b.geometry, b.id === sel.body ? this.bodySelMaterial : this.bodyMaterial);
      mesh.userData.bodyId = b.id;
      const mat = b.matrix ? new THREE.Matrix4().fromArray(b.matrix).transpose() : new THREE.Matrix4();
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(mat); this.bodyMatrix.set(b.id, mat);
      if (b.data) {
        this.bodyData.set(b.id, b.data);
        const segs: number[] = [];
        for (const e of b.data.edges) for (let i = 0; i + 5 < e.points.length; i += 3) segs.push(e.points[i], e.points[i + 1], e.points[i + 2], e.points[i + 3], e.points[i + 4], e.points[i + 5]);
        if (segs.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3)); mesh.add(new THREE.LineSegments(g, this.edgeMaterial)); }
      } else {
        mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(b.geometry, 25), this.edgeMaterial));
      }
      this.bodies.add(mesh); this.bodyMeshes.set(b.id, mesh);
    }
    this.bodies.updateMatrixWorld(true);
    this.setSelection(sel);
  }

  bodyMatrixOf(id: Id): THREE.Matrix4 { return this.bodyMatrix.get(id) ?? new THREE.Matrix4(); }

  /** Move corpos já na cena (animação): só troca matrizes, sem reconstruir geometria. */
  updateMatrices(map: Map<Id, number[]>): void {
    for (const [id, m] of map) { const mesh = this.bodyMeshes.get(id); if (!mesh) continue; const mat = new THREE.Matrix4().fromArray(m).transpose(); mesh.matrix.copy(mat); this.bodyMatrix.set(id, mat); }
    this.bodies.updateMatrixWorld(true); this.requestRender();
  }
  /** Fluxo de vídeo do canvas, para gravar a animação. */
  captureStream(fps = 30): MediaStream | null {
    const c = this.renderer.domElement as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream };
    return typeof c.captureStream === 'function' ? c.captureStream(fps) : null;
  }

  /** Redesenha só os destaques de face e aresta. */
  setSelection(sel: Sel3D): void {
    this.highlights.clear();
    for (const [id, mesh] of this.bodyMeshes) mesh.material = id === sel.body ? this.bodySelMaterial : this.bodyMaterial;
    if (sel.face) {
      const data = this.bodyData.get(sel.face.body); const mesh = this.bodyMeshes.get(sel.face.body);
      const f = data?.faces[sel.face.index];
      if (data && mesh && f) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', mesh.geometry.getAttribute('position'));
        g.setIndex(new THREE.BufferAttribute(data.indices.slice(f.triStart * 3, (f.triStart + f.triCount) * 3), 1));
        const hl = new THREE.Mesh(g, this.faceSelMaterial); hl.renderOrder = 5; hl.matrixAutoUpdate = false; hl.matrix.copy(mesh.matrix); this.highlights.add(hl);
      }
    }
    for (const e of sel.edges) {
      const data = this.bodyData.get(e.body); const ed = data?.edges[e.index]; if (!ed) continue;
      const mat = this.bodyMatrixOf(e.body);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(ed.points, 3)); g.applyMatrix4(mat);
      const line = new THREE.Line(g, this.edgeSelMaterial); line.renderOrder = 6; this.highlights.add(line);
      // Pontas marcadas para a aresta ficar visível mesmo fininha.
      for (const k of [0, ed.points.length - 3]) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(this.worldPerPixel() * 3, 8, 6), this.edgeSelMaterial as unknown as THREE.Material);
        s.position.set(ed.points[k], ed.points[k + 1], ed.points[k + 2]).applyMatrix4(mat); s.renderOrder = 6; this.highlights.add(s);
      }
    }
    this.requestRender();
  }

  /** Tamanho aproximado de um pixel em mm no alvo da câmera (modo vista). */
  worldPerPixel(): number {
    if (this.mode === 'sketch') return this.mmPerPixel();
    const dist = this.persp.position.distanceTo(this.target);
    return (2 * Math.tan((this.persp.fov * Math.PI) / 360) * dist) / this.height;
  }

  resize(): void {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h; this.persp.updateProjectionMatrix();
    this.updateOrtho();
    this.requestRender();
  }

  private updateOrtho(): void {
    const aspect = this.width / this.height;
    this.ortho.left = -this.orthoHalf * aspect; this.ortho.right = this.orthoHalf * aspect;
    this.ortho.top = this.orthoHalf; this.ortho.bottom = -this.orthoHalf;
    this.ortho.updateProjectionMatrix();
  }

  requestRender(): void {
    if (this.pending) return; this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.renderer.render(this.scene, this.camera); this.onAfterRender?.(); });
  }
  onAfterRender: (() => void) | null = null;

  // ---------- Câmera: modo vista ----------
  orbit(dx: number, dy: number): void {
    const offset = this.persp.position.clone().sub(this.target);
    const sph = new THREE.Spherical().setFromVector3(offset);
    sph.theta -= dx * 0.005; sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi - dy * 0.005));
    this.persp.position.copy(this.target).add(new THREE.Vector3().setFromSpherical(sph));
    this.persp.lookAt(this.target); this.requestRender();
  }
  pan(dx: number, dy: number): void {
    if (this.mode === 'sketch') {
      const mm = this.mmPerPixel();
      const right = new THREE.Vector3(), up = new THREE.Vector3();
      this.ortho.matrixWorld.extractBasis(right, up, new THREE.Vector3());
      const shift = right.multiplyScalar(-dx * mm).add(up.multiplyScalar(dy * mm));
      this.ortho.position.add(shift); this.target.add(shift);
    } else {
      const scale = this.worldPerPixel();
      const right = new THREE.Vector3(), up = new THREE.Vector3();
      this.persp.matrixWorld.extractBasis(right, up, new THREE.Vector3());
      const shift = right.multiplyScalar(-dx * scale).add(up.multiplyScalar(dy * scale));
      this.persp.position.add(shift); this.target.add(shift);
    }
    this.requestRender();
  }
  /** factor > 1 aproxima. `at` (pixels) mantém o ponto sob o dedo parado. */
  zoom(factor: number, at?: { x: number; y: number }): void {
    if (this.mode === 'sketch' && this.sketchPlane) {
      const before = at ? this.screenToPlane(at.x, at.y, this.sketchPlane) : null;
      this.orthoHalf = Math.max(2, Math.min(5000, this.orthoHalf / factor)); this.updateOrtho();
      if (before && at) {
        const after = this.screenToPlane(at.x, at.y, this.sketchPlane);
        if (after) { const du = before.x - after.x, dv = before.y - after.y; const p = this.sketchPlane; const shift = new THREE.Vector3(...p.u).multiplyScalar(du).add(new THREE.Vector3(...p.v).multiplyScalar(dv)); this.ortho.position.add(shift); this.target.add(shift); }
      }
    } else {
      const offset = this.persp.position.clone().sub(this.target);
      const d = Math.max(5, Math.min(10000, offset.length() / factor));
      this.persp.position.copy(this.target).add(offset.normalize().multiplyScalar(d));
    }
    this.requestRender();
  }

  fitAll(): void {
    const box = new THREE.Box3();
    this.bodies.traverse((o) => { if ((o as THREE.Mesh).isMesh) box.expandByObject(o); });
    this.sketches.traverse((o) => { if ((o as THREE.Line).isLine) box.expandByObject(o); });
    if (box.isEmpty()) box.set(new THREE.Vector3(-60, -60, -60), new THREE.Vector3(60, 60, 60));
    const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3()).length() || 100;
    if (this.mode === 'sketch') {
      this.orthoHalf = size * 0.6; this.updateOrtho();
      const n = this.ortho.getWorldDirection(new THREE.Vector3()).negate();
      this.target.copy(center); this.ortho.position.copy(center).add(n.multiplyScalar(500)); this.ortho.lookAt(center);
    } else {
      this.target.copy(center);
      const dir = this.persp.position.clone().sub(this.target).normalize(); if (dir.lengthSq() === 0) dir.set(1, 0.8, 1).normalize();
      this.persp.position.copy(center).add(dir.multiplyScalar(size * 1.6)); this.persp.lookAt(center);
    }
    this.requestRender();
  }

  // ---------- Modo esboço ----------
  enterSketch(plane: Plane): void {
    this.mode = 'sketch'; this.sketchPlane = plane;
    const n = new THREE.Vector3(...planeNormal(plane)); const up = new THREE.Vector3(...plane.v);
    const origin = new THREE.Vector3(...plane.origin);
    this.target.copy(origin);
    this.ortho.position.copy(origin).add(n.clone().multiplyScalar(500));
    this.ortho.up.copy(up); this.ortho.lookAt(origin);
    this.orthoHalf = 80; this.updateOrtho();
    this.showPlanes(false, plane.id); this.highlightPlane(null);
    this.requestRender();
  }
  exitSketch(): void {
    this.mode = 'view'; this.sketchPlane = null; this.showPlanes(true); this.requestRender();
  }

  /** Milímetros por pixel na tela (modo esboço). */
  mmPerPixel(): number { return (this.ortho.right - this.ortho.left) / this.width; }

  /** Pixel da tela → coordenadas (u, v) no plano. */
  screenToPlane(x: number, y: number, plane: Plane): Vec2 | null {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const n = new THREE.Vector3(...planeNormal(plane)); const origin = new THREE.Vector3(...plane.origin);
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, origin);
    const hit = this.raycaster.ray.intersectPlane(pl, new THREE.Vector3());
    if (!hit) return null;
    const rel = hit.sub(origin);
    return { x: rel.dot(new THREE.Vector3(...plane.u)), y: rel.dot(new THREE.Vector3(...plane.v)) };
  }
  /** Coordenadas (u, v) no plano → pixel da tela. */
  planeToScreen(plane: Plane, u: number, v: number): { x: number; y: number } {
    const p = new THREE.Vector3(...plane.origin).add(new THREE.Vector3(...plane.u).multiplyScalar(u)).add(new THREE.Vector3(...plane.v).multiplyScalar(v));
    return this.worldToScreen(p);
  }
  worldToScreen(p: THREE.Vector3): { x: number; y: number } {
    const q = p.clone().project(this.camera);
    return { x: ((q.x + 1) / 2) * this.width, y: ((1 - q.y) / 2) * this.height };
  }

  private setRay(x: number, y: number): void {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  pickPlane(x: number, y: number): string | null {
    this.setRay(x, y);
    const hits = this.raycaster.intersectObjects([...this.planeMeshes.values()], false);
    return hits.length ? (hits[0].object.userData.planeId as string) : null;
  }

  /** Face sob o cursor (corpo do kernel). Para corpos de prévia devolve índice -1. */
  pickFace(x: number, y: number): FaceHit | null {
    this.setRay(x, y);
    const hits = this.raycaster.intersectObjects([...this.bodyMeshes.values()], false);
    if (!hits.length) return null;
    const h = hits[0]; const body = h.object.userData.bodyId as Id; const data = this.bodyData.get(body);
    const index = data && h.faceIndex != null ? data.triFace[h.faceIndex] : -1;
    return { body, index, distance: h.distance, point: h.point };
  }

  /** Aresta a menos de `tolPx` pixels do cursor, ignorando as escondidas atrás de faces. */
  pickEdge(x: number, y: number, tolPx: number, faceHit: FaceHit | null): EdgeHit | null {
    let best: EdgeHit | null = null; let bestPx = tolPx;
    const cam = this.camera; const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Vector3();
    for (const [body, data] of this.bodyData) {
      const mat = this.bodyMatrixOf(body);
      for (const e of data.edges) {
        const pts = e.points;
        for (let i = 0; i + 5 < pts.length; i += 3) {
          a.set(pts[i], pts[i + 1], pts[i + 2]).applyMatrix4(mat); b.set(pts[i + 3], pts[i + 4], pts[i + 5]).applyMatrix4(mat);
          const sa = this.worldToScreen(a), sb = this.worldToScreen(b);
          const dx = sb.x - sa.x, dy = sb.y - sa.y; const L2 = dx * dx + dy * dy;
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - sa.x) * dx + (y - sa.y) * dy) / L2)) : 0;
          const px = Math.hypot(sa.x + t * dx - x, sa.y + t * dy - y);
          if (px >= bestPx) continue;
          // Oclusão: ponto da aresta mais longe da câmera que a face tocada (com folga) fica escondido.
          if (faceHit) { q.copy(a).lerp(b, t); const d = this.mode === 'sketch' ? 0 : q.distanceTo(camPos); if (d > faceHit.distance + Math.max(0.5, faceHit.distance * 0.004)) continue; }
          bestPx = px; best = { body, index: e.index, px };
        }
      }
    }
    return best;
  }

  bodyDataOf(id: Id): BodyData | undefined { return this.bodyData.get(id); }

  /** Distância em pixels de um ponto 3D ao cursor. */
  screenDistance(p: THREE.Vector3, x: number, y: number): number { const s = this.worldToScreen(p); return Math.hypot(s.x - x, s.y - y); }

  setViewPreset(name: 'iso' | 'front' | 'top' | 'right'): void {
    const d = this.persp.position.distanceTo(this.target) || 300;
    const dir = name === 'iso' ? new THREE.Vector3(1, 0.8, 1) : name === 'front' ? new THREE.Vector3(0, 0, 1) : name === 'top' ? new THREE.Vector3(0, 1, 0.0001) : new THREE.Vector3(1, 0, 0);
    this.persp.position.copy(this.target).add(dir.normalize().multiplyScalar(d)); this.persp.lookAt(this.target); this.requestRender();
  }
}
