"use client"

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useConnection } from '@solana/wallet-adapter-react'
import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, createBurnCheckedInstruction, getAccount, createCloseAccountInstruction, getMint } from '@solana/spl-token'
import { getTokenMetadata } from '@/lib/metaplex-utils'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Flame, Zap, ExternalLink, CheckCircle } from 'lucide-react'
import { RPC_CONFIG } from '@/app/config'
import { addLeaderboardPoints } from '@/components/leaderboard'

// Fee wallet address
const FEE_WALLET = new PublicKey('5YjWWvfD1r2YaHqtHbzBYvyjWbpLYT8ebVgyngCJXFVU')
const FEE_PERCENTAGE = 2.0 // 2.0% fee

interface Token {
  address: string
  mint: string
  name: string
  symbol: string
  balance: number
  decimals: number
  tokenAccount: PublicKey
  image?: string
  description?: string
  isFrozen?: boolean
}

interface TokenAccount {
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          tokenAmount: {
            uiAmount: number;
            decimals: number;
          };
        };
      };
    };
  };
  pubkey: PublicKey;
}

export function TokenBurn() {
  const { publicKey, sendTransaction } = useWallet()
  const { connection } = useConnection()
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(false)
  const [tokens, setTokens] = useState<Token[]>([])
  const [isFetching, setIsFetching] = useState(false)
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(new Set())
  const [hasInitialFetch, setHasInitialFetch] = useState(false)
  const [successTx, setSuccessTx] = useState<string | null>(null)

  // Function to fetch token metadata
  const fetchTokenMetadata = async (mint: string): Promise<{ image?: string; description?: string; symbol?: string }> => {
    // Return default metadata for common tokens first
    const commonTokens: { [key: string]: { image: string; description: string; symbol: string } } = {
      'So11111111111111111111111111111111111111112': {
        image: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
        description: 'Wrapped SOL',
        symbol: 'SOL'
      },
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
        image: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
        description: 'USD Coin',
        symbol: 'USDC'
      },
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': {
        image: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png',
        description: 'Tether USD',
        symbol: 'USDT'
      }
    }
    
    if (commonTokens[mint]) {
      console.log('Found common token:', mint, commonTokens[mint])
      return commonTokens[mint]
    }
    
    // Try to fetch from Solana Token List
    try {
      const response = await fetch('https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json')
      if (response.ok) {
        const data = await response.json()
        const token = data.tokens?.find((t: any) => t.address === mint)
        if (token) {
          console.log('Found token in token list:', token)
          return {
            image: token.logoURI,
            description: token.name,
            symbol: token.symbol
          }
        }
      }
    } catch (error) {
      console.log('Could not fetch from token list:', error)
    }
    
    // Try to fetch from Jupiter API for other tokens
    try {
      const response = await fetch(`https://price.jup.ag/v4/price?ids=${mint}`)
      if (response.ok) {
        const data = await response.json()
        const tokenData = data.data?.[mint]
        if (tokenData) {
          console.log('Found token in Jupiter API:', tokenData)
          return {
            image: tokenData.image,
            description: tokenData.description,
            symbol: tokenData.symbol
          }
        }
      }
    } catch (error) {
      console.log('Could not fetch metadata for token:', mint)
    }
    
    console.log('No metadata found for token:', mint)
    return {}
  }

  // Use QuickNode endpoint with proper configuration
  const rpcConnection = new Connection(RPC_CONFIG.QUICKNODE_HTTP, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
    wsEndpoint: RPC_CONFIG.QUICKNODE_WSS,
    httpHeaders: {
      'Content-Type': 'application/json',
    }
  })

  // Memoize the fetch function to prevent unnecessary re-renders
  // Helper function to fetch metadata from URI (based on your backend code)
  const fetchMetadataFromUri = async (uri: string): Promise<{ name?: string; symbol?: string; image?: string } | undefined> => {
    try {
      console.log('🔍 Fetching metadata from URI:', uri)
      const response = await fetch(uri)
      if (response.ok) {
        const data = await response.json()
        console.log('🔍 Metadata JSON:', data)
        return {
          name: data.name,
          symbol: data.symbol,
          image: data.image || data.logoURI
        }
      } else {
        console.log('⚠️ Failed to fetch metadata from URI:', uri, 'Status:', response.status)
      }
    } catch (error) {
      console.log('❌ Error fetching metadata from URI:', uri, error)
    }
    return undefined
  }



  const fetchTokens = useCallback(async () => {
      if (!publicKey) {
        console.log('No public key available')
        return
      }

      try {
        setIsFetching(true)
      console.log('Starting token fetch for wallet:', publicKey.toString())
        
      // Get all token accounts
        const tokenAccounts = await rpcConnection.getParsedTokenAccountsByOwner(publicKey, {
          programId: TOKEN_PROGRAM_ID,
        })

      console.log('Found token accounts:', tokenAccounts.value.length)
        
      // Process all token accounts to find tokens with balance > 0 (excluding NFTs)
      const tokenPromises = tokenAccounts.value
        .filter(({ account }) => {
          const parsedInfo = account.data.parsed.info
          const tokenAmount = parsedInfo.tokenAmount
          // Exclude NFTs: tokens with amount = 1 and decimals = 0
          const isNFT = tokenAmount.uiAmount === 1 && tokenAmount.decimals === 0
          return tokenAmount.uiAmount > 0 && !isNFT
        })
        .map(async ({ account, pubkey }) => {
          const parsedInfo = account.data.parsed.info
          const mint = new PublicKey(parsedInfo.mint)
          
          try {
            // Get token metadata
            const tokenAccount = await getAccount(rpcConnection, pubkey)
            
            // Fetch token metadata using Solana SDK (proper approach)
            let tokenName = `Token ${parsedInfo.mint.slice(0, 8)}`
            let tokenSymbol = parsedInfo.mint.slice(0, 4).toUpperCase()
            let tokenImage = undefined
            
            // Check for common tokens first (guaranteed to work)
            const commonTokens: { [key: string]: { name: string; symbol: string; image: string } } = {
              'So11111111111111111111111111111111111111112': {
                name: 'Solana',
                symbol: 'SOL',
                image: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'
              },
              'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
                name: 'USD Coin',
                symbol: 'USDC',
                image: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png'
              },
              'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': {
                name: 'Tether USD',
                symbol: 'USDT',
                image: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png'
              }
            }
            
            if (commonTokens[parsedInfo.mint]) {
              const commonToken = commonTokens[parsedInfo.mint]
              tokenName = commonToken.name
              tokenSymbol = commonToken.symbol
              tokenImage = commonToken.image
              console.log('✅ Using common token:', commonToken)
            } else {
              // For other tokens, use multiple metadata sources
              try {
                console.log('🔍 Fetching metadata for:', parsedInfo.mint)
                
                // Get token metadata using Jupiter API + Solana Token List
                const metadata = await getTokenMetadata(rpcConnection.rpcEndpoint, parsedInfo.mint)
                
                if (metadata && metadata.name) {
                  console.log('✅ Found metadata:', metadata)
                  tokenName = metadata.name
                  if (metadata.symbol) tokenSymbol = metadata.symbol
                  if (metadata.image) tokenImage = metadata.image
                } else {
                  console.log('⚠️ No metadata found for:', parsedInfo.mint)
                  
                  // Create better fallback names for unknown tokens
                  const mintShort = parsedInfo.mint.slice(0, 8)
                  const mintEnd = parsedInfo.mint.slice(-4)
                  tokenName = `Token ${mintShort}...${mintEnd}`
                  tokenSymbol = mintShort.toUpperCase()
                  
                  console.log('🔧 Using fallback name:', tokenName, 'symbol:', tokenSymbol)
                }
              } catch (error) {
                console.log('⚠️ Failed to get metadata for:', parsedInfo.mint, error)
                
                // Create better fallback names even on error
                const mintShort = parsedInfo.mint.slice(0, 8)
                const mintEnd = parsedInfo.mint.slice(-4)
                tokenName = `Token ${mintShort}...${mintEnd}`
                tokenSymbol = mintShort.toUpperCase()
                
                console.log('🔧 Using error fallback name:', tokenName, 'symbol:', tokenSymbol)
              }
            }
            
            // Check if token account is frozen
            const isFrozen = parsedInfo.state === 'frozen'
            
            console.log('Final token data:', {
              mint: parsedInfo.mint,
              name: tokenName,
              symbol: tokenSymbol,
              image: tokenImage,
              isFrozen: isFrozen
            })
            
            return {
              address: pubkey.toString(),
              mint: parsedInfo.mint,
              name: tokenName,
              symbol: tokenSymbol,
              balance: parsedInfo.tokenAmount.uiAmount,
              decimals: parsedInfo.tokenAmount.decimals,
                tokenAccount: pubkey,
              image: tokenImage,
              description: undefined,
              isFrozen: isFrozen
            }
          } catch (error) {
            console.error('Error fetching token account:', error)
            return null
          }
        })
      
      // Wait for all token metadata to be fetched
      const tokenResults = await Promise.all(tokenPromises)
      const finalTokenList = tokenResults.filter(token => token !== null) as Token[]
      
      console.log('🔍 Final token list:', finalTokenList)
      console.log('🔍 Token count:', finalTokenList.length)

      // Update state only once with all tokens
      setTokens(finalTokenList)
      setHasInitialFetch(true)
      } catch (error) {
      console.error('Error in fetchTokens:', error)
        toast({
          title: 'Error',
        description: 'Failed to fetch tokens. Please try again.',
          variant: 'destructive',
        })
      } finally {
        setIsFetching(false)
      }
  }, [publicKey, toast, rpcConnection])

  // Only fetch tokens when the wallet is connected and hasn't been fetched before
  useEffect(() => {
    if (publicKey && !hasInitialFetch) {
      fetchTokens()
    }
  }, [publicKey, hasInitialFetch, fetchTokens])

  // Memoize the token list to prevent unnecessary re-renders
  const memoizedTokens = useMemo(() => tokens, [tokens])

  const toggleTokenSelection = (address: string) => {
    setSelectedTokens(prev => {
      const newSet = new Set(prev)
      if (newSet.has(address)) {
        newSet.delete(address)
      } else {
        newSet.add(address)
      }
      return newSet
    })
  }

  const selectAllTokens = () => {
    const burnableTokenAddresses = memoizedTokens
      .filter(token => !token.isFrozen)
      .map(token => token.address)
    setSelectedTokens(new Set(burnableTokenAddresses))
  }

  const deselectAllTokens = () => {
    setSelectedTokens(new Set())
  }

  const handleBurn = async () => {
    if (!publicKey || selectedTokens.size === 0) {
      toast({
        title: 'Error',
        description: 'Please select tokens to burn',
        variant: 'destructive',
      })
      return
    }

    try {
      setIsLoading(true)
      
      const tokensToBurn = tokens.filter(token => selectedTokens.has(token.address))
      
      // Calculate rent exemption amount
      const rentExemptionLamports = await rpcConnection.getMinimumBalanceForRentExemption(165)
      const feeLamports = Math.floor(rentExemptionLamports * (FEE_PERCENTAGE / 100))

      // Check user's balance before attempting transfer
      const userBalance = await rpcConnection.getBalance(publicKey)
      const estimatedTransactionFee = 5000 // Estimated transaction fee in lamports
      
      console.log('🔍 Token Burn Debug:', {
        rentExemptionLamports,
        feeLamports,
        userBalance,
        rentExemptionSOL: rentExemptionLamports / LAMPORTS_PER_SOL,
        feeSOL: feeLamports / LAMPORTS_PER_SOL,
        userBalanceSOL: userBalance / LAMPORTS_PER_SOL
      })

      // Check if user has enough balance for fee + transaction fee
      const hasEnoughBalance = userBalance >= feeLamports + estimatedTransactionFee;
      if (!hasEnoughBalance) {
        console.log('⚠️ User has insufficient balance for fee transfer, skipping fee');
        console.log('💰 User balance:', userBalance / LAMPORTS_PER_SOL, 'SOL');
        console.log('💰 Required for fee:', (feeLamports + estimatedTransactionFee) / LAMPORTS_PER_SOL, 'SOL');
      }

      const transaction = new Transaction()
      
      // Add burn and close instructions for all selected tokens
      for (const token of tokensToBurn) {
        console.log('🔧 Creating burn instruction for token:', token.address, 'balance:', token.balance)
        
      const burnInstruction = createBurnCheckedInstruction(
        token.tokenAccount,
          new PublicKey(token.mint),
        publicKey,
          Math.floor(token.balance * Math.pow(10, token.decimals)),
          token.decimals,
          [],
          TOKEN_PROGRAM_ID
        )

      const closeInstruction = createCloseAccountInstruction(
        token.tokenAccount,
          publicKey,
          publicKey,
          [],
          TOKEN_PROGRAM_ID
        )

        transaction.add(burnInstruction)
        transaction.add(closeInstruction)
        console.log('✅ Added burn and close instructions for:', token.address)
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
      const { blockhash, lastValidBlockHeight } = await rpcConnection.getLatestBlockhash()
      transaction.recentBlockhash = blockhash
      transaction.feePayer = publicKey

      console.log('📝 Transaction instructions count:', transaction.instructions.length)
      console.log('📝 Tokens being burned:', tokensToBurn.length)
      console.log('📝 Token addresses:', tokensToBurn.map(t => t.address))

      // Simulate transaction first to avoid warnings
      try {
        const simulation = await rpcConnection.simulateTransaction(transaction)
        
        if (simulation.value.err) {
          throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`)
        }
        
        console.log('✅ Transaction simulation successful')
      } catch (simError) {
        console.error('❌ Transaction simulation failed:', simError)
        throw new Error('Transaction would fail. Please try again.')
      }

      // Sign and send the transaction
      const signature = await sendTransaction(transaction, rpcConnection)

      console.log('✅ Transaction signature:', signature)
      
      // Wait for confirmation
      const confirmation = await rpcConnection.confirmTransaction({
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
      setSuccessTx(signature)

      setTokens(prev => prev.filter(token => !selectedTokens.has(token.address)))
      setSelectedTokens(new Set())

      // Add points to leaderboard for each token burned
      const tokenCount = selectedTokens.size
      const feesPaid = hasEnoughBalance ? feeLamports : 0
      const referralCode = localStorage.getItem('referral_code')
      for (let i = 0; i < tokenCount; i++) {
        addLeaderboardPoints(publicKey.toString(), 'token_burn', feesPaid, referralCode || undefined)
      }

      toast({
        title: 'Success!',
        description: `Burned ${tokenCount} tokens + ${tokenCount * 100} points!`,
      })
    } catch (error) {
      console.error('Error burning tokens:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to burn tokens. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center mb-6">
        <h2 className="text-xl font-bold mb-2">Token Burning</h2>
      </div>

      {/* Success Box */}
      {successTx && (
        <div className="mb-6">
          <div className="bg-gray-900 border border-green-500/30 rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <CheckCircle className="h-6 w-6 text-green-400" />
              <h3 className="text-xl font-bold text-green-400">Transaction Successful!</h3>
            </div>
            <p className="text-gray-300 mb-4">
              Your token burning transaction has been completed successfully.
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
          </div>
        </div>
      )}

      {publicKey ? (
        isFetching && !hasInitialFetch ? (
          <div className="text-center py-8">
          <p className="text-red-400/60">Loading tokens...</p>
          </div>
        ) : memoizedTokens.length > 0 ? (
          <>
            <div className="flex justify-center gap-4 mb-6">
              <Button
                onClick={selectAllTokens}
                variant="outline"
                className="border-purple-500 text-purple-300 hover:bg-purple-500/20"
              >
                Select All
              </Button>
              <Button
                onClick={deselectAllTokens}
                variant="outline"
                className="border-red-500 text-red-300 hover:bg-red-500/20"
              >
                Deselect All
              </Button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {memoizedTokens.map((token) => (
              <div
                key={token.address}
                className="p-3 sm:p-4"
              >
                <div className="flex flex-col items-center text-center space-y-3">
                  <div 
                    className={`flex-shrink-0 transition-all ${
                      token.isFrozen 
                        ? 'cursor-not-allowed opacity-50' 
                        : 'cursor-pointer hover:scale-105'
                    }`}
                    onClick={() => !token.isFrozen && toggleTokenSelection(token.address)}
                  >
                    {token.image ? (
                      <div className="relative">
                        <img
                      src={token.image}
                          alt={token.symbol}
                          className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full object-cover transition-all ${
                            selectedTokens.has(token.address)
                              ? 'ring-4 ring-primary ring-opacity-50'
                              : ''
                          }`}
                          onError={(e) => {
                            console.log('❌ Image failed to load:', token.image)
                            console.log('❌ Image error details:', e)
                            e.currentTarget.style.display = 'none'
                          }}
                          onLoad={() => {
                            console.log('✅ Image loaded successfully:', token.image)
                          }}
                        />
                        {selectedTokens.has(token.address) && (
                          <div className="absolute inset-0 w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-purple-500/30 backdrop-blur-sm flex items-center justify-center">
                            <div className="w-6 h-6 bg-purple-600 rounded-full flex items-center justify-center">
                              <span className="text-white text-xs font-bold">✓</span>
                            </div>
                          </div>
                        )}
                        {token.isFrozen && (
                          <div className="absolute inset-0 w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-red-500/40 backdrop-blur-sm flex items-center justify-center">
                            <div className="bg-red-600 px-2 py-1 rounded text-center">
                              <span className="text-white text-xs font-bold">FROZEN</span>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="relative">
                        <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gradient-to-br from-red-500/30 to-purple-500/30 flex items-center justify-center transition-all ${
                          selectedTokens.has(token.address)
                            ? 'ring-4 ring-primary ring-opacity-50'
                            : ''
                        }`}>
                          <span className="text-red-300 font-bold text-lg sm:text-2xl">{token.symbol.slice(0, 2).toUpperCase()}</span>
                        </div>
                        {selectedTokens.has(token.address) && (
                          <div className="absolute inset-0 w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-purple-500/30 backdrop-blur-sm flex items-center justify-center">
                            <div className="w-6 h-6 bg-purple-600 rounded-full flex items-center justify-center">
                              <span className="text-white text-xs font-bold">✓</span>
                            </div>
                          </div>
                        )}
                        {token.isFrozen && (
                          <div className="absolute inset-0 w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-red-500/40 backdrop-blur-sm flex items-center justify-center">
                            <div className="bg-red-600 px-2 py-1 rounded text-center">
                              <span className="text-white text-xs font-bold">FROZEN</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-bold text-lg text-white">{token.name}</h3>
                    <span className="bg-red-500/20 text-red-300 px-3 py-1 rounded-full text-sm font-medium border border-red-500/30">
                      {token.symbol}
                    </span>
                    <p className="text-green-400 font-medium text-sm">Balance: {token.balance.toLocaleString()}</p>
                  </div>
                </div>
              </div>
              ))}
                </div>
            <div className="flex justify-center mt-6">
                <Button 
                onClick={handleBurn}
                disabled={isLoading || selectedTokens.size === 0}
                className="bg-red-600 hover:bg-red-700"
              >
                {isLoading ? (
                  <Zap className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Flame className="w-4 h-4 mr-2" />
                )}
                Burn Selected Tokens
                </Button>
              </div>
          </>
        ) : (
          <div className="text-center py-8">
            <p className="text-red-400/60">No tokens found in your wallet</p>
          </div>
        )
      ) : (
        <div className="text-center py-8">
          <p className="text-red-400/60">Please connect your wallet to view tokens</p>
        </div>
      )}
    </div>
  )
} 