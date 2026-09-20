import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountLayout, AccountState } from '@solana/spl-token'
import { PUMP_PROGRAMS, MAX_RENT_ACCOUNTS, pumpAddress, pumpBlockReason, tokenRentAccount, closeRentInstruction, rentTotals, estimatedRentLabel, selectRentBatch, assertUnchanged, scanPumpRent, scanTokenRent, prepareRentRecovery, submitRentRecovery } from '../lib/absorb.ts'

const signer = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
const user = signer.publicKey
const other = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey
const rent = 1346200
const address = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey
function pumpInfo(program = PUMP_PROGRAMS[0].id) {
  const data = Buffer.alloc(137)
  Buffer.from([86, 255, 112, 14, 102, 53, 154, 250]).copy(data)
  user.toBuffer().copy(data, 8)
  return { owner: program, data, lamports: rent, executable: false, rentEpoch: 0 }
}
function tokenInfo(program = TOKEN_PROGRAM_ID, changes = {}, extension = Buffer.alloc(0)) {
  const data = Buffer.alloc(extension.length ? 166 + extension.length : 165)
  AccountLayout.encode({ mint: other, owner: user, amount: 0n, delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default, ...changes }, data)
  if (extension.length) { data[165] = 2; extension.copy(data, 166) }
  return { owner: program, data, lamports: 1513840, executable: false, rentEpoch: 0 }
}
const pumpRow = (index = 0) => ({ address: pumpAddress(user, PUMP_PROGRAMS[index].id).toBase58(), program: PUMP_PROGRAMS[index].id.toBase58(), lamports: rent, label: PUMP_PROGRAMS[index].label })
const tokenRow = () => tokenRentAccount(address, tokenInfo(), user)

test('PDA matches the user-supplied transaction and differs between programs', () => {
  const wallet = new PublicKey('8CoTJFv46cVTy4uNaXNG2w8asc9wdtNdo6bPpfHjXSL7')
  assert.equal(pumpAddress(wallet, PUMP_PROGRAMS[0].id).toBase58(), '7UZ6CAeDdsi9EScA1GsNburUYGfTqGfhLtgqDjgKWCX7')
  assert.notEqual(pumpAddress(wallet, PUMP_PROGRAMS[0].id).toBase58(), pumpAddress(wallet, PUMP_PROGRAMS[1].id).toBase58())
})

test('only known, wallet-owned rent-only Pump layouts pass', () => {
  for (const { id } of PUMP_PROGRAMS) assert.equal(pumpBlockReason(pumpInfo(id), user, id, rent), undefined)
  for (const change of [info => { info.owner = TOKEN_PROGRAM_ID }, info => { info.executable = true }, info => { info.data = Buffer.alloc(86) }, info => { info.data[0] = 0 }, info => { other.toBuffer().copy(info.data, 8) }, info => { info.data[136] = 1 }, info => { info.lamports++ }, info => { info.lamports-- }]) {
    const info = pumpInfo(); change(info)
    assert.ok(pumpBlockReason(info, user, PUMP_PROGRAMS[0].id, rent))
  }
})

test('Pump pending rewards, unsettled volume and both cashback currencies block closure', () => {
  for (const offset of [40, 41, 57, 74, 90]) {
    const info = pumpInfo(); info.data[offset] = 1
    assert.ok(pumpBlockReason(info, user, PUMP_PROGRAMS[0].id, rent))
  }
  const info = pumpInfo(); info.data[49] = 1; info.data[73] = 1; info.data[82] = 1; info.data[98] = 1
  assert.equal(pumpBlockReason(info, user, PUMP_PROGRAMS[0].id, rent), undefined, 'past claimed totals are not pending rewards')
})

test('empty SPL and ImmutableOwner Token-2022 accounts use their actual lamports and owning program', () => {
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const extension = program.equals(TOKEN_2022_PROGRAM_ID) ? Buffer.from([7, 0, 0, 0]) : Buffer.alloc(0)
    const row = tokenRentAccount(address, tokenInfo(program, {}, extension), user)
    assert.equal(row.lamports, 1513840)
    assert.equal(row.blocked, undefined)
    const ix = closeRentInstruction('token', row, user)
    assert.ok(ix.programId.equals(program)); assert.equal(ix.data[0], 9)
    assert.ok(ix.keys[1].pubkey.equals(user)); assert.ok(ix.keys[2].isSigner)
  }
})

test('nonempty, native SOL and foreign-owner accounts never enter token recovery', () => {
  for (const changes of [{ amount: 1n }, { amount: 2n ** 63n }, { isNativeOption: 1, isNative: 1513840n }, { owner: other }]) assert.equal(tokenRentAccount(address, tokenInfo(TOKEN_PROGRAM_ID, changes), user), null)
  assert.equal(tokenRentAccount(address, { ...tokenInfo(), owner: SystemProgram.programId }, user), null)
})

test('foreign close authority, withheld fees and unknown extensions are excluded', () => {
  assert.match(tokenRentAccount(address, tokenInfo(TOKEN_PROGRAM_ID, { closeAuthorityOption: 1, closeAuthority: other }), user).blocked, /authority/)
  const feeExtension = Buffer.alloc(12); feeExtension.writeUInt16LE(2); feeExtension.writeUInt16LE(8, 2); feeExtension.writeBigUInt64LE(1n, 4)
  assert.match(tokenRentAccount(address, tokenInfo(TOKEN_2022_PROGRAM_ID, {}, feeExtension), user).blocked, /Withheld/)
  assert.match(tokenRentAccount(address, tokenInfo(TOKEN_2022_PROGRAM_ID, {}, Buffer.from([8, 0, 1, 0, 1])), user).blocked, /extension/)
})

test('Pump closure matches official account order and contains no claim instruction', () => {
  for (let index = 0; index < 2; index++) {
    const row = pumpRow(index), ix = closeRentInstruction('pump', row, user)
    assert.equal(ix.programId.toBase58(), row.program)
    assert.deepEqual([...ix.data], [249, 69, 164, 218, 150, 103, 84, 138])
    assert.equal(ix.keys.length, 4)
    assert.ok(ix.keys[0].pubkey.equals(user)); assert.ok(ix.keys[0].isSigner && ix.keys[0].isWritable)
    assert.equal(ix.keys[1].pubkey.toBase58(), row.address)
    assert.equal(ix.keys[3].pubkey.toBase58(), row.program)
  }
  assert.throws(() => closeRentInstruction('pump', { ...pumpRow(), address: other.toBase58() }, user), /Invalid Pump/)
  assert.throws(() => closeRentInstruction('pump', { ...pumpRow(), blocked: 'Pending rewards' }, user), /Pending/)
})

test('rent recovery returns actual balances without service fees; invalid selections are rejected', () => {
  assert.deepEqual(rentTotals([pumpRow(), tokenRow()]), { gross: 2860040, net: 2860040 })
  assertUnchanged([pumpRow()], [pumpRow()])
  for (const fresh of [[], [{ ...pumpRow(), blocked: 'pending' }], [{ ...pumpRow(), lamports: rent + 1 }], [{ ...pumpRow(), program: TOKEN_PROGRAM_ID.toBase58() }]]) assert.throws(() => assertUnchanged([pumpRow()], fresh), /changed/)
  assert.throws(() => assertUnchanged([pumpRow(), pumpRow()], [pumpRow()]), /selection/)
  assert.throws(() => assertUnchanged(Array(MAX_RENT_ACCOUNTS + 1).fill(pumpRow()), [pumpRow()]), /selection/)
})

test('scanner handles closed Pump accounts and funded reward vaults', async () => {
  assert.deepEqual(await scanPumpRent({ getMultipleAccountsInfo: async () => [null, null] }, user), [])
  const rpc = { getMultipleAccountsInfo: async () => [pumpInfo(), null], getMinimumBalanceForRentExemption: async () => rent, getTokenAccountsByOwner: async () => ({ value: [{ pubkey: address, account: tokenInfo(TOKEN_PROGRAM_ID, { amount: 1n }) }] }) }
  assert.match((await scanPumpRent(rpc, user))[0].blocked, /Associated reward/)
  rpc.getTokenAccountsByOwner = async () => { throw new Error('RPC unavailable') }
  await assert.rejects(scanPumpRent(rpc, user), /RPC unavailable/)
})

function mockConnection() {
  const calls = []
  return {
    calls,
    getTokenAccountsByOwner: async (_owner, { programId }) => ({ value: programId.equals(TOKEN_PROGRAM_ID) ? [{ pubkey: address, account: tokenInfo() }] : [] }),
    getLatestBlockhash: async () => ({ blockhash: other.toBase58(), lastValidBlockHeight: 100 }),
    getFeeForMessage: async () => ({ value: 5000 }),
    getBalance: async () => 5000,
    simulateTransaction: async (transaction, config) => { assert.ok(transaction instanceof VersionedTransaction); calls.push(['simulate', config]); return { value: { err: null } } },
    sendRawTransaction: async (bytes, config) => { calls.push(['send', bytes, config]); return 'signature' },
    confirmTransaction: async () => ({ value: { err: null } }),
  }
}

test('preparation uses network fee estimate and adds no service-fee transfer', async () => {
  const rpc = mockConnection(), rows = await scanTokenRent(rpc, user)
  const preview = await prepareRentRecovery(rpc, user, 'token', rows)
  assert.equal(preview.networkFee, 5000)
  assert.ok(preview.transaction.instructions[0].programId.equals(TOKEN_PROGRAM_ID))
  assert.equal(preview.transaction.instructions.length, 1)
  assert.equal(preview.net, preview.gross)
  assert.equal(preview.transaction.serialize({ requireAllSignatures: false }).length < 1232, true)
  assert.equal(rpc.calls[0][1].sigVerify, false)
  rpc.getBalance = async () => 4999
  await assert.rejects(prepareRentRecovery(rpc, user, 'token', rows), /network fee/)
})

test('signed bytes are simulated without blockhash mutation and preflight stays enabled', async () => {
  const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
  preview.transaction.sign(signer)
  const bytes = preview.transaction.serialize()
  let sent
  assert.equal(await submitRentRecovery(rpc, preview.transaction, preview, () => true, signature => { sent = signature }), 'signature')
  assert.equal(sent, 'signature'); assert.equal(rpc.calls[1][1].sigVerify, true)
  assert.deepEqual(rpc.calls[2][1], bytes); assert.equal(rpc.calls[2][2].skipPreflight, false)
})

test('wallet mutation, simulation rejection and wallet switches never broadcast', async () => {
  for (const mode of ['mutation', 'simulation', 'switch']) {
    const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    if (mode === 'mutation') preview.transaction.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: other, lamports: 1 }))
    preview.transaction.sign(signer)
    if (mode === 'simulation') rpc.simulateTransaction = async () => ({ value: { err: { InstructionError: [0, 'Custom'] } } })
    await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => mode !== 'switch', () => {}))
    assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
  }
})

test('on-chain errors and confirmation timeouts never report success; sent signature remains available', async () => {
  for (const timeout of [false, true]) {
    const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    preview.transaction.sign(signer)
    rpc.confirmTransaction = async () => { if (timeout) throw new Error('Confirmation timeout'); return { value: { err: 'InstructionError' } } }
    let sent
    await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => true, signature => { sent = signature }))
    assert.equal(sent, 'signature')
  }
})

test('account changes during wallet approval are rejected before submission', async () => {
  const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
  preview.transaction.sign(signer)
  rpc.getTokenAccountsByOwner = async () => ({ value: [] })
  await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}), /changed/)
  assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
})

test('a ten-account mixed-token batch fits the Solana packet limit', () => {
  const tx = new Transaction({ feePayer: user, recentBlockhash: other.toBase58() })
  for (let index = 0; index < MAX_RENT_ACCOUNTS; index++) {
    const accountAddress = Keypair.fromSeed(new Uint8Array(32).fill(index + 30)).publicKey
    const row = tokenRentAccount(accountAddress, tokenInfo(index % 2 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID), user)
    tx.add(closeRentInstruction('token', row, user))
  }
  tx.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: other, lamports: 1000 }))
  assert.ok(tx.serialize({ requireAllSignatures: false }).length <= 1232)
})

test('Pump scanner returns eligible rent for both programs without touching reward vaults', async () => {
  let reads = 0
  const rpc = {
    getMultipleAccountsInfo: async () => PUMP_PROGRAMS.map(({ id }) => pumpInfo(id)),
    getMinimumBalanceForRentExemption: async size => { assert.equal(size, 137); return rent },
    getTokenAccountsByOwner: async () => { reads++; return { value: [] } },
  }
  const rows = await scanPumpRent(rpc, user)
  assert.equal(rows.length, 2); assert.equal(reads, 4)
  assert.ok(rows.every(row => row.lamports === rent && !row.blocked))
})

test('card estimate adds 0.0015 per account without changing actual rent values', () => {
  assert.equal(estimatedRentLabel(0), '0.0000')
  assert.equal(estimatedRentLabel(1), '0.0015')
  assert.equal(estimatedRentLabel(2), '0.0030')
  assert.equal(estimatedRentLabel(3), '0.0045')
  assert.equal(rentTotals([pumpRow()]).gross, rent)
})

function mixedConnection(count = 2) {
  const rpc = mockConnection()
  const tokens = Array.from({ length: count }, (_, index) => ({
    pubkey: Keypair.fromSeed(new Uint8Array(32).fill(index + 40)).publicKey,
    account: tokenInfo(index % 2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID),
  }))
  rpc.getTokenAccountsByOwner = async (owner, { programId }) => ({ value: owner.equals(user) ? tokens.filter(row => row.account.owner.equals(programId)) : [] })
  rpc.getMultipleAccountsInfo = async () => PUMP_PROGRAMS.map(({ id }) => pumpInfo(id))
  rpc.getMinimumBalanceForRentExemption = async () => rent
  return rpc
}

test('both categories combine into ONE transaction with no service-fee transfer', async () => {
  const rpc = mixedConnection()
  const rows = selectRentBatch([...(await scanTokenRent(rpc, user)), ...(await scanPumpRent(rpc, user))])
  const preview = await prepareRentRecovery(rpc, user, 'both', rows)
  assert.equal(rows.length, 4)
  assert.equal(preview.transaction.instructions.length, 4)
  const programs = preview.transaction.instructions.map(ix => ix.programId.toBase58())
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ...PUMP_PROGRAMS.map(item => item.id)]) assert.ok(programs.includes(program.toBase58()))
  assert.ok(!programs.includes(SystemProgram.programId.toBase58()))
  assert.equal(preview.net, rentTotals(rows).gross)
  preview.transaction.sign(signer)
  assert.equal(preview.transaction.signatures.length, 1)
  await submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {})
  assert.equal(rpc.calls.filter(([type]) => type === 'send').length, 1)
})

test('maximum combined batch includes both Pump accounts and fits one packet', async () => {
  const rpc = mixedConnection(20)
  const pump = await scanPumpRent(rpc, user)
  const rows = selectRentBatch([...(await scanTokenRent(rpc, user)), ...pump])
  assert.equal(rows.length, MAX_RENT_ACCOUNTS)
  assert.deepEqual(rows.slice(0, 2).map(row => row.address), pump.map(row => row.address))
  const preview = await prepareRentRecovery(rpc, user, 'both', rows)
  assert.ok(preview.transaction.serialize({ requireAllSignatures: false }).length <= 1232)
  assert.equal(preview.transaction.instructions.length, MAX_RENT_ACCOUNTS)
})

test('combined recovery never broadcasts when a Pump account changes after signing', async () => {
  const rpc = mixedConnection()
  const rows = selectRentBatch([...(await scanTokenRent(rpc, user)), ...(await scanPumpRent(rpc, user))])
  const preview = await prepareRentRecovery(rpc, user, 'both', rows)
  preview.transaction.sign(signer)
  rpc.getMultipleAccountsInfo = async () => [null, null]
  await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}), /changed/)
  assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
})
