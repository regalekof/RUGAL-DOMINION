'use client'

import { WalletContextProvider } from './wallet-provider'
import { FC, ReactNode } from 'react'
import { Toaster } from '@/components/ui/toaster'

interface ProvidersProps {
  children: ReactNode
}

export const Providers: FC<ProvidersProps> = ({ children }) => {
  return <WalletContextProvider>{children}<Toaster /></WalletContextProvider>
} 
