import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ComputeBudgetInstruction, ComputeBudgetProgram, Keypair, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createBurnCheckedInstruction, createCloseAccountInstruction } from '@solana/spl-token'
import { FIXED_PRIORITY_FEE_LAMPORTS, MAX_NETWORK_FEE_LAMPORTS, fixedPriorityInstructions, priorityFeeProblem } from '../lib/priority-fee.mjs'

test('every compute bucket charges exactly 0.00011 SOL priority, not per account or per CU', () => {
  assert.equal(FIXED_PRIORITY_FEE_LAMPORTS, 110000)
  assert.equal(MAX_NETWORK_FEE_LAMPORTS, 115000)
  for (let requested = 1; requested <= 1400000; requested += 997) {
    const [priceIx, limitIx] = fixedPriorityInstructions(requested)
    const { units } = ComputeBudgetInstruction.decodeSetComputeUnitLimit(limitIx)
    const { microLamports } = ComputeBudgetInstruction.decodeSetComputeUnitPrice(priceIx)
    assert.ok(units >= requested && units <= 1400000)
    assert.equal((BigInt(units) * microLamports + 999999n) / 1000000n, 110000n)
  }
  for (const invalid of [0, -1, 1.5, NaN, Infinity, 1400001]) assert.throws(() => fixedPriorityInstructions(invalid), /Invalid compute limit/)
})

test('token and NFT burn budgets survive signing and reject wallet fees over the cap', () => {
  const signer = Keypair.generate(), account = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: mint.toBase58() }).add(
      ...fixedPriorityInstructions(),
      createBurnCheckedInstruction(account, mint, signer.publicKey, 1n, 0, [], program),
      createCloseAccountInstruction(account, signer.publicKey, signer.publicKey, [], program),
    )
    assert.equal(priorityFeeProblem(tx.compileMessage()), undefined)
    tx.sign(signer)
    const signed = Transaction.from(tx.serialize())
    assert.equal(priorityFeeProblem(signed.compileMessage()), undefined)
    const { microLamports } = ComputeBudgetInstruction.decodeSetComputeUnitPrice(signed.instructions[0])
    const { units } = ComputeBudgetInstruction.decodeSetComputeUnitLimit(signed.instructions[1])
    assert.equal((BigInt(units) * microLamports + 999999n) / 1000000n, 110000n)
    signed.instructions[0] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 78572 })
    assert.match(priorityFeeProblem(signed.compileMessage()), /0.000115 SOL cap/)
  }
})

test('both burn components use the shared budget, balance threshold and post-wallet cap check', () => {
  for (const name of ['token-burn', 'nft-burn']) {
    const source = readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), 'utf8')
    assert.match(source, /MIN_TRANSACTION_BALANCE_LAMPORTS = MAX_NETWORK_FEE_LAMPORTS/)
    assert.match(source, /new Transaction\(\)\.add\(\.\.\.fixedPriorityInstructions\(\)\)/)
    const sign = source.indexOf('await signTransaction(transaction)')
    const check = source.indexOf('const feeProblem = priorityFeeProblem(', sign)
    const send = source.indexOf('connection.sendRawTransaction(', sign)
    assert.ok(sign >= 0 && check > sign && send > check)
  }
})
