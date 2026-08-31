import { randomBytes } from 'crypto'

import { URLs } from '../constants/urls'
import { buildAppHeaders } from './DeviceIdentity'
import type { BrowserContext, Cookie, Page } from 'patchright'
import { ProxyUnavailableError, type HttpRequestConfig } from '../util/Http'

import type { MicrosoftRewardsBot } from '../index'
import { saveStorageState } from '../util/SessionStore'
import { isBrowserClosedError } from '../util/Utils'

import type { Counters, DashboardData } from './../interface/DashboardData'
import type { AppUserData } from '../interface/AppUserData'
import type { AppEarnablePoints, BrowserEarnablePoints, MissingSearchPoints } from '../interface/Points'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import type { PageSnapshot, ParsedOffer } from './ReactFunc'

// Bing-hosted image used to seed the daily visual search. /images/kblob fetches it (Can be changed)
const VISUAL_SEARCH_IMAGE_URL = 'https://th.bing.com/th?id=OMR.VisualSearch.VNext.BackgroundImage.png&pid=Rewards'
const BROWSER_SHUTDOWN_TIMEOUT_MS = 15000

export function calculatePointGain(currentBalance: number | null, baselineBalance: number | null, serverPreviousBalance: number | null): number | null {
    if (currentBalance == null) return null
    if (baselineBalance != null) return Math.max(0, currentBalance - baselineBalance)
    if (serverPreviousBalance != null) return Math.max(0, currentBalance - serverPreviousBalance)
    return null
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
                timer.unref?.()
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function sanitizeUrlForLog(value: string): string {
    try {
        const url = new URL(value)
        return url.origin === 'null' ? `${url.protocol}${url.pathname}` : `${url.hostname}${url.pathname}`
    } catch {
        return value.split(/[?#]/, 1)[0] ?? 'unknown'
    }
}

function isMicrosoftAuthHostname(hostname: string): boolean {
    return ['login.live.com', 'login.microsoftonline.com', 'account.live.com'].includes(hostname)
}

export class RewardsAuthenticationRequiredError extends Error {
    readonly destination: string

    constructor(finalUrl: string) {
        const destination = sanitizeUrlForLog(finalUrl)
        super(`Rewards authentication is required after redirect to ${destination}`)
        this.name = 'RewardsAuthenticationRequiredError'
        this.destination = destination
    }
}

class RewardsUnexpectedRedirectError extends Error {
    constructor(finalUrl: string) {
        super(`Rewards /dashboard redirected unexpectedly to ${sanitizeUrlForLog(finalUrl)}`)
        this.name = 'RewardsUnexpectedRedirectError'
    }
}

class RewardsHttpStatusError extends Error {
    constructor(readonly status: number) {
        super(`Rewards /dashboard returned HTTP ${status}`)
        this.name = 'RewardsHttpStatusError'
    }
}

function isRetryableDashboardError(error: unknown): boolean {
    if (error instanceof RewardsAuthenticationRequiredError || error instanceof RewardsUnexpectedRedirectError) {
        return false
    }

    if (error instanceof RewardsHttpStatusError) {
        return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
    }

    return true
}

export default class BrowserFunc {
    private bot: MicrosoftRewardsBot

    private bingJars = new Map<string, Map<string, string>>()

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    async getDashboardData(cookies?: Cookie[], page?: Page): Promise<DashboardData> {
        const request: HttpRequestConfig = {
            url: URLs.rewards.userInfoApi,
            method: 'GET',
            timeout: Math.max(20000, this.bot.utils.stringToNumber(this.bot.config.globalTimeout)),
            headers: {
                ...(this.bot.fingerprint?.headers ?? {}),
                Cookie: this.buildCookieHeader(cookies ?? this.bot.cookies.mobile, [
                    'bing.com',
                    'live.com',
                    'microsoftonline.com'
                ]),
                Referer: URLs.rewards.referer,
                Origin: URLs.rewards.origin
            }
        }

        try {
            const response = await this.bot.http.request(request)

            if (response.data && typeof response.data === 'object' && 'dashboard' in response.data) {
                return response.data as DashboardData
            }
            throw new Error('Dashboard data missing from API response')
        } catch (error) {
            // The browser context is already bound to the account's configured
            // proxy. If Impit's separate proxy transport is temporarily stuck,
            // reuse that authenticated/proxied context instead of falling back
            // to a direct connection or failing a search-progress measurement.
            if (error instanceof ProxyUnavailableError && page && !page.isClosed()) {
                try {
                    const data = await this.getDashboardDataFromBrowser(page, request)
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'GET-DASHBOARD-DATA',
                        'Primary proxy transport unavailable; recovered through browser-context proxy transport'
                    )
                    return data
                } catch (fallbackError) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'GET-DASHBOARD-DATA',
                        `Failed to get dashboard data: ${error.message} | browser-context fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
                    )
                    throw fallbackError
                }
            }

            this.bot.logger.error(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                `Failed to get dashboard data: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async getDashboardDataFromBrowser(page: Page, request: HttpRequestConfig): Promise<DashboardData> {
        const headers = Object.fromEntries(
            Object.entries(request.headers ?? {})
                .filter((entry): entry is [string, NonNullable<unknown>] => entry[1] !== undefined && entry[1] !== null)
                .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])
        )
        const response = await page.request.get(request.url ?? URLs.rewards.userInfoApi, {
            headers,
            timeout: request.timeout
        })

        if (!response.ok()) {
            throw new Error(`Browser-context dashboard request returned HTTP ${response.status()}`)
        }

        const data: unknown = await response.json()
        if (!data || typeof data !== 'object' || !('dashboard' in data)) {
            throw new Error('Dashboard data missing from browser-context response')
        }

        return data as DashboardData
    }

    async getAppDashboardData(): Promise<AppDashboardData> {
        try {
            const request: HttpRequestConfig = {
                url: URLs.platform.me(this.bot.mobileDevice.channel),
                method: 'GET',
                headers: buildAppHeaders({
                    accessToken: this.bot.accessToken,
                    geoLocale: this.bot.userData.geoLocale,
                    langCode: this.bot.userData.langCode,
                    device: this.bot.mobileDevice,
                    appUserAgent: this.bot.appUserAgent
                })
            }

            const response = await this.bot.http.request(request)
            return response.data as AppDashboardData
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-DASHBOARD-DATA',
                `Error fetching dashboard data: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    async getSearchPoints(page?: Page): Promise<Counters> {
        const dashboardData = await this.getDashboardData(undefined, page) // Always fetch newest data

        return dashboardData?.dashboard?.userStatus?.counters ?? ({} as Counters)
    }

    missingSearchPoints(counters: Counters, isMobile: boolean): MissingSearchPoints {
        const mobileData = counters.mobileSearch?.[0]
        const desktopData = counters.pcSearch?.[0]
        const edgeData = counters.pcSearch?.[1]

        const mobilePoints = mobileData ? Math.max(0, mobileData.pointProgressMax - mobileData.pointProgress) : 0
        const desktopPoints = desktopData ? Math.max(0, desktopData.pointProgressMax - desktopData.pointProgress) : 0
        const edgePoints = edgeData ? Math.max(0, edgeData.pointProgressMax - edgeData.pointProgress) : 0

        const totalPoints = isMobile ? mobilePoints : desktopPoints + edgePoints

        return { mobilePoints, desktopPoints, edgePoints, totalPoints }
    }

    async getBrowserEarnablePoints(): Promise<BrowserEarnablePoints> {
        try {
            const data = await this.getDashboardData()

            const desktopSearchPoints =
                data?.dashboard?.userStatus?.counters?.pcSearch?.reduce(
                    (sum: number, x: { pointProgressMax: number; pointProgress: number }) =>
                        sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const mobileSearchPoints =
                data?.dashboard?.userStatus?.counters?.mobileSearch?.reduce(
                    (sum: number, x: { pointProgressMax: number; pointProgress: number }) =>
                        sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const todayDate = this.bot.utils.getFormattedDate()
            const dailySetPoints =
                data?.dashboard?.dailySetPromotions?.[todayDate]?.reduce(
                    (sum: number, x: { pointProgressMax: number; pointProgress: number }) =>
                        sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const morePromotionsPoints =
                data?.dashboard?.morePromotions?.reduce((sum, x) => {
                    if (x.promotionType === 'urlreward' && x.exclusiveLockedFeatureStatus !== 'locked') {
                        return sum + (x.pointProgressMax - x.pointProgress)
                    }
                    return sum
                }, 0) ?? 0

            const totalEarnablePoints = desktopSearchPoints + mobileSearchPoints + dailySetPoints + morePromotionsPoints

            return {
                dailySetPoints,
                morePromotionsPoints,
                desktopSearchPoints,
                mobileSearchPoints,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-BROWSER-EARNABLE-POINTS',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    async getAppEarnablePoints(): Promise<AppEarnablePoints> {
        try {
            const eligibleOffers = ['ENUS_readarticle3_30points', 'Gamification_Sapphire_DailyCheckIn']

            const request: HttpRequestConfig = {
                url: URLs.platform.me(this.bot.mobileDevice.channel),
                method: 'GET',
                headers: buildAppHeaders({
                    accessToken: this.bot.accessToken,
                    geoLocale: this.bot.userData.geoLocale,
                    langCode: this.bot.userData.langCode,
                    device: this.bot.mobileDevice,
                    appUserAgent: this.bot.appUserAgent
                })
            }

            const response = await this.bot.http.request<AppUserData>(request)
            const userData: AppUserData = response.data
            const eligibleActivities = userData.response.promotions.filter(x =>
                eligibleOffers.includes(x.attributes.offerid ?? '')
            )

            let readToEarn = 0
            let checkIn = 0

            for (const item of eligibleActivities) {
                const attrs = item.attributes

                if (attrs.type === 'msnreadearn') {
                    const pointMax = parseInt(attrs.pointmax ?? '0')
                    const pointProgress = parseInt(attrs.pointprogress ?? '0')
                    readToEarn = Math.max(0, pointMax - pointProgress)
                } else if (attrs.type === 'checkin') {
                    const progress = parseInt(attrs.progress ?? '0')
                    const checkInDay = progress % 7
                    const lastUpdated = new Date(attrs.last_updated ?? '')
                    const today = new Date()

                    if (checkInDay < 6 && today.getDate() !== lastUpdated.getDate()) {
                        checkIn = parseInt(attrs[`day_${checkInDay + 1}_points`] ?? '0')
                    }
                }
            }

            const totalEarnablePoints = readToEarn + checkIn

            return {
                readToEarn,
                checkIn,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-EARNABLE-POINTS',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    async getCurrentPoints(): Promise<number> {
        try {
            const data = await this.getDashboardData()

            return data?.dashboard?.userStatus?.availablePoints ?? 0
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-CURRENT-POINTS',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    async getReadyToClaimPoints(): Promise<number | null> {
        const data = await this.getDashboardData()
        const rawClaimable = data?.dashboard?.pointClaimBannerPromotion?.attributes?.claimable_points
        if (rawClaimable == null || String(rawClaimable).trim() === '') return null

        const claimable = Number(rawClaimable)

        return Number.isFinite(claimable) ? Math.max(0, claimable) : null
    }

    private getActiveRewardsPage(): Page | null {
        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        return page && !page.isClosed() ? page : null
    }

    /**
     * Fetch a Rewards page through the active browser context. The RSC payload
     * is the source of truth for live hashes; using the page request keeps the
     * current account cookies and proxy/session context attached.
     */
    async getRewardsPageHtml(url: string, route: string): Promise<string | null> {
        const page = this.getActiveRewardsPage()
        if (!page) {
            this.bot.logger.debug(this.bot.isMobile, 'REWARDS-PAGE', `No active page available for ${route}`)
            return null
        }

        try {
            const response = await page.request.get(url, { timeout: 20000 })
            if (response.ok()) return await response.text()

            this.bot.logger.debug(
                this.bot.isMobile,
                'REWARDS-PAGE',
                `Failed to fetch ${route} | status=${response.status()}`
            )
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'REWARDS-PAGE',
                `Browser fetch failed for ${route} | ${error instanceof Error ? error.message : String(error)}`
            )
        }

        return null
    }

    /** Refresh the streamed /earn and /dashboard offer snapshot together. */
    async refreshEarnSnapshot(): Promise<PageSnapshot | null> {
        const pages = await Promise.all([
            this.getRewardsPageHtml(URLs.rewards.earn, '/earn'),
            this.getRewardsPageHtml(URLs.rewards.dashboard, '/dashboard')
        ])
        const html = pages.filter((value): value is string => value !== null).join('\n')
        return html ? this.bot.browser.react.snapshotPage(html) : null
    }

    /** Resolve an offer missing from the initial streamed page response. */
    async ensureOffer(offerId: string): Promise<ParsedOffer | null> {
        const cached = this.bot.reactSnapshot?.offers.find(offer => offer.offerId === offerId)
        if (cached) return cached

        this.bot.logger.debug(
            this.bot.isMobile,
            'EARN-SNAPSHOT',
            `${offerId} absent from cached snapshot; refetching /earn and /dashboard`
        )

        const refreshed = await this.refreshEarnSnapshot()
        if (!refreshed) return null

        const live = refreshed.offers.find(offer => offer.offerId === offerId) ?? null
        if (!this.bot.reactSnapshot || refreshed.offers.length >= this.bot.reactSnapshot.offers.length) {
            this.bot.reactSnapshot = refreshed
        }

        this.bot.logger.debug(
            this.bot.isMobile,
            'EARN-SNAPSHOT',
            `Refreshed Rewards snapshot | offers=${refreshed.offers.length} | ${offerId} found=${!!live}`
        )
        return live
    }

    async bootstrap(page: Page): Promise<void> {
        try {
            const timeoutMs = Math.max(this.bot.utils.stringToNumber(this.bot.config.globalTimeout), 60000)
            const dashboardHtml = await this.loadRewardsDashboardPage(page, timeoutMs)

            this.bot.nextRouterStateTree = this.bot.browser.react.routerStateTree('earn')

            // /earn contains offer hashes and RSC action metadata, but it is not required
            // for validating the authenticated browser session.
            let earnHtml = ''
            try {
                const res = await page.request.get(URLs.rewards.earn, { timeout: Math.min(timeoutMs, 30000) })
                if (res.ok()) {
                    earnHtml = await res.text()
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Failed to fetch optional /earn HTML | status=${res.status()} - offer/action discovery may be incomplete`
                    )
                }
            } catch (error) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    `Failed to fetch optional /earn HTML | error=${error instanceof Error ? error.message : String(error)} - continuing with /dashboard context`
                )
            }

            const snapshotHtml = earnHtml || dashboardHtml
            this.bot.reactSnapshot = this.bot.browser.react.snapshotPage(snapshotHtml)

            // Discover chunks from both pages when the optional /earn request succeeds.
            this.bot.nextActions = await this.resolveActionIds(page, [dashboardHtml, earnHtml])

            const dashboardRendered = /<section\b[^>]*\bid=["']dailyset["']/i.test(dashboardHtml)
            if (!dashboardRendered) {
                throw new Error(
                    'Rewards dashboard did not render (no section#dailyset) - likely a login/redirect issue, aborting'
                )
            }

            if (!this.bot.reactSnapshot.offers.length) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    'No offers parsed - page may not have rendered the RSC payload (check login/redirect)'
                )
            }

            if (!Object.keys(this.bot.nextActions).length) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    'No action ids discovered - server-action calls will fail (bundle may have stripped names)'
                )
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Context ready | actions=${Object.keys(this.bot.nextActions).length} | reportable=${this.bot.reactSnapshot.reportable.length} | available=${this.bot.reactSnapshot.account.availablePoints}`
            )

            this.bot.logger.info(
                this.bot.isMobile,
                'BUILD',
                `Rewards build | id=${this.bot.browser.react.buildId(snapshotHtml) ?? 'unknown'}`
            )
        } catch (error) {
            // The login flow owns this recoverable redirect and will resume the
            // Microsoft OAuth state machine once. Do not emit a false ERROR
            // before that recovery has had a chance to succeed.
            if (error instanceof RewardsAuthenticationRequiredError) throw error

            this.bot.logger.error(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Failed acquiring context | error=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async loadRewardsDashboardPage(page: Page, timeoutMs: number): Promise<string> {
        const maxAttempts = 3
        const domTimeoutMs = Math.min(timeoutMs, 20000)
        const expectedHostname = new URL(URLs.rewards.dashboard).hostname
        let lastError: unknown

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await page.goto(URLs.rewards.dashboard, { waitUntil: 'commit', timeout: timeoutMs })
                const status = response?.status()

                if (status !== undefined && status >= 400) {
                    throw new RewardsHttpStatusError(status)
                }

                let domReady = true
                try {
                    await page.waitForLoadState('domcontentloaded', { timeout: domTimeoutMs })
                } catch (error) {
                    if (isBrowserClosedError(error)) throw error
                    domReady = false
                }

                const finalUrl = page.url()
                const finalHostname = new URL(finalUrl).hostname
                if (finalHostname !== expectedHostname) {
                    if (isMicrosoftAuthHostname(finalHostname)) {
                        throw new RewardsAuthenticationRequiredError(finalUrl)
                    }
                    throw new RewardsUnexpectedRedirectError(finalUrl)
                }

                const html = await page.content()
                if (!/<body\b/i.test(html) || html.length < 1000) {
                    throw new Error(`Rewards /dashboard returned incomplete HTML (${html.length} bytes)`)
                }

                if (!domReady) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `DOMContentLoaded was not observed within ${domTimeoutMs}ms; continuing with usable HTML | attempt=${attempt}/${maxAttempts}`
                    )
                }

                return html
            } catch (error) {
                if (isBrowserClosedError(error)) throw error
                lastError = error

                const message = error instanceof Error ? error.message : String(error)
                const finalUrl = page.isClosed() ? 'page-closed' : sanitizeUrlForLog(page.url())
                const retryable = isRetryableDashboardError(error)

                if (!retryable) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Rewards /dashboard navigation stopped | attempt=${attempt}/${maxAttempts} | url=${finalUrl} | error=${message}`
                    )
                    throw error
                }

                if (attempt < maxAttempts) {
                    const retryDelayMs = attempt * 3000
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Rewards /dashboard navigation failed | attempt=${attempt}/${maxAttempts} | url=${finalUrl} | error=${message} | retryIn=${retryDelayMs}ms`
                    )
                    await page.evaluate(() => window.stop()).catch(() => {})
                    await this.bot.utils.wait(retryDelayMs)
                }
            }
        }

        const message = lastError instanceof Error ? lastError.message : String(lastError)
        const finalUrl = page.isClosed() ? 'page-closed' : sanitizeUrlForLog(page.url())
        throw new Error(
            `Rewards /dashboard could not be loaded after ${maxAttempts} attempts (transient failures; timeout=${timeoutMs}ms, finalUrl=${finalUrl}). Last error: ${message}`,
            { cause: lastError }
        )
    }

    private async resolveActionIds(page: Page, htmls: string[]): Promise<Record<string, string>> {
        const result: Record<string, string> = {}

        try {
            const initialChunks = new Set<string>()
            const chunkRegex = /(?:\/_next\/)?(static\/chunks\/[\w\-./()]+?\.js)/g
            for (const html of htmls) {
                if (!html) continue
                for (const match of html.matchAll(chunkRegex)) {
                    initialChunks.add('/_next/' + match[1]!)
                }
            }

            if (initialChunks.size === 0) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    'No initial chunks discovered in HTML - chunk reference shape may have changed'
                )
            }

            this.bot.logger.debug(this.bot.isMobile, 'BOOTSTRAP', `Fetching ${initialChunks.size} initial JS chunks`)
            const jsByPath = await this.fetchJsChunks(page, [...initialChunks])

            // Claim/streak controls are often behind a lazily loaded Rewards
            // drawer. Resolve the webpack manifest transitively instead of
            // stopping after one level, while keeping a hard cap for a broken
            // manifest.
            const requestedPaths = new Set(initialChunks)
            const maxDynamicChunks = 200
            for (let round = 0; round < 3 && requestedPaths.size < maxDynamicChunks; round++) {
                const dynamicPaths = new Set<string>()
                for (const js of jsByPath.values()) {
                    for (const path of this.extractDynamicChunkPaths(js)) {
                        if (!requestedPaths.has(path)) dynamicPaths.add(path)
                    }
                }

                const nextPaths = [...dynamicPaths].slice(0, maxDynamicChunks - requestedPaths.size)
                if (!nextPaths.length) break

                nextPaths.forEach(path => requestedPaths.add(path))
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    `Fetching ${nextPaths.length} dynamic chunks (round=${round + 1}) discovered via webpack manifest`
                )
                const moreJs = await this.fetchJsChunks(page, nextPaths)
                for (const [path, js] of moreJs) jsByPath.set(path, js)
            }

            for (const [path, js] of jsByPath) {
                const filename = path.split('/').pop() ?? path
                const ids = this.bot.browser.react.extractActionIds(js)
                const names = Object.keys(ids.byName)

                if (names.length) {
                    Object.assign(result, ids.byName)
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Found ${names.length} action id(s) in ${filename}: [${names.join(', ')}]`
                    )
                } else {
                    this.bot.logger.debug(this.bot.isMobile, 'BOOTSTRAP', `No server-action ids found in ${filename}`)
                }

                const namedSet = new Set(Object.values(ids.byName))
                const unnamed = ids.all.filter(id => !namedSet.has(id))
                if (unnamed.length) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Found ${unnamed.length} unnamed action id(s) in ${filename}: [${unnamed.join(', ')}]`
                    )
                }
            }

            // Some server actions are embedded in the streamed RSC response
            // instead of a client chunk (especially drawer-only controls).
            // Feed both authenticated page sources through the same extractor.
            for (const [index, html] of htmls.entries()) {
                if (!html) continue
                const ids = this.bot.browser.react.extractActionIds(html)
                if (Object.keys(ids.byName).length) {
                    Object.assign(result, ids.byName)
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Found ${Object.keys(ids.byName).length} action id(s) in page source ${index + 1}: [${Object.keys(ids.byName).join(', ')}]`
                    )
                }
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Discovered ${Object.keys(result).length} action ids: [${Object.keys(result).join(', ')}]`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'BOOTSTRAP',
                `Failed resolving action ids | error=${error instanceof Error ? error.message : String(error)}`
            )
        }

        return result
    }

    private async fetchJsChunks(page: Page, paths: string[]): Promise<Map<string, string>> {
        const result = new Map<string, string>()

        await Promise.all(
            paths.map(async path => {
                try {
                    const res = await page.request.get(URLs.rewards.path(path))
                    if (res.ok()) {
                        result.set(path, await res.text())
                    }
                } catch (error) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `Chunk fetch failed | path=${path} | ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            })
        )

        return result
    }

    private extractDynamicChunkPaths(js: string): string[] {
        const seen = new Set<string>()

        const builder = /static\/chunks\/"\s*\+\s*\w+\s*\+\s*"([-.])"\s*\+\s*\{([\s\S]*?)\}\s*\[/g
        for (const match of js.matchAll(builder)) {
            const sep = match[1]!
            for (const [, id, hash] of match[2]!.matchAll(/(\d+)\s*:\s*"([a-f0-9]+)"/g)) {
                seen.add(`/_next/static/chunks/${id}${sep}${hash}.js`)
            }
        }

        // If the builder shape changes, scan id:hash pairs globally
        if (!seen.size) {
            for (const [, id, hash] of js.matchAll(/\b(\d{2,6}):"([a-f0-9]{12,})"/g)) {
                seen.add(`/_next/static/chunks/${id}-${hash}.js`)
                seen.add(`/_next/static/chunks/${id}.${hash}.js`)
            }
        }

        return [...seen]
    }

    async closeBrowser(browser: BrowserContext, email: string, persistSession = true) {
        const rootBrowser = browser.browser?.() || null

        try {
            if (persistSession) {
                // Store state (cookies + localStorage) for next run only after authentication was validated.
                const storageState = await withTimeout(
                    browser.storageState(),
                    BROWSER_SHUTDOWN_TIMEOUT_MS,
                    'Browser session save'
                )
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'CLOSE-BROWSER',
                    `Saving session | cookies=${storageState.cookies.length} | origins=${storageState.origins.length}`
                )
                saveStorageState(this.bot.config.sessionPath, email, this.bot.isMobile, storageState)
                await this.bot.utils.wait(2000)
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLOSE-BROWSER',
                    'Skipping session save because Rewards authentication was not validated'
                )
            }
        } catch (error) {
            if (isBrowserClosedError(error)) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'CLOSE-BROWSER',
                    `Session not saved (browser already closing): ${error instanceof Error ? error.message : String(error)}`
                )
            } else {
                this.bot.logger.error(this.bot.isMobile, 'CLOSE-BROWSER', `Failed to save session: ${error}`)
            }
        } finally {
            let shutdownError: unknown = null
            try {
                await withTimeout(browser.close(), BROWSER_SHUTDOWN_TIMEOUT_MS, 'Browser context close')
            } catch (error) {
                if (isBrowserClosedError(error)) {
                    this.bot.logger.debug(this.bot.isMobile, 'CLOSE-BROWSER', 'Browser was already closed.')
                } else {
                    shutdownError = error
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'CLOSE-BROWSER',
                        `Context shutdown did not finish cleanly: ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }

            if (rootBrowser) {
                try {
                    await withTimeout(rootBrowser.close(), BROWSER_SHUTDOWN_TIMEOUT_MS, 'Root browser close')
                } catch (error) {
                    if (!isBrowserClosedError(error)) {
                        shutdownError ??= error
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'CLOSE-BROWSER',
                            `Root browser shutdown did not finish cleanly: ${error instanceof Error ? error.message : String(error)}`
                        )
                    }
                }
            }

            if (shutdownError) {
                this.bot.logger.warn(this.bot.isMobile, 'CLOSE-BROWSER', 'Shutdown deadline reached; process exiting.')
            } else {
                this.bot.logger.info(this.bot.isMobile, 'CLOSE-BROWSER', 'All browser resources closed.')
            }
        }
    }

    buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string {
        return [
            ...new Map(
                cookies
                    .filter(c => {
                        if (!allowedDomains || allowedDomains.length === 0) return true
                        return (
                            typeof c.domain === 'string' &&
                            allowedDomains.some(d => c.domain.toLowerCase().endsWith(d.toLowerCase()))
                        )
                    })
                    .map(c => [c.name, c])
            ).values()
        ]
            .map(c => `${c.name}=${c.value}`)
            .join('; ')
    }

    // Fire a nextjs RSC server action shared by UrlReward / ClaimReward / ClaimBonusPoints
    async reportServerAction(
        actionId: string,
        body: unknown[],
        opts?: { url?: string; referer?: string; routerStateTree?: string }
    ): Promise<{ status: number; acknowledged: boolean }> {
        const url = opts?.url ?? URLs.rewards.earn
        const referer = opts?.referer ?? url
        const routerStateTree = opts?.routerStateTree ?? this.bot.nextRouterStateTree

        const cookieHeader = this.buildCookieHeader(
            this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop,
            ['bing.com', 'live.com', 'microsoftonline.com']
        )

        const fingerprintHeaders = { ...this.bot.fingerprint.headers }
        delete fingerprintHeaders['Cookie']
        delete fingerprintHeaders['cookie']

        const request: HttpRequestConfig = {
            url,
            method: 'POST',
            headers: {
                ...fingerprintHeaders,
                Cookie: cookieHeader,
                Referer: referer,
                Origin: URLs.rewards.origin,
                Accept: 'text/x-component',
                'Content-Type': 'text/plain;charset=UTF-8',
                'Next-Action': actionId,
                'Next-Router-State-Tree': routerStateTree
            },
            data: JSON.stringify(body)
        }

        const response = await this.bot.http.request(request)
        const acknowledged = this.bot.utils.serverActionAcknowledged(response.data)

        return { status: response.status, acknowledged }
    }

    async reportSearchActivity(
        query: string,
        opts?: { cvid?: string; cg?: string }
    ): Promise<{
        ig: string | null
        balance: number | null
        previousBalance: number | null
        gained: number | null
        searchPointsEarned: number | null
        searchPointsLimit: number | null
    }> {
        const cvid = opts?.cvid ?? randomBytes(16).toString('hex')
        const searchUrl = URLs.bing.search(query, cvid)
        const jar = this.getBingJar()
        const currentBalance = Number(this.bot.userData.currentPoints)
        const baselineBalance = Number.isFinite(currentBalance) ? currentBalance : null

        const base = { ...(this.bot.fingerprint?.headers ?? {}) }
        delete base['Cookie']
        delete base['cookie']

        const empty = {
            ig: null,
            balance: null,
            previousBalance: null,
            searchPointsEarned: null,
            searchPointsLimit: null
        }

        const searchRes = await this.bot.http.request({
            url: searchUrl,
            method: 'GET',
            headers: {
                ...base,
                Cookie: this.jarToHeader(jar),
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            }
        })
        this.mergeSetCookies(jar, searchRes.headers?.['set-cookie'] as string[] | string | undefined)

        const ig =
            typeof searchRes.data === 'string'
                ? ((searchRes.data.match(/\bIG:"([A-F0-9]{32})"/i) ??
                      searchRes.data.match(/[?&]IG=([A-F0-9]{32})\b/i))?.[1] ?? null)
                : null
        if (!ig) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'SEARCH-REPORT',
                `No IG for "${query}" - SERP not served as expected`
            )
            return { ...empty, gained: null }
        }

        const params = new URLSearchParams({ IG: ig, IID: 'SERP.5064', q: query, FORM: 'ANNTA1', cvid, ajaxreq: '1' })
        // Credit the offer rather than only the daily search counter!
        const reportUrl = `${URLs.bing.origin}/rewardsapp/reportActivity?${params.toString()}${opts?.cg ? `&cg=${opts.cg}` : ''}`

        const reportRes = await this.bot.http.request({
            url: reportUrl,
            method: 'POST',
            headers: {
                ...base,
                Cookie: this.jarToHeader(jar),
                Accept: '*/*',
                'Content-Type': 'application/x-www-form-urlencoded',
                Referer: searchUrl,
                Origin: URLs.bing.origin,
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin',
                'X-Requested-With': 'XMLHttpRequest'
            },
            data: `url=${encodeURIComponent(searchUrl)}&V=web`
        })
        this.mergeSetCookies(jar, reportRes.headers?.['set-cookie'] as string[] | string | undefined)

        const parsed = this.parseReportResponse(reportRes.data)
        // PreviousBalance in the legacy report payload can be the balance at
        // the start of the whole search session, not the preceding query.
        // Use the bot's last observed balance for the per-query delta so the
        // search summary cannot count the same points repeatedly.
        const gained = calculatePointGain(parsed.balance, baselineBalance, parsed.previousBalance)

        this.bot.logger.debug(
            this.bot.isMobile,
            'SEARCH-REPORT',
            `Reported "${query}" | ig=${ig} | pointsGained=${gained ?? 'n/a'} | currentBalance=${parsed.balance ?? 'n/a'} | searchPts=${parsed.searchPointsEarned ?? 'n/a'}/${parsed.searchPointsLimit ?? 'n/a'}`
        )

        return { ig, ...parsed, gained }
    }

    async reportVisualSearchActivity(visual: { bcid: string; query: string; serpUrl: string }): Promise<{
        ig: string | null
        balance: number | null
        previousBalance: number | null
        gained: number | null
        searchPointsEarned: number | null
        searchPointsLimit: number | null
    }> {
        const { bcid, query, serpUrl } = visual

        const jar = this.getBingJar()
        const currentBalance = Number(this.bot.userData.currentPoints)
        const baselineBalance = Number.isFinite(currentBalance) ? currentBalance : null

        const base = { ...(this.bot.fingerprint?.headers ?? {}) }
        delete base['Cookie']
        delete base['cookie']

        const empty = {
            ig: null,
            balance: null,
            previousBalance: null,
            searchPointsEarned: null,
            searchPointsLimit: null
        }

        const searchRes = await this.bot.http.request({
            url: serpUrl,
            method: 'GET',
            headers: {
                ...base,
                Cookie: this.jarToHeader(jar),
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            }
        })
        this.mergeSetCookies(jar, searchRes.headers?.['set-cookie'] as string[] | string | undefined)

        const ig =
            typeof searchRes.data === 'string'
                ? ((searchRes.data.match(/\bIG:"([A-F0-9]{32})"/i) ??
                      searchRes.data.match(/[?&]IG=([A-F0-9]{32})\b/i))?.[1] ?? null)
                : null
        if (!ig) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'VISUAL-SEARCH-REPORT',
                `No IG for "${query}" - visual SERP not served as expected`
            )
            return { ...empty, gained: null }
        }

        const params = new URLSearchParams({
            IG: ig,
            IID: 'SERP.5064',
            q: query,
            bcid,
            FORM: 'SBIHMP',
            hq: '1',
            ajaxreq: '1'
        })
        const reportUrl = `${URLs.bing.origin}/rewardsapp/reportActivity?${params.toString()}`

        const reportRes = await this.bot.http.request({
            url: reportUrl,
            method: 'POST',
            headers: {
                ...base,
                Cookie: this.jarToHeader(jar),
                Accept: '*/*',
                'Content-Type': 'application/x-www-form-urlencoded',
                Referer: serpUrl,
                Origin: URLs.bing.origin,
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin',
                'X-Requested-With': 'XMLHttpRequest'
            },
            data: `url=${encodeURIComponent(serpUrl)}&V=web`
        })
        this.mergeSetCookies(jar, reportRes.headers?.['set-cookie'] as string[] | string | undefined)

        const parsed = this.parseReportResponse(reportRes.data)
        const gained = calculatePointGain(parsed.balance, baselineBalance, parsed.previousBalance)

        this.bot.logger.debug(
            this.bot.isMobile,
            'VISUAL-SEARCH-REPORT',
            `Reported "${query}" | ig=${ig} | bcid=${bcid.slice(0, 12)} | pointsGained=${gained ?? 'n/a'} | currentBalance=${parsed.balance ?? 'n/a'} | searchPts=${parsed.searchPointsEarned ?? 'n/a'}/${parsed.searchPointsLimit ?? 'n/a'}`
        )

        return { ig, ...parsed, gained }
    }

    async acquireVisualSearch(
        imageUrl: string = VISUAL_SEARCH_IMAGE_URL
    ): Promise<{ bcid: string; query: string; serpUrl: string } | null> {
        try {
            const jar = this.getBingJar()
            const base = { ...(this.bot.fingerprint?.headers ?? {}) }
            delete base['Cookie']
            delete base['cookie']

            const enc = encodeURIComponent(imageUrl)
            const url =
                `${URLs.bing.origin}/images/kblob` + `?iss=sbi&form=SBIHMP&sbisrc=UrlPaste&vsimg=${enc}&imgurl=${enc}`

            const boundary = `----WebKitFormBoundary${randomBytes(8).toString('hex')}`
            const body = this.buildMultipart(boundary, [
                { name: 'cbir', value: 'sbi' },
                { name: 'imageBin', value: '' },
                { name: 'imgurl', value: '' }
            ])

            const res = await this.bot.http.request({
                url,
                method: 'POST',
                headers: {
                    ...base,
                    Cookie: this.jarToHeader(jar),
                    Accept: 'application/json',
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    Referer: `${URLs.bing.origin}/visualsearch`,
                    Origin: URLs.bing.origin,
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin'
                },
                data: body
            })
            this.mergeSetCookies(jar, res.headers?.['set-cookie'] as string[] | string | undefined)

            const redirectUrl = this.parseKblobRedirect(res.data)
            if (!redirectUrl) {
                const dump = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'VISUAL-SEARCH-BCID',
                    `kblob returned no redirectUrl | status=${res.status} - the endpoint/shape may have changed`
                )
                this.bot.logger.debug(this.bot.isMobile, 'VISUAL-SEARCH-BCID', `kblob response: ${dump.slice(0, 400)}`)
                return null
            }

            const qs = new URLSearchParams(redirectUrl.split('?')[1] ?? '')
            const bcid = qs.get('bcid')
            if (!bcid) {
                this.bot.logger.warn(this.bot.isMobile, 'VISUAL-SEARCH-BCID', `redirect had no bcid | ${redirectUrl}`)
                return null
            }

            const query = qs.get('q') ?? ''
            const serpUrl = `${URLs.bing.origin}${redirectUrl}`

            this.bot.logger.info(
                this.bot.isMobile,
                'VISUAL-SEARCH-BCID',
                `Acquired bcid=${bcid.slice(0, 14)} | q="${query}" | status=${res.status}`,
                'green'
            )
            return { bcid, query, serpUrl }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'VISUAL-SEARCH-BCID',
                `Failed to acquire visual search | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    resetHttpJars(): void {
        this.bingJars.clear()
    }

    private getBingJar(): Map<string, string> {
        const src = this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop
        const key = `${src.find(c => c.name === '_U')?.value ?? ''}|${this.bot.isMobile}`
        let jar = this.bingJars.get(key)
        if (!jar) {
            jar = new Map<string, string>()
            for (const c of src) {
                const domain = c.domain.replace(/^\./, '')
                if (domain === 'bing.com' || domain.endsWith('.bing.com')) jar.set(c.name, c.value)
            }
            this.bingJars.set(key, jar)
        }
        return jar
    }

    private mergeSetCookies(jar: Map<string, string>, setCookie?: string[] | string): void {
        if (!setCookie) return
        for (const raw of Array.isArray(setCookie) ? setCookie : [setCookie]) {
            const pair = raw.split(';', 1)[0] ?? ''
            const eq = pair.indexOf('=')
            if (eq <= 0) continue
            const name = pair.slice(0, eq).trim()
            const value = pair.slice(eq + 1).trim()
            if (!name) continue
            if (value === '' || /expires=Thu,\s*01\s*Jan\s*1970/i.test(raw) || /\bmax-age=0\b/i.test(raw))
                jar.delete(name)
            else jar.set(name, value)
        }
    }

    private jarToHeader(jar: Map<string, string>): string {
        return [...jar.entries()].map(([n, v]) => `${n}=${v}`).join('; ')
    }

    private parseReportResponse(data: unknown): {
        balance: number | null
        previousBalance: number | null
        searchPointsEarned: number | null
        searchPointsLimit: number | null
    } {
        const empty = { balance: null, previousBalance: null, searchPointsEarned: null, searchPointsLimit: null }
        if (typeof data !== 'string') return empty
        const m = data.match(/ModernRewards\.ReportActivity\((\{[\s\S]*?\})\)\s*;/)
        if (!m) return empty
        try {
            const s = JSON.parse(m[1] ?? '{}').RewardsSessionData ?? {}
            const num = (v: unknown) => (typeof v === 'number' ? v : null)
            return {
                balance: num(s.Balance),
                previousBalance: num(s.PreviousBalance),
                searchPointsEarned: num(s.DailySearchPointsEarned),
                searchPointsLimit: num(s.DailySearchPointsLimit)
            }
        } catch {
            return empty
        }
    }

    private buildMultipart(boundary: string, fields: { name: string; value: string }[]): Buffer {
        const parts: Buffer[] = []
        for (const f of fields) {
            parts.push(
                Buffer.from(
                    `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`,
                    'utf8'
                )
            )
        }
        parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
        return Buffer.concat(parts)
    }

    private parseKblobRedirect(data: unknown): string | null {
        try {
            const obj = typeof data === 'string' ? JSON.parse(data) : data
            const url = (obj as { redirectUrl?: unknown })?.redirectUrl
            if (typeof url === 'string' && url.includes('bcid=')) return url
        } catch {}

        if (typeof data === 'string') {
            const m = data.match(/"redirectUrl"\s*:\s*"([^"]+)"/)
            const raw = m?.[1]
            if (raw && raw.includes('bcid=')) return raw.replace(/\\u002f/gi, '/').replace(/\\\//g, '/')
        }
        return null
    }
}
