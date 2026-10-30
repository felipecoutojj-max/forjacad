# ForjaCAD

CAD para ferramental e melhoria de equipamentos: esboço com caneta ou mouse, cotas e restrições que fecham
a geometria nas medidas, sólidos de verdade (OpenCASCADE em WebAssembly) com extrusão, corte, união, filete
e chanfro, revolução, esboço sobre faces, montagens com juntas (pino, deslizante, cilíndrica, rígida),
lista de materiais, animação do movimento pelas juntas com vídeo e verificação de interferências, desenho
técnico ABNT em PDF e DXF (vistas com linhas ocultas, cotas, legenda, balões), exportação para STEP, GLB,
STL e OBJ (ZBrush, visualizadores). Roda no iPad e no
Mac dentro do navegador, instala como app e funciona off-line.

Referência de interação: Shapr3D. Referência de rigor: SolidWorks.

## Rodar localmente

```bash
npm install
npm run dev
```

Abre em `http://localhost:5173`. Para abrir no iPad na mesma rede, use o endereço de rede que o Vite imprime.

## Como usar (v0.7, modelagem direta)

- **Caneta na peça.** Risque numa face plana: abre um esboço nela, na própria vista 3D (botão "Vista reta"
  se preferir de frente). Arraste uma região sombreada do esboço: extruda ao vivo; para fora adiciona, para
  dentro corta. Toque numa face e arraste-a: puxa ou empurra a face. Arraste uma aresta: filete (ou chanfro,
  conforme o botão ativo) com o raio seguindo a caneta. O valor aparece numa etiqueta; toque nela para digitar.
- **Esboço vivo.** Linhas colam em horizontal, vertical e ângulo reto automaticamente. A caneta encaixa em
  cantos, cruzamentos de linhas (o centro de um X de construção), meios de linha e na origem do plano, com um
  anel mostrando onde vai grudar; linhas de construção são tracejadas e a origem tem uma cruz. Toque numa
  linha ou círculo para ver a medida e cotá-la; arraste o que está selecionado para mover, alongar ou mudar
  o raio. "Concluir esboço" fica fixo na tela e "Furo passante" corta atravessando com um toque. Uma linha
  selecionada num esboço sobre face pode dividir o corpo.
- **Várias faces.** Toque soma faces à seleção; a seta puxa ou empurra todas juntas.
- **Tubo.** Em "Corpo ▸ Tubo", desenhe o caminho com linhas e arcos (em um ou mais esboços emendados, em planos
  diferentes para curvas em 3D), informe diâmetro e parede: sai o tubo seguindo as curvas. A varredura
  também aceita caminho em vários esboços; cantos vivos viram cotovelos.
- **Montagem.** Arraste peças livres com a caneta. Com "Colisão" ligada a peça para ao encostar em outra; desligada,
  atravessa e fica translúcida onde se sobrepõe.
- **Dedo** orbita; dois dedos aproximam. Mouse: botão esquerdo faz o que a caneta faz, direito/meio movem a câmera.

## Ferramentas, comparadas ao Shapr3D

Esboço: linha e arco à mão livre (reconhecimento do traço), linha, retângulo, círculo, polígono, rasgo, cotas,
restrições automáticas (horizontal, vertical, ângulo reto, tangente, concêntrico), deslocar contorno, espelhar,
filete 2D, construção. Faltam ainda: spline, elipse, texto, aparar, projetar arestas e padrão no esboço.

Sólidos: extrudar (novo, adicionar, cortar, por região, com padrão linear ou circular), puxar/empurrar face,
revolução, varredura, loft, filete, chanfro, casca, espelho, mover/girar/escalar, dividir por plano, união,
subtração, interseção, plano de construção deslocado, medir, vista em corte, importar STEP. Faltam: substituir
face, ângulo de saída (draft), rosca, análise de superfície e materiais visuais.

Montagem: peças embutidas, juntas por faces (rígida, pino, deslizante, cilíndrica), lista de materiais,
animação pelas juntas, vídeo, interferências. Desenho: vistas com ocultas, cotas, balões, lista, PDF e DXF.
Exportação: STEP, IGES, STL, OBJ, GLB. Faltam: Parasolid, 3MF, USDZ, cortes e detalhes no desenho.

## Como usar (fluxos por botão)

- Toque num plano (ou numa face plana de um corpo) para abrir um esboço. Risque com a caneta; o traço vira
  linha, arco ou círculo. Toque numa cota para digitar a medida.
- "Extrudar" abre o diálogo para quem prefere números: novo corpo, adicionar ou cortar, profundidade, sentido e "atravessar tudo".
- "Revolucionar" gira o perfil em torno de um eixo: o eixo vertical ou horizontal do esboço, ou qualquer
  linha dele (desenhe o eixo como linha de construção). Ângulo de 1° a 360°, também em corte ou adição.
- Toque numa aresta (ou em várias) e escolha filete ou chanfro. Toque num corpo para combinar com outro.
- "Desenho" monta a folha ABNT com frente, topo, lateral e isométrica no 1º diedro (ou 3º), escala
  automática, cotas gerais, diâmetros dos furos, linhas de centro e legenda. Prévia ao vivo; sai em PDF ou DXF.
- "Novo ▸ Nova montagem" abre o modo montagem: importe peças .forja (ou leve a peça atual), insira
  instâncias e crie juntas tocando numa face da peça móvel e numa face da peça base. Ajuste ângulo ou
  curso no painel; a lista de materiais aparece embaixo e o "Desenho" sai com balões e tabela.
- Na montagem, "Animar" abre a linha do tempo: cada junta ganha um movimento (ida, ida e volta ou giro),
  com duração e laço. Dá para arrastar o tempo, gravar um vídeo do ciclo e verificar interferências entre
  peças ao longo do movimento.
- O painel direito lista as features em ordem; mude valores ali e a peça recalcula. Se o kernel reprovar
  uma mudança, ela volta sozinha com o motivo.
- O kernel (50 MB) baixa só na primeira abertura; enquanto isso, a prévia em malha segura a ponta.

## Testes e build

```bash
npm test
npm run build
```

## Publicar (GitHub Pages)

Todo push em `main` roda os testes, faz o build e publica em `https://<usuario>.github.io/<repositorio>/`.
Nas configurações do repositório, em Pages, a fonte precisa estar em "GitHub Actions". No iPad, abra o
endereço no Safari e use Compartilhar ▸ Adicionar à Tela de Início.

## Estrutura

- `src/core/geom.ts` — geometria 2D.
- `src/core/sketch/` — modelo do esboço, solver de restrições (Levenberg-Marquardt), reconhecedor de traço.
- `src/core/document.ts` — documento `.forja` (planos, esboços, features).
- `src/core/kernel/profiles.ts` — perfis fechados (contornos e furos) de um esboço.
- `src/core/kernel/occ/` — kernel B-rep sobre OpenCASCADE: `build.ts` (esboço → faces, prisma, booleanas,
  filete/chanfro, malha, STEP), `worker.ts` (roda o WASM fora do thread da interface), `client.ts`.
- `src/core/kernel/preview.ts` — prévia em malha (three.js) enquanto o kernel carrega.
- `src/core/export/mesh.ts` — STL binário e OBJ com um grupo por face (polygroups no ZBrush).
- `src/core/export/glb.ts` — GLB (glTF binário) em metros, para visualizadores e realidade aumentada.
- `src/core/assembly/model.ts` — montagem: peças embutidas, instâncias, juntas (árvore), matrizes 4×4,
  lista de materiais.
- `src/core/drawing/` — desenho técnico: `layout.ts` (folha, vistas, escala, cotas, legenda), `pdf.ts`,
  `dxf.ts` (R12) e `svg.ts` (prévia). As projeções com linhas ocultas vêm de `kernel/occ/build.ts`.
- `src/ui/` — janela 3D, desenho do esboço, aplicativo.
- `docs/superpowers/specs/` — especificações por subprojeto.

## Roteiro

1. Núcleo e esboço 2D (v0.1, feito).
2. Sólidos com OpenCASCADE (WebAssembly): extrusão, corte, união, filete, chanfro, esboço em face, STEP (v0.2, feito).
3. Revolução e exportação GLB (v0.3, feito). Varredura e empurrar/puxar faces ficam para depois.
4. Desenho técnico ABNT em PDF e DXF (v0.4, feito). Cortes, detalhes e tolerâncias ficam para depois.
5. Montagem com juntas, lista de materiais e balões (v0.5, feito).
6. Animação pelas juntas, vídeo e verificação de interferências (v0.6, feito).

7. Modelagem direta (v0.7, feito): gestos da caneta no 3D, esboço na face em perspectiva, esboço manipulável,
   visual claro de vidro fosco com modo escuro.

Próximos candidatos: arrastar peças da montagem com o dedo, cortes e seções no desenho, cotas editáveis,
varredura, vistas explodidas.
