import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

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
