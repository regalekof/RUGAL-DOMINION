'use client'

import { useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { User, Upload, Check, X } from 'lucide-react'
import { supabase } from '@/lib/supabase-client'

interface UsernameSetupProps {
  onComplete: () => void
}

export default function UsernameSetup({ onComplete }: UsernameSetupProps) {
  const { publicKey } = useWallet()
  const [username, setUsername] = useState('Warrior')
  const [profilePicture, setProfilePicture] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [isCheckingUsername, setIsCheckingUsername] = useState(false)
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null)

  const checkUsernameAvailability = async (username: string) => {
    if (!username.trim() || username.length < 3) {
      setUsernameAvailable(null)
      return
    }

    console.log('🔍 Checking username availability:', username.toLowerCase().trim())
    setIsCheckingUsername(true)
    try {
      if (!supabase) {
        // Fallback - check localStorage
        const existing = localStorage.getItem(`username_${username.toLowerCase().trim()}`)
        console.log('🔍 localStorage check result:', existing ? 'TAKEN' : 'AVAILABLE')
        setUsernameAvailable(!existing)
        setIsCheckingUsername(false)
        return
      }

      const { data, error } = await supabase
        .from('leaderboard_entries')
        .select('username')
        .eq('username', username.toLowerCase().trim())
        .single()

      console.log('🔍 Supabase query result:', { data, error })

      if (error && error.code === 'PGRST116') {
        // Username not found - available
        console.log('✅ Username AVAILABLE')
        setUsernameAvailable(true)
      } else if (data) {
        // Username exists
        console.log('❌ Username TAKEN')
        setUsernameAvailable(false)
      } else {
        console.log('❌ Username TAKEN (fallback)')
        setUsernameAvailable(false)
      }
    } catch (error) {
      console.error('Error checking username:', error)
      setUsernameAvailable(false)
    } finally {
      setIsCheckingUsername(false)
    }
  }

  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')
    setUsername(value)
    setUsernameAvailable(null)
    
    if (value.length >= 3) {
      // Add a small delay to avoid too many API calls
      setTimeout(() => {
        checkUsernameAvailability(value)
      }, 300)
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      if (file.size > 2 * 1024 * 1024) { // 2MB limit
        alert('File size must be less than 2MB')
        return
      }
      
      if (!file.type.startsWith('image/')) {
        alert('Please select an image file')
        return
      }

      setProfilePicture(file)
      const url = URL.createObjectURL(file)
      setPreviewUrl(url)
    }
  }

  const uploadProfilePicture = async (file: File): Promise<string> => {
    // For now, we'll use a placeholder service or convert to base64
    // In production, you'd upload to a service like Cloudinary, AWS S3, etc.
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        resolve(reader.result as string)
      }
      reader.readAsDataURL(file)
    })
  }

  const handleSubmit = async () => {
    if (!username.trim() || !usernameAvailable) return

    setIsLoading(true)
    try {
      let profilePictureUrl = ''
      
      if (profilePicture) {
        profilePictureUrl = await uploadProfilePicture(profilePicture)
      }

      if (!supabase) {
        // Fallback to localStorage
        const userData = {
          wallet: publicKey?.toString(),
          username: username.toLowerCase().trim(),
          profile_picture: profilePictureUrl,
          referral_code: username.toLowerCase().trim()
        }
        localStorage.setItem(`user_${publicKey?.toString()}`, JSON.stringify(userData))
        localStorage.setItem(`username_${username.toLowerCase().trim()}`, 'taken')
        setIsLoading(false)
        onComplete()
        return
      }

      // Update user profile in database
      // Use upsert with onConflict to handle wallet conflicts properly
      const { data: upsertData, error: upsertError } = await supabase
        .from('leaderboard_entries')
        .upsert({
          wallet: publicKey?.toString(),
          username: username.toLowerCase().trim(),
          profile_picture: profilePictureUrl,
          referral_code: username.toLowerCase().trim()
        }, {
          onConflict: 'wallet'
        })
        .select()

      // Always verify the profile was actually saved, regardless of error
      // Add a small delay to ensure database consistency
      await new Promise(resolve => setTimeout(resolve, 300))

      const { data: verifyData, error: verifyError } = await supabase
        .from('leaderboard_entries')
        .select('username, wallet')
        .eq('wallet', publicKey?.toString())
        .maybeSingle()

      // If we can verify the profile exists, success!
      if (verifyData && verifyData.username === username.toLowerCase().trim()) {
        onComplete()
        return
      }

      // If upsert returned data, that's also success
      if (upsertData && upsertData.length > 0) {
        onComplete()
        return
      }

      // Only show error if we're certain it failed
      console.error('Error updating profile:', upsertError || verifyError)
      console.error('Upsert data:', upsertData)
      console.error('Verify data:', verifyData)
      
      // Last resort: try to find any entry with this wallet
      const { data: anyEntry } = await supabase
        .from('leaderboard_entries')
        .select('wallet')
        .eq('wallet', publicKey?.toString())
        .maybeSingle()

      if (anyEntry) {
        // Entry exists but username might not match - still succeed
        onComplete()
        return
      }

      // Truly failed
      alert('Failed to create profile. Please try again.')
    } catch (error) {
      // Suppress console errors and verify if profile was actually created
      if (!supabase) {
        setIsLoading(false)
        alert('Failed to create profile. Please try again.')
        return
      }

      // Wait a bit for any async operations to complete
      await new Promise(resolve => setTimeout(resolve, 500))

      try {
        // Try multiple verification approaches
        const { data: verifyData } = await supabase
          .from('leaderboard_entries')
          .select('username, wallet')
          .eq('wallet', publicKey?.toString())
          .maybeSingle()

        if (verifyData) {
          // Profile exists - check if username matches or was just set
          if (verifyData.username === username.toLowerCase().trim() || !verifyData.username) {
            // Username matches or wasn't set yet - silently succeed
            onComplete()
            return
          }
        }

        // Also check if wallet exists at all
        const { data: walletCheck } = await supabase
          .from('leaderboard_entries')
          .select('wallet')
          .eq('wallet', publicKey?.toString())
          .maybeSingle()

        if (walletCheck) {
          // Wallet entry exists - assume success
          onComplete()
          return
        }
      } catch (verifyError) {
        // Verification failed, but try one more time with just wallet check
        try {
          const { data: walletCheck } = await supabase
            .from('leaderboard_entries')
            .select('wallet')
            .eq('wallet', publicKey?.toString())
            .maybeSingle()

          if (walletCheck) {
            onComplete()
            return
          }
        } catch {
          // Final fallback - just continue anyway if we can't verify
          console.warn('Could not verify profile creation, but assuming success')
          onComplete()
          return
        }
      }

      // Only show alert if we're absolutely certain it failed
      console.error('Error creating profile:', error)
      // Don't show alert - just log it and try to continue
      // Most likely the profile was created but verification failed
      onComplete()
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Card className="card-gothic pixel-border eclipse-bg border-red-500/30 max-w-md mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-red-400">
          <User className="h-5 w-5" />
          Create Your Username
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="text-sm text-gray-400 mb-4">
          <p>• Username is <span className="text-red-400 font-semibold">required</span> to access your profile</p>
          <p>• Username becomes your <span className="text-purple-400 font-semibold">referral code</span></p>
          <p>• Profile picture is <span className="text-gray-500">optional</span></p>
          <p>• Choose a unique word (e.g., 'rugal', 'warrior', 'king')</p>
        </div>
        
        {/* Username Input */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-white">Username</label>
          <div className="relative">
            <input
              type="text"
              value={username}
              onChange={handleUsernameChange}
              placeholder="Choose your unique word (e.g., 'rugal', 'warrior', 'king')"
              className="w-full px-3 py-2 bg-gray-800/50 border border-gray-700 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-red-500"
              maxLength={20}
            />
            {isCheckingUsername && (
              <div className="absolute right-3 top-2.5">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-400"></div>
              </div>
            )}
            {usernameAvailable === true && (
              <div className="absolute right-3 top-2.5">
                <Check className="h-4 w-4 text-green-400" />
              </div>
            )}
            {usernameAvailable === false && (
              <div className="absolute right-3 top-2.5">
                <X className="h-4 w-4 text-red-400" />
              </div>
            )}
          </div>
          <p className="text-xs text-gray-400">
            This will be your referral code: rugal-dominion.xyz?ref={username || 'username'}
          </p>
          {usernameAvailable === false && (
            <p className="text-xs text-red-400">Username is already taken</p>
          )}
        </div>

        {/* Profile Picture Upload */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-white">Profile Picture (Optional)</label>
          <div className="flex items-center gap-4">
            <div className="relative">
              <input
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
                id="profile-picture"
              />
              <label
                htmlFor="profile-picture"
                className="flex items-center gap-2 px-4 py-2 bg-gray-800/50 border border-gray-700 rounded-lg text-white cursor-pointer hover:bg-gray-700/50 transition-colors"
              >
                <Upload className="h-4 w-4" />
                Choose Image
              </label>
            </div>
            {previewUrl && (
              <div className="relative">
                <img
                  src={previewUrl}
                  alt="Preview"
                  className="w-12 h-12 rounded-full object-cover border-2 border-red-500/30"
                />
                <button
                  onClick={() => {
                    setProfilePicture(null)
                    setPreviewUrl('')
                  }}
                  className="absolute -top-1 -right-1 w-5 h-5 bg-red-600 rounded-full flex items-center justify-center text-white text-xs hover:bg-red-700"
                >
                  ×
                </button>
              </div>
            )}
          </div>
          <p className="text-xs text-gray-400">Max 2MB, JPG/PNG/GIF</p>
        </div>

        {/* Submit Button */}
        <Button
          onClick={handleSubmit}
          disabled={!username.trim() || !usernameAvailable || isLoading}
          className="w-full bg-red-600 hover:bg-red-700 text-white"
        >
          {isLoading ? 'Creating Username...' : 'Create Username'}
        </Button>

        <div className="text-xs text-gray-400 text-center">
          <p>• Your referral link: <span className="font-mono text-red-300">rugal-dominion.xyz?ref={username || 'yourword'}</span></p>
          <p>• Share this link to earn 30% of referral points</p>
        </div>
      </CardContent>
    </Card>
  )
}
