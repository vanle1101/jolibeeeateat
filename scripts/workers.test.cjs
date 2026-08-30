const assert = require('node:assert/strict')
const test = require('node:test')

const { Workers, normaliseActivityType } = require('../dist/functions/Workers.js')
const { UrlReward } = require('../dist/functions/activities/api/UrlReward.js')
const { calculatePointGain } = require('../dist/browser/BrowserFunc.js')

function mockBot() {
    return {
        isMobile: true,
        utils: { getFormattedDate: () => '08/08/2026' },
        logger: { info() {}, warn() {} }
    }
}

test('normalises repeated Rewards activity types', () => {
    assert.equal(normaliseActivityType('urlreward,urlreward,urlreward,urlreward'), 'urlreward')
    assert.equal(normaliseActivityType('  URLREWARD  '), 'urlreward')
})

test('search report gain uses the last observed balance instead of stale server session balance', () => {
    assert.equal(calculatePointGain(380, 365, 65), 15)
    assert.equal(calculatePointGain(380, null, 365), 15)
    assert.equal(calculatePointGain(365, 380, 65), 0)
    assert.equal(calculatePointGain(null, 365, 65), null)
})

test('Daily Set accepts ISO date keys and tasks with a live hash but no point max', async () => {
    const worker = new Workers(mockBot())
    let selected = []
    worker.solveActivities = async activities => {
        selected = activities
    }

    const task = {
        offerId: 'daily-1',
        complete: false,
        pointProgressMax: 0,
        pointProgress: 0,
        hash: 'live-hash',
        promotionType: 'urlreward,urlreward,urlreward,urlreward'
    }

    await worker.doDailySet({ dashboard: { dailySetPromotions: { '2026-08-08': [task] } } })
    assert.deepEqual(selected, [task])
})

test('More Promotions accepts activity type supplied in attributes', async () => {
    const worker = new Workers(mockBot())
    let selected = []
    worker.solveActivities = async activities => {
        selected = activities
    }

    const task = {
        offerId: 'more-1',
        complete: false,
        pointProgressMax: 0,
        pointProgress: 0,
        hash: 'live-hash',
        promotionType: '',
        attributes: { type: 'urlreward' },
        priority: 0
    }

    await worker.doMorePromotions({ dashboard: { morePromotions: [task], morePromotionsWithoutPromotionalItems: [] } })
    assert.deepEqual(selected, [task])
})

test('UrlReward falls back to the API promotion when the streamed snapshot omits it', async () => {
    const calls = []
    const bot = {
        isMobile: true,
        nextActions: { reportActivity: 'report-action' },
        reactSnapshot: { offers: [] },
        config: { skipNonPointTasks: true },
        userData: { currentPoints: 100, gainedPoints: 0, geoLocale: 'us', timezoneOffset: 0 },
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        utils: { randomDelay: () => 0, wait: async () => {} },
        browser: {
            func: {
                reportServerAction: async (...args) => {
                    calls.push(args)
                    return { status: 200, acknowledged: true }
                },
                getCurrentPoints: async () => 110
            }
        }
    }

    await new UrlReward(bot).doUrlReward({
        offerId: 'daily-1',
        hash: 'api-hash',
        pointProgressMax: 10,
        activityType: '11',
        title: 'Daily task',
        promotionType: 'urlreward',
        attributes: { promotional: 'False' }
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0][1][0], 'api-hash')
    assert.equal(bot.userData.currentPoints, 110)
})

test('ready-to-claim punchcard rewards are claimed even when reportable is false', async () => {
    const claims = []
    const bot = {
        isMobile: true,
        config: { autoClaimPunchcardRewards: true },
        nextActions: { reportActivity: 'report-action' },
        userData: { currentPoints: 100, gainedPoints: 0 },
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        utils: { randomDelay: () => 0, wait: async () => {} },
        browser: {
            func: { getRewardsPageHtml: async () => '<quest />' },
            react: {
                snapshotQuestPage: () => [
                    {
                        offerId: 'punchcard-reward',
                        hash: 'live-hash',
                        points: 100,
                        isCompleted: true,
                        isLocked: false,
                        isDisabled: false,
                        reportable: false
                    }
                ]
            }
        },
        activities: { doClaimReward: async (...args) => claims.push(args) }
    }

    const worker = new Workers(bot)
    await worker.solvePunchCard(
        { offerId: 'parent-card', title: 'Keep earning', pointProgressMax: 100 },
        {
            childPromotions: [
                {
                    offerId: 'punchcard-reward',
                    hash: 'live-hash',
                    complete: true,
                    destinationUrl: '/rewards/redeem/punchcard-reward',
                    pointProgressMax: 100,
                    priority: 0
                }
            ]
        },
        {}
    )

    assert.equal(claims.length, 1)
    assert.equal(claims[0][0].offerId, 'punchcard-reward')
})

test('fresh punchcard API state reopens a stale completed page child', async () => {
    const reports = []
    const bot = {
        isMobile: true,
        config: { autoClaimPunchcardRewards: false },
        nextActions: { reportActivity: 'report-action' },
        userData: { currentPoints: 100, gainedPoints: 0, timezoneOffset: 0 },
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        utils: { randomDelay: () => 0, wait: async () => {} },
        browser: {
            func: {
                getRewardsPageHtml: async () => '<quest />',
                reportServerAction: async (...args) => {
                    reports.push(args)
                    return { status: 200, acknowledged: true }
                },
                getCurrentPoints: async () => 110
            },
            react: {
                snapshotQuestPage: () => [
                    {
                        offerId: 'stale-child',
                        hash: 'stale-hash',
                        points: 10,
                        isCompleted: true,
                        isLocked: false,
                        isDisabled: false,
                        reportable: false
                    }
                ],
                questRouterStateTree: () => 'tree'
            }
        },
        activities: { doClaimReward: async () => {} }
    }

    await new Workers(bot).solvePunchCard(
        { offerId: 'parent-card', title: 'Keep earning', pointProgressMax: 10 },
        {
            childPromotions: [
                {
                    offerId: 'stale-child',
                    hash: 'fresh-hash',
                    complete: false,
                    exclusiveLockedFeatureStatus: 'unlocked',
                    destinationUrl: '/earn/stale-child',
                    pointProgressMax: 10,
                    priority: 0
                }
            ]
        },
        {}
    )

    assert.equal(reports.length, 1)
    assert.equal(reports[0][1][0], 'fresh-hash')
})

test('fresh punchcard API state reopens a stale completed page parent', async () => {
    const solved = []
    const bot = {
        isMobile: true,
        config: { skipNonPointTasks: true },
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        browser: {
            func: { getRewardsPageHtml: async () => '<earn />' },
            react: {
                snapshotQuestList: () => [
                    { offerId: 'parent-card', title: 'Keep earning', pointProgressMax: 10, complete: true }
                ]
            }
        }
    }

    const worker = new Workers(bot)
    worker.solvePunchCard = async parent => solved.push(parent)
    await worker.doPunchCards(
        {
            dashboard: {
                punchCards: [
                    {
                        parentPromotion: {
                            offerId: 'parent-card',
                            title: 'Keep earning',
                            pointProgressMax: 10,
                            complete: false
                        },
                        childPromotions: []
                    }
                ]
            }
        },
        {}
    )

    assert.equal(solved.length, 1)
    assert.equal(solved[0].complete, false)
})
