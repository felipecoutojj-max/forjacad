// Reconhecedor de traço: transforma o risco da caneta em linhas, arcos e círculos.
// Entrada em coordenadas do plano (mm). A tolerância vem em mm, derivada do zoom (pixels → mm).

import { type Vec2, dist, fitCircle, fitLine, resample, polylineLength, sub, angleOf, cross, dot, normAngle, TAU, v2 } from '../geom';

export type Primitive =
  | { type: 'line'; a: Vec2; b: Vec2 }
  | { type: 'arc'; c: Vec2; r: number; a: Vec2; b: Vec2; ccw: boolean } // a→b na ordem do traço; ccw diz o sentido
  | { type: 'circle'; c: Vec2; r: number }
  | { type: 'ellipse'; c: Vec2; rx: number; ry: number; angle: number }
  | { type: 'spline'; pts: Vec2[]; closed: boolean }; // curva livre, sem cantos vivos
const SHARP = (55 * Math.PI) / 180;
/** Quantos cantos vivos o traço simplificado tem. */
function sharpCorners(pts: Vec2[], tol: number): number {
  const idx = simplify(pts, tol * 0.9); let n = 0;
  for (let k = 1; k < idx.length - 1; k++) { const a = pts[idx[k - 1]], b = pts[idx[k]], c = pts[idx[k + 1]]; const u = sub(b, a), w = sub(c, b); if (Math.abs(Math.atan2(cross(u, w), dot(u, w))) > SHARP) n++; }
  return n;
}
/** Ajuste de elipse por eixos principais (PCA): centro, direção e semieixos pelos extremos; erro radial normalizado. */
export function fitEllipse(pts: Vec2[]): { c: Vec2; rx: number; ry: number; angle: number; rms: number; maxErr: number } | null {
  const n = pts.length; if (n < 8) return null;
  let mx = 0, my = 0; for (const p of pts) { mx += p.x; my += p.y; } mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0; for (const p of pts) { const u = p.x - mx, v = p.y - my; sxx += u * u; syy += v * v; sxy += u * v; }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy); const ca = Math.cos(angle), sa = Math.sin(angle);
  let rx = 0, ry = 0; const uv: Vec2[] = [];
  for (const p of pts) { const u = (p.x - mx) * ca + (p.y - my) * sa, v = -(p.x - mx) * sa + (p.y - my) * ca; uv.push(v2(u, v)); rx = Math.max(rx, Math.abs(u)); ry = Math.max(ry, Math.abs(v)); }
  if (rx < 1e-9 || ry < 1e-9) return null;
  let se = 0, maxErr = 0; for (const q of uv) { const d = (Math.hypot(q.x / rx, q.y / ry) - 1) * Math.min(rx, ry); se += d * d; maxErr = Math.max(maxErr, Math.abs(d)); }
  return { c: v2(mx, my), rx, ry, angle, rms: Math.sqrt(se / n), maxErr };
}
/** O traço vira para os dois lados (S, onda, rim): sinais de giro opostos entre os vértices marcantes, sem cantos vivos. */
function turnFlips(pts: Vec2[], tol: number): boolean {
  const idx = simplify(pts, tol * 0.9); let pos = 0, neg = 0;
  for (let k = 1; k < idx.length - 1; k++) {
    const a = pts[idx[k - 1]], b = pts[idx[k]], c = pts[idx[k + 1]]; const u = sub(b, a), w = sub(c, b);
    const t = Math.atan2(cross(u, w), dot(u, w)); if (t > 0.2) pos++; else if (t < -0.2) neg++;
  }
  return pos > 0 && neg > 0;
}
/** Spline pelos pontos marcantes do traço (Douglas–Peucker com tolerância folgada). */
function splineOf(pts: Vec2[], tol: number, closed: boolean): Primitive {
  const idx = simplify(pts, tol * 1.6); let keep = idx.map((i) => pts[i]);
  if (closed) keep = keep.slice(0, -1);
  if (keep.length < 3) { const n = Math.max(3, Math.min(12, Math.round(pts.length / 6))); keep = []; for (let i = 0; i < n; i++) keep.push(pts[Math.round((i / (n - (closed ? 0 : 1))) * (pts.length - 1))]); }
  return { type: 'spline', pts: keep, closed };
}

export interface RecognizeOptions {
  /** Tolerância de ajuste em mm (algo como 3 a 6 pixels convertidos). */
  tol: number;
  /** Raio mínimo aceitável para círculo ou arco, em mm. */
  minRadius?: number;
}

/** Reconhece um traço completo. Retorna primitivas encadeadas (fim de uma = início da próxima). */
export function recognizeStroke(raw: Vec2[], opts: RecognizeOptions): Primitive[] {
  const tol = opts.tol; const minR = opts.minRadius ?? tol * 2;
  const pts = dedupe(raw, tol * 0.1);
  if (pts.length < 2) return [];
  const length = polylineLength(pts);
  if (length < tol * 2) return [];
  const step = Math.max(tol * 0.5, length / 200);
  const rs = resample(pts, step);
  const closed = dist(rs[0], rs[rs.length - 1]) < Math.max(tol * 3, length * 0.08) && length > tol * 8;

  if (closed) {
    const fc = fitCircle(rs);
    if (fc && fc.rms < tol && fc.r > minR && isRoundish(rs, fc.c, fc.r)) return [{ type: 'circle', c: fc.c, r: fc.r }];
    const loop = rs.slice(); loop[loop.length - 1] = loop[0];
    // Polígono fechado: fecha a polilinha e segmenta.
    const segs = segmentize(loop, tol, minR, true);
    if (sharpCorners(loop, tol) === 0) {
      // Oval sem cantos: elipse se o traço cabe justo nela (um rasgo arredondado não cabe); rim ou feijão vira spline fechada.
      const fe = fitEllipse(rs);
      if (fe && fe.maxErr < tol * 0.5 && fe.rms < tol * 0.3 && Math.min(fe.rx, fe.ry) > minR) return [{ type: 'ellipse', c: fe.c, rx: fe.rx, ry: fe.ry, angle: fe.angle }];
      if (turnFlips(loop, tol)) return [splineOf(loop, tol, true)];
    }
    return chain(segs, true);
  }

  // Tenta um único primitivo.
  const single = fitSingle(rs, tol, minR);
  if (single) return [single];
  const segs = segmentize(rs, tol, minR, false);
  // Curva ondulada sem cantos vivos: spline em vez de uma fila de arcos e linhas.
  if (sharpCorners(rs, tol) === 0 && turnFlips(rs, tol)) return [splineOf(rs, tol, false)];
  return chain(segs, false);
}

function dedupe(pts: Vec2[], eps: number): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > eps) out.push(p);
  return out;
}

/** Um conjunto de pontos cobre bem a circunferência? Evita que um arco curto fechado passe por círculo. */
function isRoundish(pts: Vec2[], c: Vec2, r: number): boolean {
  const bins = new Array(12).fill(false);
  for (const p of pts) bins[Math.floor(normAngle(angleOf(sub(p, c))) / TAU * 12) % 12] = true;
  return bins.filter(Boolean).length >= 10 && r > 0;
}

function fitSingle(pts: Vec2[], tol: number, minR: number): Primitive | null {
  const fl = fitLine(pts);
  if (fl && fl.rms < tol * 0.8) return { type: 'line', a: pts[0], b: pts[pts.length - 1] };
  const fc = fitCircle(pts);
  if (fc && fc.rms < tol && fc.r > minR) {
    const sweep = sweepOf(pts, fc.c);
    if (Math.abs(sweep) > 0.15 && Math.abs(sweep) < TAU * 0.97) {
      return { type: 'arc', c: fc.c, r: fc.r, a: pts[0], b: pts[pts.length - 1], ccw: sweep > 0 };
    }
  }
  return null;
}

/** Varredura angular assinada ao redor de c, acumulada ponto a ponto. */
function sweepOf(pts: Vec2[], c: Vec2): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const u = sub(pts[i - 1], c), w = sub(pts[i], c);
    s += Math.atan2(cross(u, w), dot(u, w));
  }
  return s;
}

/** Douglas-Peucker. */
function simplify(pts: Vec2[], tol: number): number[] {
  const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    if (i1 - i0 < 2) continue;
    const a = pts[i0], b = pts[i1]; const ab = sub(b, a); const l = Math.hypot(ab.x, ab.y);
    let best = -1, bi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      // Extremos coincidentes (laço fechado): mede a distância ao ponto, não à corda degenerada.
      const d = l < 1e-9 ? dist(pts[i], a) : Math.abs(cross(ab, sub(pts[i], a))) / l;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = true; stack.push([i0, bi], [bi, i1]); }
  }
  const idx: number[] = []; for (let i = 0; i < pts.length; i++) if (keep[i]) idx.push(i);
  return idx;
}

/** Divide o traço em primitivas: cantos vivos separam; entre eles, trechos consecutivos que cabem num círculo viram arco, o resto vira linha. */
function segmentize(pts: Vec2[], tol: number, minR: number, closed: boolean): Primitive[] {
  let idx = simplify(pts, tol * 0.9);
  if (idx.length < 2) return [];
  const SHARP = (55 * Math.PI) / 180;
  const turnAt = (k: number): number => {
    const a = pts[idx[k - 1]], b = pts[idx[k]], c = pts[idx[k + 1]];
    const u = sub(b, a), w = sub(c, b); return Math.atan2(cross(u, w), dot(u, w));
  };

  if (closed && idx.length > 3) {
    // Recomeça o laço no canto mais vivo, para que o fecho não caia no meio de um arco.
    let bestK = -1, best = -1;
    for (let k = 1; k < idx.length - 1; k++) { const t = Math.abs(turnAt(k)); if (t > best) { best = t; bestK = k; } }
    // Virada no vértice de fechamento (último == primeiro).
    const a = pts[idx[idx.length - 2]], b = pts[0], c = pts[idx[1]];
    const u = sub(b, a), w = sub(c, b); const t0 = Math.abs(Math.atan2(cross(u, w), dot(u, w)));
    if (bestK > 0 && best > t0) {
      const start = idx[bestK];
      const rot = pts.slice(start, pts.length - 1).concat(pts.slice(0, start), [pts[start]]);
      pts = rot; idx = simplify(pts, tol * 0.9);
      if (idx.length < 2) return [];
    }
  }

  // Cantos vivos.
  const corners: number[] = [0];
  for (let k = 1; k < idx.length - 1; k++) if (Math.abs(turnAt(k)) > SHARP) corners.push(k);
  corners.push(idx.length - 1);

  const out: Primitive[] = [];
  for (let c = 0; c < corners.length - 1; c++) {
    const s0 = corners[c], s1 = corners[c + 1]; // segmentos DP de s0 até s1-1
    let i = s0;
    while (i < s1) {
      let best = i;
      const segLen = (k: number) => dist(pts[idx[k]], pts[idx[k + 1]]);
      let avgLen = segLen(i);
      for (let k = i + 1; k < s1; k++) {
        // Cordas de um arco simplificado têm comprimentos parecidos; uma linha longa seguida de corda curta não é arco.
        const L = segLen(k);
        if (L > avgLen * 3 || L < avgLen / 3) break;
        const span = pts.slice(idx[i], idx[k + 1] + 1);
        const fc = fitCircle(span);
        if (!fc || fc.rms > tol || fc.r < minR) break;
        const sw = Math.abs(sweepOf(span, fc.c));
        if (sw < 0.2 || sw > TAU * 0.97) break;
        best = k; avgLen = (avgLen * (k - i) + L) / (k - i + 1);
      }
      const span = pts.slice(idx[i], idx[best + 1] + 1);
      if (best > i) {
        const prim = fitSingle(span, tol * 1.2, minR);
        if (prim && prim.type === 'arc') out.push(prim);
        else for (let k = i; k <= best; k++) out.push({ type: 'line', a: pts[idx[k]], b: pts[idx[k + 1]] });
      } else {
        out.push({ type: 'line', a: span[0], b: span[span.length - 1] });
      }
      i = best + 1;
    }
  }

  dropStubs(out, tol, closed);
  if (closed && out.length > 1) mergeEnds(out, pts, tol, minR);
  return out;
}

/** Remove linhas minúsculas (restos de junção) emendando as vizinhas. */
function dropStubs(out: Primitive[], tol: number, closed: boolean): void {
  const minLen = tol * 3;
  for (let i = out.length - 1; i >= 0 && out.length > 1; i--) {
    const p = out[i];
    if (p.type !== 'line' || dist(p.a, p.b) >= minLen) continue;
    const prev = out[(i - 1 + out.length) % out.length], next = out[(i + 1) % out.length];
    const hasPrev = closed || i > 0, hasNext = closed || i < out.length - 1;
    if (hasPrev && hasNext && prev !== next) {
      const j = v2((startOf(p).x + endOf(p).x) / 2, (startOf(p).y + endOf(p).y) / 2);
      setEnd(prev, j); setStart(next, j);
    } else if (hasPrev) setEnd(prev, endOf(p));
    else if (hasNext) setStart(next, startOf(p));
    out.splice(i, 1);
  }
}

/** Num laço fechado, a primeira e a última primitiva podem ser pedaços da mesma coisa. */
function mergeEnds(out: Primitive[], _pts: Vec2[], tol: number, _minR: number): void {
  const first = out[0], last = out[out.length - 1];
  if (first.type === 'line' && last.type === 'line') {
    const u = sub(first.b, first.a), w = sub(last.b, last.a);
    const ang = Math.abs(Math.atan2(cross(w, u), dot(w, u)));
    if (ang < 0.03 && Math.abs(cross(sub(first.b, last.a), w)) / (Math.hypot(w.x, w.y) || 1) < tol) {
      out.shift(); last.b = first.b; out.pop(); out.push(last);
    }
  } else if (first.type === 'arc' && last.type === 'arc') {
    if (dist(first.c, last.c) < tol * 2 && Math.abs(first.r - last.r) < tol * 2 && first.ccw === last.ccw) {
      out.shift(); last.b = first.b; last.c = v2((first.c.x + last.c.x) / 2, (first.c.y + last.c.y) / 2); last.r = (first.r + last.r) / 2;
    }
  }
}

/** Garante que o fim de cada primitiva coincide com o início da seguinte (e fecha o laço, se for o caso). */
function chain(prims: Primitive[], closed: boolean): Primitive[] {
  const out = prims.filter((p) => isWhole(p) || dist(startOf(p), endOf(p)) > 1e-9);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1], cur = out[i];
    const joint = midpoint(endOf(prev), startOf(cur));
    setEnd(prev, joint); setStart(cur, joint);
  }
  if (closed && out.length > 1) {
    const first = out[0], last = out[out.length - 1];
    const joint = midpoint(endOf(last), startOf(first));
    setEnd(last, joint); setStart(first, joint);
  }
  return out;
}

const midpoint = (a: Vec2, b: Vec2) => v2((a.x + b.x) / 2, (a.y + b.y) / 2);

/** Primitiva fechada em si (círculo, elipse, spline fechada): não encadeia com vizinhas. */
function isWhole(p: Primitive): boolean { return p.type === 'circle' || p.type === 'ellipse' || (p.type === 'spline' && p.closed); }
/** Ponto onde a primitiva começa, na ordem do traço. */
export function startOf(p: Primitive): Vec2 { return p.type === 'circle' || p.type === 'ellipse' ? p.c : p.type === 'spline' ? p.pts[0] : p.a; }
export function endOf(p: Primitive): Vec2 { return p.type === 'circle' || p.type === 'ellipse' ? p.c : p.type === 'spline' ? p.pts[p.pts.length - 1] : p.b; }
function setStart(p: Primitive, q: Vec2) { if (p.type === 'spline') p.pts[0] = q; else if (p.type === 'line' || p.type === 'arc') p.a = q; }
function setEnd(p: Primitive, q: Vec2) { if (p.type === 'spline') p.pts[p.pts.length - 1] = q; else if (p.type === 'line' || p.type === 'arc') p.b = q; }
