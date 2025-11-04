export const RPC_CONFIG = {
  // QuickNode endpoints
  QUICKNODE_HTTP: 'https://quaint-green-wave.solana-mainnet.quiknode.pro/547b99bb19613b5ff403ac71268514966104dc99/',
  QUICKNODE_WSS: 'wss://quaint-green-wave.solana-mainnet.quiknode.pro/547b99bb19613b5ff403ac71268514966104dc99/',
  
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
  // Primary endpoints - QuickNode
  QUICKNODE_HTTP: RPC_CONFIG.QUICKNODE_HTTP,
  QUICKNODE_WSS: RPC_CONFIG.QUICKNODE_WSS,
  
  // Backup endpoints
  HELIUS: getValidEndpoint(`https://mainnet.helius-rpc.com/?api-key=${RPC_CONFIG.HELIUS_API_KEY}`),
  ANKR: getValidEndpoint(`https://rpc.ankr.com/solana/${RPC_CONFIG.ANKR_API_KEY}`),
  
  // Last resort - public endpoint
  PUBLIC: 'https://api.mainnet-beta.solana.com',
}

// Get the best available endpoint with WebSocket support
export const getBestEndpoint = () => {
  // Try QuickNode first
  if (RPC_ENDPOINTS.QUICKNODE_HTTP && RPC_ENDPOINTS.QUICKNODE_WSS) {
    return {
      http: RPC_ENDPOINTS.QUICKNODE_HTTP,
      wss: RPC_ENDPOINTS.QUICKNODE_WSS
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