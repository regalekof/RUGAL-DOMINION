'use client'

import { useState, useEffect } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Copy, Users, Gift, Share2, Check } from 'lucide-react'
import { supabase } from '@/lib/supabase-client'

interface ReferralStats {
  referral_code: string
  referrals_count: number
  referral_rewards: number
}

export default function ReferralSystem() {
  const { publicKey, connected } = useWallet()
  const [referralStats, setReferralStats] = useState<ReferralStats | null>(null)
  const [copied, setCopied] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [customCode, setCustomCode] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)

  useEffect(() => {
    if (!publicKey || !connected) {
      setIsLoading(false)
      return
    }

    loadReferralStats()
  }, [publicKey, connected])

  const loadReferralStats = async () => {
    try {
      if (!supabase) {
        // Fallback to localStorage
        const stored = localStorage.getItem(`referral_${publicKey?.toString()}`)
        if (stored) {
          setReferralStats(JSON.parse(stored))
        } else {
          // Generate new referral code
          const newCode = generateReferralCode()
          const newStats = {
            referral_code: newCode,
            referrals_count: 0,
            referral_rewards: 0
          }
          setReferralStats(newStats)
          localStorage.setItem(`referral_${publicKey?.toString()}`, JSON.stringify(newStats))
        }
        setIsLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('leaderboard_entries')
        .select('referral_code, referrals_count, referral_rewards')
        .eq('wallet', publicKey.toString())
        .single()

      if (error && error.code === 'PGRST116') {
        // User doesn't exist, create with referral code
        const newCode = generateReferralCode()
        const newStats = {
          referral_code: newCode,
          referrals_count: 0,
          referral_rewards: 0
        }
        setReferralStats(newStats)
      } else if (data) {
        setReferralStats({
          referral_code: data.referral_code || generateReferralCode(),
          referrals_count: data.referrals_count || 0,
          referral_rewards: data.referral_rewards || 0
        })
      }
    } catch (error) {
      console.error('Error loading referral stats:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const generateCustomReferralCode = async () => {
    if (!customCode.trim()) return
    
    setIsGenerating(true)
    try {
      if (!supabase) {
        // Fallback to localStorage
        const newStats = {
          referral_code: customCode.trim(),
          referrals_count: referralStats?.referrals_count || 0,
          referral_rewards: referralStats?.referral_rewards || 0
        }
        setReferralStats(newStats)
        localStorage.setItem(`referral_${publicKey?.toString()}`, JSON.stringify(newStats))
        setIsGenerating(false)
        return
      }

      // Check if code already exists
      const { data: existingCode } = await supabase
        .from('leaderboard_entries')
        .select('referral_code')
        .eq('referral_code', customCode.trim())
        .single()

      if (existingCode) {
        alert('This referral code is already taken! Please choose another one.')
        setIsGenerating(false)
        return
      }

      // Update user's referral code
      const { error } = await supabase
        .from('leaderboard_entries')
        .upsert({
          wallet: publicKey.toString(),
          referral_code: customCode.trim(),
          referrals_count: referralStats?.referrals_count || 0,
          referral_rewards: referralStats?.referral_rewards || 0
        })

      if (error) {
        console.error('Error updating referral code:', error)
      } else {
        setReferralStats(prev => ({
          ...prev!,
          referral_code: customCode.trim()
        }))
        setCustomCode('')
      }
    } catch (error) {
      console.error('Error generating referral code:', error)
    } finally {
      setIsGenerating(false)
    }
  }

  const getReferralLink = () => {
    if (!referralStats?.referral_code) return ''
    return `${window.location.origin}?ref=${referralStats.referral_code}`
  }

  const copyReferralLink = async () => {
    try {
      await navigator.clipboard.writeText(getReferralLink())
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }

  const shareReferralLink = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Join Rugal's Dominion",
          text: "Enter the token burning arena!",
          url: getReferralLink()
        })
      } catch (error) {
        console.error('Error sharing:', error)
      }
    } else {
      copyReferralLink()
    }
  }

  if (!connected) {
    return (
      <Card className="card-gothic pixel-border eclipse-bg border-red-500/30">
        <CardContent className="p-6 text-center">
          <Users className="h-12 w-12 text-red-400 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-white mb-2">Connect Wallet</h3>
          <p className="text-red-400/60">Connect your wallet to access referral system</p>
        </CardContent>
      </Card>
    )
  }

  if (isLoading) {
    return (
      <Card className="card-gothic pixel-border eclipse-bg border-red-500/30">
        <CardContent className="p-6 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-400 mx-auto"></div>
          <p className="text-red-400/60 mt-2">Loading referral stats...</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* Referral Link Card */}
      <Card className="card-gothic pixel-border eclipse-bg border-red-500/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-400">
            <Share2 className="h-5 w-5" />
            Your Referral Link
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Custom Referral Code Input */}
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Enter custom referral code (e.g., 'rugal')"
                value={customCode}
                onChange={(e) => setCustomCode(e.target.value)}
                className="flex-1 px-3 py-2 bg-gray-800/50 border border-gray-700 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-red-500"
                maxLength={20}
              />
              <Button
                onClick={generateCustomReferralCode}
                disabled={isGenerating || !customCode.trim()}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {isGenerating ? 'Creating...' : 'Create'}
              </Button>
            </div>
            <p className="text-xs text-gray-400">
              Choose a unique name for your referral link (e.g., 'rugal' → rugal-dominion.xyz?ref=rugal)
            </p>
          </div>

          <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700">
            <p className="text-sm text-gray-400 mb-1">Share this link to invite others:</p>
            <p className="text-white font-mono text-sm break-all">{getReferralLink()}</p>
          </div>
          
          <div className="flex gap-2">
            <Button
              onClick={copyReferralLink}
              variant="outline"
              className="flex-1 border-red-500/30 text-red-300 hover:bg-red-500/10"
            >
              {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
              {copied ? 'Copied!' : 'Copy Link'}
            </Button>
            <Button
              onClick={shareReferralLink}
              className="flex-1 bg-red-600 hover:bg-red-700 text-white"
            >
              <Share2 className="h-4 w-4 mr-2" />
              Share
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Referral Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="card-gothic pixel-border eclipse-bg border-blue-500/30">
          <CardContent className="p-6 text-center">
            <div className="flex items-center justify-center w-12 h-12 bg-blue-500/20 rounded-full mx-auto mb-3">
              <Users className="h-6 w-6 text-blue-400" />
            </div>
            <h3 className="text-2xl font-bold text-white mb-1">{referralStats?.referrals_count || 0}</h3>
            <p className="text-sm text-blue-400/60">Referrals</p>
          </CardContent>
        </Card>

        <Card className="card-gothic pixel-border eclipse-bg border-yellow-500/30">
          <CardContent className="p-6 text-center">
            <div className="flex items-center justify-center w-12 h-12 bg-yellow-500/20 rounded-full mx-auto mb-3">
              <Gift className="h-6 w-6 text-yellow-400" />
            </div>
            <h3 className="text-2xl font-bold text-white mb-1">
              {referralStats ? (referralStats.referral_rewards / 1000000000).toFixed(3) : '0.000'}
            </h3>
            <p className="text-sm text-yellow-400/60">Rewards Earned</p>
          </CardContent>
        </Card>
      </div>

      {/* Referral Info */}
      <Card className="card-gothic pixel-border eclipse-bg border-purple-500/30">
        <CardContent className="p-6">
          <h3 className="text-lg font-bold text-white mb-3">How Referrals Work</h3>
          <div className="space-y-2 text-sm text-gray-300">
            <p>• <span className="text-purple-400">Create custom referral code</span> (e.g., 'rugal')</p>
            <p>• <span className="text-purple-400">Share your unique link</span> with friends</p>
            <p>• <span className="text-purple-400">Earn 30% of their points:</span></p>
            <p className="ml-4 text-xs">- They earn 50 points → You get 15 points</p>
            <p className="ml-4 text-xs">- They earn 200 points → You get 60 points</p>
            <p className="ml-4 text-xs">- They earn 10 points → You get 3 points</p>
            <p>• <span className="text-purple-400">Track referrals</span> in your profile</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
