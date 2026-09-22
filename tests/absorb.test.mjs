import test from 'node:test'
import assert from 'node:assert/strict'
import { createRecoveryDiagnostics } from '../lib/recovery-diagnostics.ts'
import { ComputeBudgetProgram, ComputeBudgetInstruction, Keypair, PublicKey, SystemProgram, SystemInstruction, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, AccountLayout, AccountState } from '@solana/spl-token'
import { PUMP_PROGRAMS, MAX_RENT_ACCOUNTS, MAX_RECOVERY_NETWORK_FEE, RENT_BATCH_BYTE_TARGET, LIGHTHOUSE_PROGRAM_ID, pumpAddress, pumpBlockReason, tokenRentAccount, closeRentInstruction, claimCashbackInstruction, recoveryAmounts, rentTotals, estimatedRentLabel, createRentReview, selectRentBatch, assertUnchanged, scanRentCategories, scanPumpRent, scanTokenRent, prepareRentRecovery, submitRentRecovery, recoveryMessageDifference, retryRecoveryRead } from '../lib/absorb.ts'

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
  for (const change of [info => { info.owner = TOKEN_PROGRAM_ID }, info => { info.executable = true }, info => { info.data = Buffer.alloc(86) }, info => { info.data[0] = 0 }, info => { other.toBuffer().copy(info.data, 8) }, info => { info.data[136] = 1 }, info => { info.lamports-- }]) {
    const info = pumpInfo(); change(info)
    assert.ok(pumpBlockReason(info, user, PUMP_PROGRAMS[0].id, rent))
  }
})

test('Pump pending incentives, unsettled volume and unsupported quote rewards block closure', () => {
  for (const offset of [40, 41, 57, 90]) {
    const info = pumpInfo(); info.data[offset] = 1
    assert.ok(pumpBlockReason(info, user, PUMP_PROGRAMS[0].id, rent))
  }
  const info = pumpInfo(); info.data[49] = 1; info.data[73] = 1; info.data[74] = 1; info.data[82] = 1; info.data[98] = 1
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
    getFeeForMessage: async message => {
      const tx = Transaction.populate(message)
      const price = ComputeBudgetInstruction.decodeSetComputeUnitPrice(tx.instructions[0]).microLamports
      const { units } = ComputeBudgetInstruction.decodeSetComputeUnitLimit(tx.instructions[1])
      return { value: 5000 + Number((BigInt(units) * price + 999999n) / 1000000n) }
    },
    getBalance: async () => 10000,
    simulateTransaction: async (transaction, config) => { assert.ok(transaction instanceof VersionedTransaction); calls.push(['simulate', config]); return { value: { err: null } } },
    sendRawTransaction: async (bytes, config) => { calls.push(['send', bytes, config]); return 'signature' },
    getBlockHeight: async () => 95,
    getSignatureStatuses: async () => ({ context: { slot: 90 }, value: [{ slot: 90, err: null, confirmations: 1, confirmationStatus: 'confirmed' }] }),
    confirmTransaction: async () => { throw new Error('Must use HTTP confirmation, not websocket waiting') },
  }
}

test('preparation adds the 2% service transfer after closing', async () => {
  const rpc = mockConnection(), rows = await scanTokenRent(rpc, user)
  const preview = await prepareRentRecovery(rpc, user, 'token', rows)
  assert.equal(preview.networkFee, 10000)
  assert.ok(preview.transaction.instructions[2].programId.equals(TOKEN_PROGRAM_ID))
  assert.equal(preview.transaction.instructions.length, 4)
  const feeTransfer = SystemInstruction.decodeTransfer(preview.transaction.instructions.at(-1))
  assert.equal(feeTransfer.toPubkey.toBase58(), 'Dkmdvd9iZWKGXiSNExgYYX7PZNncewM4WqHBgN1knUzH')
  assert.ok(feeTransfer.fromPubkey.equals(user))
  assert.equal(feeTransfer.lamports, BigInt(30276))
  assert.equal(preview.net, preview.gross - preview.fee)
  assert.equal(preview.transaction.serialize({ requireAllSignatures: false }).length < 1232, true)
  assert.equal(rpc.calls[0][1].sigVerify, false)
  rpc.getBalance = async () => 9999
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
  const estimateFee = rpc.getFeeForMessage
  rpc.getFeeForMessage = async message => { estimatedMessage = message.serialize(); return estimateFee(message) }
  const preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
  assert.deepEqual(estimatedMessage, preview.expectedMessage)
  // Model the wallet transport and Phantom's documented rule: only inject when
  // no compute-unit price/limit instruction is present. No real wallet is used.
  const walletTx = Transaction.from(preview.transaction.serialize({ requireAllSignatures: false }))
  const budget = walletTx.instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId))
  assert.equal(budget.length, 2)
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(budget[0]).microLamports, 3571n)
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(budget[1]).units, 1400000)
  const hasPriorityPolicy = budget.some(ix => ['SetComputeUnitPrice', 'SetComputeUnitLimit'].includes(ComputeBudgetInstruction.decodeInstructionType(ix)))
  if (!hasPriorityPolicy) walletTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }))
  walletTx.sign(signer)
  const returned = Transaction.from(walletTx.serialize())
  assert.deepEqual(returned.serializeMessage(), preview.expectedMessage)
  await submitRentRecovery(rpc, returned, preview, () => true, () => {})
  assert.equal(rpc.calls.filter(([type]) => type === 'send').length, 1)
})

test('priority budget includes base fee, rounds safely and reserves compute for wallet guards', async () => {
  assert.equal(MAX_RECOVERY_NETWORK_FEE, 10000)
  for (const consumed of [undefined, 0, 10000, 90001, 350000, 1000000, 1400000]) {
    const rpc = mockConnection()
    let feeCalls = 0, simulations = 0
    const estimateFee = rpc.getFeeForMessage
    rpc.getFeeForMessage = async message => { feeCalls++; return estimateFee(message) }
    rpc.simulateTransaction = async (tx, config) => {
      simulations++
      const measured = Transaction.populate(tx.message)
      if (!config.sigVerify) {
        assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(measured.instructions[1]).units, 1400000)
      }
      return { value: { err: null, unitsConsumed: consumed } }
    }
    const preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    const { units } = ComputeBudgetInstruction.decodeSetComputeUnitLimit(preview.transaction.instructions[1])
    const { microLamports } = ComputeBudgetInstruction.decodeSetComputeUnitPrice(preview.transaction.instructions[0])
    const expectedUnits = consumed === undefined ? 1400000 : Math.min(1400000, Math.max(100000, Math.ceil(consumed * 1.2) + 50000))
    assert.equal(units, expectedUnits)
    assert.ok(microLamports > 0n)
    const priority = (BigInt(units) * microLamports + 999999n) / 1000000n
    assert.ok(priority <= 5000n)
    assert.equal(preview.networkFee, 5000 + Number(priority))
    assert.ok(preview.networkFee <= MAX_RECOVERY_NETWORK_FEE)
    assert.equal(feeCalls, 1); assert.equal(simulations, 1)
    preview.transaction.add(lighthouseGuard())
    preview.transaction.sign(signer)
    await submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {})
    assert.equal(simulations, 2)
    assert.equal(rpc.calls.filter(([type]) => type === 'send').length, 1)
  }
})

test('over-cap or malformed network quotes block preparation, never broadcasting', async () => {
  for (const value of [10001, 15000, NaN, -1, 9999.5]) {
    const rpc = mockConnection()
    rpc.getFeeForMessage = async () => ({ value })
    await assert.rejects(prepareRentRecovery(rpc, user, 'token', [tokenRow()]), /cap|verified/)
    assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
  }
})

test('invalid compute consumption is rejected and a missing fee quote gets only one fresh-blockhash retry', async () => {
  for (const unitsConsumed of [-1, NaN, 1.5, 1400001]) {
    const rpc = mockConnection()
    rpc.simulateTransaction = async () => ({ value: { err: null, unitsConsumed } })
    await assert.rejects(prepareRentRecovery(rpc, user, 'token', [tokenRow()]), /Invalid compute estimate/)
  }
  const rpc = mockConnection()
  let quotes = 0
  rpc.getFeeForMessage = async () => { quotes++; return { value: null } }
  await assert.rejects(prepareRentRecovery(rpc, user, 'token', [tokenRow()]), /fresh blockhash/)
  assert.equal(quotes, 2)
  assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
})

test('over-cap compute price, invalid limit, recipient, blockhash or recovery destination still blocks broadcast', async () => {
  for (const change of [
    tx => { tx.instructions[0] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }) },
    tx => { tx.instructions[1] = ComputeBudgetProgram.setComputeUnitLimit({ units: 1400001 }) },
    tx => { tx.instructions.at(-1).keys[1].pubkey = other },
    tx => { tx.recentBlockhash = address.toBase58() },
    tx => { tx.instructions[2].keys[1].pubkey = other },
  ]) {
    const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    const walletTx = Transaction.from(preview.transaction.serialize({ requireAllSignatures: false }))
    change(walletTx)
    walletTx.sign(signer)
    await assert.rejects(submitRentRecovery(rpc, walletTx, preview, () => true, () => {}), /wallet changed the transaction/)
    assert.equal(rpc.calls.some(([type]) => type === 'send'), false)
  }
})

test('wallet compute changes within the total cap pass with or without guards; original signed bytes are sent', async () => {
  for (const withGuards of [false, true]) {
    for (const [limit, price] of [[100000, 50000], [100001, 49999], [1400000, 1000], [100000, 0]]) {
      const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
      // A wallet may resize/reprice and reorder the budget instructions.
      const tx = Transaction.from(preview.transaction.serialize({ requireAllSignatures: false }))
      tx.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: limit })
      tx.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })
      if (withGuards) { tx.instructions.unshift(lighthouseGuard()); tx.add(lighthouseGuard(other)) }
      tx.sign(signer)
      const bytes = tx.serialize()
      rpc.getFeeForMessage = async () => { throw new Error('No additional RPC fee check needed') }
      assert.equal(recoveryMessageDifference(preview.expectedMessage, tx.serializeMessage()), undefined)
      await submitRentRecovery(rpc, tx, preview, () => true, () => {})
      assert.deepEqual(rpc.calls.find(([type]) => type === 'send')[1], bytes)
    }
  }
})

test('wallet budget allowance never permits malformed budgets or hidden recovery changes', async () => {
  for (const mutate of [
    tx => { tx.instructions[0] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50001 }) }, // 5001 priority lamports: over cap
    tx => { tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })) },
    tx => { tx.instructions.splice(1, 1) },
    tx => { tx.instructions[1] = ComputeBudgetProgram.setComputeUnitLimit({ units: 0 }) },
    tx => { tx.instructions[0].data = Buffer.from([3, 0]) },
    tx => { tx.instructions[0].data[0] = 0 },
    tx => { tx.instructions[0].keys.push({ pubkey: user, isSigner: true, isWritable: true }) },
    tx => { tx.instructions[2].keys[1].pubkey = other },
    tx => { tx.instructions.at(-1).data[4] ^= 1 },
    tx => { tx.instructions.at(-1).keys[1].pubkey = other },
    tx => { tx.instructions.splice(2, 1) },
    tx => { tx.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: other, lamports: 1 })) },
  ]) {
    const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    const tx = Transaction.from(preview.transaction.serialize({ requireAllSignatures: false }))
    tx.instructions[0] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
    tx.instructions[1] = ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 })
    mutate(tx)
    await assert.rejects(submitRentRecovery(rpc, tx, preview, () => true, () => {}), /wallet changed/)
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
    [tx => { tx.instructions[0] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }) }, 'network fee exceeds 0.00001 SOL cap'],
    [tx => { tx.recentBlockhash = address.toBase58() }, 'blockhash changed'],
    [tx => { tx.instructions.at(-1).data[4] ^= 1 }, 'instruction 4 data changed'],
    [tx => { tx.instructions.push(tx.instructions[2]) }, 'instruction count changed (4 to 5)'],
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

function cashbackConnection({ swap = true, amount = 70701, pending = false, deposit = rent } = {}) {
  const rpc = mockConnection(), program = PUMP_PROGRAMS[swap ? 1 : 0].id
  const accumulator = pumpAddress(user, program)
  const info = pumpInfo(program)
  info.lamports = deposit + (swap ? 0 : amount)
  info.data.writeBigUInt64LE(BigInt(amount), 74)
  if (pending) info.data[40] = 1
  const vault = getAssociatedTokenAddressSync(NATIVE_MINT, accumulator, true)
  const vaultInfo = tokenInfo(TOKEN_PROGRAM_ID, { mint: NATIVE_MINT, owner: accumulator, amount: BigInt(amount), isNativeOption: 1, isNative: 1488440n })
  vaultInfo.lamports = 1488440 + amount
  rpc.getMultipleAccountsInfo = async keys => keys.map(key => key.equals(accumulator) ? info : key.equals(address) ? tokenInfo() : null)
  rpc.getMinimumBalanceForRentExemption = async size => size === 165 ? 1488440 : rent
  rpc.getBalance = async () => 10000000
  rpc.getTokenAccountsByOwner = async (owner, { programId }) => ({ value: swap && owner.equals(accumulator) && programId.equals(TOKEN_PROGRAM_ID) ? [{ pubkey: vault, account: vaultInfo }] : [] })
  return { rpc, info, vaultInfo, accumulator, vault, program }
}

test('higher historical Pump deposits recover their full balance', async () => {
  for (const swap of [false, true]) {
    const { rpc, info, program } = cashbackConnection({ swap, amount: 0, deposit: 1844400 })
    assert.equal(pumpBlockReason(info, user, program, rent), undefined)
    const rows = await scanPumpRent(rpc, user)
    assert.equal(rows[0].blocked, undefined)
    assert.deepEqual(recoveryAmounts(rows[0]), { rent: 1844400, cashback: 0 })
    const preview = await prepareRentRecovery(rpc, user, 'pump', rows)
    assert.equal(preview.gross, 1844400)
    assert.equal(preview.fee, 36888)
    assert.deepEqual([...preview.transaction.instructions[2].data], [249, 69, 164, 218, 150, 103, 84, 138])
  }
})

test('PumpSwap cashback-only keeps accounts with pending incentives open', async () => {
  const { rpc, accumulator, vault, program } = cashbackConnection({ amount: 2959639, pending: true })
  const rows = await scanPumpRent(rpc, user)
  assert.equal(rows[0].blocked, undefined)
  assert.deepEqual(rows[0].pump, { cashbackLamports: 2959639, close: false })
  const preview = await prepareRentRecovery(rpc, user, 'pump', rows)
  assert.equal(preview.gross, 2959639)
  assert.equal(preview.fee, 0, 'no rent recovered means no rent service fee')
  const instructions = preview.transaction.instructions
  const create = SystemInstruction.decodeCreateWithSeed(instructions[2])
  assert.ok(create.fromPubkey.equals(user) && create.basePubkey.equals(user))
  assert.ok(create.programId.equals(TOKEN_PROGRAM_ID)); assert.equal(create.space, 165)
  assert.equal(create.seed.length, 32); assert.equal(create.lamports, 1488440)
  assert.ok(create.newAccountPubkey.equals(await PublicKey.createWithSeed(user, create.seed, TOKEN_PROGRAM_ID)))
  const walletAta = getAssociatedTokenAddressSync(NATIVE_MINT, user)
  assert.ok(!create.newAccountPubkey.equals(walletAta))
  assert.equal(instructions[3].data[0], 18, 'initializeAccount3')
  assert.ok(instructions[3].keys[0].pubkey.equals(create.newAccountPubkey))
  assert.ok(instructions[3].keys[1].pubkey.equals(NATIVE_MINT))
  assert.deepEqual(instructions[3].data.subarray(1), user.toBuffer())
  const claim = instructions[4]
  assert.ok(claim.programId.equals(program))
  assert.deepEqual([...claim.data], [37, 58, 35, 126, 190, 53, 228, 197])
  assert.deepEqual(claim.keys.map(k => k.pubkey.toBase58()), [user, accumulator, NATIVE_MINT, TOKEN_PROGRAM_ID, vault, create.newAccountPubkey, SystemProgram.programId, PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], program)[0], program].map(k => k.toBase58()))
  assert.equal(instructions[5].data[0], 9)
  assert.ok(instructions[5].keys[0].pubkey.equals(create.newAccountPubkey))
  assert.ok(instructions[5].keys[1].pubkey.equals(user))
  assert.equal(instructions.length, 6, 'no accumulator close or service transfer')
  assert.equal(preview.transaction.compileMessage().header.numRequiredSignatures, 1)
  assert.ok(preview.networkFee <= MAX_RECOVERY_NETWORK_FEE)
  preview.transaction.sign(signer)
  await submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {})
})

test('PumpSwap claims and unwraps cashback before closing the accumulator', async () => {
  const { rpc, accumulator, vault } = cashbackConnection()
  const rows = await scanPumpRent(rpc, user)
  assert.deepEqual(rows[0].pump, { cashbackLamports: 70701, close: true })
  const preview = await prepareRentRecovery(rpc, user, 'pump', rows)
  assert.equal(preview.gross, rent + 70701)
  assert.equal(preview.fee, 26924, 'cashback is not added to the rent fee base')
  const close = preview.transaction.instructions[6]
  assert.deepEqual([...close.data], [249, 69, 164, 218, 150, 103, 84, 138])
  assert.ok(close.keys[1].pubkey.equals(accumulator))
  assert.ok(!preview.transaction.instructions.some(ix => ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9 && ix.keys[0].pubkey.equals(vault)), 'never close a Pump-owned vault')
  assert.ok(selectRentBatch(rows, user).length === 1)
  assert.ok(preview.transaction.serialize({ requireAllSignatures: false }).length <= RENT_BATCH_BYTE_TARGET)
})

test('native Pump cashback is not double counted and precedes optional closure', async () => {
  for (const pending of [false, true]) {
    const { rpc, accumulator, program } = cashbackConnection({ swap: false, amount: 50000, pending })
    const rows = await scanPumpRent(rpc, user)
    const preview = await prepareRentRecovery(rpc, user, 'pump', rows)
    assert.equal(preview.gross, pending ? 50000 : rent + 50000)
    assert.equal(preview.fee, pending ? 0 : 26924)
    const claim = preview.transaction.instructions[2]
    assert.deepEqual(claim.keys.map(k => k.pubkey.toBase58()), [user, accumulator, SystemProgram.programId, PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], program)[0], program].map(k => k.toBase58()))
    assert.equal(preview.transaction.instructions.length, pending ? 3 : 5)
    assert.ok(preview.transaction.instructions.every(ix => !ix.programId.equals(TOKEN_PROGRAM_ID)))
  }
})

test('cashback checks preserve other rewards, unsupported vaults and unknown layouts', async () => {
  for (const offset of [40, 41, 57, 90]) {
    const { rpc, info } = cashbackConnection({ swap: false })
    info.data[offset] = 1
    const [row] = await scanPumpRent(rpc, user)
    assert.equal(row.blocked, undefined)
    assert.equal(row.pump.close, false)
  }
  for (const mutate of [fixture => { fixture.info.data[136] = 1 }, fixture => { fixture.info.owner = other }, fixture => { fixture.vaultInfo.lamports++ }, fixture => { fixture.vaultInfo.data[108] = AccountState.Frozen }, fixture => { other.toBuffer().copy(fixture.vaultInfo.data, 32) }]) {
    const fixture = cashbackConnection(); mutate(fixture)
    assert.ok((await scanPumpRent(fixture.rpc, user))[0].blocked)
  }
  const { rpc, info } = cashbackConnection({ amount: 0 })
  info.data.writeBigUInt64LE(84416610n, 74)
  info.data.writeBigUInt64LE(88705895n, 82)
  const [row] = await scanPumpRent(rpc, user)
  assert.equal(row.blocked, undefined, 'historical counters from the user example do not prevent closure')
  assert.equal(row.pump, undefined)
})

test('cashback amount or closure eligibility changes abort before sending', async () => {
  for (const change of ['amount', 'eligibility']) {
    const { rpc, info, vaultInfo } = cashbackConnection()
    const rows = await scanPumpRent(rpc, user)
    const preview = await prepareRentRecovery(rpc, user, 'pump', rows)
    preview.transaction.sign(signer)
    if (change === 'amount') { vaultInfo.data.writeBigUInt64LE(70702n, 64); vaultInfo.lamports++ } else info.data[40] = 1
    await assert.rejects(submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}), /changed/)
    assert.equal(rpc.calls.filter(([name]) => name === 'send').length, 0)
  }
})

test('cashback preparation requires refundable temporary rent and never reuses a temporary address', async () => {
  const { rpc } = cashbackConnection()
  const rows = await scanPumpRent(rpc, user)
  rpc.getBalance = async () => 1488440
  await assert.rejects(prepareRentRecovery(rpc, user, 'pump', rows), /temporarily available/)
  rpc.getBalance = async () => 10000000
  const first = await prepareRentRecovery(rpc, user, 'pump', rows)
  const second = await prepareRentRecovery(rpc, user, 'pump', rows)
  assert.notEqual(SystemInstruction.decodeCreateWithSeed(first.transaction.instructions[2]).newAccountPubkey.toBase58(), SystemInstruction.decodeCreateWithSeed(second.transaction.instructions[2]).newAccountPubkey.toBase58())
})

test('cashback review snapshots are deep copies and forged claims are rejected', async () => {
  const { rpc } = cashbackConnection()
  const rows = await scanPumpRent(rpc, user)
  const review = createRentReview('pump', rows)
  rows[0].pump.close = false
  assert.equal(review.accounts[0].pump.close, true)
  for (const row of [{ ...review.accounts[0], address: other.toBase58() }, { ...review.accounts[0], blocked: 'bad vault' }, { ...review.accounts[0], pump: { close: true, cashbackLamports: -1 } }]) assert.throws(() => claimCashbackInstruction(row, user, address), /Invalid/)
  assert.throws(() => claimCashbackInstruction(review.accounts[0], user), /Missing temporary/)
  assert.throws(() => rentTotals([{ ...tokenRow(), pump: { close: true, cashbackLamports: 1 } }]), /Invalid cashback program/)
})

test('diagnostics locate confirmation expiry without changing signed bytes or resending', async () => {
  const rpc = mockConnection()
  rpc.getBlockHeight = async () => 95
  const diagnostics = createRecoveryDiagnostics('mainnet-beta', () => {})
  const preview = await diagnostics.measure('prepare', () => prepareRentRecovery(rpc, user, 'token', [tokenRow()], diagnostics))
  await diagnostics.measure('wallet.approval', async () => { preview.transaction.sign(signer) })
  diagnostics.signed(preview.transaction.signature)
  const bytes = preview.transaction.serialize()
  rpc.getBlockHeight = async () => 101
  rpc.getSignatureStatuses = async () => ({ context: { slot: 110 }, value: [null] })
  await assert.rejects(diagnostics.measure('submit', () => submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}, undefined, diagnostics)), /expired/)
  assert.equal(diagnostics.snapshot().failedStage, 'confirmation.wait')
  const stages = diagnostics.snapshot().entries.map(row => row.stage)
  for (const stage of ['prepare.account-read', 'prepare.balance-read', 'prepare.blockhash-read', 'prepare.simulation', 'prepare.fee-estimate', 'wallet.approval', 'signed.account-read', 'signed.simulation', 'send.rpc', 'send.rpc-acknowledged']) assert.ok(stages.includes(stage), stage)
  assert.deepEqual(rpc.calls.find(([type]) => type === 'send')[1], bytes)
  assert.equal(rpc.calls.filter(([type]) => type === 'send').length, 1)
})

test('diagnostics retain the signed transaction ID when send response is lost', async () => {
  const rpc = mockConnection()
  rpc.getBlockHeight = async () => 95
  const diagnostics = createRecoveryDiagnostics('mainnet-beta', () => {})
  const preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()], diagnostics)
  preview.transaction.sign(signer)
  diagnostics.signed(preview.transaction.signature)
  rpc.sendRawTransaction = async () => { throw new Error('Failed to fetch') }
  await assert.rejects(diagnostics.measure('submit', () => submitRentRecovery(rpc, preview.transaction, preview, () => true, () => {}, undefined, diagnostics)))
  assert.equal(diagnostics.snapshot().failedStage, 'send.rpc')
  assert.ok(diagnostics.snapshot().signature)
  assert.equal(diagnostics.snapshot().entries.some(row => row.stage === 'send.rpc-acknowledged'), false)
})

test('two Phantom Lighthouse assertions may augment recovery instructions; exact signed bytes are sent', async () => {
  const rpc = mixedConnection(1)
  const readAccounts = rpc.getMultipleAccountsInfo
  rpc.getMultipleAccountsInfo = async keys => keys[0].equals(pumpAddress(user, PUMP_PROGRAMS[0].id)) ? [pumpInfo(), null] : readAccounts(keys)
  const rows = [...await scanTokenRent(rpc, user), ...await scanPumpRent(rpc, user)]
  const preview = await prepareRentRecovery(rpc, user, 'both', rows)
  assert.equal(preview.transaction.instructions.length, 5)
  const walletTx = Transaction.from(preview.transaction.serialize({ requireAllSignatures: false }))
  walletTx.instructions.unshift(lighthouseGuard(user))
  walletTx.add(lighthouseGuard(new PublicKey(rows[0].address)))
  assert.equal(walletTx.instructions.length, 7)
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
    tx => { tx.instructions[0] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }) },
    tx => { tx.instructions[2].keys[1].pubkey = other },
    tx => { tx.instructions[3].keys[1].pubkey = other },
    tx => { tx.instructions[3].data[4] ^= 1 },
    tx => { tx.instructions.splice(2, 1) },
    tx => { [tx.instructions[2], tx.instructions[3]] = [tx.instructions[3], tx.instructions[2]] },
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

test('on-chain errors and unavailable history after expiry never report success; sent signature remains available', async () => {
  for (const timeout of [false, true]) {
    const rpc = mockConnection(), preview = await prepareRentRecovery(rpc, user, 'token', [tokenRow()])
    preview.transaction.sign(signer)
    rpc.getBlockHeight = async () => 101
    rpc.getSignatureStatuses = async () => { if (timeout) throw new Error('History unavailable'); return { context: { slot: 110 }, value: [{ err: 'InstructionError', confirmationStatus: 'confirmed' }] } }
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
  assert.equal(preview.transaction.instructions.length, 7)
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
  assert.equal(preview.transaction.instructions.length, rows.length + 3)
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
    rpc.getSignatureStatuses = async signatures => {
      assert.deepEqual(signatures, ['signature'])
      return { context: { slot: 90 }, value: [{ err: null, confirmationStatus: 'confirmed' }] }
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

test('preparation overlaps balance with account reads and quotes the final simulated compute budget', async () => {
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
    assert.ok(simulationStarted, 'fee must be quoted after sizing the compute budget')
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
