# ForjaCAD

CAD para ferramental e melhoria de equipamentos: esboço com caneta ou mouse, cotas e restrições que fecham
a geometria nas medidas, sólidos de verdade (OpenCASCADE em WebAssembly) com extrusão, corte, união, filete
e chanfro, revolução, esboço sobre faces, desenho técnico ABNT em PDF e DXF (vistas com linhas ocultas,
cotas, legenda), exportação para STEP, GLB, STL e OBJ (ZBrush, visualizadores). Roda no iPad e no
Mac dentro do navegador, instala como app e funciona off-line.

Referência de interação: Shapr3D. Referência de rigor: SolidWorks.

## Rodar localmente

```bash
npm install
npm run dev
```

Abre em `http://localhost:5173`. Para abrir no iPad na mesma rede, use o endereço de rede que o Vite imprime.

## Como usar (v0.2)

- Toque num plano (ou numa face plana de um corpo) para abrir um esboço. Risque com a caneta; o traço vira
  linha, arco ou círculo. Toque numa cota para digitar a medida.
- "Extrudar" abre o diálogo: novo corpo, adicionar ou cortar, profundidade, sentido e "atravessar tudo".
- "Revolucionar" gira o perfil em torno de um eixo: o eixo vertical ou horizontal do esboço, ou qualquer
  linha dele (desenhe o eixo como linha de construção). Ângulo de 1° a 360°, também em corte ou adição.
- Toque numa aresta (ou em várias) e escolha filete ou chanfro. Toque num corpo para combinar com outro.
- "Desenho" monta a folha ABNT com frente, topo, lateral e isométrica no 1º diedro (ou 3º), escala
  automática, cotas gerais, diâmetros dos furos, linhas de centro e legenda. Prévia ao vivo; sai em PDF ou DXF.
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
- `src/core/drawing/` — desenho técnico: `layout.ts` (folha, vistas, escala, cotas, legenda), `pdf.ts`,
  `dxf.ts` (R12) e `svg.ts` (prévia). As projeções com linhas ocultas vêm de `kernel/occ/build.ts`.
- `src/ui/` — janela 3D, desenho do esboço, aplicativo.
- `docs/superpowers/specs/` — especificações por subprojeto.

## Roteiro

1. Núcleo e esboço 2D (v0.1, feito).
2. Sólidos com OpenCASCADE (WebAssembly): extrusão, corte, união, filete, chanfro, esboço em face, STEP (v0.2, feito).
3. Revolução e exportação GLB (v0.3, feito). Varredura e empurrar/puxar faces ficam para depois.
4. Desenho técnico ABNT em PDF e DXF (v0.4, feito). Cortes, detalhes e tolerâncias ficam para depois.
5. Montagem com juntas, lista de materiais e balões.
6. Animação e simulação de movimento simples (v2).
