export const RPC_CONFIG = {
  // Primary RPC – set in .env.local (never commit real URLs)
  RPC_HTTP: process.env.NEXT_PUBLIC_RPC_HTTP || '',
  RPC_WSS: process.env.NEXT_PUBLIC_RPC_WSS || '',

  // Backup providers
  HELIUS_API_KEY: process.env.NEXT_PUBLIC_HELIUS_API_KEY || '',
  ANKR_API_KEY: process.env.NEXT_PUBLIC_ANKR_API_KEY || '',
}

// Helper function to validate endpoint
const getValidEndpoint = (endpoint: string) => {
  if (!endpoint.includes('undefined') && !endpoint.includes('null') && endpoint.length > 0) {
    return endpoint
  }
  return null
}

export const RPC_ENDPOINTS = {
  // Primary (from env)
  RPC_HTTP: getValidEndpoint(RPC_CONFIG.RPC_HTTP) || null,
  RPC_WSS: getValidEndpoint(RPC_CONFIG.RPC_WSS) || null,
  
  // Backup endpoints
  HELIUS: getValidEndpoint(`https://mainnet.helius-rpc.com/?api-key=${RPC_CONFIG.HELIUS_API_KEY}`),
  ANKR: getValidEndpoint(`https://rpc.ankr.com/solana/${RPC_CONFIG.ANKR_API_KEY}`),
  
  // Last resort - public endpoint
  PUBLIC: 'https://api.mainnet-beta.solana.com',
}

// Get the best available endpoint with WebSocket support
export const getBestEndpoint = () => {
  // Primary RPC from env first
  if (RPC_ENDPOINTS.RPC_HTTP && RPC_ENDPOINTS.RPC_WSS) {
    return {
      http: RPC_ENDPOINTS.RPC_HTTP,
      wss: RPC_ENDPOINTS.RPC_WSS
    }
  }
  
  // Try Helius next
  if (RPC_ENDPOINTS.HELIUS) {
    return {
      http: RPC_ENDPOINTS.HELIUS,
      wss: RPC_ENDPOINTS.HELIUS.replace('https://', 'wss://')
    }
  }
  
  // Try Ankr
  if (RPC_ENDPOINTS.ANKR) {
    return {
      http: RPC_ENDPOINTS.ANKR,
      wss: RPC_ENDPOINTS.ANKR.replace('https://', 'wss://')
    }
  }
  
  // Fallback to public endpoint
  return {
    http: RPC_ENDPOINTS.PUBLIC,
    wss: RPC_ENDPOINTS.PUBLIC.replace('https://', 'wss://')
  }
} 