import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowDownToLine, PackagePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { membershipQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** "Put in a place" / "Fill this box": into the Scan screen's put-away modes (Phase 7b). */
export function PutAwayLink({
  kind,
  id,
  onNavigate,
  className,
}: {
  kind: 'asset' | 'product' | 'location';
  id: string;
  onNavigate?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const membership = useQuery(membershipQuery);
  if (!membership.data || membership.data.role === 'viewer') return null;
  return (
    <Link
      to="/scan"
      search={{ put: `${kind}:${id}` }}
      onClick={onNavigate}
      className={cn('glass flex h-11 items-center justify-center gap-1.5 rounded-[14px] px-3 text-[14px]', className)}
    >
      <ArrowDownToLine className="h-4 w-4" aria-hidden />
      {t('scan.put.start')}
    </Link>
  );
}

export function FillLink({ placeId, onNavigate, className }: { placeId: string; onNavigate?: () => void; className?: string }) {
  const { t } = useTranslation();
  const membership = useQuery(membershipQuery);
  if (!membership.data || membership.data.role === 'viewer') return null;
  return (
    <Link
      to="/scan"
      search={{ fill: placeId }}
      onClick={onNavigate}
      className={cn('glass flex h-11 items-center justify-center gap-1.5 rounded-[14px] px-3 text-[14px]', className)}
    >
      <PackagePlus className="h-4 w-4" aria-hidden />
      {t('scan.fill.start')}
    </Link>
  );
}
