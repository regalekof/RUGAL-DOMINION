import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmRentRecovery } from '../lib/absorb.ts'
import { createRecoveryDiagnostics } from '../lib/recovery-diagnostics.ts'

const wire = Buffer.from([1, 2, 3, 4])
const latest = { lastValidBlockHeight: 150, minContextSlot: 80 }
const response = (state = null) => ({ context: { slot: 100 }, value: [state] })
const confirmed = { slot: 99, confirmations: 1, confirmationStatus: 'confirmed', err: null }
function setup() {
  let time = 0
  const sends = []
  const runtime = { now: () => time, sleep: async ms => { time += ms } }
  const connection = {
    getBlockHeight: async () => 100,
    getSignatureStatuses: async () => response(),
    sendRawTransaction: async (bytes, config) => { sends.push({ bytes: Buffer.from(bytes), config, time }); return 'signature' },
    confirmTransaction: async () => { throw new Error('Websocket must not be needed') },
  }
  return { connection, runtime, sends }
}

test('HTTP confirmation succeeds immediately without a websocket or extra broadcast', async () => {
  const { connection, runtime, sends } = setup()
  connection.getSignatureStatuses = async () => response(confirmed)
  assert.equal(await confirmRentRecovery(connection, wire, 'signature', latest, () => true, undefined, runtime), 'signature')
  assert.equal(sends.length, 0)
})

test('missing transaction is rebroadcast at bounded intervals with identical bytes and preflight enabled', async () => {
  const { connection, runtime, sends } = setup()
  const diagnostics = createRecoveryDiagnostics('mainnet-beta', () => {}, { now: runtime.now })
  connection.getSignatureStatuses = async () => response(sends.length >= 3 ? confirmed : null)
  await confirmRentRecovery(connection, wire, 'signature', latest, () => true, diagnostics, runtime)
  assert.deepEqual(sends.map(send => send.time), [3000, 6000, 9000])
  for (const send of sends) {
    assert.deepEqual(send.bytes, wire)
    assert.deepEqual(send.config, { skipPreflight: false, preflightCommitment: 'confirmed', minContextSlot: 80, maxRetries: 0 })
  }
  assert.equal(diagnostics.snapshot().entries.at(-1).details.rebroadcasts, 3)
})

test('retry limit and wall-clock timeout prevent an endless loop', async () => {
  const { connection, runtime, sends } = setup()
  await assert.rejects(confirmRentRecovery(connection, wire, 'signature', latest, () => true, undefined, runtime), /Confirmation timeout/)
  assert.equal(sends.length, 10)
  assert.equal(runtime.now(), 90000)
})

test('expiry stops broadcasting and checks history before declaring expiration', async () => {
  const { connection, runtime, sends } = setup()
  let historyReads = 0
  connection.getBlockHeight = async () => runtime.now() < 7000 ? 149 : 151
  connection.getSignatureStatuses = async (_signatures, config) => {
    if (config?.searchTransactionHistory) historyReads++
    return response()
  }
  await assert.rejects(confirmRentRecovery(connection, wire, 'signature', latest, () => true, undefined, runtime), /expired/)
  assert.equal(historyReads, 1)
  assert.deepEqual(sends.map(send => send.time), [3000, 6000])
})

test('confirmation found during final history lookup wins over expiry', async () => {
  const { connection, runtime, sends } = setup()
  connection.getBlockHeight = async () => 151
  connection.getSignatureStatuses = async (_signatures, config) => response(config?.searchTransactionHistory ? confirmed : null)
  assert.equal(await confirmRentRecovery(connection, wire, 'signature', latest, () => true, undefined, runtime), 'signature')
  assert.equal(sends.length, 0)
})

test('processed transactions stop rebroadcasting but still wait for confirmation, even past expiry', async () => {
  const { connection, runtime, sends } = setup()
  connection.getBlockHeight = async () => 151
  connection.getSignatureStatuses = async () => response(runtime.now() >= 4000 ? confirmed : { ...confirmed, confirmationStatus: 'processed', confirmations: 0 })
  assert.equal(await confirmRentRecovery(connection, wire, 'signature', latest, () => true, undefined, runtime), 'signature')
  assert.equal(runtime.now(), 4000)
  assert.equal(sends.length, 0)
})

test('confirmed on-chain error stops without claiming success or rebroadcasting', async () => {
  const { connection, runtime, sends } = setup()
  connection.getSignatureStatuses = async () => response({ ...confirmed, err: { InstructionError: [2, 'Custom'] } })
  await assert.rejects(confirmRentRecovery(connection, wire, 'signature', latest, () => true, undefined, runtime), /failed on-chain/)
  assert.equal(sends.length, 0)
})

test('read failures cannot authorize a broadcast without a known valid height and missing status', async () => {
  for (const failedRead of ['getBlockHeight', 'getSignatureStatuses']) {
    const { connection, runtime, sends } = setup()
    const normal = connection[failedRead]
    connection[failedRead] = async (...args) => {
      if (runtime.now() < 5000) throw new Error('429 temporary RPC error')
      return normal(...args)
    }
    const readStatus = connection.getSignatureStatuses
    connection.getSignatureStatuses = async (...args) => sends.length ? response(confirmed) : readStatus(...args)
    await confirmRentRecovery(connection, wire, 'signature', latest, () => true, undefined, runtime)
    assert.equal(sends.length, 1)
    assert.ok(sends[0].time >= 5000)
  }
})

test('a transient rebroadcast error does not abort original confirmation and later retries reuse the bytes', async () => {
  const { connection, runtime, sends } = setup()
  const send = connection.sendRawTransaction
  connection.sendRawTransaction = async (...args) => {
    const signature = await send(...args)
    if (sends.length === 1) throw new Error('Failed to fetch')
    return signature
  }
  connection.getSignatureStatuses = async () => response(sends.length >= 2 ? confirmed : null)
  await confirmRentRecovery(connection, wire, 'signature', latest, () => true, undefined, runtime)
  assert.equal(sends.length, 2)
  assert.deepEqual(sends[0].bytes, sends[1].bytes)
})

test('a pending rebroadcast never overlaps another; polling still detects confirmation', async () => {
  const { connection, runtime, sends } = setup()
  let finishSend
  connection.sendRawTransaction = async (bytes, config) => {
    sends.push({ bytes, config })
    return new Promise(resolve => { finishSend = resolve })
  }
  connection.getSignatureStatuses = async () => response(runtime.now() >= 10000 ? confirmed : null)
  await confirmRentRecovery(connection, wire, 'signature', latest, () => true, undefined, runtime)
  assert.equal(sends.length, 1)
  finishSend('signature')
  await Promise.resolve()
  assert.equal(sends.length, 1)
})

test('wallet switch stops future broadcasts even if it occurs during a status read', async () => {
  const { connection, runtime, sends } = setup()
  let current = true
  connection.getSignatureStatuses = async () => { if (runtime.now() >= 4000) current = false; return response() }
  await assert.rejects(confirmRentRecovery(connection, wire, 'signature', latest, () => current, undefined, runtime), /Wallet or network changed after submission/)
  assert.equal(sends.length, 1)
})

test('unavailable history after expiry stays unknown instead of claiming definitive failure', async () => {
  const { connection, runtime, sends } = setup()
  connection.getBlockHeight = async () => 151
  connection.getSignatureStatuses = async (_signatures, config) => {
    if (config?.searchTransactionHistory) throw new Error('History unavailable')
    return response()
  }
  await assert.rejects(confirmRentRecovery(connection, wire, 'signature', latest, () => true, undefined, runtime), /Confirmation is unknown/)
  assert.equal(sends.length, 0)
})
