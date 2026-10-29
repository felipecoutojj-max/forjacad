# ForjaCAD

CAD para ferramental e melhoria de equipamentos: esboço com caneta ou mouse, cotas e restrições que fecham
a geometria nas medidas, extrusão para 3D, exportação para STL e OBJ (ZBrush, visualizadores). Roda no iPad
e no Mac dentro do navegador, instala como app e funciona off-line.

Referência de interação: Shapr3D. Referência de rigor: SolidWorks.

## Rodar localmente

```bash
npm install
npm run dev
```

Abre em `http://localhost:5173`. Para abrir no iPad na mesma rede, use o endereço de rede que o Vite imprime.

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
- `src/core/kernel/preview.ts` — kernel de prévia: perfis fechados → extrusão em malha (three.js).
- `src/core/export/mesh.ts` — STL binário e OBJ com grupos.
- `src/ui/` — janela 3D, desenho do esboço, aplicativo.
- `docs/superpowers/specs/` — especificações por subprojeto.

## Roteiro

1. Núcleo e esboço 2D (este repositório, v0.1).
2. Sólidos com OpenCASCADE (WebAssembly): booleanas, furos, chanfros, filetes, empurrar e puxar faces.
3. Exportação STEP e GLB.
4. Desenho técnico ABNT em PDF e DXF.
5. Montagem com juntas, lista de materiais e balões.
6. Animação e simulação de movimento simples (v2).
