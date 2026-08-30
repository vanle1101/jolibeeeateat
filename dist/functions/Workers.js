"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Workers = void 0;
exports.normaliseActivityType = normaliseActivityType;
const urls_1 = require("../constants/urls");
const SUPPORTED_ACTIVITY_TYPES = new Set(['urlreward', 'search', 'welcometour']);
function normaliseActivityType(raw) {
    const values = String(raw ?? '')
        .toLowerCase()
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    return values.find(value => SUPPORTED_ACTIVITY_TYPES.has(value)) ?? values[0] ?? '';
}
function getActivityType(promotion) {
    const primary = normaliseActivityType(promotion.promotionType);
    if (SUPPORTED_ACTIVITY_TYPES.has(primary))
        return primary;
    const attributes = promotion.attributes;
    if (attributes && typeof attributes === 'object') {
        const fromAttributes = normaliseActivityType(attributes.type);
        if (fromAttributes)
            return fromAttributes;
    }
    return primary;
}
function dateKey(value) {
    const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash)
        return `${slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
    const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso)
        return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    return null;
}
class Workers {
    bot;
    constructor(bot) {
        this.bot = bot;
    }
    async doDailySet(data) {
        const todayKey = this.bot.utils.getFormattedDate();
        const dailySets = data.dashboard.dailySetPromotions ?? {};
        const todayIso = dateKey(todayKey);
        const todayData = dailySets[todayKey] ??
            (todayIso ? Object.entries(dailySets).find(([key]) => dateKey(key) === todayIso)?.[1] : undefined);
        const activitiesUncompleted = todayData?.filter(x => {
            if (x?.complete)
                return false;
            // The Rewards API has returned daily items with a zero/missing
            // pointProgressMax even though they still have a live action/hash.
            // Keep those tasks in the pipeline; UrlReward will make the final
            // creditability decision after resolving the live offer.
            return Number(x.pointProgressMax ?? 0) > 0 || !!x.hash || !!getActivityType(x);
        }) ?? [];
        if (!todayData) {
            this.bot.logger.warn(this.bot.isMobile, 'DAILY-SET', `No Daily Set data found for ${todayKey} | availableDates=${Object.keys(dailySets).join(',') || 'none'}`);
        }
        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have already been completed');
            return;
        }
        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Started solving "Daily Set" items');
        await this.solveActivities(activitiesUncompleted);
        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have been completed');
    }
    async doMorePromotions(data) {
        const morePromotions = [
            ...new Map([
                ...(data.dashboard.morePromotions ?? []),
                ...(data.dashboard.morePromotionsWithoutPromotionalItems ?? [])
            ]
                .filter(Boolean)
                .map(p => [p.offerId, p])).values()
        ];
        const activitiesUncompleted = morePromotions?.filter(x => {
            if (x.complete)
                return false;
            if (x.exclusiveLockedFeatureStatus === 'locked')
                return false;
            if (!getActivityType(x))
                return false;
            if (x.priority < 0 && x.exclusiveLockedFeatureStatus !== 'unlocked')
                return false;
            if (String(x.attributes?.promotional ?? '').toLowerCase() === 'true')
                return false;
            // Do not discard an offer merely because the API omitted its
            // progress fields. The live hash/type is enough to attempt it.
            if (Number(x.pointProgressMax ?? 0) <= 0 && !x.hash)
                return false;
            return true;
        }) ?? [];
        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have already been completed');
            return;
        }
        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', `Started solving ${activitiesUncompleted.length} "More Promotions" items`);
        await this.solveActivities(activitiesUncompleted);
        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have been completed');
    }
    async doAppPromotions(data) {
        if (!data?.response?.promotions?.length) {
            this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', 'App dashboard data unavailable or empty; skipping app promotions');
            return;
        }
        const appRewards = data.response.promotions.filter(x => {
            if (x.attributes['complete']?.toLowerCase() !== 'false')
                return false;
            if (!x.attributes['offerid'])
                return false;
            if (!x.attributes['type'])
                return false;
            if (x.attributes['type'] !== 'sapphire')
                return false;
            return true;
        });
        if (!appRewards.length) {
            this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', 'All "App Promotions" items have already been completed');
            return;
        }
        let failures = 0;
        for (const reward of appRewards) {
            // Isolate each promotion: one failing offer must not abort the rest.
            try {
                await this.bot.activities.doAppReward(reward);
            }
            catch (error) {
                failures++;
                this.bot.logger.warn(this.bot.isMobile, 'APP-PROMOTIONS', `Skipped one promotion (${reward.attributes['offerid'] ?? 'unknown'}): ${error instanceof Error ? error.message : String(error)}`);
            }
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000));
        }
        this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', failures
            ? `App Promotions finished with ${failures}/${appRewards.length} skipped`
            : 'All "App Promotions" items have been completed');
    }
    async doPunchCards(data, page) {
        // Page fetching is centralized in BrowserFunc so the active proxy and
        // account context are always used; keep the parameter for callers
        // compiled against the existing worker signature.
        void page;
        let parents;
        try {
            const html = await this.bot.browser.func.getRewardsPageHtml(urls_1.URLs.rewards.earn, '/earn');
            if (!html) {
                this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', '/earn unavailable - cannot list quests');
                return;
            }
            parents = this.bot.browser.react.snapshotQuestList(html);
            // Some deploys render the carousel only on /dashboard
            if (!parents.length) {
                const dashboard = await this.bot.browser.func.getRewardsPageHtml(urls_1.URLs.rewards.dashboard, '/dashboard');
                if (dashboard)
                    parents = this.bot.browser.react.snapshotQuestList(html, dashboard);
            }
        }
        catch (error) {
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Failed fetching /earn for quest list | ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const apiById = new Map((data.dashboard.punchCards ?? [])
            .filter(c => c.parentPromotion?.offerId)
            .map(c => [c.parentPromotion.offerId, c]));
        const seen = new Set(parents.map(p => p.offerId));
        for (const card of apiById.values()) {
            const pp = card.parentPromotion;
            if (!pp?.offerId || seen.has(pp.offerId))
                continue;
            parents.push({
                offerId: pp.offerId,
                title: pp.title ?? '',
                pointProgressMax: pp.pointProgressMax ?? 0,
                complete: !!pp.complete
            });
            seen.add(pp.offerId);
        }
        for (const p of parents) {
            const apiParent = apiById.get(p.offerId)?.parentPromotion;
            if (!apiParent)
                continue;
            // /userinfo is the fresh account state; the streamed /earn page
            // can be stale after a previous mobile/desktop pass. Prefer the
            // API completion flag so an incomplete punchcard is not discarded
            // merely because the page snapshot still says complete.
            p.complete = Boolean(apiParent.complete);
            if (!p.title && apiParent.title)
                p.title = apiParent.title;
            if (Number(apiParent.pointProgressMax ?? 0) > 0) {
                p.pointProgressMax = apiParent.pointProgressMax;
            }
        }
        const incomplete = parents.filter(p => {
            if (p.complete)
                return false;
            if (this.bot.config.skipNonPointTasks && p.pointProgressMax <= 0)
                return false;
            return true;
        });
        if (!incomplete.length) {
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'No actionable quests');
            return;
        }
        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Found ${incomplete.length} incomplete quest(s) on /earn | api-matched=${incomplete.filter(p => apiById.has(p.offerId)).length}`);
        for (const parent of incomplete) {
            try {
                await this.solvePunchCard(parent, apiById.get(parent.offerId), page);
            }
            catch (error) {
                this.bot.logger.error(this.bot.isMobile, 'PUNCHCARD', `Error solving quest "${parent.title || parent.offerId}" | message=${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'Finished processing quests');
    }
    async doClaimBonusPoints() {
        // Let's just always try to do this
        await this.bot.activities.doClaimBonusPoints();
    }
    async solvePunchCard(parent, apiCard, page) {
        void page;
        const parentId = parent.offerId;
        const title = parent.title || apiCard?.parentPromotion?.title || parentId;
        let questChildren;
        try {
            const questUrl = urls_1.URLs.rewards.quest(parentId);
            const html = await this.bot.browser.func.getRewardsPageHtml(questUrl, `/earn/quest/${parentId}`);
            if (!html) {
                this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Quest page unavailable for "${title}" - skipping`);
                return;
            }
            questChildren = this.bot.browser.react.snapshotQuestPage(html);
        }
        catch (error) {
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Failed fetching quest page for "${title}" | ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const apiChildById = new Map((apiCard?.childPromotions ?? []).filter(c => c.offerId).map(c => [c.offerId, c]));
        // Quest pages are streamed RSC responses and may omit children even
        // though /userinfo already returned them. Merge the API list into the
        // page snapshot so a partial HTML response cannot silently lose tasks.
        const mergedChildren = new Map();
        for (const child of questChildren) {
            const api = apiChildById.get(child.offerId);
            const hash = api?.hash ?? child.hash ?? null;
            const isCompleted = api ? Boolean(api.complete) : child.isCompleted;
            const isLocked = api ? api.exclusiveLockedFeatureStatus === 'locked' : child.isLocked;
            const isDisabled = child.isDisabled;
            mergedChildren.set(child.offerId, {
                ...child,
                hash,
                points: child.points || api?.pointProgressMax || 0,
                isCompleted,
                isLocked,
                reportable: !!hash && !isCompleted && !isLocked && !isDisabled
            });
        }
        for (const api of apiChildById.values()) {
            if (mergedChildren.has(api.offerId))
                continue;
            const hash = api.hash ?? null;
            const isCompleted = !!api.complete;
            const isLocked = api.exclusiveLockedFeatureStatus === 'locked';
            mergedChildren.set(api.offerId, {
                offerId: api.offerId,
                hash,
                points: api.pointProgressMax ?? 0,
                isCompleted,
                isLocked,
                isDisabled: false,
                reportable: !!hash && !isCompleted && !isLocked
            });
        }
        questChildren = [...mergedChildren.values()];
        if (!questChildren.length) {
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `No actionable children rendered for "${title}"`);
            return;
        }
        const ordered = [...questChildren].sort((a, b) => (apiChildById.get(a.offerId)?.priority ?? Number.MAX_SAFE_INTEGER) -
            (apiChildById.get(b.offerId)?.priority ?? Number.MAX_SAFE_INTEGER));
        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Solving "${title}" | children=${ordered.length} | reportable=${ordered.filter(c => c.reportable).length}`);
        const startBalance = this.bot.userData.currentPoints;
        let reported = 0;
        let remaining = 0;
        for (const child of ordered) {
            const offerId = child.offerId;
            const api = apiChildById.get(offerId);
            // A completed punchcard reward is represented by Microsoft as
            // complete=true/reportable=false. It is still actionable when
            // its destination is /redeem/ and a live hash is available, so
            // classify claims before applying the normal activity filter.
            const isClaim = this.isClaimChild(offerId, api);
            if (child.isLocked || child.isDisabled) {
                remaining++;
                this.bot.logger.debug(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: locked or disabled (locked=${child.isLocked} disabled=${child.isDisabled})`);
                continue;
            }
            if (isClaim) {
                if (!child.hash) {
                    remaining++;
                    this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: ready-to-claim reward has no live hash`);
                    continue;
                }
                if (!this.bot.config.autoClaimPunchcardRewards) {
                    remaining++;
                    this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Reward for "${title}" ready to claim - left for manual redemption (autoClaimPunchcardRewards=false) | ${offerId}`);
                    continue;
                }
                await this.bot.activities.doClaimReward(child, parentId);
                reported++;
                continue;
            }
            if (!child.reportable) {
                remaining++;
                this.bot.logger.debug(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: not reportable (done=${child.isCompleted} hash=${!!child.hash})`);
                continue;
            }
            if (this.isSearchQuotaChild(offerId, api)) {
                remaining++;
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: multi-day search task`);
                continue;
            }
            await this.reportQuestChild(child, parentId);
            reported++;
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000));
        }
        const gained = this.bot.userData.currentPoints - startBalance;
        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Quest "${title}" ${remaining === 0 ? 'COMPLETE' : 'in progress'} | reported=${reported}${remaining ? ` | remaining=${remaining}` : ''} | pointsGained=${gained} | currentBalance=${this.bot.userData.currentPoints}${parent.pointProgressMax > 0 ? ` | targetPoints=${parent.pointProgressMax}` : ''}`, gained > 0 ? 'green' : undefined);
    }
    async reportQuestChild(child, parentId) {
        const offerId = child.offerId;
        const actionId = this.bot.nextActions.reportActivity;
        if (!actionId) {
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: "reportActivity" not discovered`);
            return;
        }
        if (!child.hash) {
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: no live hash on quest child`);
            return;
        }
        const oldBalance = this.bot.userData.currentPoints;
        try {
            const questUrl = urls_1.URLs.rewards.quest(parentId);
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(actionId, [
                child.hash,
                11,
                { offerid: offerId, isPromotional: '$undefined', timezoneOffset: this.bot.userData.timezoneOffset }
            ], {
                url: questUrl,
                referer: questUrl,
                routerStateTree: this.bot.browser.react.questRouterStateTree(parentId)
            });
            const newBalance = await this.bot.browser.func.getCurrentPoints();
            const gained = newBalance - oldBalance;
            if (gained > 0) {
                this.bot.userData.currentPoints = newBalance;
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained;
            }
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Reported child | offerId=${offerId} | status=${status} | acknowledged=${acknowledged} | pointsGained=${gained} | currentBalance=${newBalance}`, gained > 0 || acknowledged ? 'green' : undefined);
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'PUNCHCARD', `Error reporting child | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async solveActivities(activities) {
        for (const activity of activities) {
            try {
                const type = getActivityType(activity);
                const name = activity.name?.toLowerCase() ?? '';
                const offerId = activity.offerId;
                this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Processing activity | title="${activity.title}" | offerId=${offerId} | type=${type}`);
                switch (type) {
                    case 'urlreward': {
                        const basePromotion = activity;
                        // Search on Bing are subtypes of "urlreward"
                        const isSearchOnBing = name.includes('exploreonbing');
                        if (isSearchOnBing && !this.bot.config.activities.searchOnBing) {
                            this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `Skipping "SearchOnBing" (disabled in config) | offerId=${offerId}`);
                            continue;
                        }
                        if (!isSearchOnBing && !this.bot.config.activities.urlReward) {
                            this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `Skipping "UrlReward" (disabled in config) | offerId=${offerId}`);
                            continue;
                        }
                        if (isSearchOnBing) {
                            this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `Found activity type "SearchOnBing" | title="${activity.title}" | offerId=${offerId}`);
                            const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage;
                            await this.bot.activities.doSearchOnBing(basePromotion, page);
                        }
                        else {
                            this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `Found activity type "UrlReward" | title="${activity.title}" | offerId=${offerId}`);
                            await this.bot.activities.doUrlReward(basePromotion);
                        }
                        break;
                    }
                    case 'welcometour': {
                        // Welcome tours are informational UI walkthroughs, not
                        // reportable Rewards activities. Treat them as a normal
                        // no-op and move on without the post-activity delay.
                        this.bot.logger.info(this.bot.isMobile, 'ACTIVITY', `Ignoring non-actionable welcome tour "${activity.title}" | offerId=${offerId}`);
                        continue;
                    }
                    default: {
                        this.bot.logger.warn(this.bot.isMobile, 'ACTIVITY', `Skipped activity "${activity.title}" | offerId=${offerId} | Reason: Unsupported type "${activity.promotionType}"`);
                        // No action was performed, so there is no reason to
                        // apply the human-like delay used after real activities.
                        continue;
                    }
                }
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000));
            }
            catch (error) {
                this.bot.logger.error(this.bot.isMobile, 'ACTIVITY', `Error while solving activity "${activity.title}" | message=${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    // Util
    isSearchQuotaChild(offerId, api) {
        if (api) {
            const type = (api.promotionType ?? '').toLowerCase();
            const attrType = String(api.attributes?.type ?? '').toLowerCase();
            const progressMax = Number(api.activityProgressMax ?? 0);
            if (type === 'search' || attrType === 'search' || progressMax > 1) {
                return true;
            }
        }
        return /search/i.test(offerId) && /(day|streak|\dx)/i.test(offerId);
    }
    isClaimChild(offerId, api) {
        const dest = (api?.destinationUrl ?? '').toLowerCase();
        if (/\/redeem\//.test(dest))
            return true;
        return /(redeem|claim|(?<!url)reward)/i.test(offerId);
    }
}
exports.Workers = Workers;
//# sourceMappingURL=Workers.js.map