"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchOnBing = void 0;
const fs = __importStar(require("fs"));
const path_1 = __importDefault(require("path"));
const Workers_1 = require("../../Workers");
const urls_1 = require("../../../constants/urls");
class SearchOnBing extends Workers_1.Workers {
    gainedPoints = 0;
    success = false;
    oldBalance = 0;
    async doSearchOnBing(promotion) {
        const offerId = promotion.offerId;
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0);
        this.gainedPoints = 0;
        this.success = false;
        this.bot.logger.info(this.bot.isMobile, 'SEARCH-ON-BING', `Starting SearchOnBing | offerId=${offerId} | title="${promotion.title}" | currentBalance=${this.oldBalance}`);
        try {
            if (!(await this.activateSearchTask(promotion))) {
                this.bot.logger.warn(this.bot.isMobile, 'SEARCH-ON-BING', `Search activity couldn't be activated, aborting | offerId=${offerId}`);
                return;
            }
            const queries = await this.getSearchQueries(promotion);
            await this.searchBing(queries, promotion);
            if (this.success) {
                this.bot.logger.info(this.bot.isMobile, 'SEARCH-ON-BING', `Completed SearchOnBing | offerId=${offerId} | pointsGained=${this.gainedPoints} | currentBalance=${this.bot.userData.currentPoints} | previousBalance=${this.oldBalance}`, 'green');
            }
            else {
                this.bot.logger.warn(this.bot.isMobile, 'SEARCH-ON-BING', `Failed SearchOnBing | offerId=${offerId} | pointsGained=${this.gainedPoints} | currentBalance=${this.bot.userData.currentPoints} | previousBalance=${this.oldBalance}`);
            }
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'SEARCH-ON-BING', `Error in doSearchOnBing | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async activateSearchTask(promotion) {
        const offerId = promotion.offerId;
        const actionId = this.bot.nextActions.reportActivity;
        if (!actionId) {
            this.bot.logger.warn(this.bot.isMobile, 'SEARCH-ON-BING-ACTIVATE', `Skipping ${offerId}: "reportActivity" not discovered in bundle`);
            return false;
        }
        const live = this.bot.reactSnapshot?.offers.find(o => o.offerId === offerId);
        const hash = live?.hash ?? promotion.hash ?? null;
        if (!hash) {
            this.bot.logger.warn(this.bot.isMobile, 'SEARCH-ON-BING-ACTIVATE', `Skipping ${offerId}: no live hash for the activation offer`);
            return false;
        }
        try {
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(actionId, [
                hash,
                11,
                { offerid: offerId, isPromotional: '$undefined', timezoneOffset: this.bot.userData.timezoneOffset }
            ]);
            this.bot.logger.info(this.bot.isMobile, 'SEARCH-ON-BING-ACTIVATE', `Activated activity | offerId=${offerId} | status=${status} | acknowledged=${acknowledged}`);
            return acknowledged;
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'SEARCH-ON-BING-ACTIVATE', `Activation failed | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    async searchBing(queries, promotion) {
        queries = [...new Set(queries)];
        const offerId = promotion.offerId;
        const cgDashboard = (await this.bot.browser.func.getDashboardData()).dashboard;
        const cg = this.buildCategoryGroup(cgDashboard, offerId);
        this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Category group | cg=${cg || '(none)'}`);
        this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Starting search loop | queriesCount=${queries.length} | targetPoints=${promotion.pointProgressMax} | currentBalance=${this.oldBalance}`);
        let lastBalance = this.oldBalance;
        let i = 0;
        for (const query of queries) {
            try {
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Processing query | query="${query}"`);
                const { ig } = await this.bot.browser.func.reportSearchActivity(query, cg ? { cg } : undefined);
                if (!ig) {
                    this.bot.logger.warn(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `No IG returned for query="${query}" - skipping this query`);
                    continue;
                }
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 7000));
                const dashboard = (await this.bot.browser.func.getDashboardData())?.dashboard;
                const newBalance = dashboard?.userStatus?.availablePoints ?? lastBalance;
                const offer = dashboard ? this.findOffer(dashboard, offerId) : null;
                const delta = newBalance - lastBalance;
                if (delta > 0) {
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + delta;
                    lastBalance = newBalance;
                }
                this.bot.userData.currentPoints = newBalance;
                this.gainedPoints = newBalance - this.oldBalance;
                const offerProgress = offer ? `${offer.pointProgress}/${offer.pointProgressMax}` : 'unknown';
                const offerComplete = !!offer &&
                    (offer.complete || (offer.pointProgressMax > 0 && offer.pointProgress >= offer.pointProgressMax));
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Progress check | query="${query}" | offerProgress=${offerProgress} | offerComplete=${offerComplete} | currentBalance=${newBalance}`);
                if (offerComplete) {
                    this.success = true;
                    this.bot.logger.info(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `SearchOnBing activity completed | pointsGained=${this.gainedPoints} | currentBalance=${newBalance} | query="${query}" | offerProgress=${offerProgress}`, 'green');
                    return;
                }
                this.bot.logger.warn(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `${++i}/${queries.length} | activity not complete | offerProgress=${offerProgress} | query="${query}"`);
            }
            catch (error) {
                this.bot.logger.error(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Error during search loop | query="${query}" | message=${error instanceof Error ? error.message : String(error)}`);
            }
            finally {
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000));
            }
        }
        this.bot.logger.warn(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Finished all queries without completing the activity | queriesTried=${queries.length} | offerId=${offerId} | pointsGained=${this.gainedPoints} | currentBalance=${this.bot.userData.currentPoints} | previousBalance=${this.oldBalance}`);
    }
    findOffer(dashboard, offerId) {
        if (!dashboard || !offerId)
            return undefined;
        const pools = [
            ...Object.values(dashboard?.dailySetPromotions ?? {}).flat(),
            ...(dashboard?.morePromotions ?? []),
            ...(dashboard?.promotionalItems ?? []),
            ...(dashboard?.promotionalItem ? [dashboard.promotionalItem] : [])
        ];
        return pools.find(o => o?.offerId === offerId);
    }
    buildCategoryGroup(dashboard, targetOfferId) {
        const pools = dashboard
            ? [
                ...Object.values(dashboard.dailySetPromotions ?? {}).flat(),
                ...(dashboard.morePromotions ?? []),
                ...(dashboard.promotionalItems ?? []),
                ...(dashboard.promotionalItem ? [dashboard.promotionalItem] : [])
            ]
            : [];
        const categoryOf = (id) => {
            const m = id.match(/(?:^|_)([a-z0-9]+)_exploreonbing/i);
            return m?.[1]?.toLowerCase() ?? null;
        };
        const categories = new Set();
        const target = categoryOf(targetOfferId);
        if (target)
            categories.add(target);
        for (const offer of pools) {
            const cat = categoryOf(offer.offerId ?? '');
            if (cat)
                categories.add(cat);
        }
        return [...categories].join(',');
    }
    async getSearchQueries(promotion) {
        try {
            let activities;
            if (this.bot.config.searchOnBingLocalQueries) {
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'Using local queries config file');
                activities = JSON.parse(fs.readFileSync(path_1.default.join(__dirname, '../../bing-search-activity-queries.json'), 'utf8'));
            }
            else {
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'Fetching queries config from remote repository');
                activities = (await this.bot.http.request({
                    method: 'GET',
                    url: urls_1.URLs.github.searchOnBingQueries
                })).data;
            }
            const match = activities.find(x => this.bot.utils.normalizeString(x.title) === this.bot.utils.normalizeString(promotion.title));
            if (match && match.queries.length > 0) {
                const shuffled = this.bot.utils.shuffleArray(match.queries);
                this.bot.logger.info(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Found ${shuffled.length} queries for "${promotion.title}" | source=${this.bot.config.searchOnBingLocalQueries ? 'local' : 'remote'}`);
                return shuffled;
            }
            this.bot.logger.info(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `No curated queries for "${promotion.title}", falling back to the activity title and description`);
            return this.fallbackQueries(promotion);
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Error resolving search queries | title="${promotion.title}" | message=${error instanceof Error ? error.message : String(error)} | fallback=titleAndDescription`);
            return this.fallbackQueries(promotion);
        }
    }
    fallbackQueries(promotion) {
        const title = (promotion.title ?? '').trim();
        const description = (promotion.description ?? '').trim();
        const derived = this.extractSearchTerm(description);
        return [...new Set([derived, title, description].map(s => s.trim()).filter(Boolean))];
    }
    // Sadly, still language dependant, will not work on non-english
    extractSearchTerm(description) {
        if (!description)
            return '';
        return description
            .trim()
            .replace(/^\s*(?:search(?:\s+on\s+bing|\s+bing|\s+the\s+web)?\s+for|look\s+up|find|explore|discover)\b[\s:]+/i, '')
            .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
            .replace(/[.!?]+$/g, '')
            .trim();
    }
}
exports.SearchOnBing = SearchOnBing;
//# sourceMappingURL=SearchOnBing.js.map