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

export interface RebuildResult { bodies: BodyData[]; errors: FeatureError[]; ms: number; }

export type KernelRequest =
  | { id: number; type: 'rebuild'; doc: ForjaDocument }
  | { id: number; type: 'export'; format: 'step' };

export type KernelResponse =
  | { id: 0; type: 'ready'; ms: number }
  | { id: 0; type: 'failed'; message: string }
  | { id: number; type: 'rebuilt'; result: RebuildResult }
  | { id: number; type: 'exported'; data: string; mime: string }
  | { id: number; type: 'error'; message: string };
