# ForjaCAD, subprojeto 6: animação e simulação simples

Data: 2026-10-30. Estado: feito na v0.6 (era a "v2" do plano original; as juntas do subprojeto 5 já
carregavam ângulo e curso, então o custo caiu).

## Objetivo

Mostrar o conjunto em movimento pelas juntas, gravar um vídeo e verificar se peças se interpenetram
durante o movimento.

## Decisões

- **Movimento por junta, não por quadros-chave.** Cada junta móvel tem uma faixa: modo "ida" (de A a B),
  "ida e volta" ou "giro contínuo" (N voltas), com ângulo ou curso inicial e final. A animação tem duração
  (s) e laço. Isso cobre giro e deslocamento simples, que era o pedido, e é fácil de ajustar no iPad.
- **Nada muda no documento ao animar:** `computeTransformsAt(asm, t)` recalcula só as matrizes com os
  valores do instante t; a cena troca matrizes sem reconstruir malha (60 fps mesmo em montagens grandes).
  Os valores fixos das juntas continuam sendo a "pose" de projeto.
- **Vídeo** gravado do próprio canvas com `MediaRecorder`: MP4 no Safari/iPad, WebM nos demais; um ciclo
  completo da animação, parando sozinho no fim.
- **Interferência** pelo kernel: o movimento é amostrado em 13 posições (ou só a atual, sem faixas) e para
  cada par de instâncias com caixas que se cruzam calcula-se `BRepAlgoAPI_Common`; volume acima de
  0,01 mm³ é interferência. Lista no painel com instante, par e volume; tocar leva a linha do tempo até lá.
  Peças que só encostam (pino justo no furo) dão volume zero e não acusam.
- Faixas e duração ficam gravadas no `.forja` (`assembly.animation`).

## Fora deste subprojeto

Quadros-chave livres, câmera animada, limites físicos de curso, contato e colisão em tempo real, exportação
de vídeo com fundo transparente.
