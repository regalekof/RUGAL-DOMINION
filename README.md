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
- `pnpm test:absorb` runs offline rent-recovery tests (Node 22.6+).
- `pnpm build` builds production assets and validates types.
- `pnpm start` serves the production build.

The live RPC health check is read-only. Burning tokens and closing accounts require wallet approval and have not been exercised by the build checks.

## Absorb: rent recovery

The **Accounts** and **Pump Reward** cards can be selected individually or together. Their simplified display is an explicitly labelled estimate of `0.0015 SOL × eligible account count` for either type. Transaction calculations always use actual account balances, not the display estimate.

Selected categories are recovered in one transaction per batch with one wallet signature. Absorb charges **2% of each recovered account's actual lamports**, rounded down per account, and sums these fees into one transfer to `Dkmdvd9iZWKGXiSNExgYYX7PZNncewM4WqHBgN1knUzH` after the closures. The fee transfer is atomic with the closures. Eligible Pump accounts are prioritised in batches of up to 10 accounts; remaining accounts require another reviewed batch. The fee notice and recipient are shown beside the recovery button; the app's final confirmation shows only the account count and approval/cancel controls. Wallet software may independently display transaction details.

- **Token-account rent** scans SPL Token and Token-2022 separately and closes only eligible empty accounts. Native/wrapped SOL, nonzero balances, foreign close authorities, withheld fees, and unreviewed extensions are excluded. The token-burning pages are unchanged.
- **Pump-account rent** derives the connected wallet's Pump.fun and PumpSwap `user_volume_accumulator` PDAs. It uses each owning program's `close_user_volume_accumulator`, not SPL closure. No cashback/reward claim instructions are implemented.
- Pump recovery is deliberately conservative: only the verified 137-byte layouts are supported; unknown fields, pending/unsettled reward state, additional SOL, or funded/extended reward vaults block recovery. Resolve these on Pump first. Future trades may recreate an account and require another rent deposit.
- Transaction calculations use actual account lamports and estimated network fees, never the rounded card display. The service fee is funded from the recovered rent; only the network fee must be funded upfront. Other pages' fee policies are unchanged.
- The exact reviewed accounts are rechecked before signing. Transactions are simulated using the versioned API (including legacy-message transactions), sent with preflight enabled, and only marked successful after error-free confirmation. A submitted signature remains visible if confirmation is uncertain.

Program layouts/instructions were checked against the [official Pump IDLs](https://github.com/pump-fun/pump-public-docs/tree/main/idl) on 2026-09-21. Layout changes fail closed and require review. Offline tests use synthetic accounts and mocked RPC, not signed mainnet operations.
