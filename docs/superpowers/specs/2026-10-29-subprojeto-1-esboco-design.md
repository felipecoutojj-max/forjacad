# Subprojeto 1 — Núcleo e esboço 2D

## Entrega

App que abre no iPad e no Mac, mostra os três planos base, deixa escolher um, riscar nele com caneta ou mouse
e transforma o risco em linhas, arcos e círculos. Restrições (horizontal, vertical, paralelo, perpendicular,
igual, tangente, concêntrico, ponto em linha, ponto em círculo, ponto médio, fixo) e cotas (distância,
horizontal, vertical, ângulo, raio, diâmetro) ajustam o esboço até fechar nas medidas. Salva e reabre.

Adiantado do subprojeto 2 para permitir teste de ponta a ponta: extrusão de prévia (malha three.js, não B-rep)
e exportação STL/OBJ.

## Componentes

| Peça | Arquivo | Responsabilidade |
| --- | --- | --- |
| Geometria 2D | `src/core/geom.ts` | vetores, ajuste de reta e círculo, reamostragem |
| Modelo do esboço | `src/core/sketch/model.ts` | pontos, entidades, restrições, cotas; fusão de pontos |
| Solver | `src/core/sketch/solver.ts` | Levenberg-Marquardt, jacobiana numérica, DOF, sobre-restrição, arrasto |
| Reconhecedor | `src/core/sketch/recognizer.ts` | traço → primitivas: cantos vivos, agrupamento por ajuste de círculo |
| Documento | `src/core/document.ts` | planos, esboços, features; JSON `.forja` versão 1 |
| Kernel de prévia | `src/core/kernel/preview.ts` | rastreio de faces do grafo planar → perfis com furos → extrusão |
| Exportação | `src/core/export/mesh.ts` | STL binário, OBJ com grupos |
| Janela 3D | `src/ui/viewport.ts` | câmeras perspectiva/ortográfica, planos, corpos, projeções |
| Desenho do esboço | `src/ui/sketchRenderer.ts` | linhas, pontos, cotas, etiquetas de restrição |
| Aplicativo | `src/ui/app.ts` | ferramentas, gestos, painel, undo, autosave, arquivos |

## Entrada

- Caneta (pointerType `pen`) e mouse esquerdo acionam a ferramenta ativa.
- Um dedo navega (órbita em vista, pan em esboço); dois dedos aproximam e arrastam. Opção "dedo desenha".
- Mouse direito ou meio arrasta a vista; roda aproxima.
- Tolerância de toque: 10 px para caneta e mouse, 16 px para dedo, convertida em mm pelo zoom.

## Reconhecimento e encaixe automático

- Traço fechado redondo → círculo. Traço reto → linha. Traço curvo → arco com sentido detectado.
- Traço composto → Douglas-Peucker, cantos acima de 55° separam; entre cantos, cordas consecutivas de
  comprimento parecido que cabem num círculo viram arco; o resto vira linha. Restos minúsculos são emendados.
- Linhas a menos de 6° da horizontal ou vertical recebem a restrição e endireitam.
- Pontas a menos da tolerância de um ponto existente são fundidas (coincidência). Pontas sobre uma linha ou
  círculo existente recebem ponto-em-linha ou ponto-em-círculo.
- Linha que encontra arco quase tangente recebe tangência.
- Se o solver não convergir com as restrições automáticas, elas são removidas e o traço fica como riscado.

## Solver

Variáveis: coordenadas de pontos não fixos e raios. Equações em milímetros (ângulo escalado por 20 mm/rad).
Arrasto: primeiro tenta o ponto como fixo no alvo; se não fecha, solta com puxão fraco e faz um passe final só
com as restrições reais. DOF = variáveis − posto da jacobiana empilhada com os três modos de corpo rígido.
Sobre-restrição = equações > posto.

## Documento `.forja`

JSON legível com `format: "forja"`, `version: 1`, planos, esboços (geometria + restrições + cotas) e features.
Autosave no `localStorage` a cada mudança; "Salvar" baixa o arquivo; "Abrir" lê do aparelho.

## Fora de escopo nesta versão

Kernel B-rep, corte (booleana), planos deslocados e em faces, desenho técnico, STEP, nuvem, múltiplos usuários.

## Testes

Vitest: solver (retângulo, concêntrico, tangente, arrasto, sobre-restrição, ângulo), reconhecedor (linha,
círculo, arco, retângulo, ranhura), perfis (furo, separados, ranhura, aresta compartilhada).
Verificação manual: Safari no Mac e no iPad em rede local, depois no endereço publicado.
