import { WalletAdapterProps } from '@solana/wallet-adapter-react'
import { FC, ReactNode } from 'react'

declare global {
  namespace JSX {
    interface IntrinsicElements {
      div: React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>
      span: React.DetailedHTMLProps<React.HTMLAttributes<HTMLSpanElement>, HTMLSpanElement>
      header: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>
      nav: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>
      button: React.DetailedHTMLProps<React.ButtonHTMLAttributes<HTMLButtonElement>, HTMLButtonElement>
    }
  }
}

declare module '@solana/wallet-adapter-react-ui' {
  export const WalletMultiButton: FC<{
    className?: string
  }>
}

declare module '@solana/wallet-adapter-react' {
  export interface WalletContextState extends WalletAdapterProps {
    publicKey: import('@solana/web3.js').PublicKey | null
    connected: boolean
    connecting: boolean
    disconnect(): Promise<void>
  }
}

export {} 