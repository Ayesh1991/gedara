import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { env } from '@/lib/env';
import { schemaVersionQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { APP_VERSION, GIT_SHA, formatBadge } from '@/lib/version';

/** Footer badge — debug step 1: is the right build deployed? */
export function VersionBadge({ className, linked = true }: { className?: string; linked?: boolean }) {
  const { data: schemaVersion } = useQuery(schemaVersionQuery);
  const text = formatBadge({ version: APP_VERSION, sha: GIT_SHA, schemaVersion, env: env.VITE_APP_ENV });
  const cls = cn('tabular text-[11px] text-muted', className);
  return linked ? (
    <Link to="/settings/diagnostics" className={cls} data-testid="version-badge">
      {text}
    </Link>
  ) : (
    <span className={cls} data-testid="version-badge">
      {text}
    </span>
  );
}
