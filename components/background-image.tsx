"use client"

import { useEffect, useState } from "react"

export function BackgroundImage() {
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    // This would be where you'd load your actual Rugal/KOF background
    // For now we'll simulate loading with a timeout
    const timer = setTimeout(() => {
      setLoaded(true)
    }, 500)

    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="fixed inset-0 -z-10">
      {/* This would be replaced with your actual Rugal/KOF background image */}
      <div
        className={`absolute inset-0 bg-cover bg-center transition-opacity duration-1000 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
        style={{
          backgroundImage: "url('/placeholder.svg?height=1080&width=1920')",
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />

      {/* Overlay with Rugal's color scheme */}
      <div className="absolute inset-0 bg-gradient-to-b from-blue-900/70 to-red-900/70" />

      {/* Energy effects */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,100,255,0.2)_0%,transparent_70%)] animate-pulse" />
    </div>
  )
}

