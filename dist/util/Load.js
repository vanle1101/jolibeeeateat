"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProjectRoot = getProjectRoot;
exports.loadAccounts = loadAccounts;
exports.loadConfig = loadConfig;
exports.applyRuntimeConfigOverrides = applyRuntimeConfigOverrides;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const AccountDatabase_1 = require("./AccountDatabase");
const ProxyConfig_1 = require("./ProxyConfig");
const Validator_1 = require("./Validator");
let configCache;
let envLoaded = false;
function getProjectRoot() {
    const cwd = process.cwd();
    if (fs_1.default.existsSync(path_1.default.join(cwd, 'package.json')))
        return cwd;
    let dir = __dirname;
    while (dir !== path_1.default.parse(dir).root) {
        if (fs_1.default.existsSync(path_1.default.join(dir, 'package.json')))
            return dir;
        dir = path_1.default.dirname(dir);
    }
    return cwd;
}
// Check root -> dist -> src (not in dist, but root)
function resolveProjectFile(filename) {
    const root = getProjectRoot();
    const candidates = [
        path_1.default.join(process.cwd(), filename),
        path_1.default.join(root, filename),
        path_1.default.join(root, 'dist', filename),
        path_1.default.join(root, 'src', filename)
    ];
    return candidates.find(p => fs_1.default.existsSync(p));
}
function ensureEnvLoaded() {
    if (envLoaded)
        return;
    envLoaded = true;
    // Check root -> dist -> src (not in dist, but root)
    const envFile = resolveProjectFile('.env');
    if (!envFile)
        return;
    const raw = fs_1.default.readFileSync(envFile, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1)
            continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}
function envStr(key) {
    const v = process.env[key];
    if (v === undefined)
        return undefined;
    const trimmed = v.trim();
    return trimmed.length ? trimmed : undefined;
}
function envBool(key, fallback) {
    const v = envStr(key);
    if (v === undefined)
        return fallback;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
const deprecationWarned = new Set();
function envBoolWithLegacy(primary, legacy, fallback) {
    if (envStr(primary) !== undefined)
        return envBool(primary, fallback);
    if (envStr(legacy) !== undefined) {
        if (!deprecationWarned.has(legacy)) {
            deprecationWarned.add(legacy);
            console.warn(`[Accounts] ${legacy} is deprecated; rename it to ${primary}.`);
        }
        return envBool(legacy, fallback);
    }
    return fallback;
}
function envInt(key, fallback) {
    const v = envStr(key);
    if (v === undefined)
        return fallback;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
}
function buildProxy(index) {
    return {
        proxyHttp: envBoolWithLegacy(`ACCOUNT_${index}_PROXY_HTTP`, `ACCOUNT_${index}_PROXY_AXIOS`, false),
        url: envStr(`ACCOUNT_${index}_PROXY_URL`) ?? '',
        port: envInt(`ACCOUNT_${index}_PROXY_PORT`, 0),
        username: envStr(`ACCOUNT_${index}_PROXY_USERNAME`) ?? '',
        password: envStr(`ACCOUNT_${index}_PROXY_PASSWORD`) ?? ''
    };
}
function buildSaveFingerprint(index) {
    return {
        mobile: envBool(`ACCOUNT_${index}_SAVE_FINGERPRINT_MOBILE`, true),
        desktop: envBool(`ACCOUNT_${index}_SAVE_FINGERPRINT_DESKTOP`, true)
    };
}
function loadAccountsFromEnv() {
    const accounts = [];
    for (let i = 1;; i++) {
        const index = String(i);
        const email = envStr(`ACCOUNT_${index}_EMAIL`);
        if (!email)
            break;
        const password = envStr(`ACCOUNT_${index}_PASSWORD`);
        if (!password) {
            throw new Error(`ACCOUNT_${index}_EMAIL is set but ACCOUNT_${index}_PASSWORD is missing`);
        }
        accounts.push({
            slot: i,
            email,
            password,
            totpSecret: envStr(`ACCOUNT_${index}_TOTP_SECRET`),
            recoveryEmail: envStr(`ACCOUNT_${index}_RECOVERY_EMAIL`) ?? '',
            geoLocale: envStr(`ACCOUNT_${index}_GEO_LOCALE`) ?? 'auto',
            langCode: envStr(`ACCOUNT_${index}_LANG_CODE`) ?? 'en',
            useProxy: envBool(`ACCOUNT_${index}_USE_PROXY`, true),
            proxy: buildProxy(index),
            saveFingerprint: buildSaveFingerprint(index)
        });
    }
    return accounts;
}
function loadAccounts() {
    try {
        ensureEnvLoaded();
        const projectRoot = getProjectRoot();
        const source = (envStr('ACCOUNTS_SOURCE') ?? 'database').toLowerCase();
        if (!['auto', 'database', 'env'].includes(source)) {
            throw new Error('ACCOUNTS_SOURCE must be one of: auto, database, env');
        }
        if (source !== 'env') {
            const databaseAccounts = (0, AccountDatabase_1.loadAccountsFromDatabase)(projectRoot);
            if (databaseAccounts?.length) {
                return requireAccountProxies((0, Validator_1.validateAccounts)(databaseAccounts));
            }
            if (source === 'database') {
                throw new Error('No active accounts found in database. Run `npm run accounts:import -- path/to/accounts.json`.');
            }
        }
        const envAccounts = loadAccountsFromEnv();
        if (!envAccounts.length) {
            throw new Error('No accounts found. Create data/accounts.db, or set ACCOUNT_1_EMAIL / ACCOUNT_1_PASSWORD in .env.');
        }
        return requireAccountProxies((0, Validator_1.validateAccounts)(envAccounts));
    }
    catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
    }
}
function requireAccountProxies(accounts) {
    for (const account of accounts) {
        if (account.useProxy === false)
            continue;
        try {
            (0, ProxyConfig_1.parseProxyConfig)(account.proxy);
        }
        catch {
            throw new Error(`Account ${account.email} has no valid proxy. Direct account traffic is disabled; configure proxy URL and port before running.`);
        }
    }
    return accounts;
}
function loadConfig() {
    try {
        if (configCache) {
            return configCache;
        }
        // Check root -> dist -> src (not in dist, but root)
        const configPath = resolveProjectFile('config.json');
        if (!configPath) {
            throw new Error('config.json not found - place it in the project root (dist/ and src/ are also searched as fallbacks)');
        }
        const config = fs_1.default.readFileSync(configPath, 'utf-8');
        const unverifiedConfig = JSON.parse(config);
        const configData = applyRuntimeConfigOverrides((0, Validator_1.validateConfig)(unverifiedConfig));
        configCache = configData;
        return configData;
    }
    catch (error) {
        throw new Error(error);
    }
}
function applyRuntimeConfigOverrides(config, sourceEnv = process.env) {
    const forceReadyToClaim = ['1', 'true', 'yes', 'on'].includes(String(sourceEnv.QUEUE_FORCE_READY_TO_CLAIM ?? '')
        .trim()
        .toLowerCase());
    if (!forceReadyToClaim)
        return config;
    return {
        ...config,
        autoClaimPunchcardRewards: true,
        workers: {
            ...config.workers,
            doClaimBonusPoints: true
        }
    };
}
//# sourceMappingURL=Load.js.map