import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountLayout, MintLayout, AccountState, decodeBurnCheckedInstruction, decodeCloseAccountInstruction } from '@solana/spl-token'
import { isProtectedBurnMint, scanBurnTokens, burnBlockReason, createCheckedBurnInstructions } from '../lib/burn-protection.ts'

test('USDC and USDT mints are excluded from burning', () => {
  assert.equal(isProtectedBurnMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), true)
  assert.equal(isProtectedBurnMint('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), true)
})

test('unrelated mints and misleading symbols are not identified as official stablecoins', () => {
  assert.equal(isProtectedBurnMint('AZYb4WQ6CfYcajBpavp1FiQ1fXh5ELUzK3HXLgJapump'), false)
  assert.equal(isProtectedBurnMint('USDC'), false)
  assert.equal(isProtectedBurnMint('USDT'), false)
})

const user = Keypair.generate().publicKey
const mint = Keypair.generate().publicKey
const address = Keypair.generate().publicKey
const other = Keypair.generate().publicKey
function parsed(program, changes = {}) {
  return { pubkey: address, account: { owner: program, data: { parsed: { info: {
    mint: mint.toBase58(), owner: user.toBase58(), state: 'initialized', isNative: false,
    tokenAmount: { amount: '1000000', decimals: 6 }, ...changes,
  } } } } }
}

test('scanner includes both token programs and excludes stablecoins, native SOL, empty accounts and NFTs', async () => {
  const calls = []
  const rpc = { getParsedTokenAccountsByOwner: async (owner, { programId }) => {
    assert.ok(owner.equals(user)); calls.push(programId.toBase58())
    return { value: [parsed(programId),
      parsed(programId, { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }),
      parsed(programId, { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }),
      parsed(programId, { isNative: true }), parsed(programId, { owner: other.toBase58() }),
      parsed(programId, { tokenAmount: { amount: '0', decimals: 6 } }),
      parsed(programId, { tokenAmount: { amount: '1', decimals: 0 } }),
    ] }
  } }
  const rows = await scanBurnTokens(rpc, user)
  assert.deepEqual(calls, [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(key => key.toBase58()))
  assert.equal(rows.length, 2)
  assert.ok(rows[1].account.owner.equals(TOKEN_2022_PROGRAM_ID))
})

test('scanner reports RPC failures instead of silently omitting a program', async () => {
  await assert.rejects(scanBurnTokens({ getParsedTokenAccountsByOwner: async () => { throw new Error('RPC unavailable') } }, user), /RPC unavailable/)
})

test('UI blocks frozen, foreign-close-authority, withheld and unsupported extension accounts', () => {
  const info = { state: 'initialized' }
  assert.equal(burnBlockReason({ ...info, extensions: [{ extension: 'immutableOwner' }] }, user), undefined)
  assert.equal(burnBlockReason({ ...info, extensions: [{ extension: 'transferFeeAmount', state: { withheldAmount: '0' } }] }, user), undefined)
  for (const changes of [{ state: 'frozen' }, { closeAuthority: other.toBase58() },
    { extensions: [{ extension: 'transferFeeAmount', state: { withheldAmount: '1' } }] },
    { extensions: [{ extension: 'transferFeeAmount' }] },
    { extensions: [{ extension: 'confidentialTransferAccount' }] },
  ]) assert.ok(burnBlockReason({ ...info, ...changes }, user))
})

function fixture(program, changes = {}, extension = Buffer.alloc(0)) {
  const amount = 9007199254740993n
  const data = Buffer.alloc(extension.length ? 166 + extension.length : 165)
  AccountLayout.encode({ mint, owner: user, amount, delegateOption: 0, delegate: PublicKey.default,
    state: AccountState.Initialized, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
    closeAuthorityOption: 0, closeAuthority: PublicKey.default, ...changes }, data)
  if (extension.length) { data[165] = 2; extension.copy(data, 166) }
  const mintData = Buffer.alloc(MintLayout.span)
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: amount,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData)
  const accountInfo = { owner: program, data, lamports: 1513840, executable: false, rentEpoch: 0 }
  const mintInfo = { ...accountInfo, data: mintData }
  const rpc = { getAccountInfo: async key => key.equals(address) ? accountInfo : mintInfo }
  return { rpc, accountInfo, mintInfo, token: { tokenAccount: address, mint: mint.toBase58(), programId: program, amount: amount.toString(), decimals: 6 } }
}

test('burn and close use each owning program and exact bigint balances including Token-2022 ImmutableOwner', async () => {
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const f = fixture(program, {}, program.equals(TOKEN_2022_PROGRAM_ID) ? Buffer.from([7, 0, 0, 0]) : Buffer.alloc(0))
    const [burn, close] = await createCheckedBurnInstructions(f.rpc, user, f.token)
    assert.ok(burn.programId.equals(program)); assert.ok(close.programId.equals(program))
    assert.equal(decodeBurnCheckedInstruction(burn, program).data.amount, BigInt(f.token.amount))
    assert.ok(decodeCloseAccountInstruction(close, program).keys.destination.pubkey.equals(user))
  }
})

test('raw revalidation rejects frozen/native/foreign accounts, changed amounts and close authorities', async () => {
  for (const changes of [{ state: AccountState.Frozen }, { isNativeOption: 1 }, { owner: other },
    { mint: other }, { amount: 1n }, { closeAuthorityOption: 1, closeAuthority: other }]) {
    const f = fixture(TOKEN_2022_PROGRAM_ID, changes)
    await assert.rejects(createCheckedBurnInstructions(f.rpc, user, f.token))
  }
  for (const change of [f => { f.accountInfo.owner = SystemProgram.programId },
    f => { f.mintInfo.owner = TOKEN_PROGRAM_ID }, f => { f.token.decimals = 9 },
    f => { f.token.mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }]) {
    const f = fixture(TOKEN_2022_PROGRAM_ID); change(f)
    await assert.rejects(createCheckedBurnInstructions(f.rpc, user, f.token))
  }
})

test('raw revalidation rejects withheld balances and unsupported extensions', async () => {
  const fee = Buffer.alloc(12); fee.writeUInt16LE(2); fee.writeUInt16LE(8, 2); fee.writeBigUInt64LE(1n, 4)
  for (const extension of [fee, Buffer.from([8, 0, 1, 0, 1])]) {
    const f = fixture(TOKEN_2022_PROGRAM_ID, {}, extension)
    await assert.rejects(createCheckedBurnInstructions(f.rpc, user, f.token), /Withheld|Unsupported/)
  }
  fee.writeBigUInt64LE(0n, 4)
  const f = fixture(TOKEN_2022_PROGRAM_ID, {}, fee)
  assert.equal((await createCheckedBurnInstructions(f.rpc, user, f.token)).length, 2)
})
