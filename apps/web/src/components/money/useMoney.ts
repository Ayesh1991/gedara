import { useQuery } from '@tanstack/react-query';
import { accountsQuery, categoriesQuery, merchantsQuery } from '@/lib/money/queries';

/** Accounts (with computed balances), categories and merchants: what every money screen needs. */
export function useMoneyBasics(householdId: string) {
  const accounts = useQuery(accountsQuery(householdId));
  const categories = useQuery(categoriesQuery(householdId));
  const merchants = useQuery(merchantsQuery(householdId));
  return {
    accounts,
    categories,
    merchants,
    ready: accounts.isSuccess && categories.isSuccess,
    error: accounts.isError || categories.isError,
  };
}
