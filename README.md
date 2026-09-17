# Rugal's Dominion

Next.js application for Solana token burning and closing empty token accounts.

## Local setup

Run commands in the directory containing `package.json`.

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. Create `.env.local` using `.env.example` and set your Helius API key.
3. Set `NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta` for mainnet or `devnet` for testing. This setting is a cluster name, not a URL.
4. Run `pnpm dev` and open http://localhost:3000.

Restart the development server after editing `.env.local`. For production, rebuild after changing `NEXT_PUBLIC_*` variables because Next.js embeds them in the browser bundle.

## Helius

The app constructs matching HTTP and standard WebSocket endpoints from `NEXT_PUBLIC_HELIUS_API_KEY`. This browser key is visible in network requests; `.env.local` keeps it out of source control, not out of the browser. Remove obsolete QuickNode variables from deployment settings.

Without a key, the app uses the public Solana RPC. A configured key that expires or becomes rate limited does not automatically switch providers.

## Optional database

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to enable the existing shared leaderboard/profile integration. Without them, the UI uses its local-storage fallback and `/api/leaderboard` returns HTTP 503. Local-only records are not shared between browsers.

## Checks

- `pnpm exec tsc --noEmit` checks TypeScript.
- `pnpm build` builds production assets and validates types.
- `pnpm start` serves the production build.

The live RPC health check is read-only. Burning tokens and closing accounts require wallet approval and have not been exercised by the build checks.
