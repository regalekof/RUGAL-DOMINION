import type React from "react"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import "./globals.css"
import { Providers } from "./providers"

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "RUGAL'S DOMINION | Token Burning Arena",
  description: "Burn tokens with the power of Rugal Bernstein in this King of Fighters inspired platform",
  generator: 'mehdi',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/favicon.svg',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className} suppressHydrationWarning>
        <Providers>
          {children}
        </Providers>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // Handle referral links
              (function() {
                const urlParams = new URLSearchParams(window.location.search);
                const refCode = urlParams.get('ref');
                if (refCode) {
                  localStorage.setItem('referral_code', refCode);
                  // Remove ref parameter from URL
                  const newUrl = new URL(window.location);
                  newUrl.searchParams.delete('ref');
                  window.history.replaceState({}, '', newUrl);
                }
              })();
            `,
          }}
        />
      </body>
    </html>
  )
}

import './globals.css'