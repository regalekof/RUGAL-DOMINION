// Match mint addresses, not untrusted token symbols or names.
const PROTECTED_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
])

export function isProtectedBurnMint(mint: string): boolean {
  return PROTECTED_MINTS.has(mint)
}
