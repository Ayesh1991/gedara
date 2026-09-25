import { Link, createFileRoute, redirect } from '@tanstack/react-router';
import { CircleAlert, ScanLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { resolveScan } from '@/lib/resolve';

// A4 labels carry https://gedara.vercel.app/s/HL:LOC:… (or HL:PRD:… / HL:AST:…), so a phone's normal camera lands here
// (MASTER_PLAN §7d). Signed-out visitors go through /login?redirect=… and come back.
export const Route = createFileRoute('/_app/s/$code')({
  loader: async ({ params }) => {
    const result = await resolveScan(params.code);
    if (result.status === 'place') {
      throw redirect({ to: '/places/$placeId', params: { placeId: result.place.id }, replace: true });
    }
    if (result.status === 'product') {
      throw redirect({ to: '/pantry/$productId', params: { productId: result.product.id }, replace: true });
    }
    if (result.status === 'asset') {
      throw redirect({ to: '/things/$assetId', params: { assetId: result.asset.id }, replace: true });
    }
    return result;
  },
  component: UnknownLabel,
});

function UnknownLabel() {
  const { t } = useTranslation();
  const result = Route.useLoaderData();
  const { code } = Route.useParams();
  const title =
    result.status === 'later' ? t('scan.later.title', { phase: result.phase }) : t(`scan.${result.status}.title`);
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 pt-6">
      <Card className="flex flex-col items-center gap-3 px-6 py-8 text-center">
        <CircleAlert className="h-10 w-10 text-caution" aria-hidden />
        <h1 className="font-display text-[22px] font-semibold">{title}</h1>
        <p className="tabular break-all text-[13px] text-muted">{code}</p>
        <p className="text-[14px] leading-relaxed text-[#a5b0d0]">{t('scan.deepLinkHint')}</p>
        <Link
          to="/scan"
          className="accent-pill mt-2 inline-flex h-11 items-center gap-2 rounded-[14px] px-5 font-display font-semibold"
        >
          <ScanLine className="h-[18px] w-[18px]" aria-hidden />
          {t('scan.scanAnother')}
        </Link>
      </Card>
    </div>
  );
}
