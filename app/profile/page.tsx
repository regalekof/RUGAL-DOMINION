'use client'

import { useState, useEffect } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { SiteHeader } from '@/components/site-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Trophy, Medal, Award, Crown, Flame, Zap, Eye, ArrowLeft, Target, Star, TrendingUp, Clock, Coins, Users, Gift } from 'lucide-react'
import Link from 'next/link'
import { POINTS } from '@/components/leaderboard'
import { supabase } from '@/lib/supabase-client'
import UsernameSetup from '@/components/username-setup'

interface UserStats {
  id: string
  wallet: string
  username?: string
  profile_picture?: string
  points: number
  absorbs: number
  token_burns: number
  nft_burns: number
  total_fees_paid: number
  referral_code?: string
  referred_by?: string
  referrals_count: number
  referral_rewards: number
  last_activity: string
  created_at: string
  updated_at: string
}

interface Achievement {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  points: number
  unlocked: boolean
  progress: number
  maxProgress: number
}

const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first_burn',
    name: 'First Burn',
    description: 'Burn your first token',
    icon: <Flame className="h-5 w-5 text-orange-400" />,
    points: 50,
    unlocked: false,
    progress: 0,
    maxProgress: 1
  },
  {
    id: 'burn_master',
    name: 'Burn Master',
    description: 'Burn 10 tokens',
    icon: <Flame className="h-5 w-5 text-red-400" />,
    points: 500,
    unlocked: false,
    progress: 0,
    maxProgress: 10
  },
  {
    id: 'nft_destroyer',
    name: 'NFT Destroyer',
    description: 'Burn 5 NFTs',
    icon: <Eye className="h-5 w-5 text-purple-400" />,
    points: 1000,
    unlocked: false,
    progress: 0,
    maxProgress: 5
  },
  {
    id: 'rent_absorber',
    name: 'Rent Absorber',
    description: 'Absorb 20 accounts',
    icon: <Zap className="h-5 w-5 text-blue-400" />,
    points: 200,
    unlocked: false,
    progress: 0,
    maxProgress: 20
  },
  {
    id: 'arena_champion',
    name: 'Arena Champion',
    description: 'Reach 1000 total points',
    icon: <Crown className="h-5 w-5 text-yellow-400" />,
    points: 1000,
    unlocked: false,
    progress: 0,
    maxProgress: 1000
  }
]

export default function ProfilePage() {
  const { publicKey, connected } = useWallet()
  const [userStats, setUserStats] = useState<UserStats | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [showUsernameSetup, setShowUsernameSetup] = useState(false)

  useEffect(() => {
    if (!publicKey) {
      setIsLoading(false)
      return
    }

    // Load user stats from Supabase or localStorage fallback
    const loadUserStats = async () => {
      try {
        if (supabase) {
          // Use Supabase if configured
          const { data: allEntries, error: fetchError } = await supabase
            .from('leaderboard_entries')
            .select('*')
            .order('points', { ascending: false })

          if (fetchError) {
            console.error('Error fetching leaderboard:', fetchError)
            loadFromLocalStorage()
            return
          }

          // Find user's entry
          const userEntry = allEntries?.find(entry => entry.wallet === publicKey.toString())
          if (userEntry) {
            setUserStats(userEntry)
            // Check if username setup is needed
            if (!userEntry.username) {
              setShowUsernameSetup(true)
            }
          } else {
            // User doesn't exist, show username setup
            setShowUsernameSetup(true)
          }
        } else {
          // Fallback to localStorage when Supabase is not configured
          loadFromLocalStorage()
        }
      } catch (error) {
        console.error('Error loading user stats:', error)
        loadFromLocalStorage()
      } finally {
        setIsLoading(false)
      }
    }

    const loadFromLocalStorage = () => {
      try {
        const stored = localStorage.getItem('rugal-leaderboard')
        if (stored) {
          const leaderboard: any[] = JSON.parse(stored)
          const sorted = leaderboard.sort((a, b) => b.points - a.points)
          
          const userEntry = sorted.find(entry => entry.wallet === publicKey.toString())
          if (userEntry) {
            // Convert localStorage format to new format
            const convertedEntry = {
              id: userEntry.wallet,
              wallet: userEntry.wallet,
              points: userEntry.points,
              absorbs: userEntry.absorbs,
              token_burns: userEntry.tokenBurns || 0,
              nft_burns: userEntry.nftBurns || 0,
              total_fees_paid: userEntry.totalFeesPaid || 0,
              last_activity: userEntry.lastActivity,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
            setUserStats(convertedEntry)
          }
        }
      } catch (error) {
        console.error('Error loading from localStorage:', error)
      }
    }

    loadUserStats()

    // Set up real-time subscription for user's stats only if Supabase is configured
    if (supabase) {
      const channel = supabase
        .channel('user_profile_changes')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'leaderboard_entries',
            filter: `wallet=eq.${publicKey.toString()}`
          },
          (payload) => {
            console.log('User profile change received:', payload)
            loadUserStats()
          }
        )
        .subscribe()

      return () => {
        supabase.removeChannel(channel)
      }
    }
  }, [publicKey])


  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString()
  }

  const calculateAchievements = (stats: UserStats) => {
    return ACHIEVEMENTS.map(achievement => {
      let progress = 0
      let unlocked = false

      switch (achievement.id) {
        case 'first_burn':
          progress = Math.min(stats.token_burns, 1)
          unlocked = stats.token_burns >= 1
          break
        case 'burn_master':
          progress = Math.min(stats.token_burns, 10)
          unlocked = stats.token_burns >= 10
          break
        case 'nft_destroyer':
          progress = Math.min(stats.nft_burns, 5)
          unlocked = stats.nft_burns >= 5
          break
        case 'rent_absorber':
          progress = Math.min(stats.absorbs, 20)
          unlocked = stats.absorbs >= 20
          break
        case 'arena_champion':
          progress = Math.min(stats.points, 1000)
          unlocked = stats.points >= 1000
          break
      }

      return { ...achievement, progress, unlocked }
    })
  }

  const getNextMilestone = (points: number) => {
    const milestones = [100, 250, 500, 1000, 2500, 5000, 10000]
    return milestones.find(milestone => milestone > points) || 10000
  }

  if (!connected) {
    return (
      <div className="relative min-h-screen">
        <SiteHeader />
        <main className="container relative py-12">
          <div className="text-center py-8">
            <p className="text-red-400/60">Please connect your wallet to view your profile</p>
          </div>
        </main>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="relative min-h-screen">
        <SiteHeader />
        <main className="container relative py-12">
          <div className="text-center py-8">
            <p className="text-red-400/60">Loading profile...</p>
          </div>
        </main>
      </div>
    )
  }

  // Create default stats if user has no activity
  const defaultStats: UserStats = {
    id: publicKey?.toString() || '',
    wallet: publicKey?.toString() || '',
    points: 0,
    absorbs: 0,
    token_burns: 0,
    nft_burns: 0,
    total_fees_paid: 0,
    referral_code: publicKey ? publicKey.toString().slice(0, 8).toUpperCase() : '',
    referred_by: '',
    referrals_count: 0,
    referral_rewards: 0,
    last_activity: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  const currentStats = userStats || defaultStats

  // Show username setup if needed
  if (showUsernameSetup) {
    return (
      <div className="relative min-h-screen bg-gradient-to-br from-gray-900 via-red-900/20 to-purple-900/20">
        <SiteHeader />
        <main className="container relative py-12">
          <div className="flex items-center mb-8">
            <Link href="/" className="flex items-center text-red-400/80 hover:text-primary transition-colors">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Arena
            </Link>
          </div>
          <div className="flex justify-center">
            <UsernameSetup onComplete={() => {
              setShowUsernameSetup(false)
              loadUserStats() // Reload stats after setup
            }} />
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="relative min-h-screen bg-gradient-to-br from-gray-900 via-red-900/20 to-purple-900/20">
      <SiteHeader />
      
      <main className="container relative py-12">
        <div className="flex items-center mb-8">
          <Link href="/" className="flex items-center text-red-400/80 hover:text-primary transition-colors">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Arena
          </Link>
        </div>

        <div className="mx-auto max-w-[1200px] space-y-8">
          {/* Hero Profile Section */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-red-900/30 via-purple-900/30 to-blue-900/30 border border-red-500/20 p-8">
            <div className="absolute inset-0 bg-gradient-to-r from-red-500/10 via-purple-500/10 to-blue-500/10"></div>
            <div className="relative z-10">
              <div className="flex flex-col lg:flex-row items-center justify-between gap-8">
                <div className="flex items-center space-x-6">
                  <div className="relative">
                    <div className="w-24 h-24 rounded-full bg-gradient-to-r from-red-500 to-purple-500 p-1">
                      <div className="w-full h-full rounded-full bg-gray-900 flex items-center justify-center overflow-hidden">
                        {currentStats.profile_picture ? (
                          <img 
                            src={currentStats.profile_picture} 
                            alt="Profile" 
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <Trophy className="h-8 w-8 text-red-400" />
                        )}
                      </div>
                    </div>
                  </div>
                  <div>
                    <h1 className="text-4xl font-bold power-text mb-2">
                      {currentStats.username || 'Anonymous Warrior'}
                    </h1>
                    {currentStats.points === 0 ? (
                      <div>
                        <p className="text-red-400/80 text-lg mb-2">
                          Welcome to the Arena! Start your journey to become a legendary warrior.
                        </p>
                        <p className="text-red-400/60 text-sm">
                          Burn tokens, absorb rent, and destroy NFTs to earn your first points!
                        </p>
                      </div>
                    ) : (
                      <p className="text-red-400/80 text-lg">
                        {currentStats.points.toLocaleString()} points • {currentStats.absorbs + currentStats.token_burns + currentStats.nft_burns} actions
                      </p>
                    )}
                    <p className="text-red-400/60 text-sm font-mono">
                      {currentStats.wallet.slice(0, 8)}...{currentStats.wallet.slice(-8)}
                    </p>
                  </div>
                </div>
                
                <div className="text-center lg:text-right">
                  <div className="bg-black/30 rounded-lg p-4 border border-red-500/20">
                    <p className="text-sm text-red-400/60 mb-1">Next Milestone</p>
                    <p className="text-2xl font-bold text-white">{getNextMilestone(currentStats.points)}</p>
                    <div className="w-32 bg-red-900/30 rounded-full h-2 mt-2 mx-auto">
                      <div 
                        className="bg-gradient-to-r from-red-500 to-purple-500 h-2 rounded-full transition-all duration-500"
                        style={{ 
                          width: `${Math.min((currentStats.points / getNextMilestone(currentStats.points)) * 100, 100)}%` 
                        }}
                      ></div>
                    </div>
                    <p className="text-xs text-red-400/60 mt-1">
                      {getNextMilestone(currentStats.points) - currentStats.points} to go
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Statistics Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="relative group">
              <div className="absolute inset-0 bg-gradient-to-r from-red-500/20 to-purple-500/20 rounded-xl blur-sm group-hover:blur-md transition-all duration-300"></div>
              <Card className="relative card-gothic pixel-border eclipse-bg border-red-500/30">
                <CardContent className="p-6 text-center">
                  <div className="flex items-center justify-center w-16 h-16 bg-gradient-to-r from-red-500/20 to-red-600/20 rounded-full mx-auto mb-4">
                    <Coins className="h-8 w-8 text-red-400" />
                  </div>
                  <h3 className="text-3xl font-bold text-white mb-2">{currentStats.points.toLocaleString()}</h3>
                  <p className="text-sm text-red-400/60 font-medium">Total Points</p>
                  <div className="mt-3 w-full bg-red-900/30 rounded-full h-1">
                    <div className="bg-gradient-to-r from-red-500 to-red-600 h-1 rounded-full" style={{ width: '100%' }}></div>
                  </div>
                </CardContent>
              </Card>
            </div>
            
            
            <div className="relative group">
              <div className="absolute inset-0 bg-gradient-to-r from-green-500/20 to-emerald-500/20 rounded-xl blur-sm group-hover:blur-md transition-all duration-300"></div>
              <Card className="relative card-gothic pixel-border eclipse-bg border-green-500/30">
                <CardContent className="p-6 text-center">
                  <div className="flex items-center justify-center w-16 h-16 bg-gradient-to-r from-green-500/20 to-emerald-500/20 rounded-full mx-auto mb-4">
                    <Target className="h-8 w-8 text-green-400" />
                  </div>
                  <h3 className="text-3xl font-bold text-white mb-2">{currentStats.absorbs + currentStats.token_burns + currentStats.nft_burns}</h3>
                  <p className="text-sm text-green-400/60 font-medium">Total Actions</p>
                  <div className="mt-3 text-xs text-green-400/60">
                    {currentStats.absorbs}A • {currentStats.token_burns}T • {currentStats.nft_burns}N
                  </div>
                </CardContent>
              </Card>
            </div>
            
            <div className="relative group">
              <div className="absolute inset-0 bg-gradient-to-r from-purple-500/20 to-pink-500/20 rounded-xl blur-sm group-hover:blur-md transition-all duration-300"></div>
              <Card className="relative card-gothic pixel-border eclipse-bg border-purple-500/30">
                <CardContent className="p-6 text-center">
                  <div className="flex items-center justify-center w-16 h-16 bg-gradient-to-r from-purple-500/20 to-pink-500/20 rounded-full mx-auto mb-4">
                    <Clock className="h-8 w-8 text-purple-400" />
                  </div>
                  <h3 className="text-3xl font-bold text-white mb-2">{((currentStats.total_fees_paid * 49) / 1000000000).toFixed(3)}</h3>
                  <p className="text-sm text-purple-400/60 font-medium">SOL Reclaimed</p>
                  <div className="mt-3 text-xs text-purple-400/60">
                    Last: {formatDate(currentStats.last_activity)}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Referral Stats */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="relative group">
              <div className="absolute inset-0 bg-gradient-to-r from-blue-500/20 to-cyan-500/20 rounded-xl blur-sm group-hover:blur-md transition-all duration-300"></div>
              <Card className="relative card-gothic pixel-border eclipse-bg border-blue-500/30">
                <CardContent className="p-6 text-center">
                  <div className="flex items-center justify-center w-16 h-16 bg-gradient-to-r from-blue-500/20 to-cyan-500/20 rounded-full mx-auto mb-4">
                    <Users className="h-8 w-8 text-blue-400" />
                  </div>
                  <h3 className="text-3xl font-bold text-white mb-2">{currentStats.referrals_count}</h3>
                  <p className="text-sm text-blue-400/60 font-medium">Referrals</p>
                  <div className="mt-3 text-xs text-blue-400/60">
                    Code: {currentStats.referral_code || 'N/A'}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="relative group">
              <div className="absolute inset-0 bg-gradient-to-r from-yellow-500/20 to-orange-500/20 rounded-xl blur-sm group-hover:blur-md transition-all duration-300"></div>
              <Card className="relative card-gothic pixel-border eclipse-bg border-yellow-500/30">
                <CardContent className="p-6 text-center">
                  <div className="flex items-center justify-center w-16 h-16 bg-gradient-to-r from-yellow-500/20 to-orange-500/20 rounded-full mx-auto mb-4">
                    <Gift className="h-8 w-8 text-yellow-400" />
                  </div>
                  <h3 className="text-3xl font-bold text-white mb-2">{(currentStats.referral_rewards / 1000000000).toFixed(3)}</h3>
                  <p className="text-sm text-yellow-400/60 font-medium">Referral Rewards</p>
                  <div className="mt-3 text-xs text-yellow-400/60">
                    SOL earned from referrals
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Achievements Section */}
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-3xl font-bold power-text mb-2">Achievements</h2>
              {currentStats.points === 0 ? (
                <p className="text-red-400/60">Start your journey and unlock your first achievements!</p>
              ) : (
                <p className="text-red-400/60">Unlock your warrior potential</p>
              )}
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {calculateAchievements(currentStats).map((achievement) => (
                <div
                  key={achievement.id}
                  className={`relative group overflow-hidden rounded-xl border transition-all duration-300 hover:scale-105 ${
                    achievement.unlocked 
                      ? 'bg-gradient-to-br from-green-500/10 to-emerald-500/10 border-green-500/40 shadow-green-500/20 shadow-lg' 
                      : 'bg-gradient-to-br from-red-900/20 to-purple-900/20 border-red-500/30 hover:border-red-400/50'
                  }`}
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-transparent via-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                  
                  <div className="relative p-6">
                    <div className="flex items-start gap-4">
                      <div className={`p-3 rounded-xl ${
                        achievement.unlocked 
                          ? 'bg-gradient-to-br from-green-500/20 to-emerald-500/20' 
                          : 'bg-gradient-to-br from-red-500/20 to-purple-500/20'
                      }`}>
                        {achievement.icon}
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-2">
                          <h4 className={`font-bold text-lg ${
                            achievement.unlocked ? 'text-green-400' : 'text-white'
                          }`}>
                            {achievement.name}
                          </h4>
                          {achievement.unlocked && (
                            <div className="flex items-center gap-1 text-green-400 text-sm">
                              <Star className="h-4 w-4" />
                              <span className="font-bold">+{achievement.points}</span>
                            </div>
                          )}
                        </div>
                        
                        <p className="text-sm text-red-400/60 mb-4">{achievement.description}</p>
                        
                        {!achievement.unlocked && (
                          <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                              <span className="text-red-400/60">Progress</span>
                              <span className="text-red-400/80 font-medium">
                                {achievement.progress}/{achievement.maxProgress}
                              </span>
                            </div>
                            <div className="w-full bg-red-900/30 rounded-full h-2">
                              <div 
                                className="bg-gradient-to-r from-red-500 via-purple-500 to-pink-500 h-2 rounded-full transition-all duration-500"
                                style={{ width: `${(achievement.progress / achievement.maxProgress) * 100}%` }}
                              ></div>
                            </div>
                            <p className="text-xs text-red-400/60">
                              {achievement.maxProgress - achievement.progress} more to unlock
                            </p>
                          </div>
                        )}
                        
                        {achievement.unlocked && (
                          <div className="flex items-center gap-2 text-green-400 text-sm">
                            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                            <span className="font-medium">Achievement Unlocked!</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Activity Breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-2xl font-bold power-text mb-2">Activity Breakdown</h2>
                <p className="text-red-400/60">Your warrior journey</p>
              </div>
              
              <div className="space-y-4">
                <div className="relative group">
                  <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 to-cyan-500/10 rounded-xl blur-sm group-hover:blur-md transition-all duration-300"></div>
                  <Card className="relative card-gothic pixel-border eclipse-bg border-blue-500/30">
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className="p-3 rounded-xl bg-gradient-to-r from-blue-500/20 to-cyan-500/20">
                            <Zap className="h-6 w-6 text-blue-400" />
                          </div>
                          <div>
                            <h3 className="text-lg font-bold text-white">Absorbs</h3>
                            <p className="text-sm text-blue-400/60">Rent absorption</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-bold text-white">{currentStats.absorbs}</p>
                          <p className="text-sm text-blue-400/60">{currentStats.absorbs * POINTS.ABSORB} pts</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
                
                <div className="relative group">
                  <div className="absolute inset-0 bg-gradient-to-r from-orange-500/10 to-red-500/10 rounded-xl blur-sm group-hover:blur-md transition-all duration-300"></div>
                  <Card className="relative card-gothic pixel-border eclipse-bg border-orange-500/30">
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className="p-3 rounded-xl bg-gradient-to-r from-orange-500/20 to-red-500/20">
                            <Flame className="h-6 w-6 text-orange-400" />
                          </div>
                          <div>
                            <h3 className="text-lg font-bold text-white">Token Burns</h3>
                            <p className="text-sm text-orange-400/60">Token destruction</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-bold text-white">{currentStats.token_burns}</p>
                          <p className="text-sm text-orange-400/60">{currentStats.token_burns * POINTS.TOKEN_BURN} pts</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
                
                <div className="relative group">
                  <div className="absolute inset-0 bg-gradient-to-r from-purple-500/10 to-pink-500/10 rounded-xl blur-sm group-hover:blur-md transition-all duration-300"></div>
                  <Card className="relative card-gothic pixel-border eclipse-bg border-purple-500/30">
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className="p-3 rounded-xl bg-gradient-to-r from-purple-500/20 to-pink-500/20">
                            <Eye className="h-6 w-6 text-purple-400" />
                          </div>
                          <div>
                            <h3 className="text-lg font-bold text-white">NFT Burns</h3>
                            <p className="text-sm text-purple-400/60">NFT destruction</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-bold text-white">{currentStats.nft_burns}</p>
                          <p className="text-sm text-purple-400/60">{currentStats.nft_burns * POINTS.NFT_BURN} pts</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-2xl font-bold power-text mb-2">Performance Stats</h2>
                <p className="text-red-400/60">Your warrior metrics</p>
              </div>
              
              <div className="space-y-4">
                <Card className="card-gothic pixel-border eclipse-bg border-green-500/30">
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-green-500/20">
                          <Clock className="h-5 w-5 text-green-400" />
                        </div>
                        <div>
                          <h3 className="font-bold text-white">Last Activity</h3>
                          <p className="text-sm text-green-400/60">Most recent action</p>
                        </div>
                      </div>
                    </div>
                    <p className="text-lg font-bold text-green-400">{formatDate(currentStats.last_activity)}</p>
                  </CardContent>
                </Card>
                
                <Card className="card-gothic pixel-border eclipse-bg border-yellow-500/30">
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-yellow-500/20">
                          <Coins className="h-5 w-5 text-yellow-400" />
                        </div>
                        <div>
                          <h3 className="font-bold text-white">SOL Reclaimed</h3>
                          <p className="text-sm text-yellow-400/60">Total SOL earned back</p>
                        </div>
                      </div>
                    </div>
                    <p className="text-lg font-bold text-yellow-400">{((currentStats.total_fees_paid * 49) / 1000000000).toFixed(6)} SOL</p>
                  </CardContent>
                </Card>
                
                <Card className="card-gothic pixel-border eclipse-bg border-purple-500/30">
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-purple-500/20">
                          <TrendingUp className="h-5 w-5 text-purple-400" />
                        </div>
                        <div>
                          <h3 className="font-bold text-white">Efficiency</h3>
                          <p className="text-sm text-purple-400/60">Points per action</p>
                        </div>
                      </div>
                    </div>
                    <p className="text-lg font-bold text-purple-400">
                      {currentStats.absorbs + currentStats.token_burns + currentStats.nft_burns > 0 
                        ? Math.round(currentStats.points / (currentStats.absorbs + currentStats.token_burns + currentStats.nft_burns))
                        : 0
                      } pts/action
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-bold power-text mb-2">
                {currentStats.points === 0 ? 'Begin Your Journey' : 'Continue Your Journey'}
              </h2>
              {currentStats.points === 0 ? (
                <p className="text-red-400/60">Choose your first warrior action to start earning points!</p>
              ) : (
                <p className="text-red-400/60">Choose your next warrior action</p>
              )}
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <Link href="/burn" className="group">
                <div className="relative overflow-hidden rounded-xl border border-red-500/30 bg-gradient-to-br from-red-900/20 to-orange-900/20 hover:from-red-500/20 hover:to-orange-500/20 transition-all duration-300 hover:scale-105">
                  <div className="absolute inset-0 bg-gradient-to-r from-red-500/10 to-orange-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                  <div className="relative p-8 text-center">
                    <div className="w-16 h-16 bg-gradient-to-r from-red-500/20 to-orange-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                      <Flame className="h-8 w-8 text-red-400" />
                    </div>
                    <h3 className="text-xl font-bold text-white mb-2">Burn Arena</h3>
                    <p className="text-red-400/60 mb-4">Destroy tokens and NFTs for points</p>
                    <div className="inline-flex items-center text-red-400 font-medium">
                      Enter Arena
                      <ArrowLeft className="ml-2 h-4 w-4 rotate-180" />
                    </div>
                  </div>
                </div>
              </Link>
              
              <Link href="/absorb" className="group">
                <div className="relative overflow-hidden rounded-xl border border-blue-500/30 bg-gradient-to-br from-blue-900/20 to-cyan-900/20 hover:from-blue-500/20 hover:to-cyan-500/20 transition-all duration-300 hover:scale-105">
                  <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 to-cyan-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                  <div className="relative p-8 text-center">
                    <div className="w-16 h-16 bg-gradient-to-r from-blue-500/20 to-cyan-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                      <Zap className="h-8 w-8 text-blue-400" />
                    </div>
                    <h3 className="text-xl font-bold text-white mb-2">Absorb Rent</h3>
                    <p className="text-blue-400/60 mb-4">Close empty accounts and reclaim rent</p>
                    <div className="inline-flex items-center text-blue-400 font-medium">
                      Start Absorbing
                      <ArrowLeft className="ml-2 h-4 w-4 rotate-180" />
                    </div>
                  </div>
                </div>
              </Link>
              
              <Link href="/" className="group">
                <div className="relative overflow-hidden rounded-xl border border-purple-500/30 bg-gradient-to-br from-purple-900/20 to-pink-900/20 hover:from-purple-500/20 hover:to-pink-500/20 transition-all duration-300 hover:scale-105">
                  <div className="absolute inset-0 bg-gradient-to-r from-purple-500/10 to-pink-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                  <div className="relative p-8 text-center">
                    <div className="w-16 h-16 bg-gradient-to-r from-purple-500/20 to-pink-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                      <Trophy className="h-8 w-8 text-purple-400" />
                    </div>
                    <h3 className="text-xl font-bold text-white mb-2">Kaiser Wave</h3>
                    <p className="text-purple-400/60 mb-4">Coming Soon - View the arena</p>
                    <div className="inline-flex items-center text-purple-400 font-medium">
                      View Arena
                      <ArrowLeft className="ml-2 h-4 w-4 rotate-180" />
                    </div>
                  </div>
                </div>
              </Link>
            </div>
          </div>

        </div>
      </main>
    </div>
  )
}
