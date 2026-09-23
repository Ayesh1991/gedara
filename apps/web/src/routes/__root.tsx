import type { QueryClient } from '@tanstack/react-query';
import { Link, Outlet, createRootRouteWithContext, type ErrorComponentProps } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Toaster } from 'sonner';
import { Brand } from '@/components/Brand';
import { VersionBadge } from '@/components/VersionBadge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <>
      <Outlet />
      <Toaster theme="dark" position="top-center" richColors />
    </>
  ),
  errorComponent: RootError,
});

function RootError({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;
  return (
    <div className="pt-safe flex min-h-dvh flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <Brand />
        <Card className="space-y-3">
          <h1 className="font-display text-xl font-semibold">
            {offline ? t('errors.offlineTitle') : t('errors.title')}
          </h1>
          <p className="tabular break-all text-xs text-muted">
            {error instanceof Error ? error.message : String(error)}
          </p>
          <Button className="w-full" onClick={reset}>
            {t('errors.retry')}
          </Button>
          <Link to="/settings/diagnostics" className="block text-center text-sm text-muted underline">
            {t('errors.diagnostics')}
          </Link>
        </Card>
        <div className="text-center">
          <VersionBadge linked={false} />
        </div>
      </div>
    </div>
  );
}
