"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountSchema = exports.ConfigSchema = void 0;
exports.validateConfig = validateConfig;
exports.validateAccounts = validateAccounts;
exports.checkNodeVersion = checkNodeVersion;
const zod_1 = require("zod");
const semver_1 = __importDefault(require("semver"));
const package_json_1 = __importDefault(require("../../package.json"));
const NumberOrString = zod_1.z.union([zod_1.z.number(), zod_1.z.string()]);
const LogFilterSchema = zod_1.z.object({
    enabled: zod_1.z.boolean(),
    mode: zod_1.z.enum(['whitelist', 'blacklist']),
    levels: zod_1.z.array(zod_1.z.enum(['debug', 'info', 'warn', 'error'])).optional(),
    keywords: zod_1.z.array(zod_1.z.string()).optional(),
    regexPatterns: zod_1.z.array(zod_1.z.string()).optional()
});
const DelaySchema = zod_1.z.object({
    min: NumberOrString,
    max: NumberOrString
});
const QueryEngineSchema = zod_1.z.union([
    zod_1.z.enum(['google', 'wikipedia', 'wikirandom', 'hackernews', 'reddit', 'local']),
    zod_1.z
        .string()
        .regex(/^rss(\.[A-Za-z0-9_-]+){0,2}$/, 'Invalid rss selector (use rss, rss.<site>, or rss.<site>.<endpoint>)')
]);
// Webhook
const WebhookSchema = zod_1.z.object({
    discord: zod_1.z
        .object({
        enabled: zod_1.z.boolean(),
        url: zod_1.z.string()
    })
        .optional(),
    ntfy: zod_1.z
        .object({
        enabled: zod_1.z.boolean().optional(),
        url: zod_1.z.string(),
        topic: zod_1.z.string().optional(),
        token: zod_1.z.string().optional(),
        title: zod_1.z.string().optional(),
        tags: zod_1.z.array(zod_1.z.string()).optional(),
        priority: zod_1.z.union([zod_1.z.literal(1), zod_1.z.literal(2), zod_1.z.literal(3), zod_1.z.literal(4), zod_1.z.literal(5)]).optional()
    })
        .optional(),
    telegram: zod_1.z
        .object({
        enabled: zod_1.z.boolean().optional(),
        botToken: zod_1.z.string(),
        chatId: zod_1.z.string()
    })
        .optional(),
    webhookLogFilter: LogFilterSchema
});
// Config
exports.ConfigSchema = zod_1.z.object({
    sessionPath: zod_1.z.string(),
    headless: zod_1.z.boolean(),
    clusters: zod_1.z.number().int().nonnegative(),
    errorDiagnostics: zod_1.z.boolean(),
    ensureStreakProtection: zod_1.z.boolean(),
    autoClaimPunchcardRewards: zod_1.z.boolean(),
    skipNonPointTasks: zod_1.z.boolean().default(true),
    workers: zod_1.z.object({
        doDailySet: zod_1.z.boolean(),
        doMorePromotions: zod_1.z.boolean(),
        doClaimBonusPoints: zod_1.z.boolean(),
        doPunchCards: zod_1.z.boolean(),
        doAppPromotions: zod_1.z.boolean(),
        doDesktopSearch: zod_1.z.boolean(),
        doMobileSearch: zod_1.z.boolean(),
        doBonusSearches: zod_1.z.boolean(),
        doDailyCheckIn: zod_1.z.boolean(),
        doReadToEarn: zod_1.z.boolean(),
        doActivateSearchPerk: zod_1.z.boolean(),
        doVisualSearch: zod_1.z.boolean().default(false)
    }),
    activities: zod_1.z
        .object({
        urlReward: zod_1.z.boolean().default(true),
        searchOnBing: zod_1.z.boolean().default(true)
    })
        .default({ urlReward: true, searchOnBing: true }),
    searchOnBingLocalQueries: zod_1.z.boolean(),
    globalTimeout: NumberOrString,
    searchSettings: zod_1.z.object({
        scrollRandomResults: zod_1.z.boolean(),
        clickRandomResults: zod_1.z.boolean(),
        runOnZeroPoints: zod_1.z.boolean().default(false),
        maxBonusSearches: zod_1.z.number().default(110),
        parallelSearching: zod_1.z.boolean(),
        queryEngines: zod_1.z.array(QueryEngineSchema),
        searchResultVisitTime: NumberOrString,
        searchDelay: DelaySchema,
        readDelay: DelaySchema
    }),
    experimental: zod_1.z
        .object({
        apiSearch: zod_1.z.boolean().default(true),
        apiSearchOnBing: zod_1.z.boolean().default(true)
    })
        .default({ apiSearch: true, apiSearchOnBing: true }),
    debugLogs: zod_1.z.boolean(),
    proxy: zod_1.z.object({
        queryEngine: zod_1.z.boolean(),
        verifyExitIp: zod_1.z.boolean().default(true),
        onProxyMismatch: zod_1.z.enum(['warn', 'skip', 'off']).default('warn')
    }),
    accountLifecycle: zod_1.z
        .object({
        autoDisableSuspended: zod_1.z.boolean().default(true),
        mode: zod_1.z.enum(['off', 'disable', 'delete']).default('disable')
    })
        .default({ autoDisableSuspended: true, mode: 'disable' }),
    consoleLogFilter: LogFilterSchema,
    webhook: WebhookSchema
});
// Account
exports.AccountSchema = zod_1.z.object({
    accountId: zod_1.z.string().optional(),
    proxyId: zod_1.z.string().nullable().optional(),
    useProxy: zod_1.z.boolean().optional(),
    status: zod_1.z.string().optional(),
    slot: zod_1.z.number().int().positive().optional(),
    email: zod_1.z.string(),
    password: zod_1.z.string(),
    totpSecret: zod_1.z.string().optional(),
    recoveryEmail: zod_1.z.string(),
    geoLocale: zod_1.z.string(),
    langCode: zod_1.z.string(),
    proxy: zod_1.z.object({
        proxyHttp: zod_1.z.boolean(),
        url: zod_1.z.string(),
        port: zod_1.z.number(),
        password: zod_1.z.string(),
        username: zod_1.z.string(),
        expectedEgressIp: zod_1.z.string().optional()
    }),
    saveFingerprint: zod_1.z.object({
        mobile: zod_1.z.boolean(),
        desktop: zod_1.z.boolean()
    })
});
const defaultConfig = {
    sessionPath: 'sessions',
    headless: true,
    clusters: 0,
    errorDiagnostics: true,
    ensureStreakProtection: true,
    autoClaimPunchcardRewards: true,
    skipNonPointTasks: true,
    workers: {
        doDailySet: true,
        doMorePromotions: true,
        doClaimBonusPoints: true,
        doPunchCards: true,
        doAppPromotions: true,
        doDesktopSearch: true,
        doMobileSearch: true,
        doBonusSearches: false,
        doDailyCheckIn: true,
        doReadToEarn: true,
        doActivateSearchPerk: true,
        doVisualSearch: false
    },
    activities: {
        urlReward: true,
        searchOnBing: true
    },
    searchOnBingLocalQueries: false,
    globalTimeout: '30sec',
    searchSettings: {
        scrollRandomResults: true,
        clickRandomResults: true,
        runOnZeroPoints: false,
        maxBonusSearches: 110,
        parallelSearching: true,
        queryEngines: ['google', 'wikipedia', 'wikirandom', 'hackernews', 'reddit', 'local'],
        searchResultVisitTime: '10sec',
        searchDelay: { min: '30sec', max: '1min' },
        readDelay: { min: '30sec', max: '1min' }
    },
    experimental: {
        apiSearch: true,
        apiSearchOnBing: true
    },
    debugLogs: false,
    proxy: { queryEngine: true, verifyExitIp: true, onProxyMismatch: 'warn' },
    accountLifecycle: { autoDisableSuspended: true, mode: 'disable' },
    consoleLogFilter: {
        enabled: false,
        mode: 'whitelist',
        levels: ['info', 'warn', 'error'],
        keywords: [],
        regexPatterns: []
    },
    webhook: {
        webhookLogFilter: {
            enabled: false,
            mode: 'whitelist',
            levels: ['warn', 'error'],
            keywords: [],
            regexPatterns: []
        }
    }
};
function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function getByPath(obj, path) {
    return path.reduce((acc, key) => {
        if (acc == null)
            return undefined;
        return acc[key];
    }, obj);
}
function setByPath(obj, path, value) {
    if (path.length === 0)
        return value;
    const head = path[0];
    if (head === undefined)
        return value;
    const rest = path.slice(1);
    const base = obj ?? (typeof head === 'number' ? [] : {});
    const cloned = (Array.isArray(base) ? [...base] : { ...base });
    cloned[head] = setByPath(base[head], rest, value);
    return cloned;
}
function fillMissing(data, defaults, path = '') {
    if (!isPlainObject(defaults))
        return data;
    if (!isPlainObject(data)) {
        if (data === undefined) {
            console.warn(`[Config] "${path || '<root>'}" missing, using default`);
            return defaults;
        }
        return data;
    }
    const result = { ...data };
    for (const key of Object.keys(defaults)) {
        const p = path ? `${path}.${key}` : key;
        if (!(key in result)) {
            console.warn(`[Config] "${p}" not found, using default: ${JSON.stringify(defaults[key])}`);
            result[key] = defaults[key];
        }
        else if (isPlainObject(defaults[key])) {
            result[key] = fillMissing(result[key], defaults[key], p);
        }
    }
    return result;
}
function validateConfig(data) {
    const filled = fillMissing(data, defaultConfig);
    let result = exports.ConfigSchema.safeParse(filled);
    if (result.success)
        return result.data;
    let patched = filled;
    for (const issue of result.error.issues) {
        const def = getByPath(defaultConfig, issue.path);
        console.warn(`[Config] "${issue.path.join('.') || '<root>'}" invalid (${issue.message}), using default: ${JSON.stringify(def)}`);
        patched = setByPath(patched, issue.path, def);
    }
    result = exports.ConfigSchema.safeParse(patched);
    if (!result.success) {
        console.error('[Config] still invalid after applying defaults:', result.error.issues);
        throw new Error('Config validation failed');
    }
    return result.data;
}
function validateAccounts(data) {
    const result = zod_1.z.array(exports.AccountSchema).safeParse(data);
    if (result.success)
        return result.data;
    for (const issue of result.error.issues) {
        const path = issue.path.join('.') || '<root>';
        if (issue.code === 'invalid_type') {
            if (issue.input === undefined) {
                console.error(`[Accounts] "${path}" is missing (expected ${issue.expected})`);
            }
            else {
                console.error(`[Accounts] "${path}" has wrong type: expected ${issue.expected}, got ${typeof issue.input}`);
            }
        }
        else if (issue.code === 'invalid_union') {
            console.error(`[Accounts] "${path}" does not match any allowed type: ${issue.message}`);
        }
        else {
            console.error(`[Accounts] "${path}" ${issue.message} (code: ${issue.code})`);
        }
    }
    throw new Error(`Accounts validation failed: ${result.error.issues.length} issue(s) - see logs above`);
}
function checkNodeVersion() {
    try {
        const requiredVersion = package_json_1.default.engines?.node;
        if (!requiredVersion) {
            console.warn('No Node.js version requirement found in package.json "engines" field.');
            return;
        }
        if (!semver_1.default.satisfies(process.version, requiredVersion)) {
            console.error(`Current Node.js version ${process.version} does not satisfy requirement: ${requiredVersion}`);
            process.exit(1);
        }
    }
    catch (error) {
        console.error('Failed to validate Node.js version:', error);
        process.exit(1);
    }
}
//# sourceMappingURL=Validator.js.map