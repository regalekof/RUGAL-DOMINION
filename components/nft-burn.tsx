"use client"

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, createBurnCheckedInstruction, getAccount, createCloseAccountInstruction } from '@solana/spl-token'
import { Metaplex } from '@metaplex-foundation/js'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Flame, Zap, ExternalLink, CheckCircle } from 'lucide-react'
import Image from 'next/image'
import { RPC_CONFIG } from '@/app/config'
import { addLeaderboardPoints } from '@/components/leaderboard'

// Fee wallet address
const FEE_WALLET = new PublicKey('5YjWWvfD1r2YaHqtHbzBYvyjWbpLYT8ebVgyngCJXFVU')
const FEE_PERCENTAGE = 2.0 // 2.0% fee

interface NFT {
  address: string
  name: string
  image: string
  tokenAccount: PublicKey
  mint: PublicKey
  collection: string
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

// Enhanced metadata fetching function similar to token burning
const fetchNFTMetadata = async (mint: string) => {
  console.log('🔍 Fetching NFT metadata for:', mint)
  
  try {
    // Try to fetch from Solana Token List first
    const tokenListResponse = await fetch('https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json')
    if (tokenListResponse.ok) {
      const tokenList = await tokenListResponse.json()
      const token = tokenList.tokens.find((t: any) => t.address === mint)
      if (token) {
        console.log('✅ Found NFT in Solana Token List:', token)
        return {
          name: token.name,
          symbol: token.symbol,
          image: token.logoURI
        }
      }
    }
  } catch (error) {
    console.log('⚠️ Solana Token List failed:', error)
  }
  
  console.log('❌ No metadata found from any source for:', mint)
  return {}
}

// Helper function to get a valid image URL with enhanced fallbacks
const getValidImageUrl = (url: string | undefined) => {
  if (!url) return '/placeholder.png'
  if (url.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${url.replace('ipfs://', '')}`
  }
  if (url.startsWith('ar://')) {
    return `https://arweave.net/${url.replace('ar://', '')}`
  }
  return url
}

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type RetryFunction = () => Promise<any>;

const retryWithBackoff = async (
  fn: RetryFunction,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<any> => {
  let retries = 0;
  let delay = initialDelay;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (retries >= maxRetries) throw error;
      
      // If it's a rate limit error, wait longer
      if (error instanceof Error && error.message.includes('429')) {
        await new Promise<void>(resolve => setTimeout(resolve, delay * 2));
      } else {
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
      
      delay *= 2;
      retries++;
    }
  }
};

export function NFTBurn() {
  const { publicKey, signTransaction } = useWallet()
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(false)
  const [nfts, setNfts] = useState<NFT[]>([])
  const [isFetching, setIsFetching] = useState(false)
  const [selectedNFTs, setSelectedNFTs] = useState<Set<string>>(new Set())
  const [hasInitialFetch, setHasInitialFetch] = useState(false)
  const [successTx, setSuccessTx] = useState<string | null>(null)

  // Use QuickNode endpoint with proper configuration
  const rpcConnection = new Connection(RPC_CONFIG.QUICKNODE_HTTP, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
    wsEndpoint: RPC_CONFIG.QUICKNODE_WSS,
    httpHeaders: {
      'Content-Type': 'application/json',
    }
  })

  // Create Metaplex instance with proper configuration
  const metaplex = new Metaplex(rpcConnection)

  // Memoize the fetch function to prevent unnecessary re-renders
  const fetchNFTs = useCallback(async () => {
    if (!publicKey) {
      console.log('No public key available')
      return
    }

    try {
      setIsFetching(true)
      console.log('Starting NFT fetch for wallet:', publicKey.toString())
      
      // Get all token accounts
      const tokenAccounts = await rpcConnection.getParsedTokenAccountsByOwner(publicKey, {
        programId: TOKEN_PROGRAM_ID,
      })

      console.log('Found token accounts:', tokenAccounts.value.length)
      const nftList: NFT[] = []
      
      // Process all token accounts to find NFTs
      for (const { account, pubkey } of tokenAccounts.value) {
        const parsedInfo = account.data.parsed.info
        
        // Check if it's an NFT (amount = 1 and decimals = 0) and not a CNFT
        if (parsedInfo.tokenAmount.uiAmount === 1 && parsedInfo.tokenAmount.decimals === 0) {
          const mint = new PublicKey(parsedInfo.mint)
          
          // Skip CNFTs - they typically have specific mint patterns or fail metadata fetching
          // CNFTs often have very long mint addresses or specific characteristics
          const mintString = mint.toString()
          
          // Skip if mint address is too long (CNFTs often have longer addresses)
          if (mintString.length > 44) {
            console.log('Skipping CNFT (long mint address):', mintString)
            continue
          }
          
          try {
            // Fetch NFT metadata with retry
            const nft = await retryWithBackoff(() => 
              metaplex.nfts().findByMint({ mintAddress: mint })
            )
            
            // Additional CNFT detection - CNFTs often fail metadata fetching or have specific patterns
            if (!nft) {
              console.log('Skipping CNFT (no metadata found):', mintString)
              continue
            }
            
            // Check for CNFT characteristics
            if (nft.json === null || nft.json === undefined) {
              console.log('Skipping CNFT (no JSON metadata):', mintString)
              continue
            }
            
            if (nft) {
              // Get collection metadata if available
              let collectionName = 'No Collection'
              if (nft.collection) {
                try {
                  const collection = await metaplex.nfts().findByMint({ mintAddress: nft.collection.address })
                  collectionName = collection.name || 'Unknown Collection'
                } catch (error) {
                  console.error('Error fetching collection metadata:', error)
                }
              }

              // Try to get enhanced metadata as fallback
              let enhancedMetadata: { name?: string; symbol?: string; image?: string } = {}
              try {
                enhancedMetadata = await fetchNFTMetadata(mint.toString())
              } catch (error) {
                console.log('Enhanced metadata fetch failed:', error)
              }

              // Check if NFT token account is frozen
              const isFrozen = parsedInfo.state === 'frozen'

              nftList.push({
                address: pubkey.toString(),
                name: nft.name || enhancedMetadata.name || `NFT #${pubkey.toString().slice(0, 4)}`,
                image: getValidImageUrl(nft.json?.image || enhancedMetadata.image),
                tokenAccount: pubkey,
                mint: mint,
                collection: collectionName,
                isFrozen: isFrozen
              })
            }
          } catch (error) {
            console.error('Error fetching NFT metadata:', error)
            // Try enhanced metadata as fallback
            let enhancedMetadata: { name?: string; symbol?: string; image?: string } = {}
            try {
              enhancedMetadata = await fetchNFTMetadata(mint.toString())
            } catch (fallbackError) {
              console.log('Enhanced metadata fallback also failed:', fallbackError)
            }
            
            // Add NFT with basic info if metadata fetch fails
            const isFrozen = parsedInfo.state === 'frozen'
            
            nftList.push({
              address: pubkey.toString(),
              name: enhancedMetadata.name || `NFT #${pubkey.toString().slice(0, 4)}`,
              image: getValidImageUrl(enhancedMetadata.image),
              tokenAccount: pubkey,
              mint: mint,
              collection: 'Unknown Collection',
              isFrozen: isFrozen
            })
          }
        }
      }

      // Update state only once with all NFTs
      setNfts(nftList)
      setHasInitialFetch(true)
    } catch (error) {
      console.error('Error in fetchNFTs:', error)
      toast({
        title: 'Error',
        description: 'Failed to fetch NFTs. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setIsFetching(false)
    }
  }, [publicKey, toast, rpcConnection, metaplex])

  // Only fetch NFTs when the wallet is connected and hasn't been fetched before
  useEffect(() => {
    if (publicKey && !hasInitialFetch) {
      fetchNFTs()
    }
  }, [publicKey, hasInitialFetch, fetchNFTs])

  // Memoize the NFT list to prevent unnecessary re-renders
  const memoizedNFTs = useMemo(() => nfts, [nfts])

  const toggleNFTSelection = (address: string) => {
    setSelectedNFTs(prev => {
      const newSet = new Set(prev)
      if (newSet.has(address)) {
        newSet.delete(address)
      } else {
        newSet.add(address)
      }
      return newSet
    })
  }

  const selectAllNFTs = () => {
    const burnableNFTAddresses = memoizedNFTs
      .filter(nft => !nft.isFrozen)
      .map(nft => nft.address)
    setSelectedNFTs(new Set(burnableNFTAddresses))
  }

  const deselectAllNFTs = () => {
    setSelectedNFTs(new Set())
  }

  const handleBurn = async () => {
    if (!publicKey || !signTransaction || selectedNFTs.size === 0) {
      toast({
        title: 'Error',
        description: 'Please select NFTs to burn',
        variant: 'destructive',
      })
      return
    }

    try {
      setIsLoading(true)
      
      const nftsToBurn = nfts.filter(nft => selectedNFTs.has(nft.address))
      
      // Calculate rent exemption amount
      const rentExemptionLamports = await rpcConnection.getMinimumBalanceForRentExemption(165)
      const feeLamports = Math.floor(rentExemptionLamports * (FEE_PERCENTAGE / 100))

      // Check user's balance before attempting transfer
      const userBalance = await rpcConnection.getBalance(publicKey)
      const estimatedTransactionFee = 5000 // Estimated transaction fee in lamports
      
      console.log('🔍 NFT Burn Debug:', {
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
      
      for (const nft of nftsToBurn) {
        console.log('🔧 Creating burn instruction for NFT:', nft.address)
        
        const burnInstruction = createBurnCheckedInstruction(
          nft.tokenAccount,
          nft.mint,
          publicKey,
          1,
          0,
          [],
          TOKEN_PROGRAM_ID
        )

        const closeInstruction = createCloseAccountInstruction(
          nft.tokenAccount,
          publicKey,
          publicKey,
          [],
          TOKEN_PROGRAM_ID
        )

        transaction.add(burnInstruction)
        transaction.add(closeInstruction)
        console.log('✅ Added burn and close instructions for:', nft.address)
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
      console.log('📝 NFTs being burned:', nftsToBurn.length)
      console.log('📝 NFT addresses:', nftsToBurn.map(nft => nft.address))

      const signedTx = await signTransaction(transaction)
      const signature = await rpcConnection.sendRawTransaction(signedTx.serialize())
      await rpcConnection.confirmTransaction(signature)

      console.log('✅ Transaction successful!')
      setSuccessTx(signature)

      setNfts(prev => prev.filter(nft => !selectedNFTs.has(nft.address)))
      setSelectedNFTs(new Set())

      // Add points to leaderboard for each NFT burned
      const nftCount = selectedNFTs.size
      const feesPaid = hasEnoughBalance ? feeLamports : 0
      const referralCode = localStorage.getItem('referral_code')
      for (let i = 0; i < nftCount; i++) {
        addLeaderboardPoints(publicKey.toString(), 'nft_burn', feesPaid, referralCode || undefined)
      }

      toast({
        title: 'Success!',
        description: `Burned ${nftCount} NFTs + ${nftCount * 200} points!`,
      })
    } catch (error) {
      console.error('Error burning NFTs:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to burn NFTs. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center mb-6">
        <h2 className="text-xl font-bold mb-2">NFT Burning</h2>
        <p className="text-red-400/60">
          Select NFTs to burn
        </p>
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
              Your NFT burning transaction has been completed successfully.
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
            <p className="text-red-400/60">Loading NFTs...</p>
          </div>
        ) : memoizedNFTs.length > 0 ? (
          <>
            <div className="flex justify-center gap-4 mb-6">
              <Button
                onClick={selectAllNFTs}
                variant="outline"
                className="border-purple-500 text-purple-300 hover:bg-purple-500/20"
              >
                Select All
              </Button>
              <Button
                onClick={deselectAllNFTs}
                variant="outline"
                className="border-red-500 text-red-300 hover:bg-red-500/20"
              >
                Deselect All
              </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {memoizedNFTs.map((nft) => (
                <div
                  key={nft.address}
                  className="p-4"
                >
                  <div className="flex flex-col items-center text-center space-y-3">
                    <div 
                      className={`flex-shrink-0 transition-all ${
                        nft.isFrozen 
                          ? 'cursor-not-allowed opacity-50' 
                          : 'cursor-pointer hover:scale-105'
                      }`}
                      onClick={() => !nft.isFrozen && toggleNFTSelection(nft.address)}
                    >
                      <div className="relative">
                        <div className="w-24 h-24 rounded-lg overflow-hidden">
                    <Image
                      src={getValidImageUrl(nft.image)}
                      alt={nft.name}
                            width={96}
                            height={96}
                            className="w-full h-full object-cover"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement
                        target.src = '/placeholder.png'
                      }}
                    />
                        </div>
                        {selectedNFTs.has(nft.address) && (
                          <div className="absolute inset-0 w-24 h-24 rounded-lg bg-purple-500/30 backdrop-blur-sm flex items-center justify-center">
                            <div className="w-6 h-6 bg-purple-600 rounded-full flex items-center justify-center">
                              <span className="text-white text-xs font-bold">✓</span>
                            </div>
                          </div>
                        )}
                        {nft.isFrozen && (
                          <div className="absolute inset-0 w-24 h-24 rounded-lg bg-red-500/40 backdrop-blur-sm flex items-center justify-center">
                            <div className="bg-red-600 px-2 py-1 rounded text-center">
                              <span className="text-white text-xs font-bold">FROZEN</span>
                            </div>
                          </div>
                        )}
                      </div>
                  </div>
                  <div className="space-y-2">
                      <h3 className="font-bold text-lg text-white">{nft.name}</h3>
                    <p className="text-sm text-gray-400">{nft.collection}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-center mt-6">
              <Button
                onClick={handleBurn}
                disabled={isLoading || selectedNFTs.size === 0}
                className="bg-red-600 hover:bg-red-700"
              >
                {isLoading ? (
                  <Zap className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Flame className="w-4 h-4 mr-2" />
                )}
                Burn Selected NFTs
              </Button>
            </div>
          </>
        ) : (
          <div className="text-center py-8">
            <p className="text-red-400/60">No NFTs found in your wallet</p>
          </div>
        )
      ) : (
        <div className="text-center py-8">
          <p className="text-red-400/60">Please connect your wallet to view NFTs</p>
        </div>
      )}
    </div>
  )
} 