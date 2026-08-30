import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { buildSingleAccountEnvById } from '../api/accounts.js'
import { applyLogToRunState, createRunState, parseLogLine, summarizeRunState } from '../api/logParser.js'

const IS_WIN = process.platform === 'win32'

export function buildQueueAccountChildEnv(baseEnv, accountEnv) {
    return {
        ...baseEnv,
        ...accountEnv,
        // A queue job is only complete after its final Ready-to-claim pass.
        // Keep this queue-specific so normal `npm start` runs still respect
        // config.json exactly as written.
        QUEUE_FORCE_READY_TO_CLAIM: 'true'
    }
}

export function accountRunFailure(run) {
    if (!run?.finished) return 'Account process exited without a complete RUN-END result.'

    const accounts = Array.isArray(run.accounts) ? run.accounts : []
    if (accounts.length !== 1) {
        return `Expected one account result but received ${accounts.length}.`
    }

    const account = accounts[0]
    if (account?.success !== true) {
        return account?.error ? `Account flow failed: ${account.error}` : 'Account flow failed before ACCOUNT-END.'
    }

    // Zero points alone is not a failure: the account may already have
    // completed all currently earnable activities. A logged flow error is.
    return null
}

function stopProcessTree(child) {
    if (!child?.pid) return
    try {
        if (IS_WIN) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else {
            try {
                process.kill(-child.pid, 'SIGTERM')
            } catch {
                child.kill('SIGTERM')
            }
        }
    } catch {}
}

export async function runAccountProcess(
    projectRoot,
    row,
    { signal, dryRun = false, idleTimeoutMs = 0, onSpawn, onLog } = {}
) {
    const startedAt = Date.now()
    const logDir = path.join(projectRoot, 'data', 'job-logs')
    fs.mkdirSync(logDir, { recursive: true })
    const logPath = path.join(logDir, `${row.id}.log`)
    const structuredLogPath = path.join(logDir, `${row.id}.jsonl`)

    const writeStructuredRecord = (stream, type, data = {}) => {
        stream.write(
            `${JSON.stringify({
                observedAt: new Date().toISOString(),
                type,
                jobId: row.id,
                batchId: row.batch_id,
                accountId: row.account_id,
                ...data
            })}${os.EOL}`
        )
    }

    if (dryRun) {
        fs.writeFileSync(logPath, `[dry-run] ${new Date().toISOString()} account=${row.account_id}${os.EOL}`)
        fs.appendFileSync(
            structuredLogPath,
            `${JSON.stringify({
                observedAt: new Date().toISOString(),
                type: 'dry-run',
                jobId: row.id,
                batchId: row.batch_id,
                accountId: row.account_id
            })}${os.EOL}`
        )
        await new Promise(resolve => setTimeout(resolve, 100))
        return {
            logPath,
            structuredLogPath,
            result: { dryRun: true, exitCode: 0, durationMs: Date.now() - startedAt, accountId: row.account_id }
        }
    }

    const executable = path.join(projectRoot, 'dist', 'index.js')
    if (!fs.existsSync(executable))
        throw new Error('dist/index.js is missing. Run `npm run build` before starting workers.')

    const selection = buildSingleAccountEnvById(row.account_id)
    const output = fs.createWriteStream(logPath, { flags: 'a' })
    const structuredOutput = fs.createWriteStream(structuredLogPath, { flags: 'a' })
    const runState = createRunState()
    const buffers = { stdout: '', stderr: '' }

    return await new Promise((resolve, reject) => {
        let aborted = false
        let idleTimedOut = false
        let settled = false
        let idleTimer = null
        const child = spawn(process.execPath, ['--no-warnings', executable], {
            cwd: projectRoot,
            env: buildQueueAccountChildEnv(process.env, selection.env),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: !IS_WIN,
            windowsHide: true
        })
        if (child.pid) onSpawn?.(child.pid)
        writeStructuredRecord(structuredOutput, 'process-start', { pid: child.pid ?? null })

        const closeLogs = () =>
            Promise.allSettled([new Promise(done => output.end(done)), new Promise(done => structuredOutput.end(done))])

        const clearIdleTimer = () => {
            if (!idleTimer) return
            clearTimeout(idleTimer)
            idleTimer = null
        }

        const armIdleTimer = () => {
            if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || settled) return
            clearIdleTimer()
            idleTimer = setTimeout(() => {
                idleTimedOut = true
                writeStructuredRecord(structuredOutput, 'process-idle-timeout', { idleTimeoutMs })
                stopProcessTree(child)
            }, idleTimeoutMs)
            idleTimer.unref?.()
        }

        const ingestLine = (source, line) => {
            if (!line) return
            const entry = parseLogLine(line, source)
            applyLogToRunState(runState, entry)
            writeStructuredRecord(structuredOutput, 'child-log', entry)
            onLog?.(entry)
        }

        const ingest = (source, chunk) => {
            armIdleTimer()
            const text = chunk.toString()
            output.write(text)
            buffers[source] += text
            const lines = buffers[source].split(/\r?\n/)
            buffers[source] = lines.pop() || ''
            for (const line of lines) ingestLine(source, line)
        }
        child.stdout.on('data', chunk => ingest('stdout', chunk))
        child.stderr.on('data', chunk => ingest('stderr', chunk))
        armIdleTimer()

        const onAbort = () => {
            aborted = true
            stopProcessTree(child)
        }
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })

        child.once('error', async error => {
            if (settled) return
            settled = true
            clearIdleTimer()
            signal?.removeEventListener('abort', onAbort)
            writeStructuredRecord(structuredOutput, 'process-error', { message: error.message })
            await closeLogs()
            reject(Object.assign(error, { logPath, structuredLogPath }))
        })
        child.once('close', async (code, exitSignal) => {
            if (settled) return
            settled = true
            clearIdleTimer()
            signal?.removeEventListener('abort', onAbort)
            for (const source of ['stdout', 'stderr']) {
                if (buffers[source]) ingestLine(source, buffers[source])
            }
            const result = {
                exitCode: code,
                signal: exitSignal,
                durationMs: Date.now() - startedAt,
                accountId: row.account_id,
                run: summarizeRunState(runState)
            }
            const runFailure = accountRunFailure(result.run)
            writeStructuredRecord(structuredOutput, 'process-exit', result)
            await closeLogs()
            if (idleTimedOut)
                reject(
                    Object.assign(
                        new Error(`Account process produced no output for ${idleTimeoutMs}ms and was stopped.`),
                        {
                            logPath,
                            structuredLogPath,
                            result
                        }
                    )
                )
            else if (aborted)
                reject(
                    Object.assign(new Error('Account process stopped because the proxy lease was lost.'), {
                        logPath,
                        structuredLogPath
                    })
                )
            else if (code !== 0)
                reject(
                    Object.assign(new Error(`Account process exited with code ${code}.`), {
                        logPath,
                        structuredLogPath,
                        result
                    })
                )
            else if (runFailure)
                reject(
                    Object.assign(new Error(runFailure), {
                        logPath,
                        structuredLogPath,
                        result
                    })
                )
            else resolve({ logPath, structuredLogPath, result })
        })
    })
}
