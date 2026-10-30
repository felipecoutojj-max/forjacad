// Exportação GLB (glTF binário): visualizadores do Mac, Windows e iPad, realidade aumentada, Blender.
// O glTF trabalha em metros, então a peça em milímetros vai dentro de um nó escalado por 0,001.

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { MeshData } from './mesh';

export async function toGLB(meshes: MeshData[], docName: string): Promise<ArrayBuffer> {
  const scene = new THREE.Scene(); scene.name = docName || 'ForjaCAD';
  const root = new THREE.Group(); root.name = 'mm_para_m'; root.scale.setScalar(0.001); scene.add(root);
  const material = new THREE.MeshStandardMaterial({ color: 0x9aa7b8, metalness: 0.4, roughness: 0.5 }); material.name = 'aco';
  for (const m of meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    if (m.normals) g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3)); else g.computeVertexNormals();
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const mesh = new THREE.Mesh(g, material); mesh.name = m.name.replace(/\s+/g, '_');
    root.add(mesh);
  }
  const out = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true });
  if (!(out instanceof ArrayBuffer)) throw new Error('exportador não devolveu binário');
  return out;
}
