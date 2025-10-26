#!/bin/bash

# Mobile Responsiveness Fix Script
# This script applies all mobile responsiveness improvements

echo "🚀 Applying mobile responsiveness fixes..."

# 1. Fix Site Header
echo "📱 Fixing site header..."
cat > components/site-header.tsx << 'EOF'
'use client'

import Link from "next/link"
import { Eye, User, Camera } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { FC, useState, useEffect } from 'react'
import Image from 'next/image'
import { supabase } from '@/lib/supabase-client'

export const SiteHeader: FC = () => {
  const { publicKey, connected } = useWallet()
  const [userProfile, setUserProfile] = useState<{username?: string, profile_picture?: string} | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (connected && publicKey) {
      loadUserProfile()
    } else {
      setUserProfile(null)
    }
  }, [connected, publicKey])

  const loadUserProfile = async () => {
    if (!publicKey) return
    
    setIsLoading(true)
    try {
      if (!supabase) {
        // Fallback to localStorage
        const username = localStorage.getItem(`username_${publicKey.toString()}`)
        const profilePicture = localStorage.getItem(`profile_picture_${publicKey.toString()}`)
        if (username) {
          setUserProfile({ username, profile_picture: profilePicture || undefined })
        } else {
          setUserProfile(null)
        }
        setIsLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('leaderboard_entries')
        .select('username, profile_picture')
        .eq('wallet', publicKey.toString())
        .single()

      if (error && error.code !== 'PGRST116') {
        console.error('Error loading user profile:', error)
      } else if (data && data.username) {
        setUserProfile(data)
      } else {
        setUserProfile(null)
      }
    } catch (error) {
      console.error('Error loading user profile:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleProfilePictureClick = () => {
    // Always go to profile page
    window.location.href = '/profile'
  }

  return (
    <>
      <header className="sticky top-0 z-50 w-full border-b border-red-900/30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between px-4">
          <div className="flex items-center">
            <Link href="/" className="flex items-center space-x-2">
              <div className="relative">
                <Eye className="h-6 w-6 sm:h-8 sm:w-8 text-primary eclipse-glow" />
              </div>
              <div className="hidden sm:block">
                <span className="block font-bold text-lg sm:text-xl power-text">RUGAL'S DOMINION</span>
              </div>
            </Link>
          </div>
          
          {/* Mobile Navigation */}
          <nav className="hidden md:flex flex-1 items-center justify-center">
            <div className="flex items-center space-x-6 lg:space-x-8 text-sm font-medium">
              <Link href="/burn" className="transition-colors hover:text-primary">
                Burn
              </Link>
              <Link href="/#leaderboard" className="transition-colors hover:text-primary">
                Leaderboard
              </Link>
              <Link href="/absorb" className="transition-colors hover:text-primary">
                Absorb
              </Link>
              <Link href="/#about" className="transition-colors hover:text-primary">
                More
              </Link>
            </div>
          </nav>
          
          <div className="flex items-center space-x-2 sm:space-x-3">
            {connected && (
              <>
                {/* Profile Picture */}
                <div 
                  className="relative cursor-pointer group"
                  onClick={handleProfilePictureClick}
                  title={userProfile?.username ? `Change ${userProfile.username}'s picture` : 'Setup username required'}
                >
                  <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-gray-800/50 border border-gray-700 flex items-center justify-center overflow-hidden hover:border-red-500/50 transition-all duration-200">
                    {userProfile?.profile_picture ? (
                      <Image 
                        src={userProfile.profile_picture} 
                        alt="Profile" 
                        width={40} 
                        height={40} 
                        className="object-cover w-full h-full"
                      />
                    ) : (
                      <User className="h-4 w-4 sm:h-5 sm:w-5 text-gray-500 group-hover:text-red-400 transition-colors" />
                    )}
                  </div>
                  <div className="absolute -bottom-1 -right-1 w-3 h-3 sm:w-4 sm:h-4 bg-red-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <Camera className="h-1.5 w-1.5 sm:h-2 sm:w-2 text-white" />
                  </div>
                </div>

                {/* Profile Link */}
                {userProfile?.username && (
                  <Link href="/profile" className="hidden sm:block">
                    <Button 
                      variant="outline" 
                      size="sm"
                      className="border-red-500/30 text-red-300 hover:bg-red-500/10 eclipse-glow"
                    >
                      <User className="mr-2 h-4 w-4" />
                      {userProfile.username}
                    </Button>
                  </Link>
                )}
              </>
            )}
            <div className="wallet-adapter-button-container">
              <WalletMultiButton className="!bg-transparent !border !border-red-500/30 !text-white hover:!bg-red-900/20 !rounded-md eclipse-glow rugal-gradient !px-2 !py-1 sm:!px-4 sm:!py-2 !text-xs sm:!text-sm" />
            </div>
          </div>
          
          {/* Social Media Icons - Hidden on mobile */}
          <div className="hidden lg:flex items-center space-x-2 ml-4">
            <a 
              href="https://discord.gg/HBJYDcfkwa" 
              target="_blank" 
              rel="noopener noreferrer"
              className="p-3 rounded-lg hover:bg-red-500/20 transition-all duration-200 group"
              title="Join our Discord"
            >
              <Image 
                src="/icons/discord.svg" 
                alt="Discord" 
                width={24} 
                height={24}
                className="text-red-400 group-hover:text-red-300 transition-colors duration-200"
              />
            </a>
            <a 
              href="https://x.com/rugaldominion" 
              target="_blank" 
              rel="noopener noreferrer"
              className="p-3 rounded-lg hover:bg-red-500/20 transition-all duration-200 group"
              title="Follow us on X"
            >
              <Image 
                src="/icons/x-twitter.svg" 
                alt="X (Twitter)" 
                width={24} 
                height={24}
                className="text-red-400 group-hover:text-red-300 transition-colors duration-200"
              />
            </a>
          </div>
        </div>
      </header>
    </>
  )
}
EOF

# 2. Fix Home Page
echo "🏠 Fixing home page..."
cat > app/page.tsx << 'EOF'
import { SiteHeader } from "@/components/site-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Eye, Flame, Trophy } from "lucide-react"
import Link from "next/link"

export default function Home() {
  return (
    <div className="relative min-h-screen">
      <SiteHeader />

      {/* Hero Section */}
      <div className="relative w-full py-8 sm:py-12 overflow-hidden">
        <div className="container mx-auto text-center px-4">
          <h1 className="text-3xl sm:text-5xl md:text-7xl font-bold power-text mb-4">RUGAL'S DOMINION</h1>
          <p className="text-lg sm:text-xl md:text-2xl text-red-400/80 max-w-2xl mx-auto mb-6 sm:mb-8">
            Absorb the essence of destruction in the dark arena
          </p>
          <div className="flex justify-center">
            <Link href="/absorb">
              <Button className="eclipse-glow rugal-gradient text-base sm:text-lg px-6 py-4 sm:px-8 sm:py-6">Enter Absorb Arena</Button>
            </Link>
          </div>
        </div>
      </div>

      <main className="container relative px-4">
        <section id="burn" className="py-12 sm:py-16 md:py-24">
          <div className="mx-auto max-w-[800px]">
            <div className="flex flex-col md:flex-row items-center gap-6 sm:gap-8 mb-6 sm:mb-8">
              <div className="md:w-1/3">
                <div className="rounded-full w-20 h-20 sm:w-24 sm:h-24 flex items-center justify-center bg-primary/20 eclipse-glow mx-auto">
                  <Flame className="h-10 w-10 sm:h-12 sm:w-12 text-primary" />
                </div>
              </div>
              <div className="md:w-2/3 text-center md:text-left">
                <h2 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold tracking-tighter power-text">
                  Genocide Cutter
                </h2>
              </div>
            </div>

            <Card className="card-gothic pixel-border eclipse-bg">
              <CardHeader>
                <CardTitle className="flex items-center justify-center gap-2">
                  <Flame className="h-6 w-6 text-primary" />
                  Choose what to burn: Tokens or NFTs
                </CardTitle>
                <CardDescription className="text-center">
                  Select tokens or NFTs to burn and reclaim SOL (2% fee applies)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Link href="/burn" className="block">
                    <Card className="card-gothic pixel-border eclipse-bg border-red-500/30 hover:border-red-500/50 transition-all cursor-pointer">
                      <CardContent className="p-6 text-center">
                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center">
                          <Flame className="h-8 w-8 text-red-400" />
                        </div>
                        <h3 className="text-xl font-bold mb-2">Token Burning</h3>
                        <p className="text-sm text-gray-400">Burn unwanted tokens and reclaim SOL</p>
                      </CardContent>
                    </Card>
                  </Link>
                  
                  <Link href="/burn" className="block">
                    <Card className="card-gothic pixel-border eclipse-bg border-purple-500/30 hover:border-purple-500/50 transition-all cursor-pointer">
                      <CardContent className="p-6 text-center">
                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-purple-500/20 flex items-center justify-center">
                          <Eye className="h-8 w-8 text-purple-400" />
                        </div>
                        <h3 className="text-xl font-bold mb-2">NFT Burning</h3>
                        <p className="text-sm text-gray-400">Burn unwanted NFTs and reclaim SOL</p>
                      </CardContent>
                    </Card>
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <section id="leaderboard" className="py-12 sm:py-16 md:py-24">
          <div className="mx-auto max-w-[800px]">
            <div className="flex flex-col md:flex-row items-center gap-6 sm:gap-8 mb-6 sm:mb-8">
              <div className="md:w-1/3">
                <div className="rounded-full w-20 h-20 sm:w-24 sm:h-24 flex items-center justify-center bg-primary/20 eclipse-glow mx-auto">
                  <Trophy className="h-10 w-10 sm:h-12 sm:w-12 text-primary" />
                </div>
              </div>
              <div className="md:w-2/3 text-center md:text-left">
                <h2 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold tracking-tighter power-text">
                  Kaiser Wave
                </h2>
              </div>
            </div>

            <Card className="card-gothic pixel-border eclipse-bg">
              <CardHeader>
                <CardTitle className="flex items-center justify-center gap-2">
                  <Trophy className="h-6 w-6 text-primary" />
                  Kaiser Wave Leaderboard
                </CardTitle>
                <CardDescription className="text-center">
                  Coming Soon
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6 text-center">
                <div className="text-gray-400">
                  <p>The Kaiser Wave leaderboard is coming soon!</p>
                  <p className="text-sm mt-2">Stay tuned for the ultimate ranking system.</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <section id="about" className="py-12 sm:py-16 md:py-24">
          <div className="mx-auto max-w-[800px]">
            <div className="flex flex-col md:flex-row items-center gap-6 sm:gap-8 mb-6 sm:mb-8">
              <div className="md:w-1/3">
                <div className="rounded-full w-20 h-20 sm:w-24 sm:h-24 flex items-center justify-center bg-primary/20 eclipse-glow mx-auto">
                  <Eye className="h-10 w-10 sm:h-12 sm:w-12 text-primary" />
                </div>
              </div>
              <div className="md:w-2/3 text-center md:text-left">
                <h2 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold tracking-tighter power-text">
                  About Rugal's Dominion
                </h2>
              </div>
            </div>

            <Card className="card-gothic pixel-border eclipse-bg">
              <CardContent className="p-6 space-y-4">
                <p className="text-gray-300">
                  Welcome to Rugal's Dominion, the ultimate token burning arena inspired by the legendary King of Fighters character. 
                  Here, you can clean up your wallet by burning unwanted tokens and NFTs while reclaiming SOL.
                </p>
                <p className="text-gray-300">
                  Our platform offers a professional, secure environment for token management with real-time transaction tracking 
                  and direct Solscan integration. Join the arena and build your legacy in the dark world of Rugal Bernstein.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-red-400">2%</div>
                    <div className="text-sm text-gray-400">Fee Rate</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-purple-400">Real-time</div>
                    <div className="text-sm text-gray-400">Tracking</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
    </div>
  )
}
EOF

echo "✅ Mobile responsiveness fixes applied!"
echo "📱 All components now have proper mobile support"
echo "🖥️ Desktop experience preserved"
echo "🚀 Ready for mobile users!"
