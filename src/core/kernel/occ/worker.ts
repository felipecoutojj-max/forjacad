// Worker do kernel: carrega o OpenCASCADE (WASM) e atende pedidos de recálculo e exportação.
// Guarda as formas do último recálculo para exportar STEP sem recalcular.

/// <reference lib="webworker" />
import ocInit from 'opencascade.js/dist/opencascade.full.js';
import wasmUrl from 'opencascade.js/dist/opencascade.full.wasm?url';
import type { OpenCascadeInstance } from 'opencascade.js';
import { rebuildDocument, tessellate, exportSTEP, errorMessage, type BuiltBody } from './build';
import type { KernelRequest, KernelResponse, BodyData } from './types';
import { bodyName } from '../../document';

const post = (m: KernelResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

let oc: OpenCascadeInstance | null = null;
let last: BuiltBody[] = [];
const queue: KernelRequest[] = [];
const t0 = performance.now();

type Factory = (opts: { locateFile(path: string): string; print?(s: string): void; printErr?(s: string): void }) => Promise<OpenCascadeInstance>;
(ocInit as unknown as Factory)({
  locateFile: (p) => (p.endsWith('.wasm') ? wasmUrl : p),
  print: () => { /* o STEPControl imprime estatísticas; silencia */ },
  printErr: (s) => console.warn('[occ]', s),
})
  .then((inst) => { oc = inst; post({ id: 0, type: 'ready', ms: performance.now() - t0 }); for (const q of queue) handle(q); queue.length = 0; })
  .catch((e) => post({ id: 0, type: 'failed', message: String(e) }));

self.onmessage = (ev: MessageEvent<KernelRequest>) => { if (!oc) { queue.push(ev.data); return; } handle(ev.data); };

function handle(req: KernelRequest): void {
  if (!oc) return;
  try {
    if (req.type === 'rebuild') {
      const t = performance.now();
      const { bodies, errors } = rebuildDocument(oc, req.doc);
      last = bodies;
      const data: BodyData[] = []; const transfer: Transferable[] = [];
      for (const b of bodies) {
        try {
          const d = tessellate(oc, b, bodyName(req.doc, b.id));
          data.push(d); transfer.push(d.positions.buffer, d.normals.buffer, d.indices.buffer, d.triFace.buffer);
          for (const e of d.edges) transfer.push(e.points.buffer);
        } catch (e) { errors.push({ feature: b.id, message: `malha falhou: ${errorMessage(oc, e)}` }); }
      }
      post({ id: req.id, type: 'rebuilt', result: { bodies: data, errors, ms: performance.now() - t } }, transfer);
    } else if (req.type === 'export') {
      if (!last.length) throw new Error('Nenhum corpo para exportar.');
      const text = exportSTEP(oc, last);
      post({ id: req.id, type: 'exported', data: text, mime: 'application/step' });
    }
  } catch (e) {
    post({ id: req.id, type: 'error', message: errorMessage(oc, e) });
  }
}
