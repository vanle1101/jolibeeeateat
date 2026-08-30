"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class ReactFunc {
    bot;
    constructor(bot) {
        this.bot = bot;
    }
    // Parse all avalable data from provided page
    snapshotPage(html) {
        const combined = this.concatFlightChunks(html);
        const offers = this.parseOffers(combined);
        const streaks = this.parseStreaks(combined);
        const streakProtection = this.parseStreakProtection(combined);
        const account = this.parseAccountData(combined);
        const accountEmail = this.bot.currentAccountEmail;
        this.bot.logger.info(this.bot.isMobile, 'REACT-PARSE', `Snapshot complete | offers=${offers.length} | reportable=${offers.filter(o => o.reportable).length} | streaks=${streaks.length} | streakProtectionEnabled=${streakProtection?.isProtectionOn ?? 'null'} | streakProtectionRemainingDays=${streakProtection?.remainingDays ?? 'null'} | streakCounter=${streakProtection?.streakCounter ?? 'null'} | level=${account.level} | account=${accountEmail ?? 'null'}`);
        return {
            offers,
            reportable: offers.filter(o => o.reportable),
            streaks,
            streakProtection,
            account
        };
    }
    getReportableOffers(html) {
        return this.parseOffers(this.concatFlightChunks(html)).filter(o => o.reportable);
    }
    getStreakProtection(html) {
        return this.parseStreakProtection(this.concatFlightChunks(html));
    }
    buildId(html) {
        const combined = this.concatFlightChunks(html);
        return (combined.match(/"buildId":"([A-Za-z0-9_-]{21})"/)?.[1] ??
            combined.match(/"b":"([A-Za-z0-9_-]{21})"/)?.[1] ??
            html.match(/\/_next\/static\/([A-Za-z0-9_-]{21})\//)?.[1] ??
            null);
    }
    concatFlightChunks(html) {
        try {
            const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
            let combined = '';
            let count = 0;
            for (const match of html.matchAll(pushRe)) {
                try {
                    // Re-wrap in quotes so JSON.parse decodes
                    combined += JSON.parse(`"${match[1]}"`);
                    count++;
                }
                catch (err) {
                    this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', `Skipped undecodable flight chunk | error=${err instanceof Error ? err.message : String(err)}`);
                }
            }
            this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', `Concatenated flight chunks | chunks=${count} | length=${combined.length}`);
            if (count === 0) {
                this.bot.logger.warn(this.bot.isMobile, 'REACT-PARSE', 'No __next_f flight chunks found - page may not be an RSC render or markup changed');
            }
            return combined;
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'REACT-PARSE', `Failed concatenating flight chunks | error=${error instanceof Error ? error.message : String(error)}`);
            return '';
        }
    }
    // Find every object containing "anchor" and return them as parsed JSON
    extractObjects(combined, anchor) {
        const out = [];
        let i = 0;
        let failures = 0;
        while ((i = combined.indexOf(anchor, i)) !== -1) {
            const start = combined.lastIndexOf('{', i);
            if (start === -1) {
                i += anchor.length;
                continue;
            }
            let depth = 0;
            let end = -1;
            let inStr = false;
            let esc = false;
            for (let j = start; j < combined.length; j++) {
                const c = combined[j];
                if (esc) {
                    esc = false;
                    continue;
                }
                if (c === '\\') {
                    esc = true;
                    continue;
                }
                if (c === '"') {
                    inStr = !inStr;
                    continue;
                }
                if (inStr)
                    continue;
                if (c === '{')
                    depth++;
                else if (c === '}') {
                    depth--;
                    if (depth === 0) {
                        end = j;
                        break;
                    }
                }
            }
            if (end === -1)
                break;
            const raw = combined.slice(start, end + 1);
            i = end;
            try {
                out.push(JSON.parse(raw.replace(/"\$undefined"/g, 'null')));
            }
            catch {
                failures++;
            }
        }
        if (failures > 0) {
            this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', `extractObjects("${anchor}") had ${failures} unparseable matches`);
        }
        return out;
    }
    // Section parsers
    parseOffers(combined) {
        try {
            const seen = new Set();
            const today = this.todayStamp();
            const offers = [];
            for (const obj of this.extractObjects(combined, '"offerId"')) {
                const offerId = obj.offerId;
                if (!offerId || seen.has(offerId))
                    continue;
                seen.add(offerId);
                const hash = obj.hash ?? null;
                const isCompleted = (obj.isCompleted ?? obj.complete) === true;
                const isLocked = obj.isLocked === true;
                const date = this.normaliseDate(obj.date);
                // Never try future-dated offers, lol
                const reportable = !!hash && !isCompleted && !isLocked && (date === null || date <= today);
                offers.push({
                    offerId,
                    hash,
                    title: obj.title ?? '',
                    description: obj.description ?? '',
                    points: obj.points ?? obj.pointProgressMax ?? 0,
                    promotionSubtype: obj.promotionSubtype ?? null,
                    destination: obj.destination ?? obj.destinationUrl ?? '',
                    isCompleted,
                    isPromotional: obj.isPromotional === true,
                    isLocked,
                    unlockCriteria: obj.unlockCriteria ?? null,
                    date,
                    activityType: null, // merge from getuserinfo later???
                    reportable
                });
            }
            this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', `Parsed offers | total=${offers.length} | reportable=${offers.filter(o => o.reportable).length}`);
            return offers;
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'REACT-PARSE', `Failed parsing offers | error=${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }
    parseStreaks(combined) {
        try {
            const streaks = this.extractObjects(combined, '"dailyPoints"')
                .filter(o => typeof o.partner === 'string' && Array.isArray(o.dailyPoints))
                .map(o => ({
                partner: o.partner,
                activitiesCompleted: o.activitiesCompleted ?? 0,
                activitiesTotal: o.activitiesTotal ?? 0,
                completedDays: o.completedDays ?? 0,
                currentDay: o.currentDay ?? 0,
                totalDays: o.totalDays ?? 0,
                isCurrentDayCompleted: o.isCurrentDayCompleted === true,
                isEnabled: o.isEnabled === true,
                dailyPoints: o.dailyPoints
            }));
            // de-dupe on partner
            const byPartner = new Map(streaks.map(s => [s.partner, s]));
            const unique = [...byPartner.values()];
            this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', `Parsed streaks | ${unique.map(s => `${s.partner}:${s.completedDays}/${s.totalDays}`).join(', ') || 'none'}`);
            return unique;
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'REACT-PARSE', `Failed parsing streaks | error=${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }
    parseStreakProtection(combined) {
        try {
            const carriers = this.extractObjects(combined, '"isProtectionOn"').filter(o => 'isProtectionOn' in o);
            if (!carriers.length)
                return null;
            // The flag and remainingDays
            const withDays = carriers.find(o => 'remainingDays' in o && typeof o.remainingDays === 'number');
            const withFlag = carriers.find(o => typeof o.isProtectionOn === 'boolean');
            const withStreakCounter = carriers.find(o => 'streakCounter' in o && typeof o.streakCounter === 'number');
            const state = {
                isProtectionOn: (withDays?.isProtectionOn ?? withFlag?.isProtectionOn) === true,
                remainingDays: withDays ? withDays.remainingDays : null,
                streakCounter: withStreakCounter ? withStreakCounter.streakCounter : null
            };
            this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', `Parsed streak protection | enabled=${state.isProtectionOn} | remainingDays=${state.remainingDays ?? 'null'} | streakCounter=${state.streakCounter}`);
            return state;
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'REACT-PARSE', `Failed parsing streak protection | error=${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }
    parseAccountData(combined) {
        const empty = {
            level: null,
            pointsProgress: null,
            pointsRemaining: null,
            lifetimeEarn: null,
            availablePoints: null
        };
        try {
            const membership = this.extractObjects(combined, '"pointsProgress"').find(o => 'pointsRemaining' in o || 'lifetimeEarn' in o) ?? {};
            // availablePoints renders in a separate header object
            const header = this.extractObjects(combined, '"availablePoints"').find(o => 'availablePoints' in o) ?? {};
            const account = {
                level: membership.level ?? null,
                pointsProgress: membership.pointsProgress ?? null,
                pointsRemaining: membership.pointsRemaining ?? null,
                lifetimeEarn: membership.lifetimeEarn ?? null,
                availablePoints: header.availablePoints ?? membership.availablePoints ?? null
            };
            this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', `Parsed account | level=${account.level} | available=${account.availablePoints} | toGo=${account.pointsRemaining} | lifetime=${account.lifetimeEarn}`);
            if (account.level === null && account.availablePoints === null) {
                // Common error! Keep however for debugging!
                this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', 'Account state empty - membership/header objects not found in payload');
            }
            return account;
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'REACT-PARSE', `Failed parsing account | error=${error instanceof Error ? error.message : String(error)}`);
            return empty;
        }
    }
    routerStateTree(segment) {
        const tree = [
            '',
            {
                children: [
                    '(nav)',
                    {
                        children: [segment, { children: ['__PAGE__', {}, null, null, 0] }, null, null, 0]
                    },
                    null,
                    null,
                    0
                ]
            },
            null,
            null,
            16
        ];
        return encodeURIComponent(JSON.stringify(tree));
    }
    questRouterStateTree(questId) {
        const tree = [
            '',
            {
                children: [
                    '(nav)',
                    {
                        children: [
                            'earn',
                            {
                                children: [
                                    'quest',
                                    {
                                        children: [
                                            ['questId', questId, 'd', null],
                                            { children: ['__PAGE__', {}, null, null, 0] },
                                            null,
                                            null,
                                            0
                                        ]
                                    },
                                    null,
                                    null,
                                    0
                                ]
                            },
                            null,
                            null,
                            0
                        ]
                    },
                    null,
                    null,
                    0
                ]
            },
            null,
            null,
            16
        ];
        return encodeURIComponent(JSON.stringify(tree));
    }
    // Pull server-action ids out of a JS chunk
    extractActionIds(jsText) {
        const byName = {};
        const all = new Set();
        // SHA-1 today (40 hex), allow growth to SHA-256 (64 hex)
        const HEX = '[a-f0-9]{40,64}';
        // Framework args that share the call shape but aren't the action name
        const KNOWN_NON_NAMES = new Set(['callServer', 'findSourceMapURL', 'encodeFormAction']);
        try {
            // I hate this so much honestly
            // Next.js has emitted both single- and double-quoted server
            // references. Keep the quote as a backreference so the parser
            // does not stop at the other quote type inside a minified chunk.
            const callRegex = new RegExp(`createServerReference\\s*\\)?\\s*\\(\\s*(["'])(${HEX})\\1([\\s\\S]{0,1200}?)\\)`, 'gi');
            const strLitRe = /(["'])([A-Za-z_$][\w$]*)\1/g;
            for (const m of jsText.matchAll(callRegex)) {
                const id = m[2];
                const argsBlock = m[3] ?? '';
                all.add(id);
                const candidates = [...argsBlock.matchAll(strLitRe)]
                    .map(x => x[2])
                    .filter(n => !KNOWN_NON_NAMES.has(n));
                if (candidates.length)
                    byName[candidates[candidates.length - 1]] = id;
            }
            // bare reference without a name arg, still record the id
            const bareRegex = new RegExp(`createServerReference\\s*\\)?\\s*\\(\\s*(["'])(${HEX})\\1`, 'gi');
            for (const m of jsText.matchAll(bareRegex))
                all.add(m[2]);
            const actionIdRe = new RegExp(`\\$ACTION_ID_(${HEX})`, 'gi');
            for (const m of jsText.matchAll(actionIdRe))
                all.add(m[1]);
            this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', `Extracted action ids | named=${Object.keys(byName).length} | total=${all.size}`);
            if (all.size === 0) {
                this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', 'No server-action ids found in JS chunk - wrong chunk, or bundler output changed');
            }
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'REACT-PARSE', `Failed extracting action ids | error=${error instanceof Error ? error.message : String(error)}`);
        }
        return { byName, all: [...all] };
    }
    // Quest pages (punchcards)
    snapshotQuestPage(html) {
        try {
            const combined = this.concatFlightChunks(html);
            const children = this.parseQuestOffers(combined);
            this.bot.logger.info(this.bot.isMobile, 'REACT-PARSE', `Quest snapshot | children=${children.length} | reportable=${children.filter(c => c.reportable).length}`);
            return children;
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'REACT-PARSE', `Failed parsing quest page | error=${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }
    parseQuestOffers(combined) {
        const out = [];
        const seen = new Set();
        for (const obj of this.extractObjects(combined, '"offerId"')) {
            const offerId = obj.offerId;
            if (!offerId || !offerId.includes('pcchild') || seen.has(offerId))
                continue;
            seen.add(offerId);
            const hash = obj.hash ?? null;
            const points = obj.points ?? obj.pointProgressMax ?? 0;
            const isCompleted = (obj.isCompleted ?? obj.complete) === true;
            const isLocked = obj.isLocked === true;
            const isDisabled = obj.isDisabled === true;
            const reportable = !!hash && !isCompleted && !isLocked && !isDisabled;
            out.push({
                offerId,
                hash,
                points,
                isCompleted,
                isLocked,
                isDisabled,
                reportable
            });
        }
        this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', `Parsed quest children | total=${out.length} | reportable=${out.filter(c => c.reportable).length}`);
        return out;
    }
    snapshotQuestList(...htmls) {
        try {
            const combined = htmls.map(h => this.concatFlightChunks(h)).join('');
            const anchors = [];
            for (const match of combined.matchAll(/\/earn\/quest\/([A-Za-z0-9_]+)/g)) {
                anchors.push({ id: match[1], at: match.index ?? 0 });
            }
            for (const match of combined.matchAll(/"id":"quest_([A-Za-z0-9_]+)"/g)) {
                anchors.push({ id: match[1], at: match.index ?? 0 });
            }
            for (const match of combined.matchAll(/[A-Za-z0-9_]*pcparent[A-Za-z0-9_]*/gi)) {
                anchors.push({ id: match[0], at: match.index ?? 0 });
            }
            anchors.sort((a, b) => a.at - b.at);
            const byId = new Map();
            for (let k = 0; k < anchors.length; k++) {
                const { id, at } = anchors[k];
                if (!this.isParentQuestId(id))
                    continue;
                const next = anchors[k + 1]?.at ?? combined.length;
                const region = combined.slice(at, Math.min(next, at + 3000));
                const title = region.match(/"alt":"((?:[^"\\]|\\.)*)"/)?.[1] ??
                    region.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1] ??
                    '';
                const pointsMatch = region.match(/\["\+","([\d,]+)"\]/);
                const points = pointsMatch ? Number(pointsMatch[1].replace(/,/g, '')) : 0;
                const taskM = region.match(/(\d+)\s*\/\s*(\d+)\s*tasks/);
                const complete = !!taskM && Number(taskM[1]) >= Number(taskM[2]) && Number(taskM[2]) > 0;
                // First wins for title/points
                const prev = byId.get(id);
                byId.set(id, {
                    offerId: id,
                    title: prev?.title || title,
                    pointProgressMax: prev?.pointProgressMax || points,
                    complete: prev?.complete || complete
                });
            }
            const out = [...byId.values()];
            this.bot.logger.info(this.bot.isMobile, 'REACT-PARSE', `Quest list | parents=${out.length} | incomplete=${out.filter(q => !q.complete).length}`);
            this.bot.logger.debug(this.bot.isMobile, 'REACT-PARSE', `Quest points | ${out.map(q => `${q.title || q.offerId}=${q.pointProgressMax}`).join(' | ') || 'none'}`);
            if (!out.length) {
                this.bot.logger.warn(this.bot.isMobile, 'REACT-PARSE', 'No parent quests parsed - the fetched HTML may be missing the QuestSection chunks (Suspense/streaming or a login redirect)');
            }
            return out;
        }
        catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'REACT-PARSE', `Failed parsing quest list | error=${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }
    // <campaign>_pcparent_<name>_punchcard
    isParentQuestId(offerId) {
        const id = offerId.toLowerCase();
        if (id.includes('pcchild'))
            return false;
        return id.includes('pcparent') || id.includes('punchcard');
    }
    // Utils
    todayStamp() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    normaliseDate(rawDate) {
        if (!rawDate)
            return null;
        const m = rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m)
            return null;
        return `${m[3]}-${m[1]}-${m[2]}`;
    }
}
exports.default = ReactFunc;
//# sourceMappingURL=ReactFunc.js.map