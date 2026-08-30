import fs from 'node:fs'
import path from 'node:path'
import { parse as parseCsv } from 'csv-parse/sync'

import { automaticProxyLabel, parseProxyParts } from './proxy.js'

const FIELD_ALIASES = new Map([
    ['mail', 'email'],
    ['user', 'email'],
    ['pass', 'password'],
    ['proxy', 'proxy_url'],
    ['proxy_host', 'proxy_url'],
    ['proxy_user', 'proxy_username'],
    ['proxy_pass', 'proxy_password'],
    ['totp', 'totp_secret'],
    ['recovery', 'recovery_email']
])

function normalizeFieldName(value) {
    const normalized = String(value)
        .trim()
        .toLowerCase()
        .replace(/^account_/, '')
        .replace(/[\s-]+/g, '_')
    return FIELD_ALIASES.get(normalized) ?? normalized
}

function normalizeRecord(record) {
    return Object.fromEntries(
        Object.entries(record).map(([key, value]) => [
            normalizeFieldName(key),
            value == null ? '' : String(value).trim()
        ])
    )
}

function autoProxyLabel(record) {
    const parsed = parseProxyParts({
        url: record.proxy_url,
        port: record.proxy_port,
        username: record.proxy_username
    })
    return automaticProxyLabel({
        url: record.proxy_url,
        port: parsed.port,
        username: parsed.username
    })
}

function recordsToBundle(rawRecords, options = {}) {
    if (!rawRecords.length) throw new Error('Import file does not contain any account rows.')

    const proxies = new Map()
    const accounts = rawRecords.map((rawRecord, index) => {
        const record = normalizeRecord(rawRecord)
        if (!record.email) throw new Error(`Import row ${index + 1} is missing email.`)

        const hasProxyDetails = Boolean(record.proxy_url || record.proxy_port)
        let proxyLabel = record.proxy_label || ''
        if (hasProxyDetails) {
            const parsed = parseProxyParts({
                url: record.proxy_url,
                port: record.proxy_port,
                username: record.proxy_username,
                password: record.proxy_password
            })
            if (!record.proxy_url || !parsed.port) {
                throw new Error(`Import row ${index + 1} must provide proxy_url with a port or proxy_port.`)
            }
            proxyLabel ||= autoProxyLabel(record)
            const proxy = {
                label: proxyLabel,
                url: record.proxy_url,
                port: parsed.port,
                username: parsed.username,
                password: parsed.password,
                proxyHttp: record.proxy_http,
                status: record.proxy_status || 'active',
                accountCapacity: record.account_capacity || 1,
                egressIp: record.proxy_egress_ip || record.egress_ip,
                cooldownSeconds: record.cooldown_seconds || 0
            }
            const key = proxyLabel.toLowerCase()
            const serialized = JSON.stringify(proxy)
            const existing = proxies.get(key)
            if (existing && existing.serialized !== serialized) {
                throw new Error(`Import rows use proxy label ${proxyLabel} with different proxy details.`)
            }
            proxies.set(key, { serialized, proxy })
        }

        return {
            email: record.email,
            password: record.password,
            totpSecret: record.totp_secret,
            recoveryEmail: record.recovery_email,
            geoLocale: record.geo_locale || 'auto',
            langCode: record.lang_code || 'en',
            proxyLabel: proxyLabel || undefined,
            status: record.status || 'ready',
            saveFingerprint: {
                mobile: record.save_fingerprint_mobile,
                desktop: record.save_fingerprint_desktop
            }
        }
    })

    return {
        proxies: [...proxies.values()].map(entry => entry.proxy),
        accounts,
        autoAssignStoredProxies:
            Boolean(options.autoAssignStoredProxies) && accounts.some(account => !account.proxyLabel),
        sourceFormat: options.sourceFormat
    }
}

function parseCsvFile(content) {
    const records = parseCsv(content, {
        bom: true,
        columns: header => header.map(normalizeFieldName),
        comment: '#',
        skip_empty_lines: true,
        skip_records_with_empty_values: false,
        trim: true
    })
    return recordsToBundle(records)
}

function parseTextBlocks(content) {
    const records = []
    let current = {}

    const pushCurrent = () => {
        if (!Object.keys(current).length) return
        records.push(current)
        current = {}
    }

    for (const [lineIndex, rawLine] of content.split(/\r?\n/).entries()) {
        const line = rawLine.trim()
        if (!line || line === '---') {
            pushCurrent()
            continue
        }
        if (line.startsWith('#')) continue

        const separator = line.indexOf('=')
        if (separator < 1) throw new Error(`Invalid accounts.txt line ${lineIndex + 1}: expected KEY=value.`)
        const key = normalizeFieldName(line.slice(0, separator))
        const value = line.slice(separator + 1).trim()

        if (key === 'email' && current.email) pushCurrent()
        if (Object.hasOwn(current, key)) {
            throw new Error(`Duplicate ${key.toUpperCase()} in accounts.txt block near line ${lineIndex + 1}.`)
        }
        current[key] = value
    }
    pushCurrent()
    return recordsToBundle(records)
}

function parsePipeProxy(value, lineNumber) {
    const raw = String(value ?? '').trim()
    if (!raw) return {}

    const compactParts = raw.split(':')
    if (compactParts.length === 4 && /^\d+$/.test(compactParts[1]) && !raw.includes('://') && !raw.includes('@')) {
        const [host, port, username, password] = compactParts
        return {
            proxy_url: host,
            proxy_port: port,
            proxy_username: username,
            proxy_password: password
        }
    }

    const parsed = parseProxyParts({ url: raw })
    if (!parsed.host || !parsed.port) {
        throw new Error(
            `Invalid pipe-delimited proxy on line ${lineNumber}: expected host:port, a proxy URL, or host:port:user:password.`
        )
    }

    return {
        proxy_url: raw,
        proxy_port: parsed.port,
        proxy_username: parsed.username,
        proxy_password: parsed.password
    }
}

function parsePipeRows(content) {
    const records = []

    for (const [lineIndex, rawLine] of content.split(/\r?\n/).entries()) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue

        const parts = line.split('|').map(value => value.trim())
        if (parts.length < 2 || parts.length > 5) {
            throw new Error(
                `Invalid pipe-delimited line ${lineIndex + 1}: expected EMAIL|PASSWORD with optional proxy, username, and password columns.`
            )
        }

        const [email, password, proxyValue = '', proxyUsername = '', proxyPassword = ''] = parts
        if (!email) throw new Error(`Import row ${lineIndex + 1} is missing email.`)
        if (!password) throw new Error(`Import row ${lineIndex + 1} is missing password.`)

        // Hotmail token format: email|password|refreshToken|clientId|recoveryEmail
        if (parts.length === 5 && (proxyValue.startsWith('M.') || proxyValue.length > 40) && parts[4].includes('@')) {
            records.push({
                email,
                password,
                recovery_email: parts[4]
            })
            continue
        }

        const proxy = parsePipeProxy(proxyValue, lineIndex + 1)
        if (proxyValue && (proxyUsername || proxyPassword)) {
            proxy.proxy_username = proxyUsername
            proxy.proxy_password = proxyPassword
        }

        records.push({
            email,
            password,
            ...proxy
        })
    }

    return recordsToBundle(records, {
        autoAssignStoredProxies: true,
        sourceFormat: 'pipe'
    })
}

function parseTextFile(content) {
    const dataLines = content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))

    if (dataLines.length && dataLines.every(line => line.includes('|'))) {
        return parsePipeRows(content)
    }
    return parseTextBlocks(content)
}

export function loadAccountImportFile(inputPath) {
    const absolutePath = path.resolve(process.cwd(), inputPath)
    const content = fs.readFileSync(absolutePath, 'utf8')
    const extension = path.extname(absolutePath).toLowerCase()

    if (extension === '.csv') return parseCsvFile(content)
    if (extension === '.txt') return parseTextFile(content)
    if (extension === '.json') return JSON.parse(content)
    throw new Error('Unsupported import file. Use .csv, .txt, or .json.')
}
