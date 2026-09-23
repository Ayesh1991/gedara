import { createFileRoute } from '@tanstack/react-router';
import { Package } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Placeholder } from '@/components/Placeholder';

export const Route = createFileRoute('/_app/things')({
  component: Page,
});

function Page() {
  const { t } = useTranslation();
  return <Placeholder title={t('nav.things')} description={t('placeholder.things')} phase="5" icon={Package} />;
}
