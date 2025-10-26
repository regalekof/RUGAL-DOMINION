"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowLeft, Zap, Shield, Coins } from "lucide-react"
import { SiteHeader } from "@/components/site-header"
import { useWallet } from "@solana/wallet-adapter-react"
import { useConnection } from "@solana/wallet-adapter-react"
import { useState, useEffect } from "react"
import { PublicKey, Transaction } from "@solana/web3.js"
import { TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token"
import { createCloseAccountInstruction } from "@solana/spl-token"
import { SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js"

// Import wallet adapter CSS
require("@solana/wallet-adapter-react-ui/styles.css")

// Fee wallet address
const FEE_WALLET = new PublicKey('5YjWWvfD1r2YaHqtHbzBYvyjWbpLYT8ebVgyngCJXFVU')
const FEE_PERCENTAGE = 2.0 // 2.0% fee

function AbsorbContent() {
  const { publicKey, sendTransaction } = useWallet()
  const { connection } = useConnection()
  const [emptyAccounts, setEmptyAccounts] = useState<{ address: string; balance: number }[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const findEmptyAccounts = async () => {
    if (!publicKey) return

    try {
      setIsLoading(true)
      setError(null)

      // Get all token accounts owned by the wallet
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        publicKey,
        { programId: TOKEN_PROGRAM_ID }
      )

      // Filter for empty accounts
      const empty = tokenAccounts.value
        .filter(account => {
          const parsedInfo = account.account.data.parsed.info
          return parsedInfo.tokenAmount.uiAmount === 0
        })
        .map(account => ({
          address: account.pubkey.toString(),
          balance: account.account.data.parsed.info.tokenAmount.uiAmount
        }))

      setEmptyAccounts(empty)
    } catch (err) {
      setError("Failed to find empty accounts")
      console.error(err)
    } finally {
      setIsLoading(false)
    }
  }

  const closeAccounts = async () => {
    if (!publicKey || emptyAccounts.length === 0) return

      try {
        setIsLoading(true)
        setError(null)

        // Calculate total rent exemption amount for all accounts
        const rentExemptionLamports = await connection.getMinimumBalanceForRentExemption(165)
        const totalRentLamports = rentExemptionLamports * emptyAccounts.length
        const feeLamports = Math.floor(totalRentLamports * (FEE_PERCENTAGE / 100))

        // Check user's balance before attempting transfer
        const userBalance = await connection.getBalance(publicKey)
        const estimatedTransactionFee = 5000 // Estimated transaction fee in lamports
        
        console.log('🔍 Transaction Debug:', {
          rentExemptionLamports,
          totalRentLamports,
          feeLamports,
          userBalance,
          rentExemptionSOL: rentExemptionLamports / LAMPORTS_PER_SOL,
          totalRentSOL: totalRentLamports / LAMPORTS_PER_SOL,
          feeSOL: feeLamports / LAMPORTS_PER_SOL,
          userBalanceSOL: userBalance / LAMPORTS_PER_SOL,
          accountCount: emptyAccounts.length
        })

        // Check if user has enough balance for fee + transaction fee
        const hasEnoughBalance = userBalance >= feeLamports + estimatedTransactionFee;
        if (!hasEnoughBalance) {
          console.log('⚠️ User has insufficient balance for fee transfer, skipping fee');
          console.log('💰 User balance:', userBalance / LAMPORTS_PER_SOL, 'SOL');
          console.log('💰 Required for fee:', (feeLamports + estimatedTransactionFee) / LAMPORTS_PER_SOL, 'SOL');
        }

        // Create a single transaction
        const transaction = new Transaction()
      
        // Add close account instructions for all empty accounts
        for (const account of emptyAccounts) {
          const accountPubkey = new PublicKey(account.address)
          console.log('🔧 Creating close instruction for account:', account.address, 'balance:', account.balance)
          
          // Double-check that the account is actually empty
          if (account.balance !== 0) {
            console.log('⚠️ Skipping account - not empty:', account.address, 'balance:', account.balance)
            continue
          }
          
          const instruction = createCloseAccountInstruction(
            accountPubkey,    // account to close
            publicKey,       // destination (rent goes to user)
            publicKey        // authority (user signs)
          )
          transaction.add(instruction)
          console.log('✅ Added close instruction for:', account.address)
        }

        // Add fee transfer instruction only if user has enough balance
        if (feeLamports > 0 && hasEnoughBalance) {
          console.log('💰 Adding fee transfer:', {
            from: publicKey.toString(),
            to: FEE_WALLET.toString(),
            lamports: feeLamports,
            sol: feeLamports / LAMPORTS_PER_SOL
          })
          transaction.add(
            SystemProgram.transfer({
              fromPubkey: publicKey,
              toPubkey: FEE_WALLET,
              lamports: feeLamports
            })
          )
        } else {
          console.log('⚠️ Skipping fee transfer - insufficient balance or no fee needed')
        }
      
        // Get latest blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
        transaction.recentBlockhash = blockhash
        transaction.feePayer = publicKey

        console.log('📝 Transaction instructions count:', transaction.instructions.length)
        console.log('📝 Empty accounts being processed:', emptyAccounts.length)
        console.log('📝 Account addresses:', emptyAccounts.map(acc => acc.address))

        // Sign and send the single transaction
        const signature = await sendTransaction(transaction, connection)

        console.log('✅ Transaction signature:', signature)

        // Wait for confirmation
        const confirmation = await connection.confirmTransaction({
          signature,
          blockhash,
          lastValidBlockHeight
        })

        console.log('📊 Transaction confirmation:', confirmation)

        if (confirmation.value.err) {
          console.error('❌ Transaction failed:', confirmation.value.err)
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`)
        }

        console.log('✅ Transaction successful!')

      // Refresh the list
      await findEmptyAccounts()
    } catch (err) {
      setError("Failed to close accounts")
      console.error(err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (publicKey) {
      findEmptyAccounts()
    }
  }, [publicKey])

  return (
    <div className="relative min-h-screen">
      <SiteHeader />

      <main className="container relative py-12">
        <div className="flex items-center mb-8">
          <Link href="/" className="flex items-center text-red-400/80 hover:text-primary transition-colors">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Arena
          </Link>
        </div>

        <div className="mx-auto max-w-[900px]">
          <div className="text-center mb-12">
            <h1 className="text-4xl font-bold tracking-tighter sm:text-5xl md:text-6xl power-text">Omega Absorption</h1>
            <p className="mt-4 text-red-400/80 md:text-xl">
              Absorb the power of dormant accounts to strengthen your dominion
            </p>
          </div>

          {/* Account Closing Card */}
          <Card className="card-gothic pixel-border eclipse-bg mb-12">
            <CardHeader>
              <CardTitle className="flex items-center justify-center gap-2">
                <Zap className="h-5 w-5 text-primary" />
                <span>Absorb Tokens</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {/* Account Summary */}
                <div className="flex flex-col items-center justify-center p-8 border border-red-900/30 rounded-md bg-purple-900/10">
                  <div className="w-20 h-20 rounded-full bg-primary/20 flex items-center justify-center mb-4">
                    <Coins className="h-10 w-10 text-primary" />
                </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold mb-2">{emptyAccounts.length}</p>
                    </div>
                </div>


                {error && (
                  <div className="p-4 border border-red-500/30 rounded bg-red-500/10">
                    <p className="text-sm text-red-400">{error}</p>
                  </div>
                )}

                <Button 
                  className="eclipse-glow rugal-gradient w-full py-6"
                  onClick={closeAccounts}
                  disabled={!publicKey || emptyAccounts.length === 0 || isLoading}
                >
                  <Zap className="mr-2 h-5 w-5" />
                  {isLoading ? "Processing..." : "Absorb"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}

export default function AbsorbPage() {
  return <AbsorbContent />
}

