import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import i18n, { setLanguage } from '@/i18n';
import { supabase } from '@/lib/supabase';
import {
  applyPrefs,
  parsePrefs,
  readLocalPrefs,
  reconcile,
  resolveMotion,
  writeLocalPrefs,
  type Prefs,
} from './prefs';

function pushToAccount(prefs: Prefs) {
  void supabase.auth.getSession().then(({ data }) => {
    if (!data.session) return;
    void supabase.auth.updateUser({ data: { prefs } }).then(({ error }) => {
      if (error) toast.error(i18n.t('appearance.saveFailed', { message: error.message }));
    });
  });
}

interface ThemeContextValue {
  prefs: Prefs;
  setPrefs: (next: Partial<Prefs>) => void;
  /** Resolved: should animations (aurora drift, count-up, page transitions) run? */
  motion: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function useSystemReducedMotion(): boolean {
  const [reduce, setReduce] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduce(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduce;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // index.html already painted these before React; state starts from the same source.
  const [prefs, setPrefsState] = useState<Prefs>(() => readLocalPrefs());
  const systemReduce = useSystemReducedMotion();

  // Sync with the account: the newer of this device's and the account's prefs wins.
  useEffect(() => {
    const sync = (remoteRaw: unknown) => {
      const { adopt, push } = reconcile(readLocalPrefs(), remoteRaw ? parsePrefs(remoteRaw) : null);
      if (adopt) {
        applyPrefs(adopt);
        writeLocalPrefs(adopt);
        setPrefsState(adopt);
      } else if (push) {
        pushToAccount(readLocalPrefs());
      }
    };
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session || (event !== 'INITIAL_SESSION' && event !== 'SIGNED_IN')) return;
      // The stored session carries user_metadata as of its last refresh, so fetch the live user.
      // Deferred: calling supabase inside this callback can deadlock the auth client.
      setTimeout(() => {
        void supabase.auth.getUser().then(({ data: u }) => sync(u.user?.user_metadata?.prefs));
      }, 0);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  // The UI language follows the prefs (also when another device changed it).
  useEffect(() => {
    void setLanguage(prefs.lang).catch(() => undefined);
  }, [prefs.lang]);

  // Apply + store locally at once; save to the account in the background.
  const setPrefs = useCallback(
    (next: Partial<Prefs>) => {
      const merged = parsePrefs({ ...prefs, ...next, updatedAt: Date.now() });
      applyPrefs(merged);
      writeLocalPrefs(merged);
      setPrefsState(merged);
      pushToAccount(merged);
    },
    [prefs],
  );

  const value = useMemo(
    () => ({ prefs, setPrefs, motion: resolveMotion(prefs.motion, systemReduce) }),
    [prefs, setPrefs, systemReduce],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
