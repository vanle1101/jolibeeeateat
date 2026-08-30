import { Workers } from '../../Workers';
export interface ClaimBonusPointsResult {
    attempts: number;
    acknowledged: number;
    pointsGained: number;
    exhausted: boolean;
}
export declare class ClaimBonusPoints extends Workers {
    claimBonusPoints(maxAttempts?: number): Promise<ClaimBonusPointsResult>;
}
//# sourceMappingURL=ClaimBonusPoints.d.ts.map