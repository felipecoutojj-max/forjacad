// Solver numérico de restrições (Levenberg-Marquardt com jacobiana por diferenças finitas).
// Variáveis: coordenadas dos pontos livres e raios de círculos e arcos.
// Cada restrição e cota vira uma ou mais equações residuais em milímetros.

import type { Sketch, Id, Entity, ArcEntity, CircleEntity, LineEntity } from './model';

export interface SolveOptions {
  /** Ponto arrastado e posição alvo: o solver tenta levá-lo até lá respeitando as restrições. */
  drag?: { point: Id; x: number; y: number };
  maxIter?: number;
  tolerance?: number;
}

export interface SolveResult {
  converged: boolean;
  residual: number;
  iterations: number;
  /** Graus de liberdade restantes (0 = totalmente definido). */
  dof: number;
  /** Equações a mais que variáveis efetivas: sinal de restrição redundante ou conflitante. */
  overConstrained: boolean;
}

type Residual = (x: Float64Array) => number;

interface VarMap { idx: Map<string, number>; n: number; }

function buildVarMap(s: Sketch, fixedPoints: Set<Id>): VarMap {
  const idx = new Map<string, number>(); let n = 0;
  for (const p of s.points) {
    if (p.fixed || fixedPoints.has(p.id)) continue;
    idx.set(`${p.id}.x`, n++); idx.set(`${p.id}.y`, n++);
  }
  for (const e of s.entities) if (e.type === 'circle' || e.type === 'arc') idx.set(`${e.id}.r`, n++);
  return { idx, n };
}

function readVars(s: Sketch, vm: VarMap): Float64Array {
  const x = new Float64Array(vm.n);
  for (const p of s.points) {
    const ix = vm.idx.get(`${p.id}.x`); if (ix !== undefined) { x[ix] = p.x; x[ix + 1] = p.y; }
  }
  for (const e of s.entities) if (e.type === 'circle' || e.type === 'arc') { const ir = vm.idx.get(`${e.id}.r`)!; x[ir] = e.r; }
  return x;
}

function writeVars(s: Sketch, vm: VarMap, x: Float64Array): void {
  for (const p of s.points) {
    const ix = vm.idx.get(`${p.id}.x`); if (ix !== undefined) { p.x = x[ix]; p.y = x[ix + 1]; }
  }
  for (const e of s.entities) if (e.type === 'circle' || e.type === 'arc') { const ir = vm.idx.get(`${e.id}.r`)!; e.r = Math.max(1e-6, Math.abs(x[ir])); }
}

/** Acessores que leem de x quando a grandeza é variável, ou do esboço quando é fixa. */
function accessors(s: Sketch, vm: VarMap) {
  const pts = new Map(s.points.map((p) => [p.id, p]));
  const ents = new Map(s.entities.map((e) => [e.id, e]));
  const px = (id: Id) => { const i = vm.idx.get(`${id}.x`); const p = pts.get(id)!; return i === undefined ? (_x: Float64Array) => p.x : (x: Float64Array) => x[i]; };
  const py = (id: Id) => { const i = vm.idx.get(`${id}.y`); const p = pts.get(id)!; return i === undefined ? (_x: Float64Array) => p.y : (x: Float64Array) => x[i]; };
  const rad = (id: Id) => { const i = vm.idx.get(`${id}.r`)!; return (x: Float64Array) => Math.abs(x[i]); };
  return { pts, ents, px, py, rad };
}

export function buildResiduals(s: Sketch, vm: VarMap, opts: SolveOptions): { hard: Residual[]; soft: Residual[] } {
  const { ents, px, py, rad } = accessors(s, vm);
  const hard: Residual[] = []; const soft: Residual[] = [];
  const line = (id: Id) => ents.get(id) as LineEntity | undefined;
  const ent = (id: Id) => ents.get(id);
  const isRound = (e?: Entity): e is CircleEntity | ArcEntity => !!e && (e.type === 'circle' || e.type === 'arc');
  const isLine = (e?: Entity): e is LineEntity => !!e && e.type === 'line';

  // Direção de uma linha.
  const dir = (l: LineEntity) => {
    const ax = px(l.a), ay = py(l.a), bx = px(l.b), by = py(l.b);
    return (x: Float64Array) => ({ x: bx(x) - ax(x), y: by(x) - ay(x) });
  };
  const hyp = (a: number, b: number) => Math.hypot(a, b) || 1e-9;

  // Arcos: start e end ficam sobre a circunferência.
  for (const e of s.entities) {
    if (e.type !== 'arc') continue;
    const cx = px(e.center), cy = py(e.center), r = rad(e.id);
    for (const pid of [e.start, e.end]) {
      const qx = px(pid), qy = py(pid);
      hard.push((x) => Math.hypot(qx(x) - cx(x), qy(x) - cy(x)) - r(x));
    }
  }

  for (const c of s.constraints) {
    const r = c.refs;
    switch (c.kind) {
      case 'horizontal': { const l = line(r[0]); if (!l) break; const ay = py(l.a), by = py(l.b); hard.push((x) => by(x) - ay(x)); break; }
      case 'vertical': { const l = line(r[0]); if (!l) break; const ax = px(l.a), bx = px(l.b); hard.push((x) => bx(x) - ax(x)); break; }
      case 'parallel': {
        const l1 = line(r[0]), l2 = line(r[1]); if (!l1 || !l2) break;
        const d1 = dir(l1), d2 = dir(l2);
        hard.push((x) => { const a = d1(x), b = d2(x); return (a.x * b.y - a.y * b.x) / hyp(b.x, b.y); });
        break;
      }
      case 'perpendicular': {
        const l1 = line(r[0]), l2 = line(r[1]); if (!l1 || !l2) break;
        const d1 = dir(l1), d2 = dir(l2);
        hard.push((x) => { const a = d1(x), b = d2(x); return (a.x * b.x + a.y * b.y) / hyp(b.x, b.y); });
        break;
      }
      case 'equal': {
        const e1 = ent(r[0]), e2 = ent(r[1]);
        if (isLine(e1) && isLine(e2)) { const d1 = dir(e1), d2 = dir(e2); hard.push((x) => { const a = d1(x), b = d2(x); return Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y); }); }
        else if (isRound(e1) && isRound(e2)) { const r1 = rad(e1.id), r2 = rad(e2.id); hard.push((x) => r1(x) - r2(x)); }
        break;
      }
      case 'tangent': {
        const e1 = ent(r[0]), e2 = ent(r[1]);
        const l = isLine(e1) ? e1 : isLine(e2) ? e2 : undefined;
        const c1 = isRound(e1) ? e1 : undefined; const c2 = isRound(e2) ? e2 : undefined;
        if (l && (c1 || c2)) {
          const c = (c1 ?? c2)!; const d = dir(l); const ax = px(l.a), ay = py(l.a); const cx = px(c.center), cy = py(c.center), rr = rad(c.id);
          hard.push((x) => { const dd = d(x); const vx = cx(x) - ax(x), vy = cy(x) - ay(x); return Math.abs(dd.x * vy - dd.y * vx) / hyp(dd.x, dd.y) - rr(x); });
        } else if (c1 && c2) {
          const c1x = px(c1.center), c1y = py(c1.center), c2x = px(c2.center), c2y = py(c2.center), r1 = rad(c1.id), r2 = rad(c2.id);
          // Externa se os centros estão mais afastados que o maior raio; interna caso contrário. Decidido na configuração inicial.
          const x0 = readVars(s, vm);
          const external = Math.hypot(c1x(x0) - c2x(x0), c1y(x0) - c2y(x0)) > Math.max(r1(x0), r2(x0));
          hard.push((x) => { const d = Math.hypot(c1x(x) - c2x(x), c1y(x) - c2y(x)); return external ? d - (r1(x) + r2(x)) : d - Math.abs(r1(x) - r2(x)); });
        }
        break;
      }
      case 'concentric': {
        const e1 = ent(r[0]), e2 = ent(r[1]); if (!isRound(e1) || !isRound(e2)) break;
        const ax = px(e1.center), ay = py(e1.center), bx = px(e2.center), by = py(e2.center);
        hard.push((x) => ax(x) - bx(x)); hard.push((x) => ay(x) - by(x));
        break;
      }
      case 'pointOnLine': {
        const l = line(r[1]); if (!l) break; const d = dir(l); const ax = px(l.a), ay = py(l.a), qx = px(r[0]), qy = py(r[0]);
        hard.push((x) => { const dd = d(x); return (dd.x * (qy(x) - ay(x)) - dd.y * (qx(x) - ax(x))) / hyp(dd.x, dd.y); });
        break;
      }
      case 'pointOnCircle': {
        const c = ent(r[1]); if (!isRound(c)) break; const cx = px(c.center), cy = py(c.center), rr = rad(c.id), qx = px(r[0]), qy = py(r[0]);
        hard.push((x) => Math.hypot(qx(x) - cx(x), qy(x) - cy(x)) - rr(x));
        break;
      }
      case 'midpoint': {
        const l = line(r[1]); if (!l) break; const ax = px(l.a), ay = py(l.a), bx = px(l.b), by = py(l.b), qx = px(r[0]), qy = py(r[0]);
        hard.push((x) => qx(x) - (ax(x) + bx(x)) / 2); hard.push((x) => qy(x) - (ay(x) + by(x)) / 2);
        break;
      }
      case 'fixed': break; // tratado na montagem das variáveis
    }
  }

  for (const d of s.dimensions) {
    const r = d.refs; const v = d.value;
    switch (d.kind) {
      case 'distance': {
        if (r.length === 1) { const l = line(r[0]); if (!l) break; const dd = dir(l); hard.push((x) => { const a = dd(x); return Math.hypot(a.x, a.y) - v; }); }
        else {
          const e1 = ent(r[1]);
          if (isLine(e1)) { // ponto a linha
            const dd = dir(e1); const ax = px(e1.a), ay = py(e1.a), qx = px(r[0]), qy = py(r[0]);
            hard.push((x) => { const a = dd(x); return Math.abs(a.x * (qy(x) - ay(x)) - a.y * (qx(x) - ax(x))) / hyp(a.x, a.y) - v; });
          } else {
            const ax = px(r[0]), ay = py(r[0]), bx = px(r[1]), by = py(r[1]);
            hard.push((x) => Math.hypot(bx(x) - ax(x), by(x) - ay(x)) - v);
          }
        }
        break;
      }
      case 'hdistance': { const [a, b] = pointPair(s, r); if (!a) break; const ax = px(a), bx = px(b); hard.push((x) => Math.abs(bx(x) - ax(x)) - v); break; }
      case 'vdistance': { const [a, b] = pointPair(s, r); if (!a) break; const ay = py(a), by = py(b); hard.push((x) => Math.abs(by(x) - ay(x)) - v); break; }
      case 'angle': {
        const l1 = line(r[0]), l2 = line(r[1]); if (!l1 || !l2) break; const d1 = dir(l1), d2 = dir(l2); const target = (v * Math.PI) / 180;
        hard.push((x) => { const a = d1(x), b = d2(x); const ang = Math.atan2(Math.abs(a.x * b.y - a.y * b.x), a.x * b.x + a.y * b.y); return (ang - target) * 20; });
        break;
      }
      case 'radius': { const c = ent(r[0]); if (!isRound(c)) break; const rr = rad(c.id); hard.push((x) => rr(x) - v); break; }
      case 'diameter': { const c = ent(r[0]); if (!isRound(c)) break; const rr = rad(c.id); hard.push((x) => 2 * rr(x) - v); break; }
    }
  }

  if (opts.drag) {
    const { point, x: tx, y: ty } = opts.drag;
    if (vm.idx.has(`${point}.x`)) { const qx = px(point), qy = py(point); soft.push((x) => qx(x) - tx); soft.push((x) => qy(x) - ty); }
  }
  return { hard, soft };
}

/** Para cotas horizontais e verticais: aceita dois pontos ou uma linha. */
function pointPair(s: Sketch, refs: Id[]): [Id, Id] | [undefined, undefined] {
  if (refs.length === 2) return [refs[0], refs[1]];
  const l = s.entities.find((e) => e.id === refs[0]);
  if (l && l.type === 'line') return [l.a, l.b];
  return [undefined, undefined];
}

function evaluate(res: Residual[], x: Float64Array, out: Float64Array, offset = 0): void {
  for (let i = 0; i < res.length; i++) out[offset + i] = res[i](x);
}

function jacobian(res: Residual[], x: Float64Array, f0: Float64Array, J: Float64Array, n: number): void {
  const m = res.length; const xp = Float64Array.from(x); const fp = new Float64Array(m);
  for (let j = 0; j < n; j++) {
    const h = 1e-6 * (1 + Math.abs(x[j]));
    xp[j] = x[j] + h; evaluate(res, xp, fp); xp[j] = x[j];
    for (let i = 0; i < m; i++) J[i * n + j] = (fp[i] - f0[i]) / h;
  }
}

/** Resolve (A) δ = b por eliminação de Gauss com pivotamento parcial. A é n×n. */
function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const M = Float64Array.from(A); const y = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let piv = c; let best = Math.abs(M[c * n + c]);
    for (let r = c + 1; r < n; r++) { const v = Math.abs(M[r * n + c]); if (v > best) { best = v; piv = r; } }
    if (best < 1e-14) return null;
    if (piv !== c) { for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[piv * n + k]; M[piv * n + k] = t; } const t = y[c]; y[c] = y[piv]; y[piv] = t; }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c]; if (f === 0) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k]; y[r] -= f * y[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) { let sum = y[r]; for (let k = r + 1; k < n; k++) sum -= M[r * n + k] * x[k]; x[r] = sum / M[r * n + r]; }
  return x;
}

/** Posto numérico de uma matriz m×n por eliminação com tolerância. */
export function matrixRank(J: Float64Array, m: number, n: number, tol = 1e-7): number {
  const M = Float64Array.from(J); let rank = 0; const rows = new Array(m).fill(false);
  for (let c = 0; c < n && rank < m; c++) {
    let piv = -1; let best = tol;
    for (let r = 0; r < m; r++) { if (rows[r]) continue; const v = Math.abs(M[r * n + c]); if (v > best) { best = v; piv = r; } }
    if (piv < 0) continue;
    rows[piv] = true; rank++;
    for (let r = 0; r < m; r++) {
      if (r === piv) continue; const f = M[r * n + c] / M[piv * n + c]; if (f === 0) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[piv * n + k];
    }
  }
  return rank;
}

function lm(res: Residual[], x: Float64Array, n: number, maxIter: number, tol: number): { converged: boolean; residual: number; iterations: number } {
  const m = res.length;
  if (m === 0 || n === 0) { const f = new Float64Array(m); evaluate(res, x, f); const r0 = Math.hypot(...f); return { converged: r0 < tol, residual: r0, iterations: 0 }; }
  const f = new Float64Array(m); const J = new Float64Array(m * n);
  const JtJ = new Float64Array(n * n); const Jtf = new Float64Array(n); const A = new Float64Array(n * n);
  let lambda = 1e-3; let it = 0;
  evaluate(res, x, f); let cost = f.reduce((s, v) => s + v * v, 0);
  for (; it < maxIter; it++) {
    if (Math.sqrt(cost) < tol) break;
    jacobian(res, x, f, J, n);
    JtJ.fill(0); Jtf.fill(0);
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { const jij = J[i * n + j]; if (jij === 0) continue; Jtf[j] += jij * f[i]; for (let k = 0; k < n; k++) JtJ[j * n + k] += jij * J[i * n + k]; }
    let improved = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      A.set(JtJ); for (let j = 0; j < n; j++) A[j * n + j] += lambda * (JtJ[j * n + j] + 1e-9);
      const neg = Jtf.map((v) => -v);
      const delta = solveLinear(A, neg, n);
      if (!delta) { lambda *= 10; continue; }
      const xn = Float64Array.from(x); for (let j = 0; j < n; j++) xn[j] += delta[j];
      const fn = new Float64Array(m); evaluate(res, xn, fn); const cn = fn.reduce((s, v) => s + v * v, 0);
      if (cn < cost) { x.set(xn); f.set(fn); cost = cn; lambda = Math.max(lambda / 5, 1e-12); improved = true; break; }
      lambda *= 6;
    }
    if (!improved) break;
  }
  return { converged: Math.sqrt(cost) < tol, residual: Math.sqrt(cost), iterations: it };
}

/** Resolve o esboço no lugar. Posições atuais servem de chute inicial, então o esboço se move o mínimo. */
export function solveSketch(s: Sketch, opts: SolveOptions = {}): SolveResult {
  const maxIter = opts.maxIter ?? 80; const tol = opts.tolerance ?? 1e-8;
  const fixedByConstraint = new Set<Id>(s.constraints.filter((c) => c.kind === 'fixed').map((c) => c.refs[0]));

  // Passo 1: ponto arrastado tratado como fixo no alvo. Se as restrições permitirem, ele chega lá.
  if (opts.drag) {
    const p = s.points.find((q) => q.id === opts.drag!.point);
    if (p && !p.fixed && !fixedByConstraint.has(p.id)) {
      const ox = p.x, oy = p.y; p.x = opts.drag.x; p.y = opts.drag.y;
      const vm = buildVarMap(s, new Set([...fixedByConstraint, p.id]));
      const { hard } = buildResiduals(s, vm, {});
      const x = readVars(s, vm); const r = lm(hard, x, vm.n, maxIter, tol);
      if (r.converged) { writeVars(s, vm, x); return finish(s, vm, hard, r); }
      p.x = ox; p.y = oy; // não deu: solta o ponto e puxa de leve
    }
  }

  const vm = buildVarMap(s, fixedByConstraint);
  const { hard, soft } = buildResiduals(s, vm, opts);
  const weighted = soft.map((f) => (x: Float64Array) => 0.05 * f(x));
  const all = hard.concat(weighted);
  const x = readVars(s, vm);
  let r = lm(all, x, vm.n, maxIter, tol * (soft.length ? 50 : 1));
  if (soft.length) {
    // O puxão suave deixa resíduo nas restrições reais; um passe final só com elas fecha a conta.
    const r2 = lm(hard, x, vm.n, maxIter, tol); r = { ...r2, iterations: r.iterations + r2.iterations };
  }
  writeVars(s, vm, x);
  return finish(s, vm, hard, r);
}

function finish(s: Sketch, vm: VarMap, hard: Residual[], r: { converged: boolean; residual: number; iterations: number }): SolveResult {
  const x = readVars(s, vm); const m = hard.length; const n = vm.n;
  if (n === 0) return { ...r, dof: 0, overConstrained: m > 0 };
  const f0 = new Float64Array(m); evaluate(hard, x, f0);
  const J = new Float64Array(m * n); if (m > 0) jacobian(hard, x, f0, J, n);
  const rank = m > 0 ? matrixRank(J, m, n) : 0;
  // Movimentos de corpo rígido (duas translações e uma rotação) não contam como liberdade "faltando".
  // Empilha os três modos na jacobiana: o que eles acrescentarem de posto é liberdade rígida ainda solta.
  let cx = 0, cy = 0, cnt = 0;
  for (const p of s.points) if (vm.idx.has(`${p.id}.x`)) { cx += p.x; cy += p.y; cnt++; }
  if (cnt) { cx /= cnt; cy /= cnt; }
  const S = new Float64Array((m + 3) * n); S.set(J);
  for (const p of s.points) {
    const ix = vm.idx.get(`${p.id}.x`); if (ix === undefined) continue; const iy = ix + 1;
    S[(m + 0) * n + ix] = 1; S[(m + 1) * n + iy] = 1;
    S[(m + 2) * n + ix] = -(p.y - cy); S[(m + 2) * n + iy] = p.x - cx;
  }
  const rankAll = matrixRank(S, m + 3, n);
  const dof = Math.max(0, n - rankAll);
  return { ...r, dof, overConstrained: m > rank };
}
