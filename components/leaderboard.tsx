'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Trophy, Medal, Award, Crown } from 'lucide-react'
import { supabase } from '@/lib/supabase-client'

// Points system
export const POINTS = {
  ABSORB: 10,    // 10 points per account absorbed
  TOKEN_BURN: 50, // 50 points per token burned
  NFT_BURN: 200   // 200 points per NFT burned
}

interface LeaderboardEntry {
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

export function Leaderboard() {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    // Load leaderboard data from Supabase or localStorage fallback
    const loadLeaderboard = async () => {
      try {
        if (supabase) {
          // Use Supabase if configured
          const { data, error } = await supabase
            .from('leaderboard_entries')
            .select('*')
            .order('points', { ascending: false })
            .limit(50)

          if (error) {
            console.error('Error loading leaderboard:', error)
            // Fallback to localStorage
            loadFromLocalStorage()
          } else {
            setLeaderboard(data || [])
          }
        } else {
          // Fallback to localStorage when Supabase is not configured
          loadFromLocalStorage()
        }
      } catch (error) {
        console.error('Error loading leaderboard:', error)
        loadFromLocalStorage()
      } finally {
        setIsLoading(false)
      }
    }

    const loadFromLocalStorage = () => {
      try {
        const stored = localStorage.getItem('rugal-leaderboard')
        if (stored) {
          const data = JSON.parse(stored)
          // Convert localStorage format to new format
          const convertedData = data.map((entry: any) => ({
            id: entry.wallet,
            wallet: entry.wallet,
            points: entry.points,
            absorbs: entry.absorbs,
            token_burns: entry.tokenBurns || 0,
            nft_burns: entry.nftBurns || 0,
            total_fees_paid: entry.totalFeesPaid || 0,
            last_activity: entry.lastActivity,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }))
          setLeaderboard(convertedData)
        }
      } catch (error) {
        console.error('Error loading from localStorage:', error)
      }
    }

    loadLeaderboard()

    // Set up real-time subscription only if Supabase is configured
    if (supabase) {
      const channel = supabase
        .channel('leaderboard_changes')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'leaderboard_entries'
          },
          (payload) => {
            console.log('Leaderboard change received:', payload)
            // Reload leaderboard when changes occur
            loadLeaderboard()
          }
        )
        .subscribe()

      return () => {
        supabase.removeChannel(channel)
      }
    }
  }, [])

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return <Crown className="h-5 w-5 text-yellow-400" />
      case 2:
        return <Medal className="h-5 w-5 text-gray-300" />
      case 3:
        return <Award className="h-5 w-5 text-orange-400" />
      default:
        return <Trophy className="h-4 w-4 text-red-400/60" />
    }
  }

  const getRankColor = (rank: number) => {
    switch (rank) {
      case 1:
        return "bg-yellow-400/20 border-yellow-400/30"
      case 2:
        return "bg-gray-300/20 border-gray-300/30"
      case 3:
        return "bg-orange-400/20 border-orange-400/30"
      default:
        return "bg-red-400/10 border-red-400/20"
    }
  }

  const formatWallet = (wallet: string) => {
    return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString()
  }

  if (isLoading) {
    return (
      <Card className="card-gothic pixel-border eclipse-bg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-primary" />
            <span>Kaiser Wave</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <div className="text-center py-8">
            <p className="text-red-400/60">Loading leaderboard...</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (leaderboard.length === 0) {
    return (
      <Card className="card-gothic pixel-border eclipse-bg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-primary" />
            <span>Kaiser Wave</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <div className="text-center py-8">
            <p className="text-red-400/60">No warriors in the arena yet</p>
            <p className="text-sm text-red-400/40 mt-2">Be the first to earn points!</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="card-gothic pixel-border eclipse-bg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="h-5 w-5 text-primary" />
          <span>Kaiser Wave</span>
        </CardTitle>
        <p className="text-red-400/60 text-sm">
          Top warriors in the arena • Points: Absorb (10) • Token Burn (50) • NFT Burn (200)
        </p>
      </CardHeader>
      <CardContent className="p-6">
        <div className="space-y-4">
          {leaderboard.slice(0, 10).map((entry, index) => {
            const rank = index + 1
            return (
              <div
                key={entry.wallet}
                className={`flex items-center justify-between border rounded-lg p-4 ${getRankColor(rank)}`}
              >
                <div className="flex items-center space-x-4">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/20">
                    {getRankIcon(rank)}
                  </div>
                  <div>
                    <p className="font-medium text-white">{formatWallet(entry.wallet)}</p>
                    <div className="flex items-center space-x-4 text-sm text-red-400/60">
                      <span>{entry.points} pts</span>
                      <span>•</span>
                      <span>{entry.absorbs} absorbs</span>
                      <span>•</span>
                      <span>{entry.token_burns} tokens</span>
                      <span>•</span>
                      <span>{entry.nft_burns} NFTs</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm text-red-400/60">Last: {formatDate(entry.last_activity)}</p>
                  <p className="text-xs text-red-400/40">
                    Fees: {(entry.total_fees_paid / 1000000000).toFixed(6)} SOL
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

// Function to add points to leaderboard
export async function addLeaderboardPoints(
  wallet: string,
  action: 'absorb' | 'token_burn' | 'nft_burn',
  feesPaid: number,
  referralCode?: string
) {
  try {
    if (supabase) {
      // Use Supabase API if configured
      const response = await fetch('/api/leaderboard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          wallet,
          action,
          feesPaid,
          referralCode
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      console.log(`Added ${action} points for wallet ${wallet}:`, data)
      return data
    } else {
      // Fallback to localStorage when Supabase is not configured
      return addToLocalStorage(wallet, action, feesPaid)
    }
  } catch (error) {
    console.error('Error updating leaderboard:', error)
    // Fallback to localStorage on error
    return addToLocalStorage(wallet, action, feesPaid)
  }
}

// Fallback function for localStorage
function addToLocalStorage(
  wallet: string,
  action: 'absorb' | 'token_burn' | 'nft_burn',
  feesPaid: number
) {
  try {
    const stored = localStorage.getItem('rugal-leaderboard')
    let leaderboard: any[] = stored ? JSON.parse(stored) : []
    
    // Find existing entry or create new one
    let entry = leaderboard.find(e => e.wallet === wallet)
    if (!entry) {
      entry = {
        wallet,
        points: 0,
        absorbs: 0,
        tokenBurns: 0,
        nftBurns: 0,
        totalFeesPaid: 0,
        lastActivity: new Date().toISOString()
      }
      leaderboard.push(entry)
    }

    // Update based on action
    switch (action) {
      case 'absorb':
        entry.absorbs++
        entry.points += POINTS.ABSORB
        break
      case 'token_burn':
        entry.tokenBurns++
        entry.points += POINTS.TOKEN_BURN
        break
      case 'nft_burn':
        entry.nftBurns++
        entry.points += POINTS.NFT_BURN
        break
    }

    // Update fees and activity
    entry.totalFeesPaid += feesPaid
    entry.lastActivity = new Date().toISOString()

    // Save back to localStorage
    localStorage.setItem('rugal-leaderboard', JSON.stringify(leaderboard))
    
    console.log(`Added ${action} points for wallet ${wallet} (localStorage)`)
    return { success: true }
  } catch (error) {
    console.error('Error updating localStorage leaderboard:', error)
    throw error
  }
}

