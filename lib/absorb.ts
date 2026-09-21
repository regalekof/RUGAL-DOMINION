import { Buffer } from 'buffer'
import { ComputeBudgetProgram, Message, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import type { AccountInfo, Connection } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType, getExtensionTypes, getTransferFeeAmount, unpackAccount, createCloseAccountInstruction } from '@solana/spl-token'

export type RentKind = 'token' | 'pump'
export type RecoveryKind = RentKind | 'both'
export type RentAccount = { address: string; program: string; label: string; lamports: number; blocked?: string }
export const MAX_RENT_ACCOUNTS = 10
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

export function tokenRentAccount(address: PublicKey, info: AccountInfo<Buffer>, user: PublicKey): RentAccount | null {
  if (!TOKEN_PROGRAMS.some(program => program.equals(info.owner))) return null
  const account = unpackAccount(address, info, info.owner)
  // Native/wrapped SOL and nonempty accounts are not rent-only recovery targets.
  if (!account.isInitialized || account.isNative || account.amount !== BigInt(0) || !account.owner.equals(user)) return null
  let blocked: string | undefined
  if (!(account.closeAuthority ?? account.owner).equals(user)) blocked = 'Another wallet has close authority.'
  const extensions = getExtensionTypes(account.tlvData)
  if (extensions.some(type => ![ExtensionType.ImmutableOwner, ExtensionType.TransferFeeAmount].includes(type))) blocked = 'This token extension needs additional checks; account excluded.'
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
  const results = await Promise.all(TOKEN_PROGRAMS.map(programId => connection.getTokenAccountsByOwner(user, { programId }, 'confirmed')))
  return results.flatMap(result => result.value.flatMap(({ pubkey, account }) => {
    const item = tokenRentAccount(pubkey, account, user)
    return item ? [item] : []
  })).sort((a, b) => a.address.localeCompare(b.address))
}

export async function scanPumpRent(connection: Connection, user: PublicKey): Promise<RentAccount[]> {
  const addresses = PUMP_PROGRAMS.map(({ id }) => pumpAddress(user, id))
  const infos = await connection.getMultipleAccountsInfo(addresses, 'confirmed')
  const rent = infos.some(Boolean) ? await connection.getMinimumBalanceForRentExemption(137, 'confirmed') : 0
  const rows = await Promise.all(infos.map(async (info, index) => {
    if (!info) return null
    const { id, label } = PUMP_PROGRAMS[index]
    let blocked = pumpBlockReason(info, user, id, rent)
    if (!blocked) {
      // PumpSwap rewards live in PDA-owned token accounts. Check both token programs;
      // never close reward vaults as part of a rent-only action.
      const vaults = await Promise.all(TOKEN_PROGRAMS.map(programId => connection.getTokenAccountsByOwner(addresses[index], { programId }, 'confirmed')))
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

export function accountRentKind(account: RentAccount): RentKind {
  if (TOKEN_PROGRAMS.some(id => id.toBase58() === account.program)) return 'token'
  if (PUMP_PROGRAMS.some(({ id }) => id.toBase58() === account.program)) return 'pump'
  throw new Error('Unsupported recovery program.')
}

export function selectRentBatch(accounts: RentAccount[]) {
  // Put the at-most-two Pump PDAs first so a large token list cannot push them
  // into a later batch when the user selected both categories.
  return accounts.filter(account => !account.blocked)
    .sort((a, b) => Number(accountRentKind(a) === 'token') - Number(accountRentKind(b) === 'token'))
    .slice(0, MAX_RENT_ACCOUNTS)
}

async function scanRecoveryRent(connection: Connection, user: PublicKey, kind: RecoveryKind) {
  if (kind === 'token') return scanTokenRent(connection, user)
  if (kind === 'pump') return scanPumpRent(connection, user)
  const [tokens, pump] = await Promise.all([scanTokenRent(connection, user), scanPumpRent(connection, user)])
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

export async function prepareRentRecovery(connection: Connection, user: PublicKey, kind: RecoveryKind, selected: RentAccount[]) {
  const fresh = await scanRecoveryRent(connection, user, kind)
  assertUnchanged(selected, fresh)
  const totals = rentTotals(selected)
  const latest = await connection.getLatestBlockhash('confirmed')
  const transaction = new Transaction({ feePayer: user, ...latest })
  // Declare the price before estimating, simulating and asking for a signature.
  // Phantom otherwise injects priority instructions at signing, invalidating our
  // exact-message check. Zero preserves the existing base-fee-only policy; leave
  // the default compute-unit limit intact. Never relax the signed-message check.
  // https://docs.phantom.com/developer-powertools/solana-priority-fees
  transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }))
  selected.forEach(account => transaction.add(closeRentInstruction(accountRentKind(account), account, user)))
  // Recover rent first so the service fee is funded from the returned SOL.
  // This transfer is atomic with all closures; it is not sent separately.
  if (totals.fee > 0) transaction.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: FEE_WALLET, lamports: totals.fee }))
  if (transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length > 1232) throw new Error('This selection is too large for one transaction. Select fewer accounts.')
  const message = transaction.compileMessage()
  const networkFee = (await connection.getFeeForMessage(message, 'confirmed')).value
  if (networkFee === null) throw new Error('Could not estimate the network fee. Try again.')
  if (await connection.getBalance(user, 'confirmed') < networkFee) throw new Error('You need enough SOL in your wallet to pay the network fee before rent is returned.')
  if (totals.net <= networkFee) throw new Error('Network fees would exceed the rent recovered.')
  // Wrap legacy messages to avoid the legacy simulateTransaction overload, which
  // can replace the blockhash of a signed transaction.
  const simulation = await connection.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, commitment: 'confirmed' })
  if (simulation.value.err) throw new Error(`Recovery simulation failed: ${JSON.stringify(simulation.value.err)}. Nothing was sent.`)
  return { transaction, expectedMessage: transaction.serializeMessage(), latest, networkFee, kind, user, selected: selected.map(account => ({ ...account })), ...totals }
}

export type RentPreview = Awaited<ReturnType<typeof prepareRentRecovery>>

// Compare byte values rather than relying on a wallet's Buffer implementation.
// Diagnostics deliberately contain no wallet addresses, signatures or RPC URLs.
export function recoveryMessageDifference(expected: Uint8Array, actual: Uint8Array): string | undefined {
  if (expected.length === actual.length && expected.every((byte, index) => byte === actual[index])) return
  try {
    const before = Message.from(expected), after = Message.from(actual)
    if (!before.accountKeys[0].equals(after.accountKeys[0])) return 'fee payer changed'
    if (before.recentBlockhash !== after.recentBlockhash) return 'blockhash changed'
    const budget = (message: Message) => message.instructions.filter(ix => message.accountKeys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)).map(ix => ix.data)
    if (JSON.stringify(budget(before)) !== JSON.stringify(budget(after))) return 'compute-budget instructions changed'
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

export async function submitRentRecovery(connection: Connection, signed: Transaction, preview: RentPreview, stillCurrent: () => boolean, onSent: (signature: string) => void) {
  if (!stillCurrent()) throw new Error('Wallet or network changed; transaction not sent.')
  const difference = recoveryMessageDifference(preview.expectedMessage, signed.serializeMessage())
  if (difference) throw new Error(`The wallet changed the transaction; review again. [Recovery check v2: ${difference}]. Nothing was sent.`)
  // A wallet prompt can stay open for minutes. Recheck after approval as well.
  const fresh = await scanRecoveryRent(connection, preview.user, preview.kind)
  assertUnchanged(preview.selected, fresh)
  const bytes = signed.serialize()
  const simulation = await connection.simulateTransaction(VersionedTransaction.deserialize(bytes), { sigVerify: true, commitment: 'confirmed' })
  if (simulation.value.err) throw new Error(`Recovery simulation failed: ${JSON.stringify(simulation.value.err)}. Nothing was sent.`)
  if (!stillCurrent()) throw new Error('Wallet or network changed; transaction not sent.')
  const signature = await connection.sendRawTransaction(bytes, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 })
  onSent(signature)
  const confirmation = await connection.confirmTransaction({ signature, ...preview.latest }, 'confirmed')
  if (confirmation.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
  return signature
}
