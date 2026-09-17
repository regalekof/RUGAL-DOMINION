import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { findMetadataPda, fetchMetadata } from '@metaplex-foundation/mpl-token-metadata'
import { publicKey as umiPublicKey } from '@metaplex-foundation/umi'

export interface TokenMetadata {
  name?: string
  symbol?: string
  image?: string
}

export async function getTokenMetadata(
  rpcEndpoint: string,
  mint: string
): Promise<TokenMetadata | null> {
  console.log('🚀 getTokenMetadata called with:', mint)
  
  // Try UMI approach first
  try {
    console.log('🔍 Fetching token metadata using UMI for:', mint)
    
    // Create UMI instance
    const umi = createUmi(rpcEndpoint)
    
    // Convert mint string to UMI publicKey
    const mintPubkey = umiPublicKey(mint)
    console.log('🔍 Mint PublicKey:', mintPubkey.toString())
    
    // Find metadata PDA
    console.log('🔍 Finding metadata PDA...')
    const metadataPda = findMetadataPda(umi, { mint: mintPubkey })
    console.log('🔍 Metadata PDA:', metadataPda.toString())
    
    // Fetch metadata from blockchain
    console.log('🔍 Fetching metadata from blockchain...')
    const metadata = await fetchMetadata(umi, metadataPda)
    console.log('🔍 Metadata from blockchain:', metadata)
    
    if (metadata && metadata.name) {
      console.log('✅ Found metadata on blockchain:', metadata)
      
      // Get image from URI if available
      let imageUrl = undefined
      if (metadata.uri) {
        console.log('🔍 Fetching image from URI:', metadata.uri)
        try {
          const uriResponse = await fetch(metadata.uri)
          if (uriResponse.ok) {
            const uriData = await uriResponse.json()
            imageUrl = uriData.image
            console.log('✅ Found image from URI:', imageUrl)
          } else {
            console.log('⚠️ Failed to fetch metadata JSON, status:', uriResponse.status)
          }
        } catch (uriError) {
          console.log('⚠️ Failed to fetch image from URI:', uriError)
        }
      }
      
      return {
        name: metadata.name,
        symbol: metadata.symbol,
        image: imageUrl
      }
    } else {
      console.log('⚠️ No metadata found on blockchain for:', mint)
    }
  } catch (error) {
    console.log('⚠️ UMI approach failed:', error)
    console.log('⚠️ Error details:', (error as Error).message, (error as Error).stack)
    console.log('🔍 Falling back to Solana Token List...')
  }
  
  // Fallback to Solana Token List if UMI fails
  try {
    console.log('🔍 Trying Solana Token List as fallback...')
    const tokenListResponse = await fetch('https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json')
    console.log('🔍 Token List response status:', tokenListResponse.status)
    
    if (tokenListResponse.ok) {
      const tokenList = await tokenListResponse.json()
      console.log('🔍 Token List loaded, searching for:', mint)
      const token = tokenList.tokens.find((t: any) => t.address === mint)
      if (token) {
        console.log('✅ Found in Solana Token List:', token)
        return {
          name: token.name,
          symbol: token.symbol,
          image: token.logoURI
        }
      } else {
        console.log('⚠️ Token not found in Solana Token List')
      }
    } else {
      console.log('⚠️ Token List failed with status:', tokenListResponse.status)
    }
  } catch (error) {
    console.log('⚠️ Solana Token List fallback also failed:', error)
  }
  
  console.log('❌ No metadata found from any source for:', mint)
  return null
}
