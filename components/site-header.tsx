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

