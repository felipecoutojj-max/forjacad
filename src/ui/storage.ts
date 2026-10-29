// Armazenamento local (autosave) e troca de arquivos com o aparelho.

const KEY = 'forjacad.current';

export function saveLocal(text: string): void {
  try { localStorage.setItem(KEY, text); } catch (e) { console.warn('Autosave falhou', e); }
}
export function loadLocal(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function clearLocal(): void { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

/** Entrega um arquivo ao usuário. No iPad vai para Arquivos ▸ Downloads; no Mac, para Downloads. */
export function downloadFile(name: string, data: string | ArrayBuffer, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
}

/** Abre o seletor de arquivos e devolve o texto do escolhido. */
export function pickFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept; input.style.display = 'none';
    input.onchange = async () => {
      const f = input.files?.[0]; input.remove();
      if (!f) return resolve(null);
      resolve({ name: f.name, text: await f.text() });
    };
    input.oncancel = () => { input.remove(); resolve(null); };
    document.body.appendChild(input); input.click();
  });
}

export function safeFileName(name: string): string {
  return (name || 'peca').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'peca';
}
