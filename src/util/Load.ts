import fs from 'fs'
import path from 'path'

import type { Account, AccountProxy, ConfigSaveFingerprint } from '../interface/Account'
import type { Config } from '../interface/Config'
import { loadAccountsFromDatabase } from './AccountDatabase'
import { parseProxyConfig } from './ProxyConfig'
import { validateAccounts, validateConfig } from './Validator'

let configCache: Config
let envLoaded = false

export function getProjectRoot(): string {
    const cwd = process.cwd()
    if (fs.existsSync(path.join(cwd, 'package.json'))) return cwd

    let dir = __dirname
    while (dir !== path.parse(dir).root) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir
        dir = path.dirname(dir)
    }

    return cwd
}

// Check root -> dist -> src (not in dist, but root)
function resolveProjectFile(filename: string): string | undefined {
    const root = getProjectRoot()
    const candidates = [
        path.join(process.cwd(), filename),
        path.join(root, filename),
        path.join(root, 'dist', filename),
        path.join(root, 'src', filename)
    ]
    return candidates.find(p => fs.existsSync(p))
}

function ensureEnvLoaded(): void {
    if (envLoaded) return
    envLoaded = true

    // Check root -> dist -> src (not in dist, but root)
    const envFile = resolveProjectFile('.env')
    if (!envFile) return

    const raw = fs.readFileSync(envFile, 'utf-8')
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue

        const eq = trimmed.indexOf('=')
        if (eq === -1) continue

        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }

        if (process.env[key] === undefined) {
            process.env[key] = value
        }
    }
}

function envStr(key: string): string | undefined {
    const v = process.env[key]
    if (v === undefined) return undefined
    const trimmed = v.trim()
    return trimmed.length ? trimmed : undefined
}

function envBool(key: string, fallback: boolean): boolean {
    const v = envStr(key)
    if (v === undefined) return fallback
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

const deprecationWarned = new Set<string>()
function envBoolWithLegacy(primary: string, legacy: string, fallback: boolean): boolean {
    if (envStr(primary) !== undefined) return envBool(primary, fallback)
    if (envStr(legacy) !== undefined) {
        if (!deprecationWarned.has(legacy)) {
            deprecationWarned.add(legacy)
            console.warn(`[Accounts] ${legacy} is deprecated; rename it to ${primary}.`)
        }
        return envBool(legacy, fallback)
    }
    return fallback
}

function envInt(key: string, fallback: number): number {
    const v = envStr(key)
    if (v === undefined) return fallback
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : fallback
}

function buildProxy(index: string): AccountProxy {
    return {
        proxyHttp: envBoolWithLegacy(`ACCOUNT_${index}_PROXY_HTTP`, `ACCOUNT_${index}_PROXY_AXIOS`, false),
        url: envStr(`ACCOUNT_${index}_PROXY_URL`) ?? '',
        port: envInt(`ACCOUNT_${index}_PROXY_PORT`, 0),
        username: envStr(`ACCOUNT_${index}_PROXY_USERNAME`) ?? '',
        password: envStr(`ACCOUNT_${index}_PROXY_PASSWORD`) ?? ''
    }
}

function buildSaveFingerprint(index: string): ConfigSaveFingerprint {
    return {
        mobile: envBool(`ACCOUNT_${index}_SAVE_FINGERPRINT_MOBILE`, true),
        desktop: envBool(`ACCOUNT_${index}_SAVE_FINGERPRINT_DESKTOP`, true)
    }
}

function loadAccountsFromEnv(): Account[] {
    const accounts: Account[] = []

    for (let i = 1; ; i++) {
        const index = String(i)
        const email = envStr(`ACCOUNT_${index}_EMAIL`)

        if (!email) break

        const password = envStr(`ACCOUNT_${index}_PASSWORD`)
        if (!password) {
            throw new Error(`ACCOUNT_${index}_EMAIL is set but ACCOUNT_${index}_PASSWORD is missing`)
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
        })
    }

    return accounts
}

export function loadAccounts(): Account[] {
    try {
        ensureEnvLoaded()

        const projectRoot = getProjectRoot()
        const source = (envStr('ACCOUNTS_SOURCE') ?? 'database').toLowerCase()
        if (!['auto', 'database', 'env'].includes(source)) {
            throw new Error('ACCOUNTS_SOURCE must be one of: auto, database, env')
        }

        if (source !== 'env') {
            const databaseAccounts = loadAccountsFromDatabase(projectRoot)
            if (databaseAccounts?.length) {
                return requireAccountProxies(validateAccounts(databaseAccounts))
            }
            if (source === 'database') {
                throw new Error(
                    'No active accounts found in database. Run `npm run accounts:import -- path/to/accounts.json`.'
                )
            }
        }

        const envAccounts = loadAccountsFromEnv()
        if (!envAccounts.length) {
            throw new Error(
                'No accounts found. Create data/accounts.db, or set ACCOUNT_1_EMAIL / ACCOUNT_1_PASSWORD in .env.'
            )
        }

        return requireAccountProxies(validateAccounts(envAccounts))
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
    }
}

function requireAccountProxies(accounts: Account[]): Account[] {
    for (const account of accounts) {
        if (account.useProxy === false) continue
        try {
            parseProxyConfig(account.proxy)
        } catch {
            throw new Error(
                `Account ${account.email} has no valid proxy. Direct account traffic is disabled; configure proxy URL and port before running.`
            )
        }
    }

    return accounts
}

export function loadConfig(): Config {
    try {
        if (configCache) {
            return configCache
        }

        // Check root -> dist -> src (not in dist, but root)
        const configPath = resolveProjectFile('config.json')
        if (!configPath) {
            throw new Error(
                'config.json not found - place it in the project root (dist/ and src/ are also searched as fallbacks)'
            )
        }
        const config = fs.readFileSync(configPath, 'utf-8')

        const unverifiedConfig = JSON.parse(config)
        const configData = applyRuntimeConfigOverrides(validateConfig(unverifiedConfig))

        configCache = configData

        return configData
    } catch (error) {
        throw new Error(error as string)
    }
}

export function applyRuntimeConfigOverrides(config: Config, sourceEnv: NodeJS.ProcessEnv = process.env): Config {
    const forceReadyToClaim = ['1', 'true', 'yes', 'on'].includes(
        String(sourceEnv.QUEUE_FORCE_READY_TO_CLAIM ?? '')
            .trim()
            .toLowerCase()
    )
    if (!forceReadyToClaim) return config

    return {
        ...config,
        autoClaimPunchcardRewards: true,
        workers: {
            ...config.workers,
            doClaimBonusPoints: true
        }
    }
}
