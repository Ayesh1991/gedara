import type { Area, InsightsSearch, Period } from '@/lib/insights/drill';
import type { Membership } from '@/lib/queries';
import { CashflowArea } from './Cashflow';
import { PantryArea } from './Pantry';
import { PlacesArea } from './Places';
import { PricesArea } from './Prices';
import { SpendArea } from './Spend';
import { ThingsArea } from './Things';
import { UtilitiesArea } from './Utilities';

export interface AreaProps {
  search: InsightsSearch;
  period: Period;
  membership: Membership;
  today: string;
}

export function AreaView({ area, ...props }: AreaProps & { area: Area }) {
  switch (area) {
    case 'cashflow':
      return <CashflowArea {...props} />;
    case 'spend':
      return <SpendArea {...props} />;
    case 'prices':
      return <PricesArea {...props} />;
    case 'pantry':
      return <PantryArea {...props} />;
    case 'things':
      return <ThingsArea {...props} />;
    case 'utilities':
      return <UtilitiesArea {...props} />;
    case 'places':
      return <PlacesArea {...props} />;
  }
}
