# ForjaCAD, subprojeto 5: montagem

Data: 2026-10-30. Estado: feito na v0.5.

## Objetivo

Juntar peças num conjunto com juntas que já descrevem o movimento (base da animação da v2), gerar a
lista de materiais e o desenho de conjunto com balões.

## Decisões

- **Arquivo:** um `.forja` com `kind: 'assembly'` embute as peças (`assembly.parts[].doc`), as instâncias
  (posição livre ou presa por junta) e as juntas. Nada depende de arquivos externos: funciona off-line no iPad.
- **Peças** entram importando `.forja` de peça ou por "Novo ▸ Nova montagem com esta peça". O kernel
  recalcula cada peça uma vez (cache por conteúdo) e as instâncias são a mesma malha com matrizes diferentes.
- **Juntas no estilo Fusion 360:** escolhe-se uma face da peça móvel e uma face da peça base. Face plana
  dá origem no centro e eixo na normal; face cilíndrica dá origem no eixo e eixo no eixo do cilindro. A
  peça móvel é levada para que os quadros coincidam; o tipo define o que ainda se move: rígida (nada),
  pino (ângulo), deslizante (curso), cilíndrica (ambos). "Inverter eixo" vira a peça (faces planas se
  encostam por padrão).
- **Árvore, não grafo:** cada instância é móvel de no máximo uma junta e ciclos são recusados. Isso
  dispensa um solver de restrições e já dá a cinemática da animação futura. Matrizes 4×4 próprias,
  testadas em Node.
- **Lista de materiais:** um item por peça na ordem de primeira aparição, quantidade, material (do desenho
  da peça) e volume somado.
- **Desenho de conjunto:** as mesmas vistas do subprojeto 4 sobre o conjunto (o kernel transforma as
  formas e faz o HLR), sem cotas por padrão, com balões numerados puxados radialmente para fora da
  isométrica e tabela de materiais sobre a legenda (cabeçalho embaixo, itens para cima, NBR 13272).
- **STEP da montagem:** todas as instâncias transformadas, um sólido por corpo.

## Fora deste subprojeto

Arrastar peças com o dedo, juntas com limites e molas, interferência entre peças, vistas explodidas.
