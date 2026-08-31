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
exports.executionContext = exports.MicrosoftRewardsBot = void 0;
exports.getCurrentContext = getCurrentContext;
const node_async_hooks_1 = require("node:async_hooks");
const cluster_1 = __importDefault(require("cluster"));
const package_json_1 = __importDefault(require("../package.json"));
const Browser_1 = __importDefault(require("./browser/Browser"));
const BrowserFunc_1 = __importDefault(require("./browser/BrowserFunc"));
const BrowserUtils_1 = __importDefault(require("./browser/BrowserUtils"));
const ReactFunc_1 = __importDefault(require("./browser/ReactFunc"));
const Logger_1 = require("./logging/Logger");
const Utils_1 = __importStar(require("./util/Utils"));
const Load_1 = require("./util/Load");
const SessionStore_1 = require("./util/SessionStore");
const Validator_1 = require("./util/Validator");
const ProxyScheduler_1 = require("./util/ProxyScheduler");
const AccountDatabase_1 = require("./util/AccountDatabase");
const AccountLifecycle_1 = require("./util/AccountLifecycle");
const DeviceIdentity_1 = require("./browser/DeviceIdentity");
const GeoProfile_1 = require("./browser/GeoProfile");
const ProxyVerify_1 = require("./util/ProxyVerify");
const Login_1 = require("./browser/auth/Login");
const Workers_1 = require("./functions/Workers");
const Activities_1 = __importDefault(require("./functions/Activities"));
const SearchManager_1 = require("./functions/SearchManager");
const PunchcardManager_1 = require("./functions/PunchcardManager");
const Http_1 = __importDefault(require("./util/Http"));
const Discord_1 = require("./logging/Discord");
const Ntfy_1 = require("./logging/Ntfy");
const Telegram_1 = require("./logging/Telegram");
const executionContext = new node_async_hooks_1.AsyncLocalStorage();
exports.executionContext = executionContext;
function getCurrentContext() {
    const context = executionContext.getStore();
    if (!context) {
        return { isMobile: false, account: {} };
    }
    return context;
}
async function flushAllWebhooks(timeoutMs = 5000) {
    await Promise.allSettled([(0, Discord_1.flushDiscordQueue)(timeoutMs), (0, Ntfy_1.flushNtfyQueue)(timeoutMs), (0, Telegram_1.flushTelegramQueue)(timeoutMs)]);
    (0, SessionStore_1.closeSessionStore)();
}
class MicrosoftRewardsBot {
    logger;
    config;
    utils;
    activities = new Activities_1.default(this);
    browser;
    mainMobilePage;
    mainDesktopPage;
    userData;
    nextActions = {};
    nextRouterStateTree = '';
    reactSnapshot = null;
    accessToken = '';
    // Stable per-account Android device identity; drives the browser UA and every
    // app/platform call so one account == one consistent phone. Set per account
    // in runTasks (see deriveMobileDeviceIdentity).
    mobileDevice = (0, DeviceIdentity_1.deriveMobileDeviceIdentity)({ email: 'default', accountId: undefined });
    // Bing Sapphire (Android) app user-agent for the current account, aligned to
    // the browser session's Chromium version. Computed once per account in Main.
    appUserAgent = '';
    cookies;
    fingerprintMobile;
    fingerprintDesktop;
    get fingerprint() {
        const ctx = this.isMobile ? this.fingerprintMobile : this.fingerprintDesktop;
        return (ctx ?? this.fingerprintMobile ?? this.fingerprintDesktop);
    }
    activeWorkers;
    exitedWorkers;
    browserFactory = new Browser_1.default(this);
    accounts;
    workers;
    searchManager;
    punchcardManager;
    login = new Login_1.Login(this);
    http;
    constructor() {
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            timezoneOffset: '60',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0
        };
        this.logger = new Logger_1.Logger(this);
        this.accounts = [];
        this.cookies = { mobile: [], desktop: [] };
        this.utils = new Utils_1.default();
        this.workers = new Workers_1.Workers(this);
        this.searchManager = new SearchManager_1.SearchManager(this);
        this.punchcardManager = new PunchcardManager_1.PunchcardManager(this);
        this.browser = {
            func: new BrowserFunc_1.default(this),
            utils: new BrowserUtils_1.default(this),
            react: new ReactFunc_1.default(this)
        };
        this.config = (0, Load_1.loadConfig)();
        this.activeWorkers = this.config.clusters;
        this.exitedWorkers = [];
    }
    get isMobile() {
        return getCurrentContext().isMobile;
    }
    get currentAccountEmail() {
        return getCurrentContext().account?.email || null;
    }
    async initialize() {
        this.accounts = (0, Load_1.loadAccounts)();
        this.warnExperimental();
    }
    // Move to utils
    warnExperimental() {
        const exp = this.config.experimental;
        const enabled = [exp.apiSearch && 'apiSearch', exp.apiSearchOnBing && 'apiSearchOnBing'].filter(Boolean);
        if (!enabled.length)
            return;
        this.logger.warn('main', 'EXPERIMENTAL', `${enabled.join(' + ')} enabled - these perform searches over HTTP with no real browser. ` +
            `This path is EXPERIMENTAL and UNSAFE and may get your account flagged or banned. ` +
            `Disable it under config.experimental if you are unsure.`, 'redBright');
    }
    async run() {
        const totalAccounts = this.accounts.length;
        const runStartTime = Date.now();
        if (!cluster_1.default.isPrimary) {
            this.runWorker(runStartTime);
            return;
        }
        const proxyRoutes = (0, ProxyScheduler_1.groupAccountsByProxy)(this.accounts).length;
        const accountChunks = (0, ProxyScheduler_1.buildProxyAwareChunks)(this.accounts, this.config.clusters);
        const effectiveWorkers = accountChunks.length;
        const concurrencyMode = this.config.clusters === 0 ? 'auto' : `max ${this.config.clusters}`;
        this.logger.info('main', 'RUN-START', `Starting Microsoft Rewards Script | v${package_json_1.default.version} | Accounts: ${totalAccounts} | Proxy routes: ${proxyRoutes} | Workers: ${effectiveWorkers} (${concurrencyMode})`);
        if (effectiveWorkers > 1) {
            await this.runMaster(runStartTime, accountChunks);
        }
        else {
            await this.runTasks(this.accounts, runStartTime);
        }
    }
    async runMaster(runStartTime, accountChunks) {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`);
        this.activeWorkers = accountChunks.length;
        const allAccountStats = [];
        let hadWorkerFailure = false;
        const onWorkerExit = async (worker, code, signal) => {
            const { pid } = worker.process;
            if (!pid || this.exitedWorkers.includes(pid)) {
                return;
            }
            this.exitedWorkers.push(pid);
            this.activeWorkers -= 1;
            const failed = (code ?? 0) !== 0 || Boolean(signal);
            if (failed) {
                hadWorkerFailure = true;
            }
            this.logger.warn('main', 'CLUSTER-WORKER-EXIT', `Worker ${pid} exit | Code: ${code ?? 'n/a'} | Signal: ${signal ?? 'n/a'} | Active workers: ${this.activeWorkers}`);
            if (this.activeWorkers <= 0) {
                const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0);
                const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0);
                const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0);
                const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1);
                this.logger.info('main', 'RUN-END', `Completed all accounts | accountsProcessed=${allAccountStats.length} | pointsGained=${totalCollectedPoints} | previousBalance=${totalInitialPoints} | currentBalance=${totalFinalPoints} | runtimeMinutes=${totalDurationMinutes}`, 'green');
                await flushAllWebhooks();
                process.exit(hadWorkerFailure ? 1 : 0);
            }
        };
        cluster_1.default.on('disconnect', worker => {
            const pid = worker.process?.pid;
            this.logger.warn('main', 'CLUSTER-WORKER-DISCONNECT', `Worker ${pid ?? '?'} disconnected`);
        });
        for (const [index, chunk] of accountChunks.entries()) {
            const worker = cluster_1.default.fork();
            worker.on('message', (msg) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats);
                }
                const log = msg.__ipcLog;
                if (log && typeof log.content === 'string') {
                    const { webhook } = this.config;
                    const { content, level } = log;
                    if (webhook.discord?.enabled && webhook.discord.url) {
                        (0, Discord_1.sendDiscord)(webhook.discord.url, content, level);
                    }
                    if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                        (0, Ntfy_1.sendNtfy)(webhook.ntfy, content, level);
                    }
                    if (webhook.telegram?.enabled && webhook.telegram.botToken && webhook.telegram.chatId) {
                        (0, Telegram_1.sendTelegram)(webhook.telegram, content, level);
                    }
                }
            });
            worker.once('exit', (code, signal) => {
                void onWorkerExit(worker, code ?? undefined, signal ?? undefined);
            });
            worker.send?.({ chunk, runStartTime });
            // Preserve the original stagger so several browser processes do not
            // hit CPU and memory at exactly the same moment.
            if (index !== accountChunks.length - 1) {
                await this.utils.wait(5000);
            }
        }
    }
    runWorker(runStartTimeFromMaster) {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `Worker spawned | PID: ${process.pid}`);
        process.on('message', async ({ chunk, runStartTime }) => {
            void this.logger.info('main', 'CLUSTER-WORKER-TASK', `Worker ${process.pid} received ${chunk.length} accounts.`);
            try {
                const stats = await this.runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now());
                if (process.send) {
                    process.send({ __stats: stats });
                }
                await flushAllWebhooks();
                process.exit(0);
            }
            catch (error) {
                this.logger.error('main', 'CLUSTER-WORKER-ERROR', `Worker task crash: ${error instanceof Error ? error.message : String(error)}`);
                await flushAllWebhooks();
                process.exit(1);
            }
        });
    }
    async runTasks(accounts, runStartTime) {
        const accountStats = [];
        for (const account of accounts) {
            const accountStartTime = Date.now();
            const accountEmail = account.email;
            this.userData.userName = this.utils.getEmailUsername(accountEmail);
            this.userData.timezoneOffset = this.accountTimezoneOffset(account);
            this.userData.langCode = account.langCode ?? 'en';
            // Lock in this account's stable device identity for the whole run.
            this.mobileDevice = (0, DeviceIdentity_1.deriveMobileDeviceIdentity)(account);
            this.appUserAgent = '';
            try {
                this.logger.info('main', 'ACCOUNT-START', `Starting account: ${accountEmail} | geoLocale: ${account.geoLocale}`);
                this.http = new Http_1.default(account.proxy);
                if (this.http.usesProxy) {
                    await this.http.assertProxyReady(true);
                    this.logger.info('main', 'PROXY', 'Proxy route verified for account; direct HTTP fallback is disabled');
                    await this.verifyProxyIdentity(account);
                }
                const result = await this.Main(account).catch(async (error) => {
                    if ((0, AccountLifecycle_1.isAccountUnusableError)(error)) {
                        await this.handleUnusableAccount(account, error);
                    }
                    else {
                        void this.logger.error(true, 'FLOW', `Mobile flow failed for ${accountEmail}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                    return undefined;
                });
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1);
                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0;
                    const accountInitialPoints = result.initialPoints ?? 0;
                    const accountFinalPoints = accountInitialPoints + collectedPoints;
                    accountStats.push({
                        email: accountEmail,
                        initialPoints: accountInitialPoints,
                        finalPoints: accountFinalPoints,
                        collectedPoints: collectedPoints,
                        duration: parseFloat(durationSeconds),
                        success: true
                    });
                    this.logger.info('main', 'ACCOUNT-END', `Completed account: ${accountEmail} | pointsGained=${collectedPoints} | previousBalance=${accountInitialPoints} | currentBalance=${accountFinalPoints} | durationSeconds=${durationSeconds}`, 'green');
                }
                else {
                    accountStats.push({
                        email: accountEmail,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: 'Flow failed'
                    });
                }
            }
            catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1);
                this.logger.error('main', 'ACCOUNT-ERROR', `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`);
                accountStats.push({
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
        if (cluster_1.default.isPrimary) {
            const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0);
            const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0);
            const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0);
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1);
            this.logger.info('main', 'RUN-END', `Completed all accounts | accountsProcessed=${accountStats.length} | pointsGained=${totalCollectedPoints} | previousBalance=${totalInitialPoints} | currentBalance=${totalFinalPoints} | runtimeMinutes=${totalDurationMinutes}`, 'green');
            await flushAllWebhooks();
            process.exit(0);
        }
        return accountStats;
    }
    /**
     * Verifies the proxy's REAL exit identity by tracing through it, then compares
     * the observed exit IP/country against the account's expectations. Catches
     * transparent, rotating, or wrong-country proxies before the account runs.
     * Behaviour on mismatch is governed by config.proxy.onProxyMismatch.
     */
    async verifyProxyIdentity(account) {
        const cfg = this.config.proxy;
        if (!cfg?.verifyExitIp || !this.http.usesProxy)
            return;
        let observedIp;
        let observedCountry;
        try {
            const res = await this.http.request({
                url: ProxyVerify_1.CLOUDFLARE_TRACE_URL,
                method: 'GET',
                responseType: 'text',
                timeout: 12000
            });
            const trace = (0, ProxyVerify_1.parseCloudflareTrace)(String(res.data));
            observedIp = trace.ip;
            observedCountry = trace.country;
        }
        catch (error) {
            // A probe failure alone isn't proof of a bad proxy (assertProxyReady
            // already validated reachability) — warn and continue.
            this.logger.warn('main', 'PROXY-VERIFY', `Could not probe proxy exit identity, skipping check: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const expectedCountry = account.geoLocale && account.geoLocale.toLowerCase() !== 'auto' ? account.geoLocale : undefined;
        const expectedIp = account.proxy.expectedEgressIp?.trim() || undefined;
        const { mismatches } = (0, ProxyVerify_1.evaluateProxyIdentity)({ observedIp, observedCountry, expectedCountry, expectedIp });
        this.logger.info('main', 'PROXY-VERIFY', `Proxy exit | ip=${observedIp ?? '?'} | country=${observedCountry ?? '?'} | expectedCountry=${expectedCountry?.toUpperCase() ?? 'n/a'}${expectedIp ? ` | expectedIp=${expectedIp}` : ''}`);
        if (!mismatches.length)
            return;
        const mode = cfg.onProxyMismatch ?? 'warn';
        const message = `Proxy identity mismatch for ${account.email}: ${mismatches.join('; ')}`;
        if (mode === 'skip') {
            this.logger.error('main', 'PROXY-VERIFY', `${message} — skipping this account (proxy.onProxyMismatch=skip)`);
            throw new Error(message);
        }
        if (mode === 'warn') {
            this.logger.warn('main', 'PROXY-VERIFY', `${message} — continuing (set proxy.onProxyMismatch=skip to enforce)`);
        }
        // 'off' → observed exit already logged; take no further action
    }
    /**
     * The Rewards API `timezoneOffset` (sent in many activity payloads) must
     * reflect the account's country, not the host clock. Falls back to the host
     * offset when the country is unknown ('auto' before login / unsupported).
     */
    accountTimezoneOffset(account, resolvedCountry) {
        const seed = account.accountId?.trim() || account.email?.trim().toLowerCase() || 'default';
        const country = resolvedCountry ??
            (account.geoLocale && account.geoLocale.toLowerCase() !== 'auto' ? account.geoLocale : undefined);
        const geo = (0, GeoProfile_1.resolveGeoProfile)(country, seed);
        return geo ? String(geo.timezoneOffsetMinutes) : String(new Date().getTimezoneOffset());
    }
    /**
     * Reacts to an account Microsoft reports as unusable (suspended/banned).
     * Depending on config.accountLifecycle it persists a 'disabled' status (or
     * hard-deletes the row) so the dead account is not re-attacked next run.
     * An 'error' level log doubles as the webhook alert.
     */
    async handleUnusableAccount(account, error) {
        const email = account.email;
        this.logger.error('main', 'ACCOUNT-UNUSABLE', `${email} is ${error.reason} | ${error.message}`);
        const lifecycle = this.config.accountLifecycle;
        if (!lifecycle?.autoDisableSuspended || lifecycle.mode === 'off') {
            this.logger.warn('main', 'ACCOUNT-LIFECYCLE', `Auto-disable is off; ${email} will be retried next run (set accountLifecycle.mode in config.json to 'disable' or 'delete')`);
            return;
        }
        try {
            const result = (0, AccountDatabase_1.disableAccountInDatabase)((0, Load_1.getProjectRoot)(), email, lifecycle.mode);
            if (result.persisted) {
                this.logger.info('main', 'ACCOUNT-LIFECYCLE', result.mode === 'delete'
                    ? `Deleted ${email} from the accounts database and blocked re-import (reason: ${error.reason})`
                    : `Disabled ${email} in the accounts database; skipped on future runs (reason: ${error.reason})`, 'yellow');
            }
            else if (!result.inDatabase) {
                this.logger.warn('main', 'ACCOUNT-LIFECYCLE', `${email} is not stored in the accounts database (env-sourced?); cannot auto-${lifecycle.mode} — remove it manually`);
            }
            else {
                this.logger.debug('main', 'ACCOUNT-LIFECYCLE', `${email} was already disabled in the database`);
            }
        }
        catch (dbError) {
            this.logger.error('main', 'ACCOUNT-LIFECYCLE', `Failed to persist unusable status for ${email}: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
        }
    }
    async createDesktopSession(account) {
        const session = await this.browserFactory.createBrowser(account);
        try {
            this.mainDesktopPage = await session.context.newPage();
            this.fingerprintDesktop = session.fingerprint;
            this.logger.info(this.isMobile, 'BROWSER', `Desktop Browser started | ${account.email}`);
            await this.login.login(this.mainDesktopPage, account);
            this.cookies.desktop = await session.context.cookies();
            return session;
        }
        catch (error) {
            await this.browser.func.closeBrowser(session.context, account.email, false).catch(() => { });
            throw error;
        }
    }
    /**
     * Authenticate one account and read its Rewards balance only.
     * This path intentionally does not invoke activities, searches, claims,
     * punch cards, or any other point-earning worker.
     */
    async checkAccountPoints(account) {
        const accountEmail = account.email;
        this.userData.userName = this.utils.getEmailUsername(accountEmail);
        this.userData.timezoneOffset = this.accountTimezoneOffset(account);
        this.userData.langCode = account.langCode ?? 'en';
        this.browser.func.resetHttpJars();
        let session = null;
        let authenticated = false;
        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                this.http = new Http_1.default(account.proxy);
                if (this.http.usesProxy) {
                    await this.http.assertProxyReady(true);
                }
                session = await this.browserFactory.createBrowser(account);
                this.mainMobilePage = await session.context.newPage();
                this.fingerprintMobile = session.fingerprint;
                await this.login.login(this.mainMobilePage, account);
                authenticated = true;
                this.cookies.mobile = await session.context.cookies();
                const data = await this.browser.func.getDashboardData(this.cookies.mobile);
                const status = data?.dashboard?.userStatus;
                return {
                    accountId: account.accountId ?? null,
                    email: accountEmail,
                    points: status?.availablePoints ?? 0,
                    lifetimePoints: status?.lifetimePoints ?? null,
                    lifetimePointsRedeemed: status?.lifetimePointsRedeemed ?? null,
                    country: data?.dashboard?.userProfile?.attributes?.country ?? null,
                    checkedAt: new Date().toISOString()
                };
            });
        }
        finally {
            if (session) {
                await executionContext.run({ isMobile: true, account }, async () => {
                    await this.browser.func.closeBrowser(session.context, accountEmail, authenticated);
                });
            }
        }
    }
    async Main(account) {
        const accountEmail = account.email;
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`);
        // Drop cookies from previous account
        this.browser.func.resetHttpJars();
        let mobileSession = null;
        let mobileContextClosed = false;
        let mobileSessionAuthenticated = false;
        let desktopSession = null;
        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account);
                const initialContext = mobileSession.context;
                this.mainMobilePage = await initialContext.newPage();
                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`);
                await this.login.login(this.mainMobilePage, account);
                mobileSessionAuthenticated = true;
                try {
                    this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail);
                }
                catch (error) {
                    this.logger.error('main', 'FLOW', `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`);
                }
                this.cookies.mobile = await initialContext.cookies();
                this.fingerprintMobile = mobileSession.fingerprint;
                // Align the app (Bing Sapphire Android) user-agent with the same
                // device + Chromium version the browser session reports.
                this.appUserAgent = (0, DeviceIdentity_1.buildAppUserAgent)(this.mobileDevice, (0, DeviceIdentity_1.extractChromeVersion)(mobileSession.fingerprint.fingerprint.navigator.userAgent));
                this.logger.debug('main', 'DEVICE-IDENTITY', `App UA: ${this.appUserAgent}`);
                const data = await this.browser.func.getDashboardData();
                // The app/platform endpoints require a valid mobile OAuth token.
                // A transient token failure must only disable the app-reward path,
                // never abort the whole mobile run (which also does browser searches).
                let appData = null;
                if (this.accessToken) {
                    appData = await this.browser.func.getAppDashboardData().catch(error => {
                        this.logger.warn('main', 'FLOW', `App dashboard unavailable; app rewards will be skipped: ${error instanceof Error ? error.message : String(error)}`);
                        return null;
                    });
                }
                else {
                    this.logger.warn('main', 'FLOW', 'Mobile access token missing; skipping app dashboard and app promotions for this account');
                }
                void appData;
                this.userData.geoLocale =
                    account.geoLocale === 'auto'
                        ? (data?.dashboard?.userProfile?.attributes?.country ?? 'us')
                        : account.geoLocale.toLowerCase();
                if (this.userData.geoLocale.length > 2) {
                    this.logger.warn('main', 'GEO-LOCALE', `The provided geoLocale is longer than 2 (${this.userData.geoLocale} | auto=${account.geoLocale === 'auto'}), this is likely invalid and can cause errors!`);
                }
                // Now that the account's country is known, re-derive the Rewards API
                // timezoneOffset from it (covers 'auto' accounts whose country was
                // only revealed by the dashboard).
                this.userData.timezoneOffset = this.accountTimezoneOffset(account, this.userData.geoLocale);
                this.userData.initialPoints = data?.dashboard?.userStatus?.availablePoints ?? 0;
                this.userData.currentPoints = data?.dashboard?.userStatus?.availablePoints ?? 0;
                const initialPoints = this.userData.initialPoints ?? 0;
                // Drain rewards that were already waiting before this run. A
                // second pass after all activities catches rewards that become
                // ready while the account is earning points.
                if (this.config.workers.doClaimBonusPoints)
                    await this.workers.doClaimBonusPoints();
                const browserEarnable = await this.browser.func.getBrowserEarnablePoints();
                const appEarnable = this.accessToken
                    ? await this.browser.func.getAppEarnablePoints().catch(error => {
                        this.logger.warn('main', 'FLOW', `App earnable points unavailable: ${error instanceof Error ? error.message : String(error)}`);
                        return null;
                    })
                    : null;
                const pointsCanCollect = browserEarnable.mobileSearchPoints + (appEarnable?.totalEarnablePoints ?? 0);
                this.logger.info('main', 'POINTS', `Earnable today | Mobile: ${pointsCanCollect} | Browser: ${browserEarnable.mobileSearchPoints} | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${this.userData.geoLocale}`);
                const apiSearch = this.config.experimental.apiSearch;
                const apiSearchOnBing = this.config.experimental.apiSearchOnBing;
                const parallel = this.config.searchSettings.parallelSearching;
                const doBonus = this.config.workers.doBonusSearches;
                const doVisualSearch = this.config.workers.doVisualSearch;
                const fullApi = apiSearch && (apiSearchOnBing || !this.config.activities.searchOnBing);
                let mobilePoints = 0;
                let desktopPoints = 0;
                let bonusPoints = 0;
                if (fullApi) {
                    if (this.config.ensureStreakProtection) {
                        await this.activities.doEnsureStreakProtection();
                    }
                    if (this.config.workers.doPunchCards)
                        await this.punchcardManager.runMobile(data);
                    if (this.config.workers.doActivateSearchPerk)
                        await this.activities.doActivateSearchPerk(data);
                    const plan = await this.searchManager.getSearchPoints();
                    const doMobileSearch = plan.doMobile;
                    const doDesktopSearch = plan.doDesktop;
                    const desktopNeeded = this.config.workers.doPunchCards || doDesktopSearch || doVisualSearch;
                    this.cookies.mobile = await initialContext.cookies();
                    await this.browser.func.closeBrowser(initialContext, accountEmail);
                    mobileContextClosed = true;
                    if (desktopNeeded) {
                        await executionContext.run({ isMobile: false, account }, async () => {
                            desktopSession = await this.createDesktopSession(account);
                            await this.punchcardManager.runDesktop();
                            if (doVisualSearch)
                                await this.activities.doVisualSearch();
                        });
                        await executionContext.run({ isMobile: false, account }, async () => {
                            await this.browser.func.closeBrowser(desktopSession.context, accountEmail);
                        });
                        desktopSession = null;
                    }
                    if (this.config.workers.doDailySet)
                        await this.workers.doDailySet(data);
                    if (this.config.workers.doMorePromotions)
                        await this.workers.doMorePromotions(data);
                    if (this.config.workers.doDailyCheckIn)
                        await this.activities.doDailyCheckIn();
                    if (this.config.workers.doAppPromotions)
                        await this.workers.doAppPromotions(appData);
                    if (this.config.workers.doReadToEarn)
                        await this.activities.doReadToEarn();
                    if (doMobileSearch)
                        mobilePoints = await this.searchManager.searchMobile(account);
                    if (doBonus)
                        bonusPoints = await this.searchManager.bonusMobile(account);
                    if (doDesktopSearch)
                        desktopPoints = await this.searchManager.searchDesktop(account);
                }
                else {
                    if (this.config.ensureStreakProtection) {
                        await this.activities.doEnsureStreakProtection();
                    }
                    if (this.config.workers.doDailySet)
                        await this.workers.doDailySet(data);
                    if (this.config.workers.doActivateSearchPerk)
                        await this.activities.doActivateSearchPerk(data);
                    if (this.config.workers.doMorePromotions)
                        await this.workers.doMorePromotions(data);
                    if (this.config.workers.doDailyCheckIn)
                        await this.activities.doDailyCheckIn();
                    if (this.config.workers.doAppPromotions)
                        await this.workers.doAppPromotions(appData);
                    if (this.config.workers.doReadToEarn)
                        await this.activities.doReadToEarn();
                    if (this.config.workers.doPunchCards)
                        await this.punchcardManager.runMobile(data);
                    const plan = await this.searchManager.getSearchPoints();
                    const doMobileSearch = plan.doMobile;
                    const doDesktopSearch = plan.doDesktop;
                    const desktopNeeded = this.config.workers.doPunchCards || doDesktopSearch || doVisualSearch;
                    if (parallel && !apiSearch && doMobileSearch && doDesktopSearch) {
                        if (desktopNeeded) {
                            await executionContext.run({ isMobile: false, account }, async () => {
                                desktopSession = await this.createDesktopSession(account);
                                await this.punchcardManager.runDesktop();
                                if (doVisualSearch)
                                    await this.activities.doVisualSearch();
                            });
                        }
                        ;
                        [mobilePoints, desktopPoints] = await Promise.all([
                            this.searchManager.searchMobile(account),
                            this.searchManager.searchDesktop(account)
                        ]);
                        if (doBonus)
                            bonusPoints = await this.searchManager.bonusMobile(account);
                        this.cookies.mobile = await initialContext.cookies();
                        await this.browser.func.closeBrowser(initialContext, accountEmail);
                        mobileContextClosed = true;
                        if (desktopSession) {
                            await executionContext.run({ isMobile: false, account }, async () => {
                                await this.browser.func.closeBrowser(desktopSession.context, accountEmail);
                            });
                            desktopSession = null;
                        }
                    }
                    else {
                        if (apiSearch) {
                            this.cookies.mobile = await initialContext.cookies();
                            await this.browser.func.closeBrowser(initialContext, accountEmail);
                            mobileContextClosed = true;
                            if (doMobileSearch)
                                mobilePoints = await this.searchManager.searchMobile(account);
                            if (doBonus)
                                bonusPoints = await this.searchManager.bonusMobile(account);
                        }
                        else {
                            if (doMobileSearch)
                                mobilePoints = await this.searchManager.searchMobile(account);
                            if (doBonus)
                                bonusPoints = await this.searchManager.bonusMobile(account);
                            this.cookies.mobile = await initialContext.cookies();
                            await this.browser.func.closeBrowser(initialContext, accountEmail);
                            mobileContextClosed = true;
                        }
                        if (desktopNeeded) {
                            await executionContext.run({ isMobile: false, account }, async () => {
                                desktopSession = await this.createDesktopSession(account);
                                await this.punchcardManager.runDesktop();
                                if (doVisualSearch)
                                    await this.activities.doVisualSearch();
                                if (doDesktopSearch && !apiSearch) {
                                    desktopPoints = await this.searchManager.searchDesktop(account);
                                }
                            });
                            await executionContext.run({ isMobile: false, account }, async () => {
                                await this.browser.func.closeBrowser(desktopSession.context, accountEmail);
                            });
                            desktopSession = null;
                            if (doDesktopSearch && apiSearch) {
                                desktopPoints = await this.searchManager.searchDesktop(account);
                            }
                        }
                    }
                }
                this.logger.info('main', 'SEARCH-MANAGER', `Search summary | mobile=${mobilePoints} | desktop=${desktopPoints} | bonus=${bonusPoints} | total=${mobilePoints + desktopPoints + bonusPoints}`);
                if (this.config.workers.doClaimBonusPoints)
                    await this.workers.doClaimBonusPoints();
                const finalPoints = await this.browser.func.getCurrentPoints();
                const collectedPoints = finalPoints - initialPoints;
                this.logger.info('main', 'FLOW', `Points collected | pointsGained=${collectedPoints} | currentBalance=${finalPoints} | account=${accountEmail}`);
                return {
                    initialPoints,
                    collectedPoints: collectedPoints || 0
                };
            });
        }
        finally {
            if (mobileSession && !mobileContextClosed) {
                try {
                    await executionContext.run({ isMobile: true, account }, async () => {
                        await this.browser.func.closeBrowser(mobileSession.context, accountEmail, mobileSessionAuthenticated);
                    });
                }
                catch (error) {
                    this.logger.debug('main', 'CLEANUP', `Mobile context close failed | ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            if (desktopSession) {
                try {
                    await executionContext.run({ isMobile: false, account }, async () => {
                        await this.browser.func.closeBrowser(desktopSession.context, accountEmail);
                    });
                }
                catch (error) {
                    this.logger.debug('main', 'CLEANUP', `Desktop context close failed | ${error instanceof Error ? error.message : String(error)}`);
                }
                desktopSession = null;
            }
        }
    }
}
exports.MicrosoftRewardsBot = MicrosoftRewardsBot;
async function main() {
    (0, Validator_1.checkNodeVersion)();
    const rewardsBot = new MicrosoftRewardsBot();
    process.on('beforeExit', () => {
        void flushAllWebhooks();
    });
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, flushing and exiting...');
        await flushAllWebhooks();
        process.exit(130);
    });
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, flushing and exiting...');
        await flushAllWebhooks();
        process.exit(143);
    });
    process.on('uncaughtException', async (error) => {
        if ((0, Utils_1.isBrowserClosedError)(error)) {
            rewardsBot.logger.debug('main', 'UNCAUGHT-EXCEPTION', `Ignoring benign browser-closed error during teardown | ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error);
        await flushAllWebhooks();
        process.exit(1);
    });
    process.on('unhandledRejection', async (reason) => {
        if ((0, Utils_1.isBrowserClosedError)(reason)) {
            rewardsBot.logger.debug('main', 'UNHANDLED-REJECTION', `Ignoring benign browser-closed rejection during teardown | ${reason instanceof Error ? reason.message : String(reason)}`);
            return;
        }
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason);
        await flushAllWebhooks();
        process.exit(1);
    });
    try {
        await rewardsBot.initialize();
        await rewardsBot.run();
    }
    catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error);
    }
}
if (require.main === module) {
    main().catch(async (error) => {
        const tmpBot = new MicrosoftRewardsBot();
        tmpBot.logger.error('main', 'MAIN-ERROR', error);
        await flushAllWebhooks();
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map