import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// GET /api/leaderboard - Get leaderboard data
export async function GET() {
  try {
    const { data, error } = await supabase
      .from('leaderboard_entries')
      .select('*')
      .order('points', { ascending: false })
      .limit(50)

    if (error) {
      console.error('Error fetching leaderboard:', error)
      return NextResponse.json({ error: 'Failed to fetch leaderboard' }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error('Error in GET /api/leaderboard:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/leaderboard - Add or update leaderboard entry
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { wallet, action, feesPaid } = body

    if (!wallet || !action) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Points system
    const POINTS = {
      absorb: 10,
      token_burn: 50,
      nft_burn: 200
    }

    // First, try to get existing entry
    const { data: existingEntry, error: fetchError } = await supabase
      .from('leaderboard_entries')
      .select('*')
      .eq('wallet', wallet)
      .single()

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('Error fetching existing entry:', fetchError)
      return NextResponse.json({ error: 'Database error' }, { status: 500 })
    }

    const pointsToAdd = POINTS[action as keyof typeof POINTS] || 0
    const now = new Date().toISOString()

    if (existingEntry) {
      // Update existing entry
      const updateData: any = {
        points: existingEntry.points + pointsToAdd,
        last_activity: now,
        total_fees_paid: existingEntry.total_fees_paid + (feesPaid || 0)
      }

      // Update specific counters
      switch (action) {
        case 'absorb':
          updateData.absorbs = existingEntry.absorbs + 1
          break
        case 'token_burn':
          updateData.token_burns = existingEntry.token_burns + 1
          break
        case 'nft_burn':
          updateData.nft_burns = existingEntry.nft_burns + 1
          break
      }

      const { data, error } = await supabase
        .from('leaderboard_entries')
        .update(updateData)
        .eq('wallet', wallet)
        .select()

      if (error) {
        console.error('Error updating leaderboard entry:', error)
        return NextResponse.json({ error: 'Failed to update leaderboard' }, { status: 500 })
      }

      return NextResponse.json({ data: data[0] })
    } else {
      // Create new entry
      const newEntry = {
        wallet,
        points: pointsToAdd,
        absorbs: action === 'absorb' ? 1 : 0,
        token_burns: action === 'token_burn' ? 1 : 0,
        nft_burns: action === 'nft_burn' ? 1 : 0,
        total_fees_paid: feesPaid || 0,
        last_activity: now
      }

      const { data, error } = await supabase
        .from('leaderboard_entries')
        .insert(newEntry)
        .select()

      if (error) {
        console.error('Error creating leaderboard entry:', error)
        return NextResponse.json({ error: 'Failed to create leaderboard entry' }, { status: 500 })
      }

      return NextResponse.json({ data: data[0] })
    }
  } catch (error) {
    console.error('Error in POST /api/leaderboard:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
