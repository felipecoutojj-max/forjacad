# ForjaCAD, subprojeto 2: sólidos de verdade (OpenCASCADE)

Data: 2026-10-30. Estado: aprovado pelo Felipe ("Sim, segue"), codando direto.

## Objetivo

Trocar a extrusão de prévia (malha three.js) por um kernel B-rep real, para que a peça
tenha faces, arestas e volume de verdade: corte, união, filete, chanfro, esboço sobre face
de um corpo e exportação STEP. O documento `.forja` continua guardando esboços e features,
nunca a malha.

## Decisões

- **Kernel:** opencascade.js 2.0.0-beta (OCCT 7.6 em WebAssembly, ~50 MB). Viabilidade medida
  em Node: carga 2,7 s, caixa menos cilindro com filetes 0,27 s, malha 0,09 s, STEP 0,13 s.
  Alternativa descartada: Manifold (só malha, sem STEP nem filete de aresta).
- **Onde roda:** num Web Worker, para a interface nunca travar. O worker guarda as formas
  (`TopoDS_Shape`) do último recálculo e devolve só malhas e metadados ao app.
- **Modelo:** lista ordenada de features, recalculada do zero a cada mudança (modelagem
  "direta" na interface, histórico simples por baixo). Corpos são identificados pela feature
  que os criou.
- **Referência de aresta** para filete e chanfro é geométrica: ponto médio e comprimento.
  No recálculo, a aresta mais próxima é usada. Se sumir, a feature fica marcada com erro e é pulada.
- **Plano sobre face:** ao tocar numa face plana, cria-se um `Plane` do documento com a
  geometria da face naquele momento (origem, u, v). Não há rastreio da face depois.
- **Prévia:** enquanto o kernel carrega (primeira vez, 50 MB), o app segue mostrando a
  extrusão de prévia para features do tipo "novo corpo".
- **Cache off-line:** o service worker passa a guardar o `.wasm` (limite subido para 64 MB).

## Formato `.forja` versão 2

```ts
ExtrudeFeature { type:'extrude', sketch, depth, op:'new'|'add'|'cut', target?, symmetric?, flip?, throughAll? }
FilletFeature  { type:'fillet'|'chamfer', body, edges: {mid:[x,y,z], len}[], radius }
BooleanFeature { type:'boolean', op:'union'|'subtract'|'intersect', body, tool }
Plane          { ..., kind?: 'base'|'face' }
```
Migração da v1: `op:'add'` vira `op:'new'` (na v1 "add" era corpo novo).

## Componentes

- `src/core/kernel/profiles.ts`: extração de perfis fechados do esboço (sem three.js), usada
  pela prévia e pelo kernel.
- `src/core/kernel/occ/build.ts`: funções puras sobre a instância `oc`: esboço → faces,
  prisma, booleanas, filete/chanfro, malha com ids de face e polilinhas de aresta, STEP.
- `src/core/kernel/occ/worker.ts`: carrega o wasm, atende `rebuild` e `export`.
- `src/core/kernel/occ/client.ts`: promessas sobre o worker, coalescendo recálculos.
- `src/ui/viewport.ts`: corpos a partir das malhas do kernel, destaque de face e aresta,
  picking de face (raio → triângulo → face) e de aresta (distância em pixels).
- `src/ui/app.ts`: seleção 3D, menu de face (esboçar, cortar), filete/chanfro, painel de
  features editável, exportação STEP.

## Testes

`build.test.ts` roda com o wasm real em Node: caixa por extrusão, furo por corte, filete por
referência de aresta, união, STEP não vazio. Os testes existentes do esboço e da prévia continuam.

## Fora deste subprojeto

Desenho técnico (4), montagem (5), revolução/varredura e casca (ficam para a v0.3 se o Felipe pedir).
