// Janela 3D: cena, câmeras, planos de trabalho, corpos e utilidades de projeção.
// Renderiza sob demanda (requestRender) para poupar bateria no iPad.

import * as THREE from 'three';
import type { Plane } from '../core/document';
import { planeNormal } from '../core/document';
import type { BodyMesh } from '../core/kernel/preview';
import type { Vec2 } from '../core/geom';

export type ViewMode = 'view' | 'sketch';

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
  private planeMeshes = new Map<string, THREE.Mesh>();
  private grid: THREE.Object3D | null = null;
  private axes: THREE.Object3D | null = null;
  private pending = false;
  private sketchPlane: Plane | null = null;
  /** Em modo esboço: meio-tamanho da janela ortográfica em mm (zoom). */
  private orthoHalf = 80;
  private raycaster = new THREE.Raycaster();
  private bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa7b8, metalness: 0.35, roughness: 0.55, side: THREE.DoubleSide });
  private bodySelMaterial = new THREE.MeshStandardMaterial({ color: 0xf2a65a, metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide });
  private edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2a2f38 });
  width = 1; height = 1;

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x14171c);
    container.appendChild(this.renderer.domElement);
    this.persp = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
    this.persp.position.set(160, 120, 200); this.persp.up.set(0, 1, 0); this.persp.lookAt(this.target);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
    this.scene.add(this.bodies, this.sketches, this.helpers);
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

  setPlanes(planes: Plane[]): void {
    for (const m of this.planeMeshes.values()) this.helpers.remove(m);
    this.planeMeshes.clear();
    for (const p of planes) {
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

  setBodies(meshes: BodyMesh[], selected: string | null): void {
    this.bodies.clear();
    for (const b of meshes) {
      const mesh = new THREE.Mesh(b.geometry, b.feature.id === selected ? this.bodySelMaterial : this.bodyMaterial);
      mesh.userData.featureId = b.feature.id;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(b.geometry, 25), this.edgeMaterial);
      mesh.add(edges);
      this.bodies.add(mesh);
    }
    this.requestRender();
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
      const dist = this.persp.position.distanceTo(this.target);
      const scale = (2 * Math.tan((this.persp.fov * Math.PI) / 360) * dist) / this.height;
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

  pickPlane(x: number, y: number): string | null {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects([...this.planeMeshes.values()], false);
    return hits.length ? (hits[0].object.userData.planeId as string) : null;
  }
  pickBody(x: number, y: number): string | null {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes: THREE.Object3D[] = []; this.bodies.children.forEach((m) => meshes.push(m));
    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits.length ? (hits[0].object.userData.featureId as string) : null;
  }
  /** Distância em pixels de um ponto 3D ao cursor. */
  screenDistance(p: THREE.Vector3, x: number, y: number): number { const s = this.worldToScreen(p); return Math.hypot(s.x - x, s.y - y); }

  setViewPreset(name: 'iso' | 'front' | 'top' | 'right'): void {
    const d = this.persp.position.distanceTo(this.target) || 300;
    const dir = name === 'iso' ? new THREE.Vector3(1, 0.8, 1) : name === 'front' ? new THREE.Vector3(0, 0, 1) : name === 'top' ? new THREE.Vector3(0, 1, 0.0001) : new THREE.Vector3(1, 0, 0);
    this.persp.position.copy(this.target).add(dir.normalize().multiplyScalar(d)); this.persp.lookAt(this.target); this.requestRender();
  }
}
