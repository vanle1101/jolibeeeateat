import { AsyncLocalStorage } from 'node:async_hooks'
import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import pkg from '../package.json'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtils from './browser/BrowserUtils'
import ReactFunc from './browser/ReactFunc'
import type { PageSnapshot } from './browser/ReactFunc'

import { IpcLog, Logger } from './logging/Logger'
import Utils, { isBrowserClosedError } from './util/Utils'
import { loadAccounts, loadConfig, getProjectRoot } from './util/Load'
import { closeSessionStore } from './util/SessionStore'
import { checkNodeVersion } from './util/Validator'
import { buildProxyAwareChunks, groupAccountsByProxy } from './util/ProxyScheduler'
import { disableAccountInDatabase } from './util/AccountDatabase'
import { isAccountUnusableError, type AccountUnusableError } from './util/AccountLifecycle'
import {
    deriveMobileDeviceIdentity,
    buildAppUserAgent,
    extractChromeVersion,
    type MobileDeviceIdentity
} from './browser/DeviceIdentity'
import { resolveGeoProfile } from './browser/GeoProfile'
import { CLOUDFLARE_TRACE_URL, parseCloudflareTrace, evaluateProxyIdentity } from './util/ProxyVerify'

import { Login } from './browser/auth/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'
import { SearchManager } from './functions/SearchManager'
import { PunchcardManager } from './functions/PunchcardManager'

import type { Account } from './interface/Account'
import HttpClient from './util/Http'
import { sendDiscord, flushDiscordQueue } from './logging/Discord'
import { sendNtfy, flushNtfyQueue } from './logging/Ntfy'
import { sendTelegram, flushTelegramQueue } from './logging/Telegram'
import type { DashboardData } from './interface/DashboardData'
import type { AppDashboardData } from './interface/AppDashBoardData'

interface ExecutionContext {
    isMobile: boolean
    account: Account
}

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
}

export interface PointCheckResult {
    accountId: string | null
    email: string
    points: number
    lifetimePoints: number | null
    lifetimePointsRedeemed: number | null
    country: string | null
    checkedAt: string
}

const executionContext = new AsyncLocalStorage<ExecutionContext>()

export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) {
        return { isMobile: false, account: {} as Account }
    }
    return context
}

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([flushDiscordQueue(timeoutMs), flushNtfyQueue(timeoutMs), flushTelegramQueue(timeoutMs)])
    closeSessionStore()
}

interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    timezoneOffset: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
}

export class MicrosoftRewardsBot {
    public logger: Logger
    public config
    public utils: Utils
    public activities: Activities = new Activities(this)
    public browser: { func: BrowserFunc; utils: BrowserUtils; react: ReactFunc }

    public mainMobilePage!: Page
    public mainDesktopPage!: Page

    public userData: UserData

    public nextActions: Record<string, string> = {}
    public nextRouterStateTree = ''
    public reactSnapshot: PageSnapshot | null = null

    public accessToken = ''
    // Stable per-account Android device identity; drives the browser UA and every
    // app/platform call so one account == one consistent phone. Set per account
    // in runTasks (see deriveMobileDeviceIdentity).
    public mobileDevice: MobileDeviceIdentity = deriveMobileDeviceIdentity({ email: 'default', accountId: undefined })
    // Bing Sapphire (Android) app user-agent for the current account, aligned to
    // the browser session's Chromium version. Computed once per account in Main.
    public appUserAgent = ''
    public cookies: { mobile: Cookie[]; desktop: Cookie[] }
    private fingerprintMobile?: BrowserFingerprintWithHeaders
    private fingerprintDesktop?: BrowserFingerprintWithHeaders

    get fingerprint(): BrowserFingerprintWithHeaders {
        const ctx = this.isMobile ? this.fingerprintMobile : this.fingerprintDesktop
        return (ctx ?? this.fingerprintMobile ?? this.fingerprintDesktop) as BrowserFingerprintWithHeaders
    }

    private activeWorkers: number
    private exitedWorkers: number[]
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    public workers: Workers
    private searchManager: SearchManager
    private punchcardManager: PunchcardManager
    private login = new Login(this)

    public http!: HttpClient

    constructor() {
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            timezoneOffset: '60',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0
        }
        this.logger = new Logger(this)
        this.accounts = []
        this.cookies = { mobile: [], desktop: [] }
        this.utils = new Utils()
        this.workers = new Workers(this)
        this.searchManager = new SearchManager(this)
        this.punchcardManager = new PunchcardManager(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtils(this),
            react: new ReactFunc(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
        this.exitedWorkers = []
    }

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    get currentAccountEmail(): string | null {
        return getCurrentContext().account?.email || null
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
        this.warnExperimental()
    }

    // Move to utils
    private warnExperimental(): void {
        const exp = this.config.experimental
        const enabled = [exp.apiSearch && 'apiSearch', exp.apiSearchOnBing && 'apiSearchOnBing'].filter(
            Boolean
        ) as string[]
        if (!enabled.length) return

        this.logger.warn(
            'main',
            'EXPERIMENTAL',
            `${enabled.join(' + ')} enabled - these perform searches over HTTP with no real browser. ` +
                `This path is EXPERIMENTAL and UNSAFE and may get your account flagged or banned. ` +
                `Disable it under config.experimental if you are unsure.`,
            'redBright'
        )
    }

    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        if (!cluster.isPrimary) {
            this.runWorker(runStartTime)
            return
        }

        const proxyRoutes = groupAccountsByProxy(this.accounts).length
        const accountChunks = buildProxyAwareChunks(this.accounts, this.config.clusters)
        const effectiveWorkers = accountChunks.length
        const concurrencyMode = this.config.clusters === 0 ? 'auto' : `max ${this.config.clusters}`

        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Proxy routes: ${proxyRoutes} | Workers: ${effectiveWorkers} (${concurrencyMode})`
        )

        if (effectiveWorkers > 1) {
            await this.runMaster(runStartTime, accountChunks)
        } else {
            await this.runTasks(this.accounts, runStartTime)
        }
    }

    private async runMaster(runStartTime: number, accountChunks: Account[][]): Promise<void> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`)

        this.activeWorkers = accountChunks.length

        const allAccountStats: AccountStats[] = []
        let hadWorkerFailure = false

        const onWorkerExit = async (worker: Worker, code?: number, signal?: string): Promise<void> => {
            const { pid } = worker.process

            if (!pid || this.exitedWorkers.includes(pid)) {
                return
            }

            this.exitedWorkers.push(pid)
            this.activeWorkers -= 1

            const failed = (code ?? 0) !== 0 || Boolean(signal)
            if (failed) {
                hadWorkerFailure = true
            }

            this.logger.warn(
                'main',
                'CLUSTER-WORKER-EXIT',
                `Worker ${pid} exit | Code: ${code ?? 'n/a'} | Signal: ${signal ?? 'n/a'} | Active workers: ${this.activeWorkers}`
            )

            if (this.activeWorkers <= 0) {
                const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
                const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
                const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
                const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                this.logger.info(
                    'main',
                    'RUN-END',
                    `Completed all accounts | accountsProcessed=${allAccountStats.length} | pointsGained=${totalCollectedPoints} | previousBalance=${totalInitialPoints} | currentBalance=${totalFinalPoints} | runtimeMinutes=${totalDurationMinutes}`,
                    'green'
                )

                await flushAllWebhooks()

                process.exit(hadWorkerFailure ? 1 : 0)
            }
        }

        cluster.on('disconnect', worker => {
            const pid = worker.process?.pid
            this.logger.warn('main', 'CLUSTER-WORKER-DISCONNECT', `Worker ${pid ?? '?'} disconnected`)
        })

        for (const [index, chunk] of accountChunks.entries()) {
            const worker = cluster.fork()

            worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[] }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
                }

                const log = msg.__ipcLog
                if (log && typeof log.content === 'string') {
                    const { webhook } = this.config
                    const { content, level } = log

                    if (webhook.discord?.enabled && webhook.discord.url) {
                        sendDiscord(webhook.discord.url, content, level)
                    }
                    if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                        sendNtfy(webhook.ntfy, content, level)
                    }
                    if (webhook.telegram?.enabled && webhook.telegram.botToken && webhook.telegram.chatId) {
                        sendTelegram(webhook.telegram, content, level)
                    }
                }
            })

            worker.once('exit', (code, signal) => {
                void onWorkerExit(worker, code ?? undefined, signal ?? undefined)
            })
            worker.send?.({ chunk, runStartTime })

            // Preserve the original stagger so several browser processes do not
            // hit CPU and memory at exactly the same moment.
            if (index !== accountChunks.length - 1) {
                await this.utils.wait(5000)
            }
        }
    }

    private runWorker(runStartTimeFromMaster?: number): void {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `Worker spawned | PID: ${process.pid}`)

        process.on('message', async ({ chunk, runStartTime }: { chunk: Account[]; runStartTime: number }) => {
            void this.logger.info(
                'main',
                'CLUSTER-WORKER-TASK',
                `Worker ${process.pid} received ${chunk.length} accounts.`
            )

            try {
                const stats = await this.runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now())

                if (process.send) {
                    process.send({ __stats: stats })
                }

                await flushAllWebhooks()
                process.exit(0)
            } catch (error) {
                this.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `Worker task crash: ${error instanceof Error ? error.message : String(error)}`
                )

                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        const accountStats: AccountStats[] = []

        for (const account of accounts) {
            const accountStartTime = Date.now()
            const accountEmail = account.email
            this.userData.userName = this.utils.getEmailUsername(accountEmail)
            this.userData.timezoneOffset = this.accountTimezoneOffset(account)
            this.userData.langCode = account.langCode ?? 'en'
            // Lock in this account's stable device identity for the whole run.
            this.mobileDevice = deriveMobileDeviceIdentity(account)
            this.appUserAgent = ''

            try {
                this.logger.info(
                    'main',
                    'ACCOUNT-START',
                    `Starting account: ${accountEmail} | geoLocale: ${account.geoLocale}`
                )

                this.http = new HttpClient(account.proxy)
                if (this.http.usesProxy) {
                    await this.http.assertProxyReady(true)
                    this.logger.info(
                        'main',
                        'PROXY',
                        'Proxy route verified for account; direct HTTP fallback is disabled'
                    )
                    await this.verifyProxyIdentity(account)
                }

                const result: { initialPoints: number; collectedPoints: number } | undefined = await this.Main(
                    account
                ).catch(async error => {
                    if (isAccountUnusableError(error)) {
                        await this.handleUnusableAccount(account, error)
                    } else {
                        void this.logger.error(
                            true,
                            'FLOW',
                            `Mobile flow failed for ${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                        )
                    }
                    return undefined
                })

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0
                    const accountInitialPoints = result.initialPoints ?? 0
                    const accountFinalPoints = accountInitialPoints + collectedPoints

                    accountStats.push({
                        email: accountEmail,
                        initialPoints: accountInitialPoints,
                        finalPoints: accountFinalPoints,
                        collectedPoints: collectedPoints,
                        duration: parseFloat(durationSeconds),
                        success: true
                    })

                    this.logger.info(
                        'main',
                        'ACCOUNT-END',
                        `Completed account: ${accountEmail} | pointsGained=${collectedPoints} | previousBalance=${accountInitialPoints} | currentBalance=${accountFinalPoints} | durationSeconds=${durationSeconds}`,
                        'green'
                    )
                } else {
                    accountStats.push({
                        email: accountEmail,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: 'Flow failed'
                    })
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                this.logger.error(
                    'main',
                    'ACCOUNT-ERROR',
                    `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                )

                accountStats.push({
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                })
            }
        }

        if (cluster.isPrimary) {
            const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

            this.logger.info(
                'main',
                'RUN-END',
                `Completed all accounts | accountsProcessed=${accountStats.length} | pointsGained=${totalCollectedPoints} | previousBalance=${totalInitialPoints} | currentBalance=${totalFinalPoints} | runtimeMinutes=${totalDurationMinutes}`,
                'green'
            )

            await flushAllWebhooks()
            process.exit(0)
        }

        return accountStats
    }

    /**
     * Verifies the proxy's REAL exit identity by tracing through it, then compares
     * the observed exit IP/country against the account's expectations. Catches
     * transparent, rotating, or wrong-country proxies before the account runs.
     * Behaviour on mismatch is governed by config.proxy.onProxyMismatch.
     */
    private async verifyProxyIdentity(account: Account): Promise<void> {
        const cfg = this.config.proxy
        if (!cfg?.verifyExitIp || !this.http.usesProxy) return

        let observedIp: string | undefined
        let observedCountry: string | undefined
        try {
            const res = await this.http.request<string>({
                url: CLOUDFLARE_TRACE_URL,
                method: 'GET',
                responseType: 'text',
                timeout: 12000
            })
            const trace = parseCloudflareTrace(String(res.data))
            observedIp = trace.ip
            observedCountry = trace.country
        } catch (error) {
            // A probe failure alone isn't proof of a bad proxy (assertProxyReady
            // already validated reachability) — warn and continue.
            this.logger.warn(
                'main',
                'PROXY-VERIFY',
                `Could not probe proxy exit identity, skipping check: ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        const expectedCountry =
            account.geoLocale && account.geoLocale.toLowerCase() !== 'auto' ? account.geoLocale : undefined
        const expectedIp = account.proxy.expectedEgressIp?.trim() || undefined

        const { mismatches } = evaluateProxyIdentity({ observedIp, observedCountry, expectedCountry, expectedIp })

        this.logger.info(
            'main',
            'PROXY-VERIFY',
            `Proxy exit | ip=${observedIp ?? '?'} | country=${observedCountry ?? '?'} | expectedCountry=${expectedCountry?.toUpperCase() ?? 'n/a'}${expectedIp ? ` | expectedIp=${expectedIp}` : ''}`
        )

        if (!mismatches.length) return

        const mode = cfg.onProxyMismatch ?? 'warn'
        const message = `Proxy identity mismatch for ${account.email}: ${mismatches.join('; ')}`
        if (mode === 'skip') {
            this.logger.error('main', 'PROXY-VERIFY', `${message} — skipping this account (proxy.onProxyMismatch=skip)`)
            throw new Error(message)
        }
        if (mode === 'warn') {
            this.logger.warn(
                'main',
                'PROXY-VERIFY',
                `${message} — continuing (set proxy.onProxyMismatch=skip to enforce)`
            )
        }
        // 'off' → observed exit already logged; take no further action
    }

    /**
     * The Rewards API `timezoneOffset` (sent in many activity payloads) must
     * reflect the account's country, not the host clock. Falls back to the host
     * offset when the country is unknown ('auto' before login / unsupported).
     */
    private accountTimezoneOffset(account: Account, resolvedCountry?: string): string {
        const seed = account.accountId?.trim() || account.email?.trim().toLowerCase() || 'default'
        const country =
            resolvedCountry ??
            (account.geoLocale && account.geoLocale.toLowerCase() !== 'auto' ? account.geoLocale : undefined)
        const geo = resolveGeoProfile(country, seed)
        return geo ? String(geo.timezoneOffsetMinutes) : String(new Date().getTimezoneOffset())
    }

    /**
     * Reacts to an account Microsoft reports as unusable (suspended/banned).
     * Depending on config.accountLifecycle it persists a 'disabled' status (or
     * hard-deletes the row) so the dead account is not re-attacked next run.
     * An 'error' level log doubles as the webhook alert.
     */
    private async handleUnusableAccount(account: Account, error: AccountUnusableError): Promise<void> {
        const email = account.email
        this.logger.error('main', 'ACCOUNT-UNUSABLE', `${email} is ${error.reason} | ${error.message}`)

        const lifecycle = this.config.accountLifecycle
        if (!lifecycle?.autoDisableSuspended || lifecycle.mode === 'off') {
            this.logger.warn(
                'main',
                'ACCOUNT-LIFECYCLE',
                `Auto-disable is off; ${email} will be retried next run (set accountLifecycle.mode in config.json to 'disable' or 'delete')`
            )
            return
        }

        try {
            const result = disableAccountInDatabase(getProjectRoot(), email, lifecycle.mode)
            if (result.persisted) {
                this.logger.info(
                    'main',
                    'ACCOUNT-LIFECYCLE',
                    result.mode === 'delete'
                        ? `Deleted ${email} from the accounts database and blocked re-import (reason: ${error.reason})`
                        : `Disabled ${email} in the accounts database; skipped on future runs (reason: ${error.reason})`,
                    'yellow'
                )
            } else if (!result.inDatabase) {
                this.logger.warn(
                    'main',
                    'ACCOUNT-LIFECYCLE',
                    `${email} is not stored in the accounts database (env-sourced?); cannot auto-${lifecycle.mode} — remove it manually`
                )
            } else {
                this.logger.debug('main', 'ACCOUNT-LIFECYCLE', `${email} was already disabled in the database`)
            }
        } catch (dbError) {
            this.logger.error(
                'main',
                'ACCOUNT-LIFECYCLE',
                `Failed to persist unusable status for ${email}: ${dbError instanceof Error ? dbError.message : String(dbError)}`
            )
        }
    }

    async createDesktopSession(account: Account): Promise<BrowserSession> {
        const session = await this.browserFactory.createBrowser(account)
        try {
            this.mainDesktopPage = await session.context.newPage()
            this.fingerprintDesktop = session.fingerprint

            this.logger.info(this.isMobile, 'BROWSER', `Desktop Browser started | ${account.email}`)

            await this.login.login(this.mainDesktopPage, account)
            this.cookies.desktop = await session.context.cookies()

            return session
        } catch (error) {
            await this.browser.func.closeBrowser(session.context, account.email, false).catch(() => {})
            throw error
        }
    }

    /**
     * Authenticate one account and read its Rewards balance only.
     * This path intentionally does not invoke activities, searches, claims,
     * punch cards, or any other point-earning worker.
     */
    async checkAccountPoints(account: Account): Promise<PointCheckResult> {
        const accountEmail = account.email
        this.userData.userName = this.utils.getEmailUsername(accountEmail)
        this.userData.timezoneOffset = this.accountTimezoneOffset(account)
        this.userData.langCode = account.langCode ?? 'en'
        this.browser.func.resetHttpJars()

        let session: BrowserSession | null = null
        let authenticated = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                this.http = new HttpClient(account.proxy)
                if (this.http.usesProxy) {
                    await this.http.assertProxyReady(true)
                }

                session = await this.browserFactory.createBrowser(account)
                this.mainMobilePage = await session.context.newPage()
                this.fingerprintMobile = session.fingerprint

                await this.login.login(this.mainMobilePage, account)
                authenticated = true
                this.cookies.mobile = await session.context.cookies()

                const data = await this.browser.func.getDashboardData(this.cookies.mobile)
                const status = data?.dashboard?.userStatus

                return {
                    accountId: account.accountId ?? null,
                    email: accountEmail,
                    points: status?.availablePoints ?? 0,
                    lifetimePoints: status?.lifetimePoints ?? null,
                    lifetimePointsRedeemed: status?.lifetimePointsRedeemed ?? null,
                    country: data?.dashboard?.userProfile?.attributes?.country ?? null,
                    checkedAt: new Date().toISOString()
                }
            })
        } finally {
            if (session) {
                await executionContext.run({ isMobile: true, account }, async () => {
                    await this.browser.func.closeBrowser(session!.context, accountEmail, authenticated)
                })
            }
        }
    }

    async Main(account: Account): Promise<{ initialPoints: number; collectedPoints: number }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`)

        // Drop cookies from previous account
        this.browser.func.resetHttpJars()

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false
        let mobileSessionAuthenticated = false
        let desktopSession: BrowserSession | null = null

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)
                mobileSessionAuthenticated = true

                try {
                    this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail)
                } catch (error) {
                    this.logger.error(
                        'main',
                        'FLOW',
                        `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`
                    )
                }

                this.cookies.mobile = await initialContext.cookies()
                this.fingerprintMobile = mobileSession.fingerprint

                // Align the app (Bing Sapphire Android) user-agent with the same
                // device + Chromium version the browser session reports.
                this.appUserAgent = buildAppUserAgent(
                    this.mobileDevice,
                    extractChromeVersion(mobileSession.fingerprint.fingerprint.navigator.userAgent)
                )
                this.logger.debug('main', 'DEVICE-IDENTITY', `App UA: ${this.appUserAgent}`)

                const data: DashboardData = await this.browser.func.getDashboardData()

                // The app/platform endpoints require a valid mobile OAuth token.
                // A transient token failure must only disable the app-reward path,
                // never abort the whole mobile run (which also does browser searches).
                let appData: AppDashboardData | null = null
                if (this.accessToken) {
                    appData = await this.browser.func.getAppDashboardData().catch(error => {
                        this.logger.warn(
                            'main',
                            'FLOW',
                            `App dashboard unavailable; app rewards will be skipped: ${error instanceof Error ? error.message : String(error)}`
                        )
                        return null
                    })
                } else {
                    this.logger.warn(
                        'main',
                        'FLOW',
                        'Mobile access token missing; skipping app dashboard and app promotions for this account'
                    )
                }
                void appData

                this.userData.geoLocale =
                    account.geoLocale === 'auto'
                        ? (data?.dashboard?.userProfile?.attributes?.country ?? 'us')
                        : account.geoLocale.toLowerCase()
                if (this.userData.geoLocale.length > 2) {
                    this.logger.warn(
                        'main',
                        'GEO-LOCALE',
                        `The provided geoLocale is longer than 2 (${this.userData.geoLocale} | auto=${account.geoLocale === 'auto'}), this is likely invalid and can cause errors!`
                    )
                }

                // Now that the account's country is known, re-derive the Rewards API
                // timezoneOffset from it (covers 'auto' accounts whose country was
                // only revealed by the dashboard).
                this.userData.timezoneOffset = this.accountTimezoneOffset(account, this.userData.geoLocale)

                this.userData.initialPoints = data.dashboard.userStatus.availablePoints
                this.userData.currentPoints = data.dashboard.userStatus.availablePoints
                const initialPoints = this.userData.initialPoints ?? 0

                // Drain rewards that were already waiting before this run. A
                // second pass after all activities catches rewards that become
                // ready while the account is earning points.
                if (this.config.workers.doClaimBonusPoints) await this.workers.doClaimBonusPoints()

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints()
                const appEarnable = this.accessToken
                    ? await this.browser.func.getAppEarnablePoints().catch(error => {
                          this.logger.warn(
                              'main',
                              'FLOW',
                              `App earnable points unavailable: ${error instanceof Error ? error.message : String(error)}`
                          )
                          return null
                      })
                    : null

                const pointsCanCollect = browserEarnable.mobileSearchPoints + (appEarnable?.totalEarnablePoints ?? 0)

                this.logger.info(
                    'main',
                    'POINTS',
                    `Earnable today | Mobile: ${pointsCanCollect} | Browser: ${
                        browserEarnable.mobileSearchPoints
                    } | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${this.userData.geoLocale}`
                )

                const apiSearch = this.config.experimental.apiSearch
                const apiSearchOnBing = this.config.experimental.apiSearchOnBing
                const parallel = this.config.searchSettings.parallelSearching
                const doBonus = this.config.workers.doBonusSearches
                const doVisualSearch = this.config.workers.doVisualSearch

                const fullApi = apiSearch && (apiSearchOnBing || !this.config.activities.searchOnBing)

                let mobilePoints = 0
                let desktopPoints = 0
                let bonusPoints = 0

                if (fullApi) {
                    if (this.config.ensureStreakProtection) {
                        await this.activities.doEnsureStreakProtection()
                    }
                    if (this.config.workers.doPunchCards) await this.punchcardManager.runMobile(data)
                    if (this.config.workers.doActivateSearchPerk) await this.activities.doActivateSearchPerk(data)

                    const plan = await this.searchManager.getSearchPoints()
                    const doMobileSearch = plan.doMobile
                    const doDesktopSearch = plan.doDesktop
                    const desktopNeeded = this.config.workers.doPunchCards || doDesktopSearch || doVisualSearch

                    this.cookies.mobile = await initialContext.cookies()
                    await this.browser.func.closeBrowser(initialContext, accountEmail)
                    mobileContextClosed = true

                    if (desktopNeeded) {
                        await executionContext.run({ isMobile: false, account }, async () => {
                            desktopSession = await this.createDesktopSession(account)
                            await this.punchcardManager.runDesktop()
                            if (doVisualSearch) await this.activities.doVisualSearch()
                        })

                        await executionContext.run({ isMobile: false, account }, async () => {
                            await this.browser.func.closeBrowser(desktopSession!.context, accountEmail)
                        })
                        desktopSession = null
                    }

                    if (this.config.workers.doDailySet) await this.workers.doDailySet(data)
                    if (this.config.workers.doMorePromotions) await this.workers.doMorePromotions(data)
                    if (this.config.workers.doDailyCheckIn) await this.activities.doDailyCheckIn()
                    if (this.config.workers.doAppPromotions) await this.workers.doAppPromotions(appData)
                    if (this.config.workers.doReadToEarn) await this.activities.doReadToEarn()

                    if (doMobileSearch) mobilePoints = await this.searchManager.searchMobile(account)
                    if (doBonus) bonusPoints = await this.searchManager.bonusMobile(account)
                    if (doDesktopSearch) desktopPoints = await this.searchManager.searchDesktop(account)
                } else {
                    if (this.config.ensureStreakProtection) {
                        await this.activities.doEnsureStreakProtection()
                    }
                    if (this.config.workers.doDailySet) await this.workers.doDailySet(data)
                    if (this.config.workers.doActivateSearchPerk) await this.activities.doActivateSearchPerk(data)
                    if (this.config.workers.doMorePromotions) await this.workers.doMorePromotions(data)
                    if (this.config.workers.doDailyCheckIn) await this.activities.doDailyCheckIn()
                    if (this.config.workers.doAppPromotions) await this.workers.doAppPromotions(appData)
                    if (this.config.workers.doReadToEarn) await this.activities.doReadToEarn()
                    if (this.config.workers.doPunchCards) await this.punchcardManager.runMobile(data)

                    const plan = await this.searchManager.getSearchPoints()
                    const doMobileSearch = plan.doMobile
                    const doDesktopSearch = plan.doDesktop

                    const desktopNeeded = this.config.workers.doPunchCards || doDesktopSearch || doVisualSearch

                    if (parallel && !apiSearch && doMobileSearch && doDesktopSearch) {
                        if (desktopNeeded) {
                            await executionContext.run({ isMobile: false, account }, async () => {
                                desktopSession = await this.createDesktopSession(account)
                                await this.punchcardManager.runDesktop()
                                if (doVisualSearch) await this.activities.doVisualSearch()
                            })
                        }

                        ;[mobilePoints, desktopPoints] = await Promise.all([
                            this.searchManager.searchMobile(account),
                            this.searchManager.searchDesktop(account)
                        ])

                        if (doBonus) bonusPoints = await this.searchManager.bonusMobile(account)

                        this.cookies.mobile = await initialContext.cookies()
                        await this.browser.func.closeBrowser(initialContext, accountEmail)
                        mobileContextClosed = true

                        if (desktopSession) {
                            await executionContext.run({ isMobile: false, account }, async () => {
                                await this.browser.func.closeBrowser(desktopSession!.context, accountEmail)
                            })
                            desktopSession = null
                        }
                    } else {
                        if (apiSearch) {
                            this.cookies.mobile = await initialContext.cookies()
                            await this.browser.func.closeBrowser(initialContext, accountEmail)
                            mobileContextClosed = true

                            if (doMobileSearch) mobilePoints = await this.searchManager.searchMobile(account)
                            if (doBonus) bonusPoints = await this.searchManager.bonusMobile(account)
                        } else {
                            if (doMobileSearch) mobilePoints = await this.searchManager.searchMobile(account)
                            if (doBonus) bonusPoints = await this.searchManager.bonusMobile(account)

                            this.cookies.mobile = await initialContext.cookies()
                            await this.browser.func.closeBrowser(initialContext, accountEmail)
                            mobileContextClosed = true
                        }

                        if (desktopNeeded) {
                            await executionContext.run({ isMobile: false, account }, async () => {
                                desktopSession = await this.createDesktopSession(account)

                                await this.punchcardManager.runDesktop()
                                if (doVisualSearch) await this.activities.doVisualSearch()
                                if (doDesktopSearch && !apiSearch) {
                                    desktopPoints = await this.searchManager.searchDesktop(account)
                                }
                            })

                            await executionContext.run({ isMobile: false, account }, async () => {
                                await this.browser.func.closeBrowser(desktopSession!.context, accountEmail)
                            })
                            desktopSession = null

                            if (doDesktopSearch && apiSearch) {
                                desktopPoints = await this.searchManager.searchDesktop(account)
                            }
                        }
                    }
                }

                this.logger.info(
                    'main',
                    'SEARCH-MANAGER',
                    `Search summary | mobile=${mobilePoints} | desktop=${desktopPoints} | bonus=${bonusPoints} | total=${
                        mobilePoints + desktopPoints + bonusPoints
                    }`
                )

                if (this.config.workers.doClaimBonusPoints) await this.workers.doClaimBonusPoints()

                const finalPoints = await this.browser.func.getCurrentPoints()
                const collectedPoints = finalPoints - initialPoints

                this.logger.info(
                    'main',
                    'FLOW',
                    `Points collected | pointsGained=${collectedPoints} | currentBalance=${finalPoints} | account=${accountEmail}`
                )

                return {
                    initialPoints,
                    collectedPoints: collectedPoints || 0
                }
            })
        } finally {
            if (mobileSession && !mobileContextClosed) {
                try {
                    await executionContext.run({ isMobile: true, account }, async () => {
                        await this.browser.func.closeBrowser(
                            mobileSession!.context,
                            accountEmail,
                            mobileSessionAuthenticated
                        )
                    })
                } catch (error) {
                    this.logger.debug(
                        'main',
                        'CLEANUP',
                        `Mobile context close failed | ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }

            if (desktopSession) {
                try {
                    await executionContext.run({ isMobile: false, account }, async () => {
                        await this.browser.func.closeBrowser(desktopSession!.context, accountEmail)
                    })
                } catch (error) {
                    this.logger.debug(
                        'main',
                        'CLEANUP',
                        `Desktop context close failed | ${error instanceof Error ? error.message : String(error)}`
                    )
                }
                desktopSession = null
            }
        }
    }
}

export { executionContext }

async function main(): Promise<void> {
    checkNodeVersion()
    const rewardsBot = new MicrosoftRewardsBot()

    process.on('beforeExit', () => {
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, flushing and exiting...')
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, flushing and exiting...')
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        if (isBrowserClosedError(error)) {
            rewardsBot.logger.debug(
                'main',
                'UNCAUGHT-EXCEPTION',
                `Ignoring benign browser-closed error during teardown | ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        if (isBrowserClosedError(reason)) {
            rewardsBot.logger.debug(
                'main',
                'UNHANDLED-REJECTION',
                `Ignoring benign browser-closed rejection during teardown | ${reason instanceof Error ? reason.message : String(reason)}`
            )
            return
        }
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
    }
}

if (require.main === module) {
    main().catch(async error => {
        const tmpBot = new MicrosoftRewardsBot()
        tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
        await flushAllWebhooks()
        process.exit(1)
    })
}
