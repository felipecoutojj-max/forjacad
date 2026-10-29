// Exportação de malhas: STL binário (impressão 3D, visualizadores) e OBJ (ZBrush, com grupos).

import * as THREE from 'three';

export interface NamedMesh { name: string; geometry: THREE.BufferGeometry; }

function triangles(geo: THREE.BufferGeometry): Float32Array {
  const g = geo.index ? geo.toNonIndexed() : geo;
  return g.getAttribute('position').array as Float32Array;
}

/** STL binário com todos os corpos juntos. */
export function toSTL(meshes: NamedMesh[]): ArrayBuffer {
  const tris = meshes.map((m) => triangles(m.geometry));
  const count = tris.reduce((acc, t) => acc + t.length / 9, 0);
  const buf = new ArrayBuffer(84 + count * 50); const dv = new DataView(buf);
  const header = new TextEncoder().encode('ForjaCAD STL binario'); new Uint8Array(buf, 0, 80).set(header.subarray(0, 80));
  dv.setUint32(80, count, true);
  let off = 84; const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const t of tris) for (let i = 0; i < t.length; i += 9) {
    a.set(t[i], t[i + 1], t[i + 2]); b.set(t[i + 3], t[i + 4], t[i + 5]); c.set(t[i + 6], t[i + 7], t[i + 8]);
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    for (const v of [n, a, b, c]) { dv.setFloat32(off, v.x, true); dv.setFloat32(off + 4, v.y, true); dv.setFloat32(off + 8, v.z, true); off += 12; }
    dv.setUint16(off, 0, true); off += 2;
  }
  return buf;
}

/** OBJ com um objeto por corpo e grupos por tampa e lateral (o ZBrush lê grupos como polygroups). */
export function toOBJ(meshes: NamedMesh[]): string {
  const lines: string[] = ['# ForjaCAD OBJ', '# unidades: mm'];
  let vbase = 1;
  for (const m of meshes) {
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    const pos = g.getAttribute('position').array as Float32Array;
    lines.push(`o ${m.name.replace(/\s+/g, '_')}`);
    for (let i = 0; i < pos.length; i += 3) lines.push(`v ${fmt(pos[i])} ${fmt(pos[i + 1])} ${fmt(pos[i + 2])}`);
    const groups = g.groups.length ? g.groups : [{ start: 0, count: pos.length / 3, materialIndex: 0 }];
    groups.forEach((gr, gi) => {
      lines.push(`g ${m.name.replace(/\s+/g, '_')}_${gr.materialIndex === 0 ? 'tampas' : 'lateral'}${gi}`);
      const end = gr.count === Infinity ? pos.length / 3 : gr.start + gr.count;
      for (let i = gr.start; i < end; i += 3) lines.push(`f ${vbase + i} ${vbase + i + 1} ${vbase + i + 2}`);
    });
    vbase += pos.length / 3;
  }
  return lines.join('\n') + '\n';
}

const fmt = (v: number) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(4).replace(/\.?0+$/, ''));
