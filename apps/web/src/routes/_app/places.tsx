import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Placeholder } from '@/components/Placeholder';

export const Route = createFileRoute('/_app/places')({
  component: Page,
});

function Page() {
  const { t } = useTranslation();
  return <Placeholder title={t('nav.places')} description={t('placeholder.places')} phase="1" />;
}
