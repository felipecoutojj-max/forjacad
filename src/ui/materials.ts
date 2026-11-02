// Materiais visuais das peças e ajustes de visualização (linhas, arestas), guardados no aparelho.

export interface MaterialSpec { name: string; color: number; metalness: number; roughness: number; }

/** Materiais de oficina: a cor e o brilho lembram o material real, sem pretensão de render físico. */
export const MATERIALS: Record<string, MaterialSpec> = {
  aco: { name: 'Aço (padrão)', color: 0xd3d8df, metalness: 0.12, roughness: 0.62 },
  acoTemperado: { name: 'Aço temperado', color: 0x6b7684, metalness: 0.45, roughness: 0.42 },
  inox: { name: 'Inox', color: 0xc8ccd2, metalness: 0.6, roughness: 0.3 },
  aluminio: { name: 'Alumínio', color: 0xe2e5e9, metalness: 0.55, roughness: 0.4 },
  latao: { name: 'Latão', color: 0xd4b25c, metalness: 0.75, roughness: 0.35 },
  bronze: { name: 'Bronze', color: 0xb07a3c, metalness: 0.7, roughness: 0.4 },
  cobre: { name: 'Cobre', color: 0xc8744a, metalness: 0.8, roughness: 0.35 },
  ferroFundido: { name: 'Ferro fundido', color: 0x707478, metalness: 0.3, roughness: 0.85 },
  plastico: { name: 'Plástico', color: 0x3b7dd8, metalness: 0, roughness: 0.45 },
  borracha: { name: 'Borracha', color: 0x2b2b2e, metalness: 0, roughness: 0.95 },
  madeira: { name: 'Madeira', color: 0xb8895a, metalness: 0, roughness: 0.8 },
};

export type EdgeColorKey = 'auto' | 'black' | 'graphite' | 'white' | 'ember';
export const EDGE_COLORS: Record<EdgeColorKey, { name: string; hex: number | null }> = {
  auto: { name: 'Automática (tema)', hex: null },
  black: { name: 'Preto', hex: 0x111111 },
  graphite: { name: 'Grafite', hex: 0x3a3a3c },
  white: { name: 'Branco', hex: 0xf5f5f7 },
  ember: { name: 'Laranja', hex: 0xf0542b },
};

export interface ViewSettings {
  /** Material padrão (chave de MATERIALS ou "custom"). */
  material: string;
  /** Cor do material personalizado, "#rrggbb". */
  customColor: string;
  edgeColor: EdgeColorKey;
  /** Espessura das arestas em pixels. */
  edgeWidth: number;
  showEdges: boolean;
}

export const DEFAULT_VIEW: ViewSettings = { material: 'aco', customColor: '#f0542b', edgeColor: 'auto', edgeWidth: 1.5, showEdges: true };

const KEY = 'forjacad.view';
export function loadViewSettings(): ViewSettings {
  try {
    const raw = localStorage.getItem(KEY); if (!raw) return { ...DEFAULT_VIEW };
    const v = JSON.parse(raw) as Partial<ViewSettings>; const out = { ...DEFAULT_VIEW };
    if (typeof v.material === 'string' && (v.material in MATERIALS || v.material === 'custom')) out.material = v.material;
    if (typeof v.customColor === 'string' && /^#[0-9a-f]{6}$/i.test(v.customColor)) out.customColor = v.customColor;
    if (typeof v.edgeColor === 'string' && v.edgeColor in EDGE_COLORS) out.edgeColor = v.edgeColor as EdgeColorKey;
    if (typeof v.edgeWidth === 'number' && v.edgeWidth >= 0.5 && v.edgeWidth <= 6) out.edgeWidth = v.edgeWidth;
    if (typeof v.showEdges === 'boolean') out.showEdges = v.showEdges;
    return out;
  } catch { return { ...DEFAULT_VIEW }; }
}
export function saveViewSettings(v: ViewSettings): void { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ } }

/** Especificação de material para uma chave ("aco", "latao", "#rrggbb" ou "custom"). `undefined` = padrão do tema. */
export function materialSpec(key: string | undefined, customColor: string): MaterialSpec | undefined {
  if (!key || key === 'aco') return undefined;
  if (key === 'custom') return { name: 'Personalizado', color: parseInt(customColor.slice(1), 16), metalness: 0.2, roughness: 0.55 };
  if (/^#[0-9a-f]{6}$/i.test(key)) return { name: 'Cor', color: parseInt(key.slice(1), 16), metalness: 0.2, roughness: 0.55 };
  return MATERIALS[key];
}
export function hexString(color: number): string { return `#${color.toString(16).padStart(6, '0')}`; }
