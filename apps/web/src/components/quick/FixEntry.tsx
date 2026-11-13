// "Fix" on one of today's quick entries: the ordinary expense form (note, date, account, category,
// amount), loaded only when asked for so the Quick spend screen itself stays small.
import { useQuery } from '@tanstack/react-query';
import { TransactionForm } from '@/components/money/TransactionForm';
import { accountsQuery, categoriesQuery, merchantsQuery, transactionQuery } from '@/lib/money/queries';
import type { Entry } from '@/lib/quick/state';
import type { Identity } from './useQuick';

export default function FixEntry({ identity, entry, onClose }: { identity: Identity; entry: Entry; onClose: () => void }) {
  const h = identity.householdId;
  const accounts = useQuery(accountsQuery(h));
  const categories = useQuery(categoriesQuery(h));
  const merchants = useQuery(merchantsQuery(h));
  const tx = useQuery({ ...transactionQuery(h, entry.id ?? ''), enabled: entry.id !== null });
  if (!accounts.data || !categories.data || !merchants.data || !tx.data?.tx) return null;
  return (
    <TransactionForm
      open
      onClose={onClose}
      householdId={h}
      timezone={identity.timezone}
      accounts={accounts.data}
      categories={categories.data}
      merchants={merchants.data}
      editing={{ tx: tx.data.tx, fee: tx.data.fee }}
      onSaved={onClose}
    />
  );
}
