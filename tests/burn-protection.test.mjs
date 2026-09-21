import test from 'node:test'
import assert from 'node:assert/strict'
import { isProtectedBurnMint } from '../lib/burn-protection.ts'

test('USDC and USDT mints are excluded from burning', () => {
  assert.equal(isProtectedBurnMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), true)
  assert.equal(isProtectedBurnMint('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), true)
})

test('unrelated mints and misleading symbols are not identified as official stablecoins', () => {
  assert.equal(isProtectedBurnMint('AZYb4WQ6CfYcajBpavp1FiQ1fXh5ELUzK3HXLgJapump'), false)
  assert.equal(isProtectedBurnMint('USDC'), false)
  assert.equal(isProtectedBurnMint('USDT'), false)
})
