"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaimBonusPoints = void 0;
const Workers_1 = require("../../Workers");
const urls_1 = require("../../../constants/urls");
function resolveClaimAction(actions) {
    if (actions.reportClaimAllPoints)
        return actions.reportClaimAllPoints;
    // The action name is not stable across Rewards deployments. The action
    // extractor may expose reportClaimAllPointsAction, claimAllPoints, or a
    // similarly named variant instead of the historical exact key.
    return Object.entries(actions).find(([name]) => {
        const normalised = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
        return normalised.includes('claim') && normalised.includes('point');
    })?.[1];
}
class ClaimBonusPoints extends Workers_1.Workers {
    async claimBonusPoints(maxAttempts = 5) {
        const result = {
            attempts: 0,
            acknowledged: 0,
            pointsGained: 0,
            exhausted: false
        };
        const actionId = resolveClaimAction(this.bot.nextActions);
        if (!actionId) {
            this.bot.logger.warn(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'Skipping: no Ready-to-claim action id discovered in Rewards chunks');
            return result;
        }
        const attemptLimit = Math.max(1, Math.floor(maxAttempts));
        const dashboardUrl = urls_1.URLs.rewards.dashboard;
        const routeContext = {
            url: dashboardUrl,
            referer: dashboardUrl,
            routerStateTree: this.bot.browser.react.routerStateTree('dashboard')
        };
        this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', `Starting ClaimBonusPoints | geo=${this.bot.userData.geoLocale} | currentBalance=${this.bot.userData.currentPoints}`);
        for (let attempt = 1; attempt <= attemptLimit; attempt++) {
            const oldBalance = this.bot.userData.currentPoints;
            try {
                const readyBefore = await this.bot.browser.func.getReadyToClaimPoints();
                if (readyBefore === 0) {
                    result.exhausted = true;
                    break;
                }
                // The "Ready to claim" drawer is rendered by /dashboard. Keep
                // every claim request in the same route context as its UI button.
                const { status, acknowledged } = await this.bot.browser.func.reportServerAction(actionId, [], routeContext);
                result.attempts++;
                if (acknowledged)
                    result.acknowledged++;
                let newBalance = await this.bot.browser.func.getCurrentPoints();
                let readyAfter = await this.bot.browser.func.getReadyToClaimPoints();
                // The balance and the claim drawer are eventually consistent.
                // Poll both signals before deciding that an acknowledged claim
                // made no progress, otherwise a valid 6-point claim can be
                // reported as empty when the first read is still stale.
                for (let check = 1; acknowledged && check < 3; check++) {
                    const balanceChanged = newBalance > oldBalance;
                    const drawerDrained = readyBefore != null && readyAfter != null && readyAfter < readyBefore;
                    if (balanceChanged || drawerDrained || readyAfter === 0)
                        break;
                    await this.bot.utils.wait(1000);
                    newBalance = await this.bot.browser.func.getCurrentPoints();
                    readyAfter = await this.bot.browser.func.getReadyToClaimPoints();
                }
                const gainedPoints = Math.max(0, newBalance - oldBalance);
                const drawerDrained = readyBefore != null && readyAfter != null && readyAfter < readyBefore;
                this.bot.logger.debug(this.bot.isMobile, 'CLAIM-BONUS-POINTS', `Claim pass ${attempt} | status=${status} | acknowledged=${acknowledged} | previousBalance=${oldBalance} | currentBalance=${newBalance} | pointsGained=${gainedPoints} | readyBefore=${readyBefore ?? 'unknown'} | readyAfter=${readyAfter ?? 'unknown'}`);
                this.bot.userData.currentPoints = newBalance;
                if (!acknowledged || (gainedPoints <= 0 && !drawerDrained)) {
                    result.exhausted = true;
                    break;
                }
                if (gainedPoints > 0) {
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints;
                    result.pointsGained += gainedPoints;
                }
                this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', `Claimed Ready to claim pass ${attempt} | pointsGained=${gainedPoints} | totalClaimed=${result.pointsGained} | currentBalance=${newBalance} | readyBefore=${readyBefore ?? 'unknown'} | readyAfter=${readyAfter ?? 'unknown'}`, 'green');
                if (readyAfter === 0) {
                    result.exhausted = true;
                    break;
                }
                await this.bot.utils.wait(this.bot.utils.randomDelay(2000, 5000));
            }
            catch (error) {
                this.bot.logger.error(this.bot.isMobile, 'CLAIM-BONUS-POINTS', `Error draining Ready to claim on pass ${attempt} | message=${error instanceof Error ? error.message : String(error)}`);
                break;
            }
        }
        if (!result.exhausted && result.attempts >= attemptLimit) {
            this.bot.logger.warn(this.bot.isMobile, 'CLAIM-BONUS-POINTS', `Ready to claim safety limit reached | attempts=${result.attempts} | pointsGained=${result.pointsGained}`);
        }
        this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', result.pointsGained > 0
            ? `Completed ClaimBonusPoints | acknowledged=${result.acknowledged > 0} | attempts=${result.attempts} | pointsGained=${result.pointsGained} | currentBalance=${this.bot.userData.currentPoints}`
            : `Nothing claimed | attempts=${result.attempts} | pointsGained=0 | currentBalance=${this.bot.userData.currentPoints}`, result.pointsGained > 0 ? 'green' : undefined);
        return result;
    }
}
exports.ClaimBonusPoints = ClaimBonusPoints;
//# sourceMappingURL=ClaimBonusPoints.js.map