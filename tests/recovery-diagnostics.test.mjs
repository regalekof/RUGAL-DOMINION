import test from 'node:test'
import assert from 'node:assert/strict'
import { createRecoveryDiagnostics } from '../lib/recovery-diagnostics.ts'

function fixture(status = null, height = 101) {
  const calls = []
  return {
    calls,
    getBlockHeight: async commitment => { calls.push(['height', commitment]); return height },
    getSignatureStatuses: async (signatures, config) => { calls.push(['status', signatures, config]); return { context: { slot: 120 }, value: [status] } },
  }
}
function signedDiagnostic(options = {}) {
  const diagnostic = createRecoveryDiagnostics('mainnet-beta', () => {}, options)
  diagnostic.blockhashReceived(100, 80)
  diagnostic.signed(Uint8Array.from({ length: 64 }, (_, index) => index === 63 ? 1 : 0))
  return diagnostic
}

test('timing separates wallet approval from blockhash age and records nested failure stage', async () => {
  let time = 100
  const diagnostic = signedDiagnostic({ now: () => time })
  await diagnostic.measure('wallet.approval', async () => { time += 12000 })
  const wallet = diagnostic.snapshot().entries.find(row => row.stage === 'wallet.approval' && row.event === 'ok')
  assert.equal(wallet.durationMs, 12000)
  assert.equal(wallet.blockhashAgeMs, 12000)
  await assert.rejects(diagnostic.measure('submit', () => diagnostic.measure('confirmation.wait', async () => {
    time += 30000
    throw new Error('Signature has expired: block height exceeded')
  })))
  assert.equal(diagnostic.snapshot().failedStage, 'confirmation.wait')
  assert.equal(diagnostic.snapshot().entries.at(-1).errorCode, 'BLOCKHEIGHT_EXPIRED')
})

test('reports never contain raw RPC errors, URLs or credentials; callbacks cannot break work', async () => {
  const diagnostic = createRecoveryDiagnostics('mainnet-beta', () => { throw new Error('broken UI observer') })
  const secret = 'secret-api-key-do-not-print'
  await assert.rejects(diagnostic.measure('send.rpc', async () => { throw new Error(`Failed to fetch https://example.test/?api-key=${secret}`) }))
  const report = JSON.stringify(diagnostic.snapshot())
  assert.ok(!report.includes(secret)); assert.ok(!report.includes('https://'))
  assert.match(report, /NETWORK_OR_RPC/)
  assert.equal(await diagnostic.measure('test', async () => 42), 42)
})

test('expired missing signature is evidence, not proof of a congestion or fee cause', async () => {
  const diagnostic = signedDiagnostic(), rpc = fixture()
  await diagnostic.inspectFailure(rpc)
  assert.match(diagnostic.snapshot().evidence, /expired.*no signature history record/)
  assert.match(diagnostic.snapshot().evidence, /cannot distinguish/)
  assert.equal(diagnostic.snapshot().signature, '1'.repeat(63) + '2')
  assert.deepEqual(rpc.calls.find(row => row[0] === 'status')[2], { searchTransactionHistory: true })
})

test('confirmed HTTP history distinguishes a missed confirmation from on-chain failure', async () => {
  for (const confirmationStatus of ['confirmed', 'finalized']) {
    const diagnostic = signedDiagnostic()
    await diagnostic.inspectFailure(fixture({ slot: 90, err: null, confirmationStatus }))
    assert.match(diagnostic.snapshot().evidence, /HTTP history reports success/)
  }
  const diagnostic = signedDiagnostic()
  await diagnostic.inspectFailure(fixture({ slot: 90, err: { InstructionError: [2, 'Custom'] }, confirmationStatus: 'confirmed' }))
  assert.match(diagnostic.snapshot().evidence, /on-chain execution error/)
})

test('unconfirmed observation and missing pre-expiry history never claim success or definitive failure', async () => {
  const diagnostic = signedDiagnostic()
  await diagnostic.inspectFailure(fixture({ slot: 90, err: null, confirmationStatus: 'processed' }, 95))
  assert.match(diagnostic.snapshot().evidence, /not established/)
  await diagnostic.inspectFailure(fixture(null, 95))
  assert.match(diagnostic.snapshot().evidence, /does not prove/)
})

test('failure diagnostics time out, do not throw or resend, and handle missing signatures', async () => {
  const diagnostic = signedDiagnostic({ timeoutMs: 5 })
  await diagnostic.inspectFailure({ getBlockHeight: () => new Promise(() => {}), getSignatureStatuses: () => new Promise(() => {}) })
  assert.match(diagnostic.snapshot().evidence, /outcome is still unknown/)
  assert.equal(diagnostic.snapshot().entries.at(-1).errorCode, 'DIAGNOSTIC_TIMEOUT')
  const unsigned = createRecoveryDiagnostics('devnet', () => {})
  const rpc = fixture()
  await unsigned.inspectFailure(rpc)
  assert.equal(rpc.calls.some(row => row[0] === 'status'), false)
  assert.match(unsigned.snapshot().evidence, /did not reach submission/)
})

test('height samples include request time and remaining blocks; failed samples stay non-fatal', async () => {
  const diagnostic = signedDiagnostic()
  await diagnostic.sampleHeight(fixture(null, 95), 'height.send-start')
  assert.equal(diagnostic.snapshot().entries.at(-1).details.blocksRemaining, 5)
  assert.equal(typeof diagnostic.snapshot().entries.at(-1).details.requestedAtMs, 'number')
  await diagnostic.sampleHeight({ getBlockHeight: async () => { throw new Error('429 at https://secret.test') } }, 'height.send-start')
  assert.equal(diagnostic.snapshot().entries.at(-1).errorCode, 'RATE_LIMITED')
  assert.ok(!JSON.stringify(diagnostic.snapshot()).includes('secret.test'))
})

test('reports are bounded snapshots and successful blockhash retry clears obsolete failure stage', async () => {
  const diagnostic = signedDiagnostic()
  await assert.rejects(diagnostic.measure('prepare.simulation', async () => { throw new Error('BlockhashNotFound') }))
  diagnostic.retrying()
  assert.equal(diagnostic.snapshot().failedStage, undefined)
  for (let i = 0; i < 150; i++) diagnostic.note('test', { count: i })
  const report = diagnostic.snapshot()
  assert.equal(report.entries.length, 100)
  report.entries[0].details.count = -1
  assert.notEqual(diagnostic.snapshot().entries[0].details.count, -1)
})
