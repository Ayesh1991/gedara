// The browser's own "Install" offer (Chrome / Edge / Samsung Internet) arrives once, early in the
// page's life — before the Install help sheet is ever opened — so it is caught here, as soon as
// the Quick spend route loads, and kept until the person asks for it. (iOS never offers it: there
// the steps are Share › Add to Home Screen.) Phase 12.
export interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
}

let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

export const canInstall = () => deferred !== null;

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Show the browser's install dialog (once; the browser offers it again later if declined). */
export async function promptInstall(): Promise<void> {
  const d = deferred;
  deferred = null;
  listeners.forEach((l) => l());
  await d?.prompt();
}
