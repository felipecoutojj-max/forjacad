// Tipos trocados entre o app e o worker do kernel. Sem dependência do OpenCASCADE.

import type { Id } from '../../sketch/model';
import type { ForjaDocument, V3 } from '../../document';

export type FaceType = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other';

export interface FaceData {
  index: number; type: FaceType; area: number;
  /** Primeiro triângulo e quantidade (os triângulos de uma face são contíguos em `indices`). */
  triStart: number; triCount: number;
  /** Para faces planas: origem, normal para fora e eixos do plano. */
  origin?: V3; normal?: V3; u?: V3; v?: V3;
  /** Para cilindros: eixo e raio. */
  axisOrigin?: V3; axisDir?: V3; radius?: number;
  /** Centro geométrico aproximado (média dos vértices da malha). */
  center: V3;
}

export interface EdgeData {
  index: number;
  /** Polilinha xyz achatada. */
  points: Float32Array;
  mid: V3; len: number;
}

export interface BodyData {
  id: Id; name: string;
  positions: Float32Array; normals: Float32Array; indices: Uint32Array;
  /** Índice da face de cada triângulo. */
  triFace: Uint32Array;
  faces: FaceData[]; edges: EdgeData[];
  volume: number; area: number;
  bbox: [V3, V3];
}

export interface FeatureError { feature: Id; message: string; }

/** Vista para projeção: `n` aponta do objeto para quem olha, `up` é o alto da folha. */
export interface ViewSpec { name: string; n: V3; up: V3; }
export interface ProjCircle { cx: number; cy: number; r: number; hidden: boolean; }
/** Resultado da projeção com remoção de linhas ocultas, em mm do modelo, no plano da vista (y para cima). */
export interface ProjectedView {
  name: string;
  visible: Float32Array[]; hidden: Float32Array[]; tangent: Float32Array[];
  circles: ProjCircle[];
  /** [minX, minY, maxX, maxY] */
  bbox: [number, number, number, number];
}

export interface RebuildResult { bodies: BodyData[]; errors: FeatureError[]; ms: number; }

/** Conjunto para projeção/exportação: peças (documentos) e instâncias com matriz 4×4 em linha-maior. */
export interface AssemblyPayload { parts: { id: Id; doc: ForjaDocument }[]; instances: { part: Id; matrix: number[] }[]; }

export type KernelRequest =
  | { id: number; type: 'rebuild'; doc: ForjaDocument }
  | { id: number; type: 'export'; format: 'step' }
  | { id: number; type: 'project'; views: ViewSpec[] }
  | { id: number; type: 'projectAssembly'; assembly: AssemblyPayload; views: ViewSpec[] }
  | { id: number; type: 'exportAssembly'; assembly: AssemblyPayload }
  | { id: number; type: 'interference'; parts: AssemblyPayload['parts']; steps: { part: Id; matrix: number[] }[][] };

export interface InterferenceHit { step: number; a: number; b: number; volume: number; }

export type KernelResponse =
  | { id: 0; type: 'ready'; ms: number }
  | { id: 0; type: 'failed'; message: string }
  | { id: number; type: 'rebuilt'; result: RebuildResult }
  | { id: number; type: 'exported'; data: string; mime: string }
  | { id: number; type: 'projected'; views: ProjectedView[] }
  | { id: number; type: 'interference'; hits: InterferenceHit[] }
  | { id: number; type: 'error'; message: string };
