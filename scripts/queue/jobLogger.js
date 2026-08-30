import chalk from 'chalk'

const COMPACT_TITLES = new Set([
    'RUN-START',
    'ACCOUNT-START',
    'POINTS',
    'CLAIM-BONUS-POINTS',
    'MORE-PROMOTIONS',
    'READ-TO-EARN',
    'FLOW',
    'ACCOUNT-END',
    'ACCOUNT-ERROR',
    'RUN-END'
])

function colorizeQueueLine(level, line) {
    switch (String(level || '').toLowerCase()) {
        case 'error':
            return chalk.red(line)
        case 'warn':
            return chalk.yellow(line)
        case 'success':
            return chalk.green(line)
        case 'debug':
            return chalk.gray(line)
        default:
            return chalk.cyan(line)
    }
}

function cleanField(value, fallback) {
    const clean = String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return clean || fallback
}

export function maskEmail(email) {
    const value = cleanField(email, 'unknown')
    const separator = value.lastIndexOf('@')
    if (separator <= 0) return value

    const local = value.slice(0, separator)
    const domain = value.slice(separator + 1)
    const visible = local.slice(0, Math.min(2, local.length))
    return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`
}

export function formatQueueLog(record) {
    const timestamp = cleanField(record.timestamp, new Date().toISOString())
    const level = cleanField(record.level, 'info').toUpperCase().padEnd(7)
    const lane = String(record.lane ?? '?').padStart(2, '0')
    const proxy = cleanField(record.proxy, 'direct')
    const account = maskEmail(record.account)
    const job = cleanField(record.jobId, '--------').slice(0, 8)
    const event = cleanField(record.event, 'LOG')
    const message = cleanField(record.message, '')

    return `[${timestamp}] [${level}] [T${lane}] [proxy:${proxy}] [${account}] [job:${job}] [${event}] ${message}`
}

function shouldPrintChild(mode, entry) {
    if (mode === 'silent') return false
    if (mode === 'verbose') return true
    if (entry.level === 'error' || entry.level === 'warn') return true
    return entry.parsed && COMPACT_TITLES.has(entry.title)
}

export function createJobConsoleLogger({ row, lane, mode = 'compact', write } = {}) {
    const output =
        write ||
        ((level, line) => {
            const coloredLine = colorizeQueueLine(level, line)
            if (level === 'error') return console.error(coloredLine)
            if (level === 'warn') return console.warn(coloredLine)
            return console.log(coloredLine)
        })
    const context = {
        lane,
        proxy: row?.proxy_label || (row?.proxy_id ? row.lock_key : 'direct'),
        account: row?.email || row?.account_id,
        jobId: row?.id
    }

    const emit = (level, event, message) => {
        const record = {
            timestamp: new Date().toISOString(),
            level,
            event,
            message,
            ...context
        }
        output(level, formatQueueLog(record), record)
        return record
    }

    return {
        emit,
        child(entry) {
            if (!shouldPrintChild(mode, entry)) return null
            return emit(entry.level || 'info', entry.title || 'RAW', entry.message || entry.raw)
        }
    }
}
