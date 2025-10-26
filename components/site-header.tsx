'use client'

import Link from "next/link"
import { Eye, User } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { FC } from 'react'
import Image from 'next/image'

export const SiteHeader: FC = () => {
  const { publicKey, connected } = useWallet()

  return (
    <header className="sticky top-0 z-50 w-full border-b border-red-900/30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center">
        <div className="mr-4 flex">
          <Link href="/" className="mr-6 flex items-center space-x-2">
            <div className="relative">
              <Eye className="h-8 w-8 text-primary eclipse-glow" />
            </div>
            <div className="hidden sm:block">
              <span className="block font-bold text-xl power-text">RUGAL'S DOMINION</span>
            </div>
          </Link>
        </div>
        <nav className="flex flex-1 items-center justify-center">
          <div className="flex items-center space-x-8 text-sm font-medium">
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
        
        <div className="flex items-center space-x-3">
          {connected && (
            <Link href="/profile">
              <Button 
                variant="outline" 
                size="sm"
                className="border-red-500/30 text-red-300 hover:bg-red-500/10 eclipse-glow"
              >
                <User className="mr-2 h-4 w-4" />
                Profile
              </Button>
            </Link>
          )}
          <div className="wallet-adapter-button-container">
            <WalletMultiButton className="!bg-transparent !border !border-red-500/30 !text-white hover:!bg-red-900/20 !rounded-md eclipse-glow rugal-gradient !px-4 !py-2" />
          </div>
        </div>
        
        {/* Social Media Icons - Far Right Corner */}
        <div className="flex items-center space-x-2 ml-4">
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
  )
}

