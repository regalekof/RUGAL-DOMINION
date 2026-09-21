import { PublicKey } from '@solana/web3.js'
import type { Connection } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType, getExtensionTypes, getTransferFeeAmount, unpackAccount, unpackMint, createBurnCheckedInstruction, createCloseAccountInstruction } from '@solana/spl-token'

// Match mint addresses, not untrusted token symbols or names.
const PROTECTED_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
])

export function isProtectedBurnMint(mint: string): boolean {
  return PROTECTED_MINTS.has(mint)
}

export const BURN_TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]

export async function scanBurnTokens(connection: Connection, user: PublicKey) {
  const results = await Promise.all(BURN_TOKEN_PROGRAMS.map(programId =>
    connection.getParsedTokenAccountsByOwner(user, { programId }, 'confirmed')))
  return results.flatMap(result => result.value).filter(({ account }) => {
    const info = account.data.parsed.info
    const amount = info.tokenAmount
    return BURN_TOKEN_PROGRAMS.some(program => program.equals(account.owner)) &&
      info.owner === user.toBase58() && !info.isNative &&
      amount.amount !== '0' && !(amount.amount === '1' && amount.decimals === 0) &&
      !isProtectedBurnMint(info.mint)
  })
}

export function burnBlockReason(info: {
  state: string; closeAuthority?: string;
  extensions?: { extension: string; state?: { withheldAmount?: string | number } }[]
}, user: PublicKey): string | undefined {
  if (info.state !== 'initialized') return 'This account is frozen or not initialized.'
  if (info.closeAuthority && info.closeAuthority !== user.toBase58()) return 'Another wallet has close authority.'
  for (const extension of info.extensions ?? []) {
    if (!['immutableOwner', 'transferFeeAmount'].includes(extension.extension)) return 'Unsupported token extension; excluded for safety.'
    if (extension.extension === 'transferFeeAmount' && String(extension.state?.withheldAmount) !== '0') return 'Withheld tokens must be resolved before closing this account.'
  }
}

// Re-read raw account and mint state before constructing destructive instructions.
// Metadata, names and symbols never determine the program or burn amount.
export async function createCheckedBurnInstructions(connection: Connection, user: PublicKey, token: {
  tokenAccount: PublicKey; mint: string; programId: PublicKey; amount: string; decimals: number
}) {
  if (isProtectedBurnMint(token.mint)) throw new Error('USDC and USDT are excluded from burning.')
  if (!BURN_TOKEN_PROGRAMS.some(program => program.equals(token.programId))) throw new Error('Unsupported token program.')
  const mint = new PublicKey(token.mint)
  const [info, mintInfo] = await Promise.all([
    connection.getAccountInfo(token.tokenAccount, 'confirmed'),
    connection.getAccountInfo(mint, 'confirmed'),
  ])
  if (!info || !mintInfo || !info.owner.equals(token.programId) || !mintInfo.owner.equals(token.programId)) throw new Error('Token account or program changed. Refresh and review again.')
  const account = unpackAccount(token.tokenAccount, info, token.programId)
  const mintAccount = unpackMint(mint, mintInfo, token.programId)
  if (!account.owner.equals(user) || !account.mint.equals(mint) || !account.isInitialized || account.isFrozen || account.isNative ||
      !(account.closeAuthority ?? account.owner).equals(user)) throw new Error('This token account cannot be safely burned and closed by your wallet.')
  if (!mintAccount.isInitialized || mintAccount.decimals !== token.decimals || account.amount <= BigInt(0) || account.amount !== BigInt(token.amount)) throw new Error('Token balance or mint changed. Refresh and review again.')
  if (getExtensionTypes(account.tlvData).some(type => ![ExtensionType.ImmutableOwner, ExtensionType.TransferFeeAmount].includes(type))) throw new Error('Unsupported token extension; excluded for safety.')
  if ((getTransferFeeAmount(account)?.withheldAmount ?? BigInt(0)) !== BigInt(0)) throw new Error('Withheld tokens must be resolved before closing this account.')
  return [
    createBurnCheckedInstruction(token.tokenAccount, mint, user, account.amount, token.decimals, [], token.programId),
    createCloseAccountInstruction(token.tokenAccount, user, user, [], token.programId),
  ]
}
