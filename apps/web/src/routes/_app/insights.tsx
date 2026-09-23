import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Placeholder } from '@/components/Placeholder';

export const Route = createFileRoute('/_app/insights')({
  component: Page,
});

function Page() {
  const { t } = useTranslation();
  return <Placeholder title={t('nav.insights')} description={t('placeholder.insights')} phase="6" />;
}
