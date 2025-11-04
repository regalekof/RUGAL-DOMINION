"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowLeft, Zap, Shield, Coins, ExternalLink, CheckCircle } from "lucide-react"
import { SiteHeader } from "@/components/site-header"
import { useWallet } from "@solana/wallet-adapter-react"
import { useConnection } from "@solana/wallet-adapter-react"
import { useState, useEffect } from "react"
import { addLeaderboardPoints } from "@/components/leaderboard"
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
  const [successTx, setSuccessTx] = useState<string | null>(null)

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
      // Silently fail - don't show error message to user
      console.error(err)
      setError(null)
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

        // Simulate transaction first to avoid warnings
        try {
          const simulation = await connection.simulateTransaction(transaction)
          
          if (simulation.value.err) {
            throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`)
          }
          
          console.log('✅ Transaction simulation successful')
        } catch (simError) {
          console.error('❌ Transaction simulation failed:', simError)
          throw new Error('Transaction would fail. Please try again.')
        }

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
          setError('Transaction failed. Please try again.')
          return
        }

        console.log('🎉 Transaction successful!')
        setSuccessTx(signature)
        setError(null)

        // Add points to leaderboard
        const referralCode = localStorage.getItem('referral_code')
        for (let i = 0; i < emptyAccounts.length; i++) {
          addLeaderboardPoints(publicKey.toString(), 'absorb', 0, referralCode || undefined)
        }

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

      <main className="container relative py-8 sm:py-12 px-4">
        <div className="flex items-center mb-8">
          <Link href="/" className="flex items-center text-red-400/80 hover:text-primary transition-colors">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Arena
          </Link>
        </div>

        {/* Success Box */}
        {successTx && (
          <div className="mx-auto max-w-[900px] mb-8">
            <Card className="card-gothic pixel-border eclipse-bg border-green-500/30">
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-4">
                  <CheckCircle className="h-6 w-6 text-green-400" />
                  <h3 className="text-xl font-bold text-green-400">Transaction Successful!</h3>
                </div>
                <p className="text-gray-300 mb-4">
                  Your rent absorption transaction has been completed successfully.
                </p>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-400">Transaction ID:</span>
                  <code className="text-sm bg-gray-800 px-2 py-1 rounded text-green-300 font-mono">
                    {successTx.slice(0, 8)}...{successTx.slice(-8)}
                  </code>
                  <a
                    href={`https://solscan.io/tx/${successTx}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    <ExternalLink className="h-4 w-4" />
                    View on Solscan
                  </a>
                </div>
                <Button
                  onClick={() => setSuccessTx(null)}
                  variant="outline"
                  size="sm"
                  className="mt-4 border-gray-600 text-gray-300 hover:bg-gray-800"
                >
                  Close
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

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
                  className="eclipse-glow rugal-gradient w-full py-4 sm:py-6 text-sm sm:text-base"
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

