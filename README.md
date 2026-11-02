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

## Como usar (v0.18, modelagem direta)

- **Caneta na peça.** Risque numa face plana: abre um esboço nela, na própria vista 3D (botão "Vista reta"
  se preferir de frente). Arraste uma região sombreada do esboço: extruda ao vivo; para fora adiciona, para
  dentro corta. Toque numa face e arraste a seta: puxa ou empurra a face. Arraste uma aresta **para fora da
  peça**: filete; **para dentro**: chanfro (os botões Filete/Chanfro travam uma das formas, se preferir).
  O valor aparece numa etiqueta; toque nela para digitar.
- **Barra de ações.** Como o menu adaptativo do Shapr3D: ao tocar numa região, face, aresta ou corpo, aparece
  embaixo só o que faz sentido para aquela seleção (Extrudar, Esboçar, Puxar, Casca, Espelhar, Filete,
  Chanfro, Mover/Girar, Dividir, Padrão, Combinar, Ocultar, Apagar). Toque no vazio para limpar.
- **Mover e girar.** Toque duas vezes numa face (ou escolha o corpo em Itens): aparece o gizmo com setas X, Y, Z
  e anéis de giro. Arraste uma seta para mover no eixo, um anel para girar (de 5 em 5 graus); o valor sai na
  etiqueta e pode ser digitado. Toque duas vezes no vazio para enquadrar tudo.
- **Itens.** O painel lista corpos, esboços e planos com um olho para ocultar e mostrar. Segure a caneta (ou
  clique com o direito) num item para renomear, enquadrar ou apagar. Esboços que viraram corpo se escondem
  sozinhos; "Mostrar ocultos" e "Inverter visibilidade" ficam logo abaixo. Tecla H oculta o corpo selecionado.
- **Sobrepostos.** Segure a caneta parada sobre a peça (ou clique com o direito): abre a lista do que está
  ali embaixo (aresta, face, corpo inteiro, região de esboço, plano) para escolher exatamente o que quer.
- **Caixa de seleção.** Arraste a caneta no vazio (mouse: Shift + arrastar). Da esquerda para a direita pega só
  o que fica inteiro dentro (caixa tracejada); da direita para a esquerda, tudo o que a caixa encosta (caixa
  cheia). Vários corpos selecionados movem, giram, unem, somem e apagam juntos.
- **Filtro de seleção.** Botão "Tudo" na paleta (ou Tab para alternar; A, B, F, E): tudo, só corpos, só faces ou
  só arestas. Com "Corpos", tocar numa face pega o corpo inteiro e cada toque soma mais um.
- **Selecionar através.** O toque longo lista tudo o que a caneta atravessa, da frente para trás, com a
  distância ("Face plana de Corpo 1 · 13 mm atrás"), inclusive arestas escondidas. O botão "Através" (tecla T)
  deixa a peça translúcida: cada toque no mesmo ponto passa para a face de trás.
- **Cotas.** Retângulo, círculo, rasgo e polígono já nascem cotados (largura e altura, diâmetro, distância
  entre centros). Toque numa cota, ou direto numa linha ou círculo, e digite o valor em mm: a geometria obedece.
  O botão "Construção" na paleta deixa tudo o que você riscar como linha de referência tracejada.
- **Paleta.** A barra de ferramentas fica no topo, na horizontal; arraste pela alça para a lateral se preferir vertical.
- **Elipse e spline.** "Elipse": arraste do centro (o arrasto dá o eixo maior e a inclinação; toque na elipse para
  digitar os dois eixos). "Spline": toque ponto a ponto, a curva passa por todos; toque no primeiro ponto para
  fechar; arraste os pontos depois para ajustar. Na Caneta, um oval à mão livre vira elipse e uma curva ondulada
  sem cantos vira spline. Os dois extrudam, revolucionam e servem de caminho (spline) como qualquer contorno.
- **Aparar.** Botão "Aparar" (tecla T): o trecho sob a caneta fica laranja com um tracinho em cada corte; toque e
  ele some até os cruzamentos vizinhos (linha, círculo ou arco; spline e elipse cortam, mas ainda não se aparam).
  Arraste a caneta por cima de vários trechos para tirar todos de uma vez. Círculo cortado vira arco, linha
  cortada no meio vira duas, e a ponta nova fica presa na linha que a cortou. Sem cruzamento, some inteiro.
- **Projetar arestas.** Botão "Projetar" (tecla J): passe a caneta por um corpo e a aresta ou a face sob ela
  acende; toque e o contorno cai no plano do esboço como linha, círculo, arco ou spline (face inteira traz
  todas as arestas de uma vez, inclusive furos). Cantos repetidos se fundem e nada entra duas vezes. Com
  "Construção" ligada vira referência tracejada. Aresta de ponta para o plano não desenha nada.
- **Substituir face.** Toque numa face plana, depois em "Substituir" na barra de ações, depois na face de destino
  (plana ou cilíndrica, deste corpo ou de outro). A face passa a ficar rente ao destino: as faces vizinhas
  esticam ou encurtam, só dentro da coluna da face (um degrau some, um topo fica inclinado ou abaulado).
  Esc ou toque no vazio cancela.
- **Ângulo de saída (draft).** Toque na face plana a inclinar (ou em várias do mesmo corpo), depois em "Inclinar"
  na barra de ações, depois na face plana que fica fixa (o fundo da matriz, o plano de partição) e digite o
  ângulo. Positivo afunila no sentido de saída; negativo alarga. O ângulo pode ser mudado no histórico.
- **Ajustes (engrenagem no topo).** Material e cor da peça (aço, aço temperado, inox, alumínio, latão, bronze,
  cobre, ferro fundido, plástico, borracha, madeira ou uma cor sua), para o corpo selecionado (fica salvo na
  peça) ou para todos; cor e espessura das linhas das arestas (pretas por padrão), arestas visíveis e tema.
- **Plano solto no espaço.** No esboço, arrastar com um dedo gira a cena mesmo na vista reta (ela se desliga
  sozinha; o botão "Vista reta" volta). Dois dedos deslocam e aproximam. A órbita ficou mais leve.
- **Esboço vivo.** Linhas colam em horizontal, vertical e ângulo reto automaticamente. A caneta encaixa em
  cantos, cruzamentos de linhas (o centro de um X de construção), meios de linha e na origem do plano, com um
  anel mostrando onde vai grudar; linhas de construção são tracejadas e a origem tem uma cruz. Toque numa
  linha ou círculo para ver a medida e cotá-la; arraste o que está selecionado para mover, alongar ou mudar
  o raio. "Concluir esboço" fica fixo na tela e "Furo passante" corta atravessando com um toque. Uma linha
  selecionada num esboço sobre face pode dividir o corpo.
- **Várias faces.** Toque soma faces à seleção; a seta puxa ou empurra todas juntas. Para repetir um rasgo:
  desenhe-o numa face, conclua, toque nas outras faces e use "Furo passante com Esboço N" (ou Extrudar com
  "Repetir nas outras faces"): o mesmo desenho sai em cada face, centrado nela.
- **Tubo.** Em "Corpo ▸ Tubo", desenhe o caminho com linhas e arcos (em um ou mais esboços emendados, em planos
  diferentes para curvas em 3D), informe diâmetro e parede: sai o tubo seguindo as curvas. A varredura
  também aceita caminho em vários esboços; cantos vivos viram cotovelos.
- **Montagem.** Arraste peças livres com a caneta. Com "Colisão" ligada a peça para ao encostar em outra; desligada,
  atravessa e fica translúcida onde se sobrepõe.
- **Dedo** orbita; dois dedos aproximam. Mouse: botão esquerdo faz o que a caneta faz, direito/meio movem a câmera.

## Ferramentas, comparadas ao Shapr3D

Esboço: linha, arco, oval e curva livre à mão livre (reconhecimento do traço), linha, retângulo, círculo, elipse,
spline, polígono, rasgo, cotas, restrições automáticas (horizontal, vertical, ângulo reto, tangente, concêntrico),
deslocar contorno, espelhar, filete 2D, aparar (toque ou varredura), projetar arestas e faces de corpos, construção.
Faltam ainda: texto, padrão no esboço, aparar spline ou elipse e projeção associativa (a projetada não acompanha o corpo).

Sólidos: extrudar (novo, adicionar, cortar, por região, com padrão linear ou circular), puxar/empurrar face,
revolução, varredura, loft, filete, chanfro (pelo sentido do arrasto), casca, espelho, mover/girar pelo gizmo
(e escalar por diálogo), dividir por plano, menu adaptativo à seleção, caixa de seleção com filtros, selecionar através, vários
corpos de uma vez, itens com visibilidade e nomes, união,
subtração, interseção, substituir face (rente a plano ou cilindro), plano de construção deslocado, medir, vista em corte,
importar STEP, ângulo de saída (draft), materiais visuais. Faltam: rosca e análise de superfície.

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
