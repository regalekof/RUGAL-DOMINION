import { Buffer } from 'buffer'
import { ComputeBudgetProgram } from '@solana/web3.js'

export const FIXED_PRIORITY_FEE_LAMPORTS = 110_000 // 0.00011 SOL, excluding base fee.
export const BASE_NETWORK_FEE_LAMPORTS = 5_000 // One signature.
export const MAX_NETWORK_FEE_LAMPORTS = BASE_NETWORK_FEE_LAMPORTS + FIXED_PRIORITY_FEE_LAMPORTS
export const MAX_COMPUTE_UNITS = 1_400_000

/** @param {number} requestedUnits */
export function fixedPriorityInstructions(requestedUnits = MAX_COMPUTE_UNITS) {
  if (!Number.isSafeInteger(requestedUnits) || requestedUnits < 1 || requestedUnits > MAX_COMPUTE_UNITS) throw new Error('Invalid compute limit.')
  // Round UP to a supported 100k bucket, retaining simulation headroom. Each
  // bucket permits exactly 110,000 lamports after Solana's ceiling rounding.
  // https://solana.com/docs/core/fees
  const units = Math.ceil(requestedUnits / 100_000) * 100_000
  const microLamports = Math.floor(FIXED_PRIORITY_FEE_LAMPORTS * 1_000_000 / units)
  return [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ]
}

/** @param {import('@solana/web3.js').Message} message */
export function priorityFeeProblem(message) {
  /** @type {number | undefined} */
  let limit
  /** @type {bigint | undefined} */
  let price
  for (const instruction of message.compiledInstructions) {
    if (!message.accountKeys[instruction.programIdIndex].equals(ComputeBudgetProgram.programId)) continue
    const data = Buffer.from(instruction.data)
    if (instruction.accountKeyIndexes.length) return 'invalid compute-budget accounts'
    if (data[0] === 2 && data.length === 5 && limit === undefined) limit = data.readUInt32LE(1)
    else if (data[0] === 3 && data.length === 9 && price === undefined) price = data.readBigUInt64LE(1)
    else return 'unsupported or duplicate compute-budget instruction'
  }
  if (limit === undefined || price === undefined || limit < 1 || limit > MAX_COMPUTE_UNITS) return 'invalid compute budget'
  const priority = (BigInt(limit) * price + BigInt(999_999)) / BigInt(1_000_000)
  // Preserve wallet compatibility for cheaper budget adjustments, never allow
  // a wallet-added priority charge above the user's fixed maximum.
  if (message.header.numRequiredSignatures !== 1 || BigInt(BASE_NETWORK_FEE_LAMPORTS) + priority > BigInt(MAX_NETWORK_FEE_LAMPORTS)) return 'network fee exceeds 0.000115 SOL cap'
}
