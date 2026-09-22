import { Buffer } from 'buffer'
import { ComputeBudgetProgram, Message, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import type { AccountInfo, Connection } from '@solana/web3.js'
import type { RecoveryDiagnostics } from './recovery-diagnostics'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getExtensionTypes, getTransferFeeAmount, unpackAccount, createCloseAccountInstruction } from '@solana/spl-token'

export type RentKind = 'token' | 'pump'
export type RecoveryKind = RentKind | 'both'
export type RentAccount = { address: string; program: string; label: string; lamports: number; blocked?: string }
export const MAX_RENT_ACCOUNTS = 100
export const RENT_PACKET_LIMIT = 1232
// Leave room for wallet-added assertions. Final serialized size is still checked.
export const RENT_BATCH_BYTE_TARGET = RENT_PACKET_LIMIT - 192
export const MAX_RECOVERY_NETWORK_FEE = 10_000 // 0.00001 SOL, including the base fee
const RECOVERY_BASE_FEE = 5_000 // One required signature; verify the total with RPC.
const MAX_RECOVERY_COMPUTE_UNITS = 1_400_000
// Phantom's documented transaction guards. Only the assertion-only variants
// below are accepted, never MemoryWrite (0), MemoryClose (1), or unknown opcodes.
// https://docs.phantom.com/developer-powertools/lighthouse
// https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/instruction.rs
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95')
export const FEE_WALLET = new PublicKey('Dkmdvd9iZWKGXiSNExgYYX7PZNncewM4WqHBgN1knUzH')
export const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]
export const PUMP_PROGRAMS = [
  { id: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), label: 'Pump.fun' },
  { id: new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'), label: 'PumpSwap' },
]
// Official IDLs: https://github.com/pump-fun/pump-public-docs/tree/main/idl
// Checked 2026-09-21. Only close_user_volume_accumulator is used; never claim rewards.
const ACCUMULATOR_DISCRIMINATOR = Buffer.from([86, 255, 112, 14, 102, 53, 154, 250])
const CLOSE_DISCRIMINATOR = Buffer.from([249, 69, 164, 218, 150, 103, 84, 138])

export function pumpAddress(user: PublicKey, program: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), user.toBuffer()], program)[0]
}

export function rentTotals(accounts: RentAccount[]) {
  if (accounts.some(account => !Number.isSafeInteger(account.lamports) || account.lamports < 0)) throw new Error('Invalid account balance.')
  const gross = accounts.reduce((sum, account) => sum + account.lamports, 0)
  if (!Number.isSafeInteger(gross) || gross < 0) throw new Error('Invalid account balance.')
  // Round down per account to whole lamports, then combine into one transfer.
  const fee = accounts.reduce((sum, account) => sum + Number(BigInt(account.lamports) * BigInt(2) / BigInt(100)), 0)
  return { gross, fee, net: gross - fee }
}

// Card display only. Never use this estimate to build or price a transaction.
export function estimatedRentLabel(count: number) {
  return (count * 0.0015).toFixed(4)
}

// One bounded retry for transport failures on idempotent reads only. Never wrap
// signing/submission: a failed send response does not prove nothing was sent.
export async function retryRecoveryRead<T>(read: () => Promise<T>): Promise<T> {
  try { return await read() } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (!/failed to fetch|fetch failed|networkerror|network request failed|ECONNRESET|ETIMEDOUT/i.test(message)) throw error
    await new Promise(resolve => setTimeout(resolve, 300))
    return read()
  }
}

export function tokenRentAccount(address: PublicKey, info: AccountInfo<Buffer>, user: PublicKey): RentAccount | null {
  if (!TOKEN_PROGRAMS.some(program => program.equals(info.owner))) return null
  const account = unpackAccount(address, info, info.owner)
  // Native/wrapped SOL and nonempty accounts are not rent-only recovery targets.
  if (!account.isInitialized || account.isNative || account.amount !== BigInt(0) || !account.owner.equals(user)) return null
  let blocked: string | undefined
  if (!(account.closeAuthority ?? account.owner).equals(user)) blocked = 'Another wallet has close authority.'
  // Do not blanket-exclude extensions. The owning Token program's close checks
  // run during unsigned and signed simulation. Known withheld funds still block.
  if ((getTransferFeeAmount(account)?.withheldAmount ?? BigInt(0)) !== BigInt(0)) blocked = 'Withheld token fees must be handled before closing.'
  return { address: address.toBase58(), program: info.owner.toBase58(), label: info.owner.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL Token', lamports: info.lamports, blocked }
}

export function pumpBlockReason(info: AccountInfo<Buffer>, user: PublicKey, program: PublicKey, rent: number): string | undefined {
  const data = info.data
  if (!info.owner.equals(program) || info.executable || !PUMP_PROGRAMS.some(item => item.id.equals(program))) return 'Unexpected account owner.'
  // Fail closed on old/unknown allocations rather than guessing offsets after an upgrade.
  if (data.length !== 137 || !data.subarray(0, 8).equals(ACCUMULATOR_DISCRIMINATOR)) return 'Unsupported Pump account layout; excluded for safety.'
  if (!new PublicKey(data.subarray(8, 40)).equals(user)) return 'This account belongs to another wallet.'
  if (data[40] > 1 || data[73] > 1) return 'Invalid Pump account data.'
  // Shared fields: needs_claim @40, unclaimed tokens @41, current volume @57.
  // Exclude unsynchronised trading volume as well as known pending rewards.
  if (data[40] !== 0 || data.readBigUInt64LE(41) !== BigInt(0) || data.readBigUInt64LE(57) !== BigInt(0)) return 'Pending rewards or unsettled trading volume. Review on Pump before closing.'
  if (data.readBigUInt64LE(74) !== BigInt(0)) return 'Reward balance detected; rent-only recovery will not touch it.'
  const isPump = program.equals(PUMP_PROGRAMS[0].id)
  if (isPump && data.readBigUInt64LE(90) !== BigInt(0)) return 'Quote-token rewards detected; account excluded.'
  const knownLength = isPump ? 106 : 90
  if (data.subarray(knownLength).some(byte => byte !== 0)) return 'Unrecognised account fields; excluded for safety.'
  if (info.lamports > rent) return 'SOL above the rent deposit detected. Rent-only recovery will not claim it.'
  if (info.lamports < rent) return 'Account balance differs from the current rent requirement; review required.'
}

export async function scanTokenRent(connection: Connection, user: PublicKey): Promise<RentAccount[]> {
  const results = await Promise.all(TOKEN_PROGRAMS.map(programId => retryRecoveryRead(() => connection.getTokenAccountsByOwner(user, { programId }, 'confirmed'))))
  return results.flatMap(result => result.value.flatMap(({ pubkey, account }) => {
    const item = tokenRentAccount(pubkey, account, user)
    return item ? [item] : []
  })).sort((a, b) => a.address.localeCompare(b.address))
}

export async function scanPumpRent(connection: Connection, user: PublicKey): Promise<RentAccount[]> {
  const addresses = PUMP_PROGRAMS.map(({ id }) => pumpAddress(user, id))
  const infos = await retryRecoveryRead(() => connection.getMultipleAccountsInfo(addresses, 'confirmed'))
  const rent = infos.some(Boolean) ? await retryRecoveryRead(() => connection.getMinimumBalanceForRentExemption(137, 'confirmed')) : 0
  const rows = await Promise.all(infos.map(async (info, index) => {
    if (!info) return null
    const { id, label } = PUMP_PROGRAMS[index]
    let blocked = pumpBlockReason(info, user, id, rent)
    if (!blocked) {
      // PumpSwap rewards live in PDA-owned token accounts. Check both token programs;
      // never close reward vaults as part of a rent-only action.
      const vaults = await Promise.all(TOKEN_PROGRAMS.map(programId => retryRecoveryRead(() => connection.getTokenAccountsByOwner(addresses[index], { programId }, 'confirmed'))))
      const hasFunds = vaults.some(result => result.value.some(({ pubkey, account }) => {
        const vault = unpackAccount(pubkey, account, account.owner)
        return vault.amount !== BigInt(0) || getExtensionTypes(vault.tlvData).length > 0 ||
          (vault.isNative && BigInt(account.lamports) > (vault.rentExemptReserve ?? BigInt(0)))
      }))
      if (hasFunds) blocked = 'Associated reward funds or extensions detected; review on Pump before closing.'
    }
    return { address: addresses[index].toBase58(), program: id.toBase58(), label, lamports: info.lamports, blocked }
  }))
  return rows.filter((row): row is NonNullable<typeof row> => row !== null)
}

export async function scanRentCategories(connection: Connection, user: PublicKey, onResult: (kind: RentKind, result: { accounts: RentAccount[]; error: unknown | null }) => void) {
  // Publish each category independently; a slow Pump scan must not hide token results.
  await Promise.all((['token', 'pump'] as const).map(kind =>
    (kind === 'token' ? scanTokenRent(connection, user) : scanPumpRent(connection, user)).then(
      accounts => onResult(kind, { accounts, error: null }),
      error => onResult(kind, { accounts: [], error }),
    )))
}

export function accountRentKind(account: RentAccount): RentKind {
  if (TOKEN_PROGRAMS.some(id => id.toBase58() === account.program)) return 'token'
  if (PUMP_PROGRAMS.some(({ id }) => id.toBase58() === account.program)) return 'pump'
  throw new Error('Unsupported recovery program.')
}

export function selectRentBatch(accounts: RentAccount[], user: PublicKey) {
  // Put the at-most-two Pump PDAs first so a large token list cannot push them
  // into a later batch when the user selected both categories.
  const seen = new Set<string>()
  const candidates = accounts.filter(account => {
    if (account.blocked || seen.has(account.address)) return false
    seen.add(account.address)
    return true
  })
    .sort((a, b) => Number(accountRentKind(a) === 'token') - Number(accountRentKind(b) === 'token'))
    .slice(0, MAX_RENT_ACCOUNTS)
  const batch: RentAccount[] = []
  for (const account of candidates) {
    const trial = [...batch, account]
    const transaction = buildRentTransaction(user, trial, { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 0 })
    if (transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length > RENT_BATCH_BYTE_TARGET) break
    batch.push(account)
  }
  return batch
}

async function scanRecoveryRent(connection: Connection, user: PublicKey, kind: RecoveryKind, selected: RentAccount[]) {
  assertUnchanged(selected, selected)
  if (selected.some(account => kind !== 'both' && accountRentKind(account) !== kind)) throw new Error('Invalid recovery selection.')
  const tokenRows = selected.filter(account => accountRentKind(account) === 'token')
  // Fetch the at-most-100 selected accounts in one request. Never cache this:
  // all raw ownership, balance, close-authority and extension checks still run.
  const readTokens = async () => {
    if (!tokenRows.length) return []
    const infos = await retryRecoveryRead(() => connection.getMultipleAccountsInfo(tokenRows.map(row => new PublicKey(row.address)), 'confirmed'))
    return infos.flatMap((info, index) => {
      if (!info) return []
      const row = tokenRentAccount(new PublicKey(tokenRows[index].address), info, user)
      return row ? [row] : []
    })
  }
  const [tokens, pump] = await Promise.all([
    readTokens(),
    selected.some(account => accountRentKind(account) === 'pump') ? scanPumpRent(connection, user) : Promise.resolve([]),
  ])
  return [...tokens, ...pump]
}

export function closeRentInstruction(kind: RentKind, account: RentAccount, user: PublicKey) {
  if (account.blocked) throw new Error(account.blocked)
  const program = new PublicKey(account.program)
  const address = new PublicKey(account.address)
  if (kind === 'token') {
    if (!TOKEN_PROGRAMS.some(id => id.equals(program))) throw new Error('Unsupported token program.')
    return createCloseAccountInstruction(address, user, user, [], program)
  }
  if (!PUMP_PROGRAMS.some(item => item.id.equals(program)) || !pumpAddress(user, program).equals(address)) throw new Error('Invalid Pump recovery account.')
  const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], program)[0]
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: address, isSigner: false, isWritable: true },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: CLOSE_DISCRIMINATOR,
  })
}

export function assertUnchanged(selected: RentAccount[], fresh: RentAccount[]) {
  if (!selected.length || selected.length > MAX_RENT_ACCOUNTS || new Set(selected.map(row => row.address)).size !== selected.length) throw new Error('Invalid recovery selection.')
  for (const previous of selected) {
    const current = fresh.find(row => row.address === previous.address)
    if (!current || current.blocked || current.program !== previous.program || current.lamports !== previous.lamports) throw new Error('An account changed or is no longer eligible. Refresh and review again.')
  }
}

export function createRentReview(kind: RecoveryKind, accounts: RentAccount[]) {
  // UI-only snapshot: no RPC reads, blockhash fetching or simulation here.
  assertUnchanged(accounts, accounts)
  if (accounts.some(account => kind !== 'both' && accountRentKind(account) !== kind)) throw new Error('Invalid recovery selection.')
  return { kind, accounts: accounts.map(account => ({ ...account })) }
}

function recoveryComputeLimit(unitsConsumed: number | undefined) {
  // Older RPCs can omit consumption. Keep the full limit in that case, with
  // the same fee cap. Reserve headroom for wallet-added Lighthouse assertions.
  if (unitsConsumed === undefined) return MAX_RECOVERY_COMPUTE_UNITS
  if (!Number.isSafeInteger(unitsConsumed) || unitsConsumed < 0 || unitsConsumed > MAX_RECOVERY_COMPUTE_UNITS) throw new Error('Invalid compute estimate. Nothing was sent.')
  return Math.min(MAX_RECOVERY_COMPUTE_UNITS, Math.max(100_000, Math.ceil(unitsConsumed * 1.2) + 50_000))
}

function buildRentTransaction(user: PublicKey, selected: RentAccount[], latest: { blockhash: string; lastValidBlockHeight: number }, computeUnitLimit = MAX_RECOVERY_COMPUTE_UNITS) {
  const transaction = new Transaction({ feePayer: user, ...latest })
  // Declare priority policy before signing so Phantom does not inject it later.
  // https://docs.phantom.com/developer-powertools/solana-priority-fees
  // The network rounds priority charges UP to lamports; round the unit price
  // DOWN so base + ceil(limit * price / 1e6) never exceeds the total cap.
  const microLamports = Math.floor((MAX_RECOVERY_NETWORK_FEE - RECOVERY_BASE_FEE) * 1_000_000 / computeUnitLimit)
  transaction.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
  )
  selected.forEach(account => transaction.add(closeRentInstruction(accountRentKind(account), account, user)))
  // Recover rent first; the transfer stays atomic with the account closures.
  const { fee } = rentTotals(selected)
  if (fee > 0) transaction.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: FEE_WALLET, lamports: fee }))
  return transaction
}

class RecoveryBlockhashError extends Error {
  constructor() {
    super('The RPC could not validate the transaction blockhash (it may have expired or the RPC may be behind). Nothing was sent. Approve again to rebuild with a fresh blockhash and sign again.')
    this.name = 'RecoveryBlockhashError'
  }
}

async function simulateRecovery(connection: Connection, transaction: VersionedTransaction, minContextSlot: number, signed: boolean) {
  // After signing, retry an unavailable blockhash once with IDENTICAL bytes to
  // tolerate a lagging backend. Never replace a blockhash in a signed message.
  const attempts = signed ? 2 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await connection.simulateTransaction(transaction, {
        sigVerify: signed, replaceRecentBlockhash: false, commitment: 'confirmed', minContextSlot,
      })
      if (result.value.err !== 'BlockhashNotFound') return result
    } catch (error) {
      if (!(error instanceof Error) || !/minimum context slot|blockhash not found|BlockhashNotFound/i.test(error.message)) throw error
    }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw new RecoveryBlockhashError()
}

function recoveryStep<T>(diagnostics: RecoveryDiagnostics | undefined, stage: string, run: () => Promise<T>) {
  return diagnostics ? diagnostics.measure(stage, run) : run()
}

export async function prepareRentRecovery(connection: Connection, user: PublicKey, kind: RecoveryKind, selected: RentAccount[], diagnostics?: RecoveryDiagnostics) {
  // Only unsigned preparation may rebuild automatically, once. All account
  // checks, fee estimates and simulation run again on the new transaction.
  try { return await prepareRentRecoveryOnce(connection, user, kind, selected, diagnostics) } catch (error) {
    if (!(error instanceof RecoveryBlockhashError)) throw error
    diagnostics?.retrying()
    return prepareRentRecoveryOnce(connection, user, kind, selected, diagnostics)
  }
}

async function prepareRentRecoveryOnce(connection: Connection, user: PublicKey, kind: RecoveryKind, selected: RentAccount[], diagnostics?: RecoveryDiagnostics) {
  const [fresh, balance] = await Promise.all([
    recoveryStep(diagnostics, 'prepare.account-read', () => scanRecoveryRent(connection, user, kind, selected)),
    recoveryStep(diagnostics, 'prepare.balance-read', () => retryRecoveryRead(() => connection.getBalance(user, 'confirmed'))),
  ])
  assertUnchanged(selected, fresh)
  const totals = rentTotals(selected)
  const blockhashResponse = await recoveryStep(diagnostics, 'prepare.blockhash-read', () => retryRecoveryRead(() => connection.getLatestBlockhashAndContext('confirmed')))
  const latest = blockhashResponse.value
  const minContextSlot = blockhashResponse.context.slot
  diagnostics?.blockhashReceived(latest.lastValidBlockHeight, minContextSlot)
  if (diagnostics) void diagnostics.sampleHeight(connection, 'height.blockhash-received')
  let transaction = buildRentTransaction(user, selected, latest)
  try {
    if (transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length > RENT_PACKET_LIMIT) throw new Error('Transaction too large')
  } catch (error) {
    if (error instanceof Error && /too large|encoding overruns/i.test(error.message)) throw new Error('This selection is too large for one transaction. Refresh to use size-based batches.')
    throw error
  }
  // Measure with the full compute limit, then price the final unsigned message.
  // No extra RPC calls are added; the exact signed message is
  // still simulated after wallet approval, including any Lighthouse guards.
  const simulation = await recoveryStep(diagnostics, 'prepare.simulation', () => simulateRecovery(connection, new VersionedTransaction(transaction.compileMessage()), minContextSlot, false))
  diagnostics?.note('prepare.simulation-result', { failed: !!simulation.value.err, ...(simulation.value.unitsConsumed === undefined ? {} : { unitsConsumed: simulation.value.unitsConsumed }) })
  if (simulation.value.err) throw new Error(`Recovery simulation failed: ${JSON.stringify(simulation.value.err)}. Nothing was sent.`)
  transaction = buildRentTransaction(user, selected, latest, recoveryComputeLimit(simulation.value.unitsConsumed))
  const feeEstimate = await recoveryStep(diagnostics, 'prepare.fee-estimate', () => retryRecoveryRead(() => connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')))
  const networkFee = feeEstimate.value
  if (networkFee === null) throw new RecoveryBlockhashError()
  if (!Number.isSafeInteger(networkFee) || networkFee < 0 || networkFee > MAX_RECOVERY_NETWORK_FEE) throw new Error('Network fee exceeds the configured cap or could not be verified. Nothing was sent.')
  if (balance < networkFee) throw new Error('You need enough SOL in your wallet to pay the network fee before rent is returned.')
  if (totals.net <= networkFee) throw new Error('Network fees would exceed the rent recovered.')
  return { transaction, expectedMessage: transaction.serializeMessage(), latest, minContextSlot, networkFee, kind, user, selected: selected.map(account => ({ ...account })), ...totals }
}

export type RentPreview = Awaited<ReturnType<typeof prepareRentRecovery>>

function computeBudgetProblem(message: Message): string | undefined {
  let limit: number | undefined
  let price: bigint | undefined
  for (const instruction of message.compiledInstructions) {
    if (!message.accountKeys[instruction.programIdIndex].equals(ComputeBudgetProgram.programId)) continue
    const data = Buffer.from(instruction.data)
    if (instruction.accountKeyIndexes.length) return 'invalid compute-budget accounts'
    if (data[0] === 2 && data.length === 5 && limit === undefined) {
      limit = data.readUInt32LE(1)
    } else if (data[0] === 3 && data.length === 9 && price === undefined) {
      price = data.readBigUInt64LE(1)
    } else {
      return 'unsupported or duplicate compute-budget instruction'
    }
  }
  if (limit === undefined || price === undefined || limit < 1 || limit > MAX_RECOVERY_COMPUTE_UNITS) return 'invalid compute budget'
  // Validate locally, without adding RPC waits. These recovery transactions
  // require one signature, and no added signatures/programs are permitted.
  const priority = (BigInt(limit) * price + BigInt(999_999)) / BigInt(1_000_000)
  if (message.header.numRequiredSignatures !== 1 || BigInt(RECOVERY_BASE_FEE) + priority > BigInt(MAX_RECOVERY_NETWORK_FEE)) return 'network fee exceeds 0.00001 SOL cap'
}

function recoveryInstructionDifference(before: Message, after: Message): string | undefined {
  const beforeKeys = new Map(before.accountKeys.map((key, index) => [key.toBase58(), index]))
  const afterKeys = new Map(after.accountKeys.map((key, index) => [key.toBase58(), index]))
  if (beforeKeys.size !== before.accountKeys.length || afterKeys.size !== after.accountKeys.length) return 'duplicate account keys'
  for (const [key, index] of beforeKeys) {
    const next = afterKeys.get(key)
    if (next === undefined) return 'original account removed'
    if (before.isAccountSigner(index) !== after.isAccountSigner(next) || before.isAccountWritable(index) !== after.isAccountWritable(next)) return 'signer or account permissions changed'
  }
  // Additional guard-only accounts must never receive signing/write privileges.
  for (const [key, index] of afterKeys) {
    if (!beforeKeys.has(key) && (after.isAccountSigner(index) || after.isAccountWritable(index))) return 'added signer or writable account'
  }
  const original = before.compiledInstructions.filter(ix => !before.accountKeys[ix.programIdIndex].equals(ComputeBudgetProgram.programId))
  let position = 0
  for (const instruction of after.compiledInstructions) {
    const program = after.accountKeys[instruction.programIdIndex]
    // Budget changes are checked separately against the cap, not byte-for-byte.
    if (program.equals(ComputeBudgetProgram.programId)) continue
    if (program.equals(LIGHTHOUSE_PROGRAM_ID)) {
      // These one-account variants only assert account data/info or mint/token
      // state. Payload validity is also checked by the exact signed simulation.
      const allowed = [2, 3, 5, 6, 7, 8, 9, 10]
      if (instruction.data.length < 3 || !allowed.includes(instruction.data[0]) || instruction.accountKeyIndexes.length !== 1) return 'unsupported Lighthouse guard'
      continue
    }
    const previous = original[position]
    if (!previous) return 'unexpected non-guard instruction added'
    if (!program.equals(before.accountKeys[previous.programIdIndex])) return `instruction ${position + 1} program or order changed`
    if (!Buffer.from(instruction.data).equals(Buffer.from(previous.data))) return `instruction ${position + 1} data changed`
    if (instruction.accountKeyIndexes.length !== previous.accountKeyIndexes.length || instruction.accountKeyIndexes.some((key, index) => !after.accountKeys[key].equals(before.accountKeys[previous.accountKeyIndexes[index]]))) return `instruction ${position + 1} accounts changed`
    position++
  }
  if (position !== original.length) return 'original instruction removed'
}

// Compare byte values rather than relying on a wallet's Buffer implementation.
// Diagnostics deliberately contain no wallet addresses, signatures or RPC URLs.
export function recoveryMessageDifference(expected: Uint8Array, actual: Uint8Array): string | undefined {
  if (expected.length === actual.length && expected.every((byte, index) => byte === actual[index])) return
  try {
    const before = Message.from(expected), after = Message.from(actual)
    if (!before.accountKeys[0].equals(after.accountKeys[0])) return 'fee payer changed'
    if (before.recentBlockhash !== after.recentBlockhash) return 'blockhash changed'
    const budget = (message: Message) => message.instructions.filter(ix => message.accountKeys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)).map(ix => ix.data)
    const budgetChanged = JSON.stringify(budget(before)) !== JSON.stringify(budget(after))
    if (budgetChanged || after.instructions.some(ix => after.accountKeys[ix.programIdIndex].equals(LIGHTHOUSE_PROGRAM_ID))) {
      const problem = computeBudgetProblem(after)
      if (problem) return problem
      return recoveryInstructionDifference(before, after)
    }
    if (before.instructions.length !== after.instructions.length) return `instruction count changed (${before.instructions.length} to ${after.instructions.length})`
    if (JSON.stringify(before.header) !== JSON.stringify(after.header)) return 'signer or account permissions changed'
    if (before.accountKeys.length !== after.accountKeys.length) return 'account list changed'
    for (let index = 0; index < before.instructions.length; index++) {
      const a = before.instructions[index], b = after.instructions[index]
      if (!before.accountKeys[a.programIdIndex].equals(after.accountKeys[b.programIdIndex])) return `instruction ${index + 1} program changed`
      if (a.data !== b.data) return `instruction ${index + 1} data changed`
      if (a.accounts.length !== b.accounts.length || a.accounts.some((key, i) => !before.accountKeys[key].equals(after.accountKeys[b.accounts[i]]))) return `instruction ${index + 1} accounts changed`
    }
    // Even apparent reordering is rejected until the cause has been verified.
    return 'account ordering or message encoding changed'
  } catch {
    return 'unrecognized message encoding'
  }
}

const RECOVERY_CONFIRMATION_POLICY = {
  pollMs: 1000,
  rebroadcastMs: 3000,
  maxRebroadcasts: 10,
  maxWaitMs: 90_000,
  requestTimeoutMs: 3000,
}

type ConfirmationRuntime = {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

type ConfirmationRead<T> = { ok: true; value: T } | { ok: false; timedOut?: boolean }
function boundedConfirmationRead<T>(read: () => Promise<T>, timeoutMs: number): Promise<ConfirmationRead<T>> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs)
    Promise.resolve().then(read).then(
      value => { clearTimeout(timer); resolve({ ok: true, value }) },
      () => { clearTimeout(timer); resolve({ ok: false }) },
    )
  })
}

// HTTP confirmation does not depend on a websocket subscription establishing.
// Rebroadcast only the already-approved bytes, never a rebuilt transaction.
export async function confirmRentRecovery(connection: Connection, bytes: Uint8Array, signature: string, latest: { lastValidBlockHeight: number; minContextSlot: number }, stillCurrent: () => boolean, diagnostics?: RecoveryDiagnostics, runtime: ConfirmationRuntime = {
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const policy = RECOVERY_CONFIRMATION_POLICY
  const signedBytes = Buffer.from(bytes)
  const started = runtime.now()
  let lastBroadcastAt = started, broadcasts = 0, polls = 0, readFailures = 0
  let observed = false, active = true, broadcastPending = false, broadcastingDisabled = false
  let lastState = ''
  const requireCurrent = () => {
    if (!stillCurrent()) throw new Error('Wallet or network changed after submission. Check the submitted transaction before retrying.')
  }
  const checkStatus = (status: Awaited<ReturnType<Connection['getSignatureStatuses']>>['value'][number]) => {
    if (!status) return false
    observed = true
    const confirmed = status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' || status.confirmations === null
    if (!confirmed) return false
    if (status.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`)
    return true
  }
  const historyCheck = async () => {
    const result = await boundedConfirmationRead(() => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }), policy.requestTimeoutMs)
    requireCurrent()
    diagnostics?.note('confirmation.history-check', { available: result.ok, found: result.ok && !!result.value.value[0] })
    return result
  }
  try {
    while (runtime.now() - started < policy.maxWaitMs) {
      requireCurrent()
      const timeoutMs = Math.min(policy.requestTimeoutMs, policy.maxWaitMs - (runtime.now() - started))
      const [status, height] = await Promise.all([
        boundedConfirmationRead(() => connection.getSignatureStatuses([signature]), timeoutMs),
        boundedConfirmationRead(() => connection.getBlockHeight('confirmed'), timeoutMs),
      ])
      requireCurrent()
      polls++
      if (!status.ok || !height.ok) readFailures++
      const value = status.ok ? status.value.value[0] : null
      const state = `${status.ok}/${height.ok}/${value?.confirmationStatus ?? 'missing'}/${!!value?.err}`
      if (state !== lastState || polls % 5 === 0) {
        diagnostics?.note('confirmation.http-poll', { poll: polls, statusAvailable: status.ok, heightAvailable: height.ok, found: !!value, ...(height.ok ? { currentBlockHeight: height.value, blocksRemaining: latest.lastValidBlockHeight - height.value } : {}) })
        lastState = state
      }
      if (checkStatus(value)) return signature
      if (height.ok && height.value > latest.lastValidBlockHeight) {
        // An expired blockhash does not undo a transaction already processed.
        // Check history before deciding expiry, including a confirmation race.
        const final = await historyCheck()
        if (final.ok && checkStatus(final.value.value[0])) return signature
        if (!final.ok) throw new Error('Blockhash expired, but transaction history is unavailable. Confirmation is unknown; check the signature before retrying.')
        if (!final.value.value[0]) throw new Error('Transaction blockhash has expired: block height exceeded, and the RPC has no signature history record. Check the signature before retrying.')
        // Processed on a fork is not confirmed: keep polling, without resending.
      } else if (!observed && status.ok && height.ok && !broadcastPending && !broadcastingDisabled && broadcasts < policy.maxRebroadcasts && runtime.now() - started < policy.maxWaitMs && runtime.now() - lastBroadcastAt >= policy.rebroadcastMs) {
        requireCurrent()
        broadcasts++
        lastBroadcastAt = runtime.now()
        broadcastPending = true
        const attempt = broadcasts
        diagnostics?.note('rebroadcast.start', { attempt, blocksRemaining: latest.lastValidBlockHeight - height.value })
        // Start immediately, not in a detached callback that could run after
        // cancellation. Only one request can be in flight. Keep preflight on.
        let request: Promise<string>
        try {
          request = connection.sendRawTransaction(Buffer.from(signedBytes), { skipPreflight: false, preflightCommitment: 'confirmed', minContextSlot: latest.minContextSlot, maxRetries: 0 })
        } catch {
          request = Promise.reject(new Error('Rebroadcast request failed'))
        }
        // A failed rebroadcast is never proof the original failed. A timeout
        // stops additional broadcasts so an unresolved request cannot overlap
        // a new one. Other transport failures can retry the SAME bytes later.
        void boundedConfirmationRead(() => request, policy.requestTimeoutMs).then(result => {
          broadcastPending = false
          if ((!result.ok && result.timedOut) || (result.ok && result.value !== signature)) broadcastingDisabled = true
          if (active) diagnostics?.note('rebroadcast.result', { attempt, acknowledged: result.ok && result.value === signature })
        })
      }
      const remaining = policy.maxWaitMs - (runtime.now() - started)
      if (remaining > 0) await runtime.sleep(Math.min(policy.pollMs, remaining))
    }
    const final = await historyCheck()
    if (final.ok && checkStatus(final.value.value[0])) return signature
    throw new Error('Confirmation timeout: transaction outcome is not yet verified. Check the submitted signature before retrying.')
  } finally {
    active = false
    diagnostics?.note('confirmation.http-summary', { polls, readFailures, rebroadcasts: broadcasts, observed })
  }
}

export async function submitRentRecovery(connection: Connection, signed: Transaction, preview: RentPreview, stillCurrent: () => boolean, onSent: (signature: string) => void, onProgress?: (stage: 'validating' | 'sending' | 'confirming') => void, diagnostics?: RecoveryDiagnostics) {
  if (!stillCurrent()) throw new Error('Wallet or network changed; transaction not sent.')
  const difference = recoveryMessageDifference(preview.expectedMessage, signed.serializeMessage())
  diagnostics?.note('signed.message-check', { passed: !difference, instructionCount: signed.instructions.length })
  if (difference) throw new Error(`The wallet changed the transaction; review again. [Recovery check v3: ${difference}]. Nothing was sent.`)
  // A wallet prompt can stay open for minutes. Recheck after approval as well.
  const bytes = signed.serialize()
  diagnostics?.note('signed.serialized', { bytes: bytes.length })
  onProgress?.('validating')
  const [fresh, simulation] = await Promise.all([
    recoveryStep(diagnostics, 'signed.account-read', () => scanRecoveryRent(connection, preview.user, preview.kind, preview.selected)),
    recoveryStep(diagnostics, 'signed.simulation', () => simulateRecovery(connection, VersionedTransaction.deserialize(bytes), preview.minContextSlot, true)),
  ])
  assertUnchanged(preview.selected, fresh)
  diagnostics?.note('signed.simulation-result', { failed: !!simulation.value.err, ...(simulation.value.unitsConsumed === undefined ? {} : { unitsConsumed: simulation.value.unitsConsumed }) })
  if (simulation.value.err) throw new Error(`Recovery simulation failed: ${JSON.stringify(simulation.value.err)}. Nothing was sent.`)
  if (!stillCurrent()) throw new Error('Wallet or network changed; transaction not sent.')
  onProgress?.('sending')
  if (diagnostics) void diagnostics.sampleHeight(connection, 'height.send-start')
  const signature = await recoveryStep(diagnostics, 'send.rpc', () => connection.sendRawTransaction(bytes, { skipPreflight: false, preflightCommitment: 'confirmed', minContextSlot: preview.minContextSlot, maxRetries: 3 }))
  diagnostics?.submitted()
  onSent(signature)
  onProgress?.('confirming')
  await recoveryStep(diagnostics, 'confirmation.wait', () => confirmRentRecovery(connection, bytes, signature, { lastValidBlockHeight: preview.latest.lastValidBlockHeight, minContextSlot: preview.minContextSlot }, stillCurrent, diagnostics))
  diagnostics?.note('confirmation.result', { failed: false })
  return signature
}
