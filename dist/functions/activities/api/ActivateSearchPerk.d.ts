import type { Dashboard, DashboardData } from '../../../interface/DashboardData';
import { Workers } from '../../Workers';
export interface SearchMultiplierPerk {
    offerId: string;
    multiplier: number;
}
export declare function detectSearchMultiplierPerk(dashboard?: Dashboard): SearchMultiplierPerk | null;
export declare class ActivateSearchPerk extends Workers {
    activate(data: DashboardData): Promise<void>;
}
//# sourceMappingURL=ActivateSearchPerk.d.ts.map