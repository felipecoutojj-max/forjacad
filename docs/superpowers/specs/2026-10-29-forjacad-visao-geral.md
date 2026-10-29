# ForjaCAD — visão geral e decisões

Data: 2026-10-29. Status: aprovado em conversa; código iniciado no mesmo dia a pedido do Felipe.

## Propósito

CAD para criação de ferramental interno e melhoria de equipamentos na Têmpera Gaúcha, com uso secundário em
peças hard surface para o ZBrush. Precisão real em milímetros, desenho técnico em norma, exportação que um
usinador abre.

## Decisões

- **Plataforma:** iPad e Mac com um código só, tecnologia de navegador empacotada como app instalável (PWA).
  Caneta pelo Pointer Events do Safari (pressão e inclinação disponíveis). Descartados: Python/Qt (não roda no
  iPad), Swift nativo (ponte C++ do kernel muito cara), extensão do FreeCAD (interface entranhada).
- **Distribuição:** GitHub Pages. Código público; projetos ficam no aparelho (nunca sobem). Sem telemetria.
- **Referência de interação:** Shapr3D — modelagem direta, caneta como ferramenta principal, dedo navega.
- **Sem engenharia reversa de software proprietário.** Formatos abertos (STL, OBJ, STEP, DXF) bastam.
- **Montagem completa** no roteiro (restrições, lista de materiais, balões), modelada como juntas para servir a
  animação da versão 2.

## Subprojetos

1. Núcleo e esboço 2D — esta versão. Ver spec própria.
2. Sólidos (OpenCASCADE em WebAssembly).
3. Exportação e visualização (STEP, GLB; STL e OBJ já na v0.1).
4. Desenho técnico (ABNT, PDF, DXF).
5. Montagem.
6. Animação e simulação simples (v2).
