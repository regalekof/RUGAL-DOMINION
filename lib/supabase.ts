export { supabase } from './supabase-client'

// Database types
export interface LeaderboardEntry {
  id: string
  wallet: string
  points: number
  absorbs: number
  token_burns: number
  nft_burns: number
  total_fees_paid: number
  last_activity: string
  created_at: string
  updated_at: string
}

export interface LeaderboardInsert {
  wallet: string
  points?: number
  absorbs?: number
  token_burns?: number
  nft_burns?: number
  total_fees_paid?: number
  last_activity?: string
}

export interface LeaderboardUpdate {
  points?: number
  absorbs?: number
  token_burns?: number
  nft_burns?: number
  total_fees_paid?: number
  last_activity?: string
}
