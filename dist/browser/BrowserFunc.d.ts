import type { BrowserContext, Cookie, Page } from 'patchright';
import type { MicrosoftRewardsBot } from '../index';
import type { Counters, DashboardData } from './../interface/DashboardData';
import type { AppEarnablePoints, BrowserEarnablePoints, MissingSearchPoints } from '../interface/Points';
import type { AppDashboardData } from '../interface/AppDashBoardData';
import type { PageSnapshot, ParsedOffer } from './ReactFunc';
export declare function calculatePointGain(currentBalance: number | null, baselineBalance: number | null, serverPreviousBalance: number | null): number | null;
export declare class RewardsAuthenticationRequiredError extends Error {
    readonly destination: string;
    constructor(finalUrl: string);
}
export default class BrowserFunc {
    private bot;
    private bingJars;
    constructor(bot: MicrosoftRewardsBot);
    getDashboardData(cookies?: Cookie[], page?: Page): Promise<DashboardData>;
    private getDashboardDataFromBrowser;
    getAppDashboardData(): Promise<AppDashboardData>;
    getSearchPoints(page?: Page): Promise<Counters>;
    missingSearchPoints(counters: Counters, isMobile: boolean): MissingSearchPoints;
    getBrowserEarnablePoints(): Promise<BrowserEarnablePoints>;
    getAppEarnablePoints(): Promise<AppEarnablePoints>;
    getCurrentPoints(): Promise<number>;
    getReadyToClaimPoints(): Promise<number | null>;
    private getActiveRewardsPage;
    /**
     * Fetch a Rewards page through the active browser context. The RSC payload
     * is the source of truth for live hashes; using the page request keeps the
     * current account cookies and proxy/session context attached.
     */
    getRewardsPageHtml(url: string, route: string): Promise<string | null>;
    /** Refresh the streamed /earn and /dashboard offer snapshot together. */
    refreshEarnSnapshot(): Promise<PageSnapshot | null>;
    /** Resolve an offer missing from the initial streamed page response. */
    ensureOffer(offerId: string): Promise<ParsedOffer | null>;
    bootstrap(page: Page): Promise<void>;
    private loadRewardsDashboardPage;
    private resolveActionIds;
    private fetchJsChunks;
    private extractDynamicChunkPaths;
    closeBrowser(browser: BrowserContext, email: string, persistSession?: boolean): Promise<void>;
    buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string;
    reportServerAction(actionId: string, body: unknown[], opts?: {
        url?: string;
        referer?: string;
        routerStateTree?: string;
    }): Promise<{
        status: number;
        acknowledged: boolean;
    }>;
    reportSearchActivity(query: string, opts?: {
        cvid?: string;
        cg?: string;
    }): Promise<{
        ig: string | null;
        balance: number | null;
        previousBalance: number | null;
        gained: number | null;
        searchPointsEarned: number | null;
        searchPointsLimit: number | null;
    }>;
    reportVisualSearchActivity(visual: {
        bcid: string;
        query: string;
        serpUrl: string;
    }): Promise<{
        ig: string | null;
        balance: number | null;
        previousBalance: number | null;
        gained: number | null;
        searchPointsEarned: number | null;
        searchPointsLimit: number | null;
    }>;
    acquireVisualSearch(imageUrl?: string): Promise<{
        bcid: string;
        query: string;
        serpUrl: string;
    } | null>;
    resetHttpJars(): void;
    private getBingJar;
    private mergeSetCookies;
    private jarToHeader;
    private parseReportResponse;
    private buildMultipart;
    private parseKblobRedirect;
}
//# sourceMappingURL=BrowserFunc.d.ts.map