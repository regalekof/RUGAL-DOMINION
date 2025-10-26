-- Create the leaderboard_entries table
CREATE TABLE IF NOT EXISTS leaderboard_entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet TEXT UNIQUE NOT NULL,
  points INTEGER DEFAULT 0,
  absorbs INTEGER DEFAULT 0,
  token_burns INTEGER DEFAULT 0,
  nft_burns INTEGER DEFAULT 0,
  total_fees_paid BIGINT DEFAULT 0,
  last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_leaderboard_points ON leaderboard_entries(points DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_wallet ON leaderboard_entries(wallet);

-- Enable Row Level Security (RLS)
ALTER TABLE leaderboard_entries ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows all operations (for public leaderboard)
CREATE POLICY "Allow all operations on leaderboard_entries" ON leaderboard_entries
  FOR ALL USING (true);

-- Create a function to automatically update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Create a trigger to automatically update the updated_at column
CREATE TRIGGER update_leaderboard_entries_updated_at
  BEFORE UPDATE ON leaderboard_entries
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
