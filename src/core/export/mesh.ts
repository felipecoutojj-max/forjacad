// Exportação de malhas: STL binário (impressão 3D, visualizadores) e OBJ (ZBrush, com grupos).
// Trabalha sobre arrays puros, então serve tanto às malhas do kernel quanto às da prévia.

import type * as THREE from 'three';
import type { BodyData } from '../kernel/occ/types';

export interface MeshGroup { name: string; /** em triângulos */ start: number; count: number; }
export interface MeshData { name: string; positions: Float32Array; normals?: Float32Array; indices: Uint32Array; groups?: MeshGroup[]; }

export function fromGeometry(name: string, geo: THREE.BufferGeometry): MeshData {
  const pos = geo.getAttribute('position').array as Float32Array;
  const n = pos.length / 3;
  let indices: Uint32Array;
  if (geo.index) indices = Uint32Array.from(geo.index.array as ArrayLike<number>);
  else { indices = new Uint32Array(n); for (let i = 0; i < n; i++) indices[i] = i; }
  const groups: MeshGroup[] = geo.groups.length ? geo.groups.map((g, i) => ({ name: g.materialIndex === 0 ? `tampas${i}` : `lateral${i}`, start: g.start / 3, count: (g.count === Infinity ? indices.length - g.start : g.count) / 3 })) : [];
  const nrm = geo.getAttribute('normal'); const normals = nrm ? (nrm.array as Float32Array) : undefined;
  return { name, positions: pos, normals, indices, groups };
}

/** Malha de um corpo do kernel, com um grupo por face B-rep (vira polygroup no ZBrush). */
export function fromBody(b: BodyData): MeshData {
  return { name: b.name, positions: b.positions, normals: b.normals, indices: b.indices, groups: b.faces.map((f) => ({ name: `face${f.index + 1}`, start: f.triStart, count: f.triCount })) };
}

/** STL binário com todos os corpos juntos. */
export function toSTL(meshes: MeshData[]): ArrayBuffer {
  const count = meshes.reduce((acc, m) => acc + m.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + count * 50); const dv = new DataView(buf);
  const header = new TextEncoder().encode('ForjaCAD STL binario'); new Uint8Array(buf, 0, 80).set(header.subarray(0, 80));
  dv.setUint32(80, count, true);
  let off = 84;
  for (const m of meshes) {
    const p = m.positions, ix = m.indices;
    for (let i = 0; i < ix.length; i += 3) {
      const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
      dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true); off += 12;
      for (const k of [a, b, c]) { dv.setFloat32(off, p[k], true); dv.setFloat32(off + 4, p[k + 1], true); dv.setFloat32(off + 8, p[k + 2], true); off += 12; }
      dv.setUint16(off, 0, true); off += 2;
    }
  }
  return buf;
}

/** OBJ com um objeto por corpo e grupos por face (o ZBrush lê grupos como polygroups). */
export function toOBJ(meshes: MeshData[]): string {
  const lines: string[] = ['# ForjaCAD OBJ', '# unidades: mm'];
  let vbase = 1;
  for (const m of meshes) {
    const safe = m.name.replace(/\s+/g, '_');
    lines.push(`o ${safe}`);
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) lines.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`);
    const groups = m.groups?.length ? m.groups : [{ name: 'todas', start: 0, count: m.indices.length / 3 }];
    for (const g of groups) {
      lines.push(`g ${safe}_${g.name}`);
      const end = (g.start + g.count) * 3;
      for (let i = g.start * 3; i < end; i += 3) lines.push(`f ${vbase + m.indices[i]} ${vbase + m.indices[i + 1]} ${vbase + m.indices[i + 2]}`);
    }
    vbase += p.length / 3;
  }
  return lines.join('\n') + '\n';
}

const fmt = (v: number) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(4).replace(/\.?0+$/, ''));
