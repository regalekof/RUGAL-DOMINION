import test from 'node:test'
import assert from 'node:assert/strict'
import { ComputeBudgetProgram, ComputeBudgetInstruction, Keypair, PublicKey, SystemProgram, SystemInstruction, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountLayout, AccountState } from '@solana/spl-token'
import { PUMP_PROGRAMS, MAX_RENT_ACCOUNTS, RENT_BATCH_BYTE_TARGET, LIGHTHOUSE_PROGRAM_ID, pumpAddress, pumpBlockReason, tokenRentAccount, closeRentInstruction, rentTotals, estimatedRentLabel, createRentReview, selectRentBatch, assertUnchanged, scanRentCategories, scanPumpRent, scanTokenRent, prepareRentRecovery, submitRentRecovery, recoveryMessageDifference, retryRecoveryRead } from '../lib/absorb.ts'

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

test('foreign close authority and withheld fees are blocked without blanket-excluding extensions', () => {
  assert.match(tokenRentAccount(address, tokenInfo(TOKEN_PROGRAM_ID, { closeAuthorityOption: 1, closeAuthority: other }), user).blocked, /authority/)
  const feeExtension = Buffer.alloc(12); feeExtension.writeUInt16LE(2); feeExtension.writeUInt16LE(8, 2); feeExtension.writeBigUInt64LE(1n, 4)
  assert.match(tokenRentAccount(address, tokenInfo(TOKEN_2022_PROGRAM_ID, {}, feeExtension), user).blocked, /Withheld/)
  assert.equal(tokenRentAccount(address, tokenInfo(TOKEN_2022_PROGRAM_ID, {}, Buffer.from([8, 0, 1, 0, 1])), user).blocked, undefined)
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

test('rent recovery charges 2% per actual account balance; invalid selections are rejected', () => {
  assert.deepEqual(rentTotals([pumpRow(), tokenRow()]), { gross: 2860040, fee: 57200, net: 2802840 })
  assert.equal(rentTotals([{ ...tokenRow(), lamports: 149 }, { ...pumpRow(), lamports: 149 }]).fee, 4, 'round down per account, not after summing')
  assert.throws(() => rentTotals([{ ...tokenRow(), lamports: -1 }]), /Invalid/)
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
    getMultipleAccountsInfo: async keys => keys.map(key => key.equals(address) ? tokenInfo() : null),
    getLatestBlockhashAndContext: async () => ({ context: { slot: 80 }, value: { blockhash: other.toBase58(), lastValidBlockHeight: 100 } }),
    getFeeForMessage: async () => ({ value: 5000 }),
    getBalance: async () => 5000,
    simulateTransaction: async (transaction, config) => { assert.ok(transaction instanceof VersionedTransaction); calls.push(['simulate', config]); return { value: { err: null } } },
    sendRawTransaction: async (bytes, config) => { calls.push(['send', bytes, config]); return 'signature' },
    confirmTransaction: async () => ({ value: { err: null } }),
  }
}

test('preparation adds the 2% service transfer after closing', async () => {
  const rpc = mockConnection(), rows = await scanTokenRent(rpc, user)
  const preview = await prepareRentRecovery(rpc, user, 'token', rows)
  assert.equal(preview.networkFee, 5000)
  assert.ok(preview.transaction.instructions[1].programId.equals(TOKEN_PROGRAM_ID))
  assert.equal(preview.transaction.instructions.length, 3)
  const feeTransfer = SystemInstruction.decodeTransfer(preview.transaction.instructions.at(-1))
  assert.equal(feeTransfer.toPubkey.toBase58(), 'Dkmdvd9iZWKGXiSNExgYYX7PZNncewM4WqHBgN1knUzH')
  assert.ok(feeTransfer.fromPubkey.equals(user))
  assert.equal(feeTransfer.lamports, BigInt(30276))
  assert.equal(preview.net, preview.gross - preview.fee)
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

test('explicit priority policy survives wallet serialization without triggering Phantom auto-injection', async () => {
  const rpc = mockConnection()
  let estimatedMessage
  rpc.getFeeForMessage = async message => { estimatedMessage = message.serialize(); return { value: 5000 } }
  const preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
  assert.deepEqual(estimatedMessage, preview.expectedMessage)
  // Model the wallet transport and Phantom's documented rule: only inject when
  // no compute-unit price/limit instruction is present. No real wallet is used.
  const walletTx = Transaction.from(preview.transaction.serialize({ requireAllSignatures: false }))
  const budget = walletTx.instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId))
  assert.equal(budget.length, 1)
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(budget[0]).microLamports, 0n)
  const hasPriorityPolicy = budget.some(ix => ['SetComputeUnitPrice', 'SetComputeUnitLimit'].includes(ComputeBudgetInstruction.decodeInstructionType(ix)))
  if (!hasPriorityPolicy) walletTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }))
  walletTx.sign(signer)
  const returned = Transaction.from(walletTx.serialize())
  assert.deepEqual(returned.serializeMessage(), preview.expectedMessage)
  await submitRentRecovery(rpc, returned, preview, () => true, () => {})
  assert.equal(rpc.calls.filter(([type]) => type === 'send').length, 1)
})

test('changed compute price, recipient, blockhash or recovery destination still blocks broadcast', async () => {
  for (const change of [
    tx => { tx.instructions[0] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }) },
    tx => { tx.instructions.at(-1).keys[1].pubkey = other },
    tx => { tx.recentBlockhash = address.toBase58() },
    tx => { tx.instructions[1].keys[1].pubkey = other },
  ]) {
    const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    const walletTx = Transaction.from(preview.transaction.serialize({ requireAllSignatures: false }))
    change(walletTx)
    walletTx.sign(signer)
    await assert.rejects(submitRentRecovery(rpc, walletTx, preview, () => true, () => {}), /wallet changed the transaction/)
    assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
  }
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

test('recovery comparison accepts identical plain byte arrays without trusting wallet Buffer.equals', async () => {
  const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
  const sameBytes = Uint8Array.from(preview.expectedMessage)
  assert.equal(recoveryMessageDifference(preview.expectedMessage, sameBytes), undefined)
  preview.transaction.sign(signer)
  const serializeMessage = preview.transaction.serializeMessage.bind(preview.transaction)
  preview.transaction.serializeMessage = () => {
    const bytes = serializeMessage()
    bytes.equals = () => { throw new Error('Must not use the wallet Buffer comparison') }
    return bytes
  }
  await submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {})
  assert.equal(rpc.calls.filter(([type]) => type === 'send').length, 1)
})

test('recovery mismatch diagnostics identify changes without broadcasting or exposing addresses', async () => {
  for (const [change, reason] of [
    [tx => { tx.instructions[0] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }) }, 'compute-budget instructions changed'],
    [tx => { tx.recentBlockhash = address.toBase58() }, 'blockhash changed'],
    [tx => { tx.instructions.at(-1).data[4] ^= 1 }, 'instruction 3 data changed'],
    [tx => { tx.instructions.push(tx.instructions[1]) }, 'instruction count changed (3 to 4)'],
  ]) {
    const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    change(preview.transaction)
    preview.transaction.sign(signer)
    assert.equal(recoveryMessageDifference(preview.expectedMessage, preview.transaction.serializeMessage()), reason)
    await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}), error => {
      assert.ok(error.message.includes(`Recovery check v3: ${reason}`))
      assert.ok(!error.message.includes(user.toBase58()))
      return true
    })
    assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
  }
})

function lighthouseGuard(target = user) {
  return new TransactionInstruction({
    programId: LIGHTHOUSE_PROGRAM_ID,
    keys: [{ pubkey: target, isSigner: false, isWritable: false }],
    // AssertAccountInfo, silent log, Executable(false), Equal.
    data: Buffer.from([5, 0, 7, 0, 0]),
  })
}

test('two Phantom Lighthouse assertions may augment four recovery instructions; exact signed bytes are sent', async () => {
  const rpc = mixedConnection(1)
  const readAccounts = rpc.getMultipleAccountsInfo
  rpc.getMultipleAccountsInfo = async keys => keys[0].equals(pumpAddress(user, PUMP_PROGRAMS[0].id)) ? [pumpInfo(), null] : readAccounts(keys)
  const rows = [...await scanTokenRent(rpc, user), ...await scanPumpRent(rpc, user)]
  const preview = await prepareRentRecovery(rpc, user, 'both', rows)
  assert.equal(preview.transaction.instructions.length, 4)
  const walletTx = Transaction.from(preview.transaction.serialize({ requireAllSignatures: false }))
  walletTx.instructions.unshift(lighthouseGuard(user))
  walletTx.add(lighthouseGuard(new PublicKey(rows[0].address)))
  assert.equal(walletTx.instructions.length, 6)
  walletTx.sign(signer)
  const returned = Transaction.from(walletTx.serialize())
  assert.equal(recoveryMessageDifference(preview.expectedMessage, returned.serializeMessage()), undefined)
  await submitRentRecovery(rpc, returned, preview, () => true, () => {})
  const send = rpc.calls.find(([type]) => type === 'send')
  assert.deepEqual(send[1], returned.serialize(), 'never strip guards from signed bytes')
  assert.equal(send[2].skipPreflight, false)
})

test('Lighthouse guards never permit modified recovery instructions, transfers, ordering, payer or blockhash', async () => {
  for (const change of [
    tx => { tx.instructions[0] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10 }) },
    tx => { tx.instructions[1].keys[1].pubkey = other },
    tx => { tx.instructions[2].keys[1].pubkey = other },
    tx => { tx.instructions[2].data[4] ^= 1 },
    tx => { tx.instructions.splice(1, 1) },
    tx => { [tx.instructions[1], tx.instructions[2]] = [tx.instructions[2], tx.instructions[1]] },
    tx => { tx.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: other, lamports: 1 })) },
    tx => { tx.recentBlockhash = address.toBase58() },
    tx => { tx.feePayer = other },
  ]) {
    const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    const walletTx = Transaction.from(preview.transaction.serialize({ requireAllSignatures: false }))
    walletTx.add(lighthouseGuard())
    change(walletTx)
    await assert.rejects(submitRentRecovery(rpc, walletTx, preview, () => true, () => {}), /wallet changed/)
    assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
  }
})

test('unknown programs, Lighthouse memory writes, unknown opcodes and privilege escalation stay blocked', async () => {
  for (const change of [
    guard => { guard.programId = other },
    guard => { guard.data[0] = 0 },
    guard => { guard.data[0] = 1 },
    guard => { guard.data[0] = 255 },
    guard => { guard.data = Buffer.alloc(0) },
    guard => { guard.keys.push({ pubkey: other, isSigner: false, isWritable: false }) },
    guard => { guard.keys[0] = { pubkey: other, isSigner: false, isWritable: true } },
    guard => { guard.keys[0] = { pubkey: other, isSigner: true, isWritable: false } },
    guard => { guard.keys[0] = { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: true } },
  ]) {
    const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    const walletTx = Transaction.from(preview.transaction.serialize({ requireAllSignatures: false }))
    const guard = lighthouseGuard(); change(guard); walletTx.add(guard)
    await assert.rejects(submitRentRecovery(rpc, walletTx, preview, () => true, () => {}), /wallet changed/)
    assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
  }
})

test('guard targets may be additional read-only accounts; assertion simulation failure still prevents sending', async () => {
  const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
  preview.transaction.add(lighthouseGuard(other))
  preview.transaction.sign(signer)
  assert.equal(recoveryMessageDifference(preview.expectedMessage, preview.transaction.serializeMessage()), undefined)
  rpc.simulateTransaction = async () => ({ value: { err: { InstructionError: [3, 'Custom'] } } })
  await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}), /simulation failed/)
  assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
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
  rpc.getMultipleAccountsInfo = async keys => keys.map(() => null)
  await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}), /changed/)
  assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
})

test('a ten-account mixed-token batch fits the Solana packet limit', () => {
  const tx = new Transaction({ feePayer: user, recentBlockhash: other.toBase58() })
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }))
  for (let index = 0; index < 10; index++) {
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
  rpc.getMultipleAccountsInfo = async keys => keys.map(key => {
    const pump = PUMP_PROGRAMS.find(({ id }) => pumpAddress(user, id).equals(key))
    return pump ? pumpInfo(pump.id) : tokens.find(row => row.pubkey.equals(key))?.account ?? null
  })
  rpc.getMinimumBalanceForRentExemption = async () => rent
  return rpc
}

test('both categories combine into ONE transaction with one aggregated service transfer', async () => {
  const rpc = mixedConnection()
  const rows = selectRentBatch([...(await scanTokenRent(rpc, user)), ...(await scanPumpRent(rpc, user))], user)
  const preview = await prepareRentRecovery(rpc, user, 'both', rows)
  assert.equal(rows.length, 4)
  assert.equal(preview.transaction.instructions.length, 6)
  const programs = preview.transaction.instructions.map(ix => ix.programId.toBase58())
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ...PUMP_PROGRAMS.map(item => item.id)]) assert.ok(programs.includes(program.toBase58()))
  assert.equal(programs.filter(program => program === SystemProgram.programId.toBase58()).length, 1)
  const transfer = SystemInstruction.decodeTransfer(preview.transaction.instructions.at(-1))
  assert.equal(transfer.toPubkey.toBase58(), 'Dkmdvd9iZWKGXiSNExgYYX7PZNncewM4WqHBgN1knUzH')
  assert.equal(transfer.lamports, BigInt(rentTotals(rows).fee))
  assert.equal(preview.net, rentTotals(rows).net)
  preview.transaction.sign(signer)
  assert.equal(preview.transaction.signatures.length, 1)
  await submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {})
  assert.equal(rpc.calls.filter(([type]) => type === 'send').length, 1)
})

test('maximum combined batch includes both Pump accounts and fits one packet', async () => {
  const rpc = mixedConnection(100)
  const pump = await scanPumpRent(rpc, user)
  const rows = selectRentBatch([...(await scanTokenRent(rpc, user)), ...pump], user)
  assert.equal(MAX_RENT_ACCOUNTS, 100)
  assert.ok(rows.length > 10 && rows.length < MAX_RENT_ACCOUNTS)
  assert.deepEqual(rows.slice(0, 2).map(row => row.address), pump.map(row => row.address))
  const preview = await prepareRentRecovery(rpc, user, 'both', rows)
  assert.ok(preview.transaction.serialize({ requireAllSignatures: false }).length <= RENT_BATCH_BYTE_TARGET)
  assert.equal(preview.transaction.instructions.length, rows.length + 2)
  preview.transaction.add(lighthouseGuard(), lighthouseGuard(new PublicKey(rows[0].address)))
  assert.ok(preview.transaction.serialize({ requireAllSignatures: false }).length <= 1232)
})

test('combined recovery never broadcasts when a Pump account changes after signing', async () => {
  const rpc = mixedConnection()
  const rows = selectRentBatch([...(await scanTokenRent(rpc, user)), ...(await scanPumpRent(rpc, user))], user)
  const preview = await prepareRentRecovery(rpc, user, 'both', rows)
  preview.transaction.sign(signer)
  rpc.getMultipleAccountsInfo = async () => [null, null]
  await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}), /changed/)
  assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
})

test('recovery revalidates only selected token accounts with one batched read per check', async () => {
  const rpc = mixedConnection(20)
  const selected = (await scanTokenRent(rpc, user)).slice(0, 3)
  let reads = 0
  const readAccounts = rpc.getMultipleAccountsInfo
  rpc.getMultipleAccountsInfo = async keys => {
    reads++
    assert.deepEqual(keys.map(key => key.toBase58()), selected.map(row => row.address))
    return readAccounts(keys)
  }
  rpc.getTokenAccountsByOwner = async () => { throw new Error('Must not rescan the whole wallet') }
  const preview = await prepareRentRecovery(rpc, user, 'token', selected)
  assert.equal(reads, 1)
  preview.transaction.sign(signer)
  await submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {})
  assert.equal(reads, 2, 'post-signing state is always reread, never cached')
})

test('selected-account checks still reject changed balance, owner, authority and extensions', async () => {
  for (const info of [
    tokenInfo(TOKEN_PROGRAM_ID, { amount: 1n }),
    tokenInfo(TOKEN_PROGRAM_ID, { owner: other }),
    tokenInfo(TOKEN_PROGRAM_ID, { closeAuthorityOption: 1, closeAuthority: other }),
    { ...tokenInfo(), lamports: 1 },
    { ...tokenInfo(), owner: SystemProgram.programId },
  ]) {
    const rpc = mockConnection()
    const preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    preview.transaction.sign(signer)
    rpc.getMultipleAccountsInfo = async () => [info]
    await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}), /changed/)
    assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
  }
})

test('temporary read failures get one retry; persistent failures and validation errors stop', async () => {
  let attempts = 0
  assert.equal(await retryRecoveryRead(async () => {
    if (++attempts === 1) throw new TypeError('Failed to fetch')
    return 'recovered'
  }), 'recovered')
  assert.equal(attempts, 2)
  attempts = 0
  await assert.rejects(retryRecoveryRead(async () => { attempts++; throw new TypeError('Failed to fetch') }), /Failed to fetch/)
  assert.equal(attempts, 2)
  for (const message of ['401 Unauthorized', 'Invalid account', '403 Forbidden']) {
    attempts = 0
    await assert.rejects(retryRecoveryRead(async () => { attempts++; throw new Error(message) }))
    assert.equal(attempts, 1)
  }
})

test('scan transport recovery retries only the failed request and never retries a send', async () => {
  const rpc = mockConnection()
  let reads = 0
  rpc.getMultipleAccountsInfo = async () => {
    if (++reads === 1) throw new TypeError('Failed to fetch')
    return [tokenInfo()]
  }
  const preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
  assert.equal(reads, 2)
  preview.transaction.sign(signer)
  let sends = 0
  rpc.sendRawTransaction = async () => { sends++; throw new TypeError('Failed to fetch') }
  await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}), /Failed to fetch/)
  assert.equal(sends, 1)
})

test('earlier balance reads do not skip the affordability check', async () => {
  const rpc = mockConnection()
  let balanceStarted = false
  rpc.getFeeForMessage = async () => {
    await Promise.resolve()
    assert.ok(balanceStarted)
    return { value: 5000 }
  }
  rpc.getBalance = async () => { balanceStarted = true; return 4999 }
  await assert.rejects(prepareRentRecovery(rpc, user, 'token', [tokenRow()]), /network fee/)
})

test('unsigned BlockhashNotFound rebuilds once with a fresh blockhash, slot and message snapshot', async () => {
  const rpc = mockConnection()
  let blockhashReads = 0, simulations = 0, accountReads = 0
  rpc.getLatestBlockhashAndContext = async () => ({
    context: { slot: ++blockhashReads === 1 ? 80 : 81 },
    value: { blockhash: blockhashReads === 1 ? other.toBase58() : address.toBase58(), lastValidBlockHeight: 100 + blockhashReads },
  })
  rpc.getMultipleAccountsInfo = async () => { accountReads++; return [tokenInfo()] }
  rpc.simulateTransaction = async (tx, config) => {
    assert.equal(config.sigVerify, false)
    assert.equal(config.replaceRecentBlockhash, false)
    assert.equal(config.minContextSlot, 80 + simulations)
    return { value: { err: ++simulations === 1 ? 'BlockhashNotFound' : null } }
  }
  const preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
  assert.equal(blockhashReads, 2); assert.equal(accountReads, 2)
  assert.equal(preview.latest.blockhash, address.toBase58())
  assert.equal(preview.latest.lastValidBlockHeight, 102)
  assert.equal(preview.minContextSlot, 81)
  assert.deepEqual(preview.expectedMessage, preview.transaction.serializeMessage())
})

test('unsigned blockhash refresh is bounded and reruns selection safety checks', async () => {
  const rpc = mockConnection()
  let simulations = 0
  rpc.simulateTransaction = async () => { simulations++; return { value: { err: 'BlockhashNotFound' } } }
  await assert.rejects(prepareRentRecovery(rpc, user, 'token', [tokenRow()]), /fresh blockhash/)
  assert.equal(simulations, 2)
  let reads = 0
  rpc.getMultipleAccountsInfo = async () => ++reads === 1 ? [tokenInfo()] : [null]
  await assert.rejects(prepareRentRecovery(rpc, user, 'token', [tokenRow()]), /account changed/)
  assert.equal(reads, 2)
})

test('signed blockhash lag retries identical bytes once with slot constraint and preserves confirmation metadata', async () => {
  for (const contextError of [false, true]) {
    const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    preview.transaction.sign(signer)
    const bytes = preview.transaction.serialize()
    let attempts = 0
    rpc.getLatestBlockhashAndContext = async () => { throw new Error('Must not rebuild a signed transaction') }
    rpc.simulateTransaction = async (tx, config) => {
      assert.deepEqual(Buffer.from(tx.serialize()), bytes)
      assert.equal(config.minContextSlot, preview.minContextSlot)
      assert.equal(config.replaceRecentBlockhash, false)
      assert.equal(config.sigVerify, true)
      if (++attempts === 1) {
        if (contextError) throw new Error('Minimum context slot has not been reached')
        return { value: { err: 'BlockhashNotFound' } }
      }
      return { value: { err: null } }
    }
    rpc.confirmTransaction = async config => {
      assert.equal(config.blockhash, preview.latest.blockhash)
      assert.equal(config.lastValidBlockHeight, preview.latest.lastValidBlockHeight)
      return { value: { err: null } }
    }
    await submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {})
    assert.equal(attempts, 2)
    const send = rpc.calls.find(([type]) => type === 'send')
    assert.deepEqual(send[1], bytes)
    assert.equal(send[2].minContextSlot, preview.minContextSlot)
  }
})

test('persistently unavailable signed blockhash asks for reapproval without sending or changing the signature', async () => {
  const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
  preview.transaction.sign(signer)
  const bytes = preview.transaction.serialize()
  let attempts = 0
  rpc.simulateTransaction = async () => { attempts++; return { value: { err: 'BlockhashNotFound' } } }
  await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}), /Nothing was sent.*sign again/)
  assert.equal(attempts, 2)
  assert.deepEqual(preview.transaction.serialize(), bytes)
  assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
})

test('wallet change during a blockhash-lag retry never broadcasts', async () => {
  const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
  preview.transaction.sign(signer)
  let current = true, attempts = 0
  rpc.simulateTransaction = async () => {
    current = false
    return { value: { err: ++attempts === 1 ? 'BlockhashNotFound' : null } }
  }
  await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => current, () => {}), /Wallet or network changed/)
  assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
})

test('review is a synchronous copied snapshot; preparation and simulation run only on approval', async () => {
  const rpc = mockConnection()
  let reads = 0
  rpc.getMultipleAccountsInfo = async () => { reads++; return [tokenInfo()] }
  const accounts = [tokenRow()]
  const review = createRentReview('token', accounts)
  assert.equal(review instanceof Promise, false)
  assert.notEqual(review.accounts, accounts)
  assert.notEqual(review.accounts[0], accounts[0])
  assert.equal(reads, 0); assert.equal(rpc.calls.length, 0)
  const preview = await prepareRentRecovery(rpc, user, review.kind, review.accounts)
  assert.equal(reads, 1)
  assert.equal(rpc.calls.filter(([type, config]) => type === 'simulate' && !config.sigVerify).length, 1)
  preview.transaction.sign(signer)
  await submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {})
  assert.equal(reads, 2, 'post-signature state validation remains')
  assert.equal(rpc.calls.filter(([type, config]) => type === 'simulate' && config.sigVerify).length, 1)
})

test('100-account review cap is distinct from transaction byte limits', async () => {
  const rpc = mixedConnection(101)
  const accounts = await scanTokenRent(rpc, user)
  assert.equal(createRentReview('token', accounts.slice(0, 100)).accounts.length, 100)
  assert.throws(() => createRentReview('token', accounts), /selection/)
  assert.throws(() => createRentReview('pump', accounts.slice(0, 1)), /selection/)
  await assert.rejects(prepareRentRecovery(rpc, user, 'token', accounts.slice(0, 100)), /too large for one transaction/)
})

test('size-based batches cover 100 accounts without duplicates and exceed the old ten-account limit', async () => {
  const rpc = mixedConnection(100)
  let remaining = await scanTokenRent(rpc, user)
  const covered = new Set()
  while (remaining.length) {
    const batch = selectRentBatch([...remaining, remaining[0]], user)
    assert.ok(batch.length > 0 && batch.length <= 100)
    if (!covered.size) assert.ok(batch.length > 10)
    const preview = await prepareRentRecovery(rpc, user, 'token', batch)
    assert.ok(preview.transaction.serialize({ requireAllSignatures: false }).length <= RENT_BATCH_BYTE_TARGET)
    for (const row of batch) { assert.equal(covered.has(row.address), false); covered.add(row.address) }
    remaining = remaining.filter(row => !covered.has(row.address))
  }
  assert.equal(covered.size, 100)
})

test('extension accounts can reach simulation, but program rejection still prevents signing or sending', async () => {
  const rpc = mockConnection()
  const info = tokenInfo(TOKEN_2022_PROGRAM_ID, {}, Buffer.from([8, 0, 1, 0, 1]))
  const row = tokenRentAccount(address, info, user)
  assert.equal(row.blocked, undefined)
  rpc.getMultipleAccountsInfo = async () => [info]
  let simulations = 0
  rpc.simulateTransaction = async () => { simulations++; return { value: { err: { InstructionError: [1, 'Custom'] } } } }
  await assert.rejects(prepareRentRecovery(rpc, user, 'token', [row]), /simulation failed/)
  assert.equal(simulations, 1)
  assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
})

test('token scan results are published while the Pump scan is still pending', async () => {
  const rpc = mockConnection()
  let releasePump, reportToken
  rpc.getMultipleAccountsInfo = () => new Promise(resolve => { releasePump = resolve })
  const tokenReady = new Promise(resolve => { reportToken = resolve })
  const results = []
  const finished = scanRentCategories(rpc, user, (kind, result) => {
    results.push([kind, result])
    if (kind === 'token') reportToken()
  })
  await tokenReady
  assert.deepEqual(results.map(([kind]) => kind), ['token'])
  assert.equal(results[0][1].accounts.length, 1)
  releasePump([null, null])
  await finished
  assert.deepEqual(results.map(([kind]) => kind), ['token', 'pump'])
})

test('a failing category does not discard another category scan result', async () => {
  const rpc = mockConnection()
  rpc.getMultipleAccountsInfo = async () => { throw new Error('RPC unavailable') }
  const results = {}
  await scanRentCategories(rpc, user, (kind, result) => { results[kind] = result })
  assert.equal(results.token.accounts.length, 1)
  assert.equal(results.token.error, null)
  assert.match(results.pump.error.message, /RPC unavailable/)
  assert.deepEqual(results.pump.accounts, [])
})

test('preparation overlaps balance with account reads and fee estimation with unsigned simulation', async () => {
  const rpc = mockConnection()
  let balanceStarted = false, simulationStarted = false
  rpc.getMultipleAccountsInfo = async () => {
    await Promise.resolve()
    assert.ok(balanceStarted, 'balance read must not wait for account validation')
    return [tokenInfo()]
  }
  rpc.getBalance = async () => { balanceStarted = true; return 5000 }
  rpc.getFeeForMessage = async () => {
    await Promise.resolve()
    assert.ok(simulationStarted, 'simulation must not wait for fee estimation')
    return { value: 5000 }
  }
  rpc.simulateTransaction = async () => { simulationStarted = true; return { value: { err: null } } }
  await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
})

test('post-sign validation and simulation overlap, but no send occurs until both pass', async () => {
  for (const changed of [false, true]) {
    const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    preview.transaction.sign(signer)
    let releaseRead, reportSimulation
    rpc.getMultipleAccountsInfo = () => new Promise(resolve => { releaseRead = resolve })
    const simulationStarted = new Promise(resolve => { reportSimulation = resolve })
    rpc.simulateTransaction = async () => { reportSimulation(); return { value: { err: null } } }
    const progress = []
    const submission = submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}, stage => progress.push(stage))
    const outcome = changed ? assert.rejects(submission, /account changed/) : submission
    await simulationStarted
    assert.deepEqual(progress, ['validating'])
    assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
    releaseRead(changed ? [null] : [tokenInfo()])
    await outcome
    assert.deepEqual(progress, changed ? ['validating'] : ['validating', 'sending', 'confirming'])
    assert.equal(rpc.calls.some(([type]) => type === 'send'), !changed)
  }
})
