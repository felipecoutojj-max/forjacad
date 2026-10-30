// Perfis fechados de um esboço: laços externos com seus furos.
// Sem dependência de three.js: serve à prévia (malha) e ao kernel OpenCASCADE (worker).

import type { Sketch, Entity, Id } from '../sketch/model';
import { getPoint, arcAngles } from '../sketch/model';
import { type Vec2, normAngle, TAU } from '../geom';

/** Um lado de um laço: entidade percorrida de `from` para `to`. */
export interface LoopEdge { entity: Entity; from: Id; to: Id; reversed: boolean; }
export type Loop = { kind: 'circle'; entity: Entity } | { kind: 'path'; edges: LoopEdge[] };
export interface Profile { outer: Loop; holes: Loop[]; area: number; }

/** Extrai perfis (laços fechados com furos) de um esboço. Entidades de construção são ignoradas. */
export function extractProfiles(s: Sketch): Profile[] {
  const ents = s.entities.filter((e) => !e.construction);
  const loops: { loop: Loop; poly: Vec2[]; area: number; neg?: boolean }[] = [];

  for (const e of ents) if (e.type === 'circle') {
    const c = getPoint(s, e.center); const poly = sampleCircle({ x: c.x, y: c.y }, e.r);
    loops.push({ loop: { kind: 'circle', entity: e }, poly, area: Math.PI * e.r * e.r });
  }

  // Grafo planar das linhas e arcos.
  const edges = ents.filter((e) => e.type !== 'circle');
  const adj = new Map<Id, { e: Entity; other: Id }[]>();
  const endpoints = (e: Entity): [Id, Id] => e.type === 'line' ? [e.a, e.b] : e.type === 'arc' ? [e.start, e.end] : [e.center, e.center];
  for (const e of edges) {
    const [a, b] = endpoints(e);
    if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ e, other: b }); adj.get(b)!.push({ e, other: a });
  }
  // Direção de saída de uma aresta num vértice (tangente para arcos).
  const outDir = (e: Entity, from: Id): number => {
    const p = getPoint(s, from);
    if (e.type === 'line') { const q = getPoint(s, e.a === from ? e.b : e.a); return Math.atan2(q.y - p.y, q.x - p.x); }
    if (e.type === 'arc') {
      const c = getPoint(s, e.center); const ang = Math.atan2(p.y - c.y, p.x - c.x);
      // Arco anti-horário de start até end: saindo de start, tangente = ang + 90°; saindo de end, ang - 90°.
      return e.start === from ? ang + Math.PI / 2 : ang - Math.PI / 2;
    }
    return 0;
  };
  // Rastreio de faces: a partir de cada meia-aresta, no vértice de chegada escolhe a próxima aresta
  // como a primeira no sentido horário a partir da direção de volta. Isso percorre cada face com ela à esquerda.
  const used = new Set<string>();
  const key = (e: Entity, from: Id) => `${e.id}:${from}`;
  const nextHalfEdge = (curE: Entity, curFrom: Id, curTo: Id): { e: Entity; other: Id } | null => {
    const options = adj.get(curTo) ?? [];
    if (!options.length) return null;
    if (options.length === 1) return options[0]; // beco sem saída: volta
    const backDir = outDir(curE, curTo);
    let best: { e: Entity; other: Id } | null = null; let bestTurn = Infinity;
    for (const o of options) {
      if (o.e === curE && o.other === curFrom) continue;
      const turn = normAngle(backDir - outDir(o.e, curTo));
      if (turn > 1e-9 && turn < bestTurn) { bestTurn = turn; best = o; }
    }
    return best;
  };
  for (const e of edges) {
    const [a, b] = endpoints(e);
    for (const [from, to] of [[a, b], [b, a]] as [Id, Id][]) {
      if (used.has(key(e, from))) continue;
      const path: LoopEdge[] = []; let curE: Entity = e; let curFrom = from, curTo = to; let ok = false;
      const local = new Set<string>();
      for (let guard = 0; guard < 5000; guard++) {
        const k = key(curE, curFrom);
        if (local.has(k)) break;
        local.add(k);
        path.push({ entity: curE, from: curFrom, to: curTo, reversed: curE.type === 'line' ? curE.a !== curFrom : curE.type === 'arc' ? curE.start !== curFrom : false });
        const nx = nextHalfEdge(curE, curFrom, curTo);
        if (!nx) break;
        if (nx.e === e && curTo === from) { ok = true; break; }
        curE = nx.e; curFrom = curTo; curTo = nx.other;
      }
      for (const k of local) used.add(k);
      if (!ok || path.length < 2) continue;
      const poly = samplePath(s, path);
      const area = signedArea(poly);
      if (area > 1e-6) loops.push({ loop: { kind: 'path', edges: path }, poly, area });
      else if (area < -1e-6) loops.push({ loop: { kind: 'path', edges: path }, poly: poly.slice().reverse(), area: -area, neg: true });
    }
  }

  // Com faces percorridas à esquerda, faces internas têm área positiva e a face externa de cada componente
  // tem área negativa. Mesmo conjunto de arestas pode aparecer nos dois sentidos: fica o positivo.
  const sigOf = (l: Loop) => (l.kind === 'circle' ? l.entity.id : l.edges.map((x) => x.entity.id).sort().join('|'));
  const bySig = new Map<string, { loop: Loop; poly: Vec2[]; area: number; positive: boolean }>();
  for (const l of loops) {
    const sig = sigOf(l.loop);
    const positive = l.loop.kind === 'circle' || !l.neg;
    const prev = bySig.get(sig);
    if (!prev || (!prev.positive && positive)) bySig.set(sig, { loop: l.loop, poly: l.poly, area: l.area, positive });
  }
  const kept = [...bySig.values()].filter((l) => l.positive).sort((a, b) => b.area - a.area);

  // Hierarquia de contenção: profundidade par = contorno, ímpar = furo do pai imediato.
  const profiles: Profile[] = [];
  const depth = kept.map((l) => kept.filter((o) => o !== l && contains(o.poly, l.poly)).length);
  kept.forEach((l, i) => { if (depth[i] % 2 === 0) profiles.push({ outer: l.loop, holes: [], area: l.area }); });
  kept.forEach((l, i) => {
    if (depth[i] % 2 !== 1) return;
    let parent: typeof kept[number] | null = null;
    for (const o of kept) if (o !== l && contains(o.poly, l.poly) && (!parent || o.area < parent.area)) parent = o;
    if (!parent) return;
    const prof = profiles.find((p) => p.outer === parent!.loop); if (prof) prof.holes.push(l.loop);
  });
  return profiles;
}

/** Ângulos de um lado de arco no sentido em que o laço o percorre: de `a0` para `a1`, varrendo `sweep` (sinal dá o sentido). */
export function loopArcAngles(s: Sketch, ed: LoopEdge): { a0: number; a1: number; sweep: number } {
  if (ed.entity.type !== 'arc') throw new Error('não é arco');
  const { start, end } = arcAngles(s, ed.entity);
  let sweep = normAngle(end - start); if (sweep === 0) sweep = TAU;
  return ed.reversed ? { a0: end, a1: start, sweep: -sweep } : { a0: start, a1: end, sweep };
}

function sampleCircle(c: Vec2, r: number, n = 64): Vec2[] {
  const out: Vec2[] = []; for (let i = 0; i < n; i++) { const t = (i / n) * TAU; out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }); } return out;
}

function samplePath(s: Sketch, path: LoopEdge[]): Vec2[] {
  const out: Vec2[] = [];
  for (const ed of path) {
    const p0 = getPoint(s, ed.from);
    if (ed.entity.type === 'line') out.push({ x: p0.x, y: p0.y });
    else if (ed.entity.type === 'arc') {
      const a = ed.entity; const c = getPoint(s, a.center); const { a0, sweep } = loopArcAngles(s, ed);
      const n = Math.max(4, Math.ceil(Math.abs(sweep) / (TAU / 48)));
      for (let i = 0; i < n; i++) { const t = a0 + (sweep * i) / n; out.push({ x: c.x + a.r * Math.cos(t), y: c.y + a.r * Math.sin(t) }); }
    }
  }
  return out;
}

export function signedArea(poly: Vec2[]): number {
  let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; } return a / 2;
}

function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** `outer` contém `inner`? Testa a maioria dos pontos (tolerante a vértices compartilhados). */
function contains(outer: Vec2[], inner: Vec2[]): boolean {
  if (outer === inner) return false;
  let inCount = 0, tested = 0;
  for (let i = 0; i < inner.length; i += Math.max(1, Math.floor(inner.length / 24))) { tested++; if (pointInPoly(inner[i], outer)) inCount++; }
  return inCount > tested * 0.6 && Math.abs(signedArea(outer)) > Math.abs(signedArea(inner));
}
