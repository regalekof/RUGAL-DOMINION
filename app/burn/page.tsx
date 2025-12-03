"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Flame, ArrowLeft, Image } from "lucide-react"
import { SiteHeader } from "@/components/site-header"
import { TokenBurn } from "@/components/token-burn"
import { NFTBurn } from "@/components/nft-burn"

export default function BurnPage() {
  return (
    <div className="relative min-h-screen">
      <SiteHeader />

      <main className="container relative py-8 sm:py-12 px-4">
        <div className="flex items-center mb-8">
          <Link href="/" className="flex items-center text-red-400/80 hover:text-primary transition-colors">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Arena
          </Link>
        </div>

        <div className="mx-auto max-w-[900px]">
          <div className="text-center mb-12">
            <h1 className="text-4xl font-bold tracking-tighter sm:text-5xl md:text-6xl power-text">Genocide Cutter</h1>
          </div>

          <Tabs defaultValue="tokens" className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-8 h-14 rugal-gradient eclipse-glow">
              <TabsTrigger
                value="tokens"
                className="data-[state=active]:bg-purple-900/40 data-[state=active]:text-white"
              >
                <Flame className="mr-2 h-4 w-4" />
                TOKENS
              </TabsTrigger>
              <TabsTrigger value="nfts" className="data-[state=active]:bg-purple-900/40 data-[state=active]:text-white">
                <Image className="mr-2 h-4 w-4" />
                NFTS
              </TabsTrigger>
            </TabsList>

            <TabsContent value="tokens" className="mt-0">
                  <TokenBurn />
            </TabsContent>

            <TabsContent value="nfts" className="mt-0">
              <Card className="card-gothic pixel-border eclipse-bg">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Image className="h-5 w-5 text-primary" />
                    <span>Burn NFTs</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <NFTBurn />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  )
}

