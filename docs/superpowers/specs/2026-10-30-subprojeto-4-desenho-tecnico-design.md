# ForjaCAD, subprojeto 4: desenho técnico ABNT

Data: 2026-10-30. Estado: feito na v0.4.

## Objetivo

Gerar, a partir dos corpos do kernel, um desenho técnico no estilo SolidWorks: vistas ortográficas com
linhas ocultas, isométrica, cotas gerais e de furos, linhas de centro e legenda, em PDF e DXF.

## Decisões

- **Projeção:** `HLRBRep_Algo` do OpenCASCADE (remoção exata de linhas ocultas) no worker. Cada vista é um
  `gp_Ax2` com a normal apontando para quem olha. Arestas visíveis, de contorno, tangentes e ocultas saem
  separadas; círculos completos são detectados para cotar diâmetro e desenhar linhas de centro.
- **Ocultas coincidentes com visíveis** (arestas de trás alinhadas com o contorno) são descartadas testando
  pontas e meios de cada trecho contra as polilinhas visíveis.
- **Diedro:** 1º diedro por padrão (ABNT NBR 10067): topo abaixo da frente, vista esquerda à direita. 3º
  diedro opcional. A imagem de cada vista é a vista natural daquele lado; só a posição muda. Símbolo do
  diedro na legenda.
- **Folha:** A4, A3 ou A2 paisagem (NBR 10068), margem esquerda 25 mm, demais 7 mm (10 mm no A2), legenda
  de 178 mm (NBR 10582) com empresa, desenhou, data, escala, unidade, folha, título, nº, material.
- **Escala:** automática entre as normalizadas (NBR 8196), a maior em que o conjunto cabe; ou fixa.
- **Cotas automáticas:** largura e altura de cada vista ortográfica e um diâmetro por raio de furo visível,
  com setas cheias e texto de 3,5 mm (NBR 8402/10126). Linhas: visível 0,5; fina 0,25; oculta tracejada;
  centro traço-ponto (NBR 8403).
- **Saídas:** PDF 1.4 escrito à mão (vetorial, Helvetica WinAnsi), DXF R12 (camadas VISIVEL, OCULTA, CENTRO,
  COTA, TEXTO, FOLHA; tipos de linha; textos com %%c) e SVG para a prévia no diálogo.
- As opções do desenho ficam no `.forja` (`doc.drawing`).

## Fora deste subprojeto

Cortes e seções, vistas de detalhe, cotas editáveis à mão, tolerâncias e acabamento superficial.
