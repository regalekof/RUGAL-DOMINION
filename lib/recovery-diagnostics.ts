import type { Connection } from '@solana/web3.js'

type Details = Record<string, number | boolean>
type Entry = { stage: string; event: 'start' | 'ok' | 'error' | 'info'; elapsedMs: number; durationMs?: number; blockhashAgeMs?: number; errorCode?: string; details?: Details }
export type RecoveryDiagnosticReport = {
  version: 'recovery-diagnostics-v1'
  startedAt: string
  network: 'devnet' | 'mainnet-beta'
  signature?: string
  failedStage?: string
  evidence?: string
  entries: Entry[]
}

// Never copy raw error messages, RPC URLs, transaction bytes or account lists
// into a report. Provider errors can embed credentials in their messages.
function errorCode(error: unknown) {
  const text = error instanceof Error ? error.message : ''
  if (/block height exceeded|blockheight.*exceeded|has expired/i.test(text)) return 'BLOCKHEIGHT_EXPIRED'
  if (/blockhash|minimum context slot/i.test(text)) return 'BLOCKHASH_UNAVAILABLE'
  if (/429|too many requests/i.test(text)) return 'RATE_LIMITED'
  if (/401|403|unauthorized|forbidden/i.test(text)) return 'RPC_AUTH'
  if (/fetch|network|ECONNRESET|ETIMEDOUT/i.test(text)) return 'NETWORK_OR_RPC'
  if (/timeout|timed out/i.test(text)) return 'TIMEOUT'
  if (/reject|cancel/i.test(text)) return 'REJECTED'
  if (/wallet changed the transaction/i.test(text)) return 'MESSAGE_CHANGED'
  if (/simulation failed/i.test(text)) return 'SIMULATION_FAILED'
  if (/failed on-chain/i.test(text)) return 'ONCHAIN_FAILED'
  return 'OTHER_ERROR'
}

// The public transaction ID lets us investigate an ambiguous send response.
// This is encoding only; it never signs or submits anything.
function signatureId(bytes: Uint8Array) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = BigInt(0), encoded = '', zeros = 0
  for (const byte of bytes) value = value * BigInt(256) + BigInt(byte)
  while (value > BigInt(0)) {
    encoded = alphabet[Number(value % BigInt(58))] + encoded
    value /= BigInt(58)
  }
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  return '1'.repeat(zeros) + encoded
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; code: string }
function boundedRead<T>(read: () => Promise<T>, timeoutMs: number): Promise<ReadResult<T>> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, code: 'DIAGNOSTIC_TIMEOUT' }), timeoutMs)
    Promise.resolve().then(read).then(
      value => { clearTimeout(timer); resolve({ ok: true, value }) },
      error => { clearTimeout(timer); resolve({ ok: false, code: errorCode(error) }) },
    )
  })
}

export function createRecoveryDiagnostics(network: RecoveryDiagnosticReport['network'], onUpdate: (report: RecoveryDiagnosticReport) => void, options: { now?: () => number; timeoutMs?: number } = {}) {
  const now = options.now ?? (() => performance.now())
  const started = now(), timeoutMs = options.timeoutMs ?? 2500
  let blockhashAt: number | undefined, lastValidBlockHeight: number | undefined
  const report: RecoveryDiagnosticReport = { version: 'recovery-diagnostics-v1', startedAt: new Date().toISOString(), network, entries: [] }
  const snapshot = (): RecoveryDiagnosticReport => ({ ...report, entries: report.entries.map(entry => ({ ...entry, details: entry.details ? { ...entry.details } : undefined })) })
  const publish = () => { try { onUpdate(snapshot()) } catch { /* Diagnostics must never break recovery. */ } }
  const record = (stage: string, event: Entry['event'], extra: Partial<Entry> = {}) => {
    report.entries.push({ stage, event, elapsedMs: Math.round(now() - started), ...(blockhashAt === undefined ? {} : { blockhashAgeMs: Math.round(now() - blockhashAt) }), ...extra })
    if (report.entries.length > 100) report.entries.shift()
    publish()
  }
  const note = (stage: string, details?: Details) => record(stage, 'info', { details })
  const measure = async <T>(stage: string, run: () => Promise<T>): Promise<T> => {
    const start = now()
    record(stage, 'start')
    try {
      const result = await run()
      record(stage, 'ok', { durationMs: Math.round(now() - start) })
      return result
    } catch (error) {
      report.failedStage ??= stage
      record(stage, 'error', { durationMs: Math.round(now() - start), errorCode: errorCode(error) })
      throw error
    }
  }
  const sampleHeight = async (connection: Connection, stage: string) => {
    const requestedAtMs = Math.round(now() - started), expiry = lastValidBlockHeight
    const result = await boundedRead(() => connection.getBlockHeight('confirmed'), timeoutMs)
    if (result.ok) note(stage, { requestedAtMs, currentBlockHeight: result.value, ...(expiry === undefined ? {} : { lastValidBlockHeight: expiry, blocksRemaining: expiry - result.value }) })
    else record(stage, 'error', { errorCode: result.code, details: { requestedAtMs } })
  }
  return {
    snapshot, note, measure, sampleHeight,
    retrying: () => { report.failedStage = undefined; note('prepare.blockhash-retry') },
    blockhashReceived: (height: number, contextSlot: number) => {
      blockhashAt = now(); lastValidBlockHeight = height
      note('blockhash.received', { lastValidBlockHeight: height, contextSlot })
    },
    signed: (signature: Uint8Array | null) => {
      if (signature?.length === 64) report.signature = signatureId(signature)
      note('wallet.signed')
    },
    submitted: () => note('send.rpc-acknowledged'),
    inspectFailure: async (connection: Connection) => {
      const signature = report.signature
      // Only after a failure: bounded HTTP history lookup, independent of the
      // websocket-based confirmation waiter. Never retry or rebuild a send.
      const [height, status] = await Promise.all([
        boundedRead(() => connection.getBlockHeight('confirmed'), timeoutMs),
        signature ? boundedRead(() => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }), timeoutMs) : Promise.resolve(null),
      ])
      if (height.ok) note('failure.block-height', { currentBlockHeight: height.value, ...(lastValidBlockHeight === undefined ? {} : { lastValidBlockHeight, blocksRemaining: lastValidBlockHeight - height.value }) })
      else record('failure.block-height', 'error', { errorCode: height.code })
      if (!status) report.evidence = 'No signed transaction ID available. See the failed stage; the app did not reach submission.'
      else if (!status.ok) {
        record('failure.signature-history', 'error', { errorCode: status.code })
        report.evidence = 'Signature lookup unavailable. Transaction outcome is still unknown; do not infer failure from the timeout.'
      } else {
        const value = status.value.value[0]
        note('failure.signature-history', { found: !!value, rpcContextSlot: status.value.context.slot, ...(value ? { transactionSlot: value.slot, onchainError: value.err !== null, confirmed: value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized', finalized: value.confirmationStatus === 'finalized' } : {}) })
        if (value?.err) report.evidence = 'RPC history reports an on-chain execution error. Inspect the signature for program logs.'
        else if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') report.evidence = 'HTTP history reports success: the confirmation wait failed to report it. This is not an unlanded transaction.'
        else if (value) report.evidence = 'RPC saw the transaction, but confirmed/finalized status is not established yet.'
        else if (height.ok && lastValidBlockHeight !== undefined && height.value > lastValidBlockHeight) report.evidence = 'Blockhash expired and this RPC has no signature history record. Timing shows where time was spent; RPC data alone cannot distinguish a dropped broadcast from validator non-inclusion.'
        else report.evidence = 'This RPC has no signature history record yet. That alone does not prove the transaction failed.'
      }
      publish()
    },
  }
}

export type RecoveryDiagnostics = ReturnType<typeof createRecoveryDiagnostics>
