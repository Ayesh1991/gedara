import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setLanguage } from './i18n';
import './styles/index.css';
import { outbox } from './lib/offline';
import { clearOfflineCache, restoreOfflineCache } from './lib/offline/persist';
import { setResolverCache } from './lib/resolve';
import { supabase } from './lib/supabase';
import { registerServiceWorker } from './pwa/register';
import { routeTree } from './routeTree.gen';
import { readLocalPrefs } from './theme/prefs';
import { ThemeProvider } from './theme/ThemeProvider';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// The route guards may only run once the saved catalogue is back (see below): otherwise the start-up
// SIGNED_IN event would fetch the membership from the network before the saved copy is restored.
let started = false;

// Session changes (sign in/out, token refresh failure) re-run the route guards.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    queryClient.removeQueries({ queryKey: ['membership'] });
    // Nothing of this person's household stays on the device (saved catalogue, unsynced actions).
    void clearOfflineCache();
    for (const op of outbox.list()) void outbox.remove(op.op_id);
    void router.navigate({ to: '/login' });
  } else if (event === 'SIGNED_IN' && started) {
    void router.invalidate();
  }
});

registerServiceWorker();
setResolverCache(queryClient);

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

// The saved offline catalogue first (≤ 1.5 s), so a phone with no signal still opens the app.
// (A promise, not top-level await: TLA in the entry makes the bundler split every route stub out.)
void Promise.all([restoreOfflineCache(queryClient), setLanguage(readLocalPrefs().lang).catch(() => undefined)]).then(() => {
  started = true;
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});
