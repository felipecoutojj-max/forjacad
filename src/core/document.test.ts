import { describe, it, expect } from 'vitest';
import { createDocument, serialize, deserialize, setHidden, isHidden, renameBody, bodyName, addExtrude } from './document';
import { createSketch } from './sketch/model';

describe('visibilidade e nomes no documento', () => {
  it('oculta e mostra itens, e sobrevive a salvar e abrir', () => {
    const doc = createDocument();
    const s = createSketch('plane-xy', 'Esboço 1'); doc.sketches.push(s);
    setHidden(doc, s.id, true);
    expect(isHidden(doc, s.id)).toBe(true);
    const d2 = deserialize(serialize(doc));
    expect(isHidden(d2, s.id)).toBe(true);
    setHidden(d2, s.id, false);
    expect(d2.hidden).toBeUndefined();
  });
  it('renomeia corpos e limpa caracteres de controle', () => {
    const doc = createDocument();
    const s = createSketch('plane-xy', 'Esboço 1'); doc.sketches.push(s);
    const f = addExtrude(doc, s.id, 10);
    expect(bodyName(doc, f.id)).toBe('Corpo 1');
    renameBody(doc, f.id, 'Base da matriz');
    const d2 = deserialize(serialize(doc));
    expect(bodyName(d2, f.id)).toBe('Base da matriz');
    renameBody(d2, f.id, '');
    expect(bodyName(d2, f.id)).toBe('Corpo 1');
    const raw = JSON.parse(serialize(doc)); raw.names[f.id] = 'a\u0007b'; raw.hidden = ['x', 5, null];
    const d3 = deserialize(JSON.stringify(raw));
    expect(bodyName(d3, f.id)).toBe('ab'); expect(d3.hidden).toEqual(['x']);
  });
});
