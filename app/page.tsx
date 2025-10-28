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
                  <Flame className="h-5 w-5 text-primary" />
                  <span>Burn Assets</span>
                </CardTitle>
                <CardDescription className="text-red-400/60">
                  Choose what to burn: Tokens or NFTs
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col space-y-4">
                  <Link href="/burn" className="w-full">
                    <Button className="eclipse-glow rugal-gradient w-full">
                      <Flame className="mr-2 h-4 w-4" />
                      Go to Burn Arena
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <section id="leaderboard" className="py-16 md:py-24">
          <div className="mx-auto max-w-[800px]">
            <div className="flex flex-col md:flex-row items-center gap-8 mb-8">
              <div className="md:w-1/3">
                <div className="rounded-full w-24 h-24 flex items-center justify-center bg-primary/20 eclipse-glow mx-auto">
                  <Trophy className="h-12 w-12 text-primary" />
                </div>
              </div>
              <div className="md:w-2/3 text-center md:text-left">
                <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl power-text">Kaiser Wave</h2>
              </div>
            </div>

            <Card className="card-gothic pixel-border eclipse-bg">
              <CardContent className="p-12 text-center">
                <div className="w-20 h-20 bg-gradient-to-r from-red-500/20 to-purple-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
                  <Trophy className="h-10 w-10 text-red-400" />
                        </div>
                <h3 className="text-2xl font-bold text-white mb-4">Kaiser Wave Coming Soon</h3>
                <p className="text-red-400/60 text-lg mb-6">
                  The ultimate leaderboard system is being prepared. Warriors will soon be able to compete for the top spots in the arena!
                </p>
                <div className="flex items-center justify-center space-x-2 text-red-400/80">
                  <div className="w-2 h-2 bg-red-400 rounded-full animate-pulse"></div>
                  <div className="w-2 h-2 bg-red-400 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }}></div>
                  <div className="w-2 h-2 bg-red-400 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }}></div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <section id="about" className="py-16 md:py-24">
          <div className="mx-auto max-w-[800px]">
            <div className="flex flex-col md:flex-row items-center gap-8 mb-8">
              <div className="md:w-1/3">
                <div className="rounded-full w-24 h-24 flex items-center justify-center bg-primary/20 eclipse-glow mx-auto">
                  <Eye className="h-12 w-12 text-primary" />
                </div>
              </div>
              <div className="md:w-2/3 text-center md:text-left">
                <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl power-text">
                  Gigantic Pressure
                </h2>
                <p className="mt-4 text-red-400/80 md:text-xl">Learn more about our platform</p>
              </div>
            </div>

            <Card className="card-gothic pixel-border eclipse-bg">
              <CardContent className="p-6">
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="space-y-2">
                    <h3 className="font-bold flex items-center gap-2">
                      <Eye className="h-4 w-4 text-primary" />
                      Our Mission
                    </h3>
                    <p className="text-sm text-red-400/60">
                      We aim to optimize the Solana blockchain by absorbing dormant accounts and burning tokens, just as
                      Rugal absorbs the power of his opponents.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-bold flex items-center gap-2">
                      <Flame className="h-4 w-4 text-primary" />
                      How It Works
                    </h3>
                    <p className="text-sm text-red-400/60">
                      Connect your wallet, choose to burn tokens or absorb account power to strengthen your dominion on
                      the blockchain.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>

      <footer className="border-t border-red-900/30 py-6 mt-12">
        <div className="container">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="flex items-center space-x-2 mb-4 md:mb-0">
              <Eye className="h-5 w-5 text-primary" />
              <span className="font-bold">RUGAL'S DOMINION</span>
            </div>
            <p className="text-sm text-red-400/60">© 2025 RUGAL'S DOMINION. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  )
}

