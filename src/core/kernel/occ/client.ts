// Cliente do kernel no thread principal: promessas sobre o worker, com recálculos coalescidos
// (se chegam vários pedidos enquanto um roda, só o último vale).

import type { ForjaDocument } from '../../document';
import type { KernelRequest, KernelResponse, RebuildResult, ViewSpec, ProjectedView, AssemblyPayload, InterferenceHit } from './types';

type RequestBody = { type: 'rebuild'; doc: ForjaDocument } | { type: 'export'; format: 'step' } | { type: 'project'; views: ViewSpec[] } | { type: 'projectAssembly'; assembly: AssemblyPayload; views: ViewSpec[] } | { type: 'exportAssembly'; assembly: AssemblyPayload } | { type: 'interference'; parts: AssemblyPayload['parts']; steps: { part: string; matrix: number[] }[][] };

export type KernelState = 'loading' | 'ready' | 'failed';

export class SupersededError extends Error { constructor() { super('recálculo substituído por outro mais novo'); this.name = 'SupersededError'; } }

interface Pending { resolve: (v: never) => void; reject: (e: Error) => void; kind: KernelRequest['type']; coalesced?: boolean; }

export class KernelClient {
  state: KernelState = 'loading';
  loadMs = 0; failure = '';
  onState: ((s: KernelState) => void) | null = null;
  private worker: Worker | null = null;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private rebuildInFlight = false;
  private queued: { doc: ForjaDocument; resolve: (v: RebuildResult) => void; reject: (e: Error) => void } | null = null;

  constructor() {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<KernelResponse>) => this.onMessage(ev.data);
      this.worker.onerror = (ev) => this.fail(ev.message || 'erro no worker do kernel');
    } catch (e) { this.fail((e as Error).message); }
  }

  private fail(message: string): void {
    this.state = 'failed'; this.failure = message;
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
    if (this.queued) { this.queued.reject(new Error(message)); this.queued = null; }
    this.onState?.(this.state);
  }

  private onMessage(m: KernelResponse): void {
    if (m.type === 'ready') { this.state = 'ready'; this.loadMs = m.ms; this.onState?.(this.state); return; }
    if (m.type === 'failed') { this.fail(m.message); return; }
    const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
    if (p.coalesced) { this.rebuildInFlight = false; }
    if (m.type === 'error') p.reject(new Error(m.message));
    else if (m.type === 'rebuilt') p.resolve(m.result as never);
    else if (m.type === 'exported') p.resolve(m.data as never);
    else if (m.type === 'projected') p.resolve(m.views as never);
    else if (m.type === 'interference') p.resolve(m.hits as never);
    if (p.coalesced && this.queued) { const q = this.queued; this.queued = null; this.startRebuild(q.doc, q.resolve, q.reject); }
  }

  private send(req: RequestBody, resolve: (v: never) => void, reject: (e: Error) => void, coalesced = false): void {
    if (!this.worker || this.state === 'failed') { reject(new Error(this.failure || 'kernel indisponível')); return; }
    const id = this.seq++;
    this.pending.set(id, { resolve, reject, kind: req.type, coalesced });
    const msg: KernelRequest = { ...req, id }; this.worker.postMessage(msg);
  }

  private startRebuild(doc: ForjaDocument, resolve: (v: RebuildResult) => void, reject: (e: Error) => void): void {
    this.rebuildInFlight = true;
    this.send({ type: 'rebuild', doc }, resolve as (v: never) => void, reject, true);
  }

  /** Recálculo avulso (peça de uma montagem): não entra na fila coalescida do documento principal. */
  rebuildOnce(doc: ForjaDocument): Promise<RebuildResult> {
    return new Promise((resolve, reject) => this.send({ type: 'rebuild', doc }, resolve as (v: never) => void, reject));
  }
  projectAssembly(assembly: AssemblyPayload, views: ViewSpec[]): Promise<ProjectedView[]> {
    return new Promise((resolve, reject) => this.send({ type: 'projectAssembly', assembly, views }, resolve as (v: never) => void, reject));
  }
  interference(parts: AssemblyPayload['parts'], steps: { part: string; matrix: number[] }[][]): Promise<InterferenceHit[]> {
    return new Promise((resolve, reject) => this.send({ type: 'interference', parts, steps }, resolve as (v: never) => void, reject));
  }
  exportStepAssembly(assembly: AssemblyPayload): Promise<string> {
    return new Promise((resolve, reject) => this.send({ type: 'exportAssembly', assembly }, resolve as (v: never) => void, reject));
  }

  /** Recalcula o documento. Um pedido anterior ainda na fila é rejeitado com SupersededError. */
  rebuild(doc: ForjaDocument): Promise<RebuildResult> {
    return new Promise((resolve, reject) => {
      if (this.rebuildInFlight) {
        if (this.queued) this.queued.reject(new SupersededError());
        this.queued = { doc, resolve, reject };
        return;
      }
      this.startRebuild(doc, resolve, reject);
    });
  }

  /** Projeções com linhas ocultas dos corpos do último recálculo. */
  project(views: ViewSpec[]): Promise<ProjectedView[]> {
    return new Promise((resolve, reject) => this.send({ type: 'project', views }, resolve as (v: never) => void, reject));
  }

  exportStep(): Promise<string> {
    return new Promise((resolve, reject) => this.send({ type: 'export', format: 'step' }, resolve as (v: never) => void, reject));
  }
}
