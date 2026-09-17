type SolanaNetwork = 'mainnet-beta' | 'devnet'

const network = (process.env.NEXT_PUBLIC_SOLANA_NETWORK || 'mainnet-beta') as SolanaNetwork
const heliusApiKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY?.trim()
const heliusHost = network === 'devnet' ? 'devnet.helius-rpc.com' : 'mainnet.helius-rpc.com'
const heliusQuery = heliusApiKey ? `?api-key=${encodeURIComponent(heliusApiKey)}` : ''

/** Helius uses the same path for HTTP and standard Solana WebSockets. */
export const RPC_ENDPOINTS = {
  http: heliusApiKey ? `https://${heliusHost}/${heliusQuery}` : null,
  wss: heliusApiKey ? `wss://${heliusHost}/${heliusQuery}` : null,
  public: network === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com',
} as const

export const getBestEndpoint = () => {
  if (!RPC_ENDPOINTS.http || !RPC_ENDPOINTS.wss) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('Missing NEXT_PUBLIC_HELIUS_API_KEY; falling back to the public Solana RPC.')
    }
    return { http: RPC_ENDPOINTS.public, wss: undefined }
  }
  return { http: RPC_ENDPOINTS.http, wss: RPC_ENDPOINTS.wss }
}
