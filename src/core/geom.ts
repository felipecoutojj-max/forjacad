// Geometria 2D básica, em milímetros.

export interface Vec2 { x: number; y: number; }

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec2): Vec2 => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);

export const TAU = Math.PI * 2;

/** Normaliza ângulo para [0, 2π). */
export function normAngle(a: number): number {
  a = a % TAU; if (a < 0) a += TAU; return a;
}

/** Distância de um ponto a um segmento. */
export function distPointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a); const l2 = dot(ab, ab);
  if (l2 === 0) return dist(p, a);
  let t = dot(sub(p, a), ab) / l2; t = Math.max(0, Math.min(1, t));
  return dist(p, add(a, scale(ab, t)));
}

/** Ponto mais próximo num segmento. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a); const l2 = dot(ab, ab);
  if (l2 === 0) return a;
  let t = dot(sub(p, a), ab) / l2; t = Math.max(0, Math.min(1, t));
  return add(a, scale(ab, t));
}

/** Verifica se o ângulo `a` está no arco anti-horário de `start` até `end`. */
export function angleInArc(a: number, start: number, end: number): boolean {
  const s = normAngle(start); let e = normAngle(end); let x = normAngle(a);
  if (e < s) e += TAU;
  if (x < s) x += TAU;
  return x <= e + 1e-9;
}

/** Varredura angular (anti-horária) de start até end, em (0, 2π]. */
export function arcSweep(start: number, end: number): number {
  let s = normAngle(end - start); if (s === 0) s = TAU; return s;
}

/** Distância de um ponto a um arco anti-horário (centro c, raio r, de start a end). */
export function distPointArc(p: Vec2, c: Vec2, r: number, start: number, end: number): number {
  const a = angleOf(sub(p, c));
  if (angleInArc(a, start, end)) return Math.abs(dist(p, c) - r);
  const ps = add(c, v2(Math.cos(start) * r, Math.sin(start) * r));
  const pe = add(c, v2(Math.cos(end) * r, Math.sin(end) * r));
  return Math.min(dist(p, ps), dist(p, pe));
}

/** Ajuste de círculo por mínimos quadrados (método algébrico de Kasa). */
export function fitCircle(pts: Vec2[]): { c: Vec2; r: number; rms: number } | null {
  const n = pts.length; if (n < 3) return null;
  let sx = 0, sy = 0; for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12) return null;
  const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
  const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det;
  const c = v2(uc + mx, vc + my);
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  let se = 0; for (const p of pts) { const d = dist(p, c) - r; se += d * d; }
  return { c, r, rms: Math.sqrt(se / n) };
}

/** Ajuste de reta por mínimos quadrados totais (PCA). Retorna ponto, direção unitária e RMS perpendicular. */
export function fitLine(pts: Vec2[]): { p: Vec2; d: Vec2; rms: number } | null {
  const n = pts.length; if (n < 2) return null;
  let mx = 0, my = 0; for (const p of pts) { mx += p.x; my += p.y; } mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) { const u = p.x - mx, v = p.y - my; sxx += u * u; syy += v * v; sxy += u * v; }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d = v2(Math.cos(theta), Math.sin(theta));
  let se = 0; for (const p of pts) { const e = cross(d, sub(p, v2(mx, my))); se += e * e; }
  return { p: v2(mx, my), d, rms: Math.sqrt(se / n) };
}

/** Reamostra uma polilinha para passo aproximadamente uniforme. */
export function resample(pts: Vec2[], step: number): Vec2[] {
  if (pts.length < 2) return pts.slice();
  const out: Vec2[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1]; const b = pts[i];
    let d = dist(a, b);
    while (acc + d >= step) {
      const t = (step - acc) / d;
      const p = lerp(a, b, t);
      out.push(p); a = p; d = dist(a, b); acc = 0;
    }
    acc += d;
  }
  if (dist(out[out.length - 1], pts[pts.length - 1]) > step * 0.25) out.push(pts[pts.length - 1]);
  return out;
}

export function polylineLength(pts: Vec2[]): number {
  let l = 0; for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]); return l;
}

export function round(v: number, decimals = 2): number {
  const f = Math.pow(10, decimals); return Math.round(v * f) / f;
}
