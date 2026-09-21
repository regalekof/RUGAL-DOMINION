# RUGAL-Dominion

A Solana wallet-cleanup app with a King of Fighters-inspired red-and-purple theme. Burn unwanted tokens, manage supported NFTs, and recover rent from eligible unused accounts through **Omega Absorption**.

## Features

### Token & NFT Burning

- Connect through Phantom or Solflare.
- Browse supported wallet assets and select items to burn.
- Use Select All or clear your selection.
- USDC and USDT are hidden from the token-burn list and blocked from burn transaction construction using their official mainnet mint addresses.
- Open submitted transactions in Solscan.

The current burn components use the original SPL Token Program. Token-2022 support below applies to Absorb, not to the burn components. NFT support is limited to the implemented legacy-token flow; do not assume support for compressed or programmable NFTs.

### Omega Absorption

Choose either card or select both:

- **Accounts** — recover rent from eligible empty SPL Token and Token-2022 accounts.
- **Pump Reward** — recover rent from eligible Pump.fun and PumpSwap user volume accounts. Despite its name, this is account-rent recovery, not a cashback or trading-reward claim.

Both categories can be recovered together in **one transaction per batch**, with one wallet signature. Each batch contains up to **10 accounts**. Eligible Pump accounts are prioritised when both categories are selected; additional token accounts remain available for another batch.

The cards display a simplified estimate of `0.0015 SOL × eligible account count`. This is a display estimate only. Transaction calculations use each account's actual on-chain balance.

### Community & Interface

- Leaderboard, profile, and referral interfaces.
- Optional Supabase integration for shared records, with a local-storage fallback.
- Custom artwork, multi-select recovery cards, responsive layouts, and reduced-motion support in Absorb.
- Shared Helius connection with configurable mainnet or devnet access.

## Safety Checks

### Burn Protection

- USDC and USDT protection is based on mint addresses, not editable token names or symbols.
- Protected mints are filtered before metadata loading, excluded from selection, and checked again before constructing burn instructions.
- Wallet approval is required to sign a transaction. The app does not require users to enter a seed phrase or private key.

**Burning is irreversible.** Review the assets selected and the transaction shown by your wallet before approving.

### Absorb Protection

- Only eligible empty token accounts enter rent recovery; nonzero token balances and native/wrapped SOL accounts are excluded.
- Account ownership, close authority, and supported Token-2022 extensions are checked. Unsupported or unresolved extension state is excluded.
- Pump accounts are derived for the connected wallet and validated against the supported program owners, account discriminator, and 137-byte layout.
- Pending rewards, unsettled trading volume, unexpected account fields, extra SOL, and funded or unreviewed reward vaults block Pump rent recovery.
- The exact reviewed accounts are rechecked before signing and again after wallet approval.
- Absorb simulates transactions, preserves the signed payload, and submits with preflight enabled. Success is shown only after error-free confirmation.
- Wallet or connection changes prevent stale recovery submissions. A submitted transaction link remains available when confirmation is uncertain.

These transaction safeguards describe the Absorb implementation; the burn components have a separate transaction flow. Closing a Pump account removes its tracking state, and future trading may recreate it with another rent deposit. Unsupported account layouts require code review before being enabled.

## Local Setup

Use **Node.js 22.14 or later** and **pnpm**. Run commands from the directory containing `package.json`; downloaded ZIP archives may contain an extra nested project folder.

```sh
pnpm install --frozen-lockfile
```

Create `.env.local` from `.env.example` and configure:

```dotenv
NEXT_PUBLIC_HELIUS_API_KEY=your-helius-api-key
NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta

# Optional shared leaderboard/profile storage
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

Set the network to `mainnet-beta` or `devnet`—not an RPC URL. Then start the app:

```sh
pnpm dev
```

Open [localhost:3000](http://localhost:3000). Restart the development server after changing `.env.local`.

### RPC & Environment Safety

The app constructs matching Helius HTTP and WebSocket endpoints. Without a Helius key, it falls back to the public Solana RPC. An invalid or rate-limited configured key does not automatically trigger provider failover.

`NEXT_PUBLIC_*` values are exposed to the browser. Use an appropriately restricted Helius key, never put private keys or Supabase service-role credentials in these variables, and keep `.env.local` out of source control. Production builds must be rebuilt after changing public environment variables.

Supabase is optional. Without it, local records stay in the browser and are not shared across devices; the leaderboard API returns HTTP 503.

## Development Checks

```sh
# TypeScript
pnpm exec tsc --noEmit

# Offline Absorb checks
pnpm test:absorb

# Stablecoin burn-protection checks
node --experimental-strip-types --test tests/burn-protection.test.mjs

# Production build
pnpm build

# Serve the production build
pnpm start
```

Offline tests use synthetic accounts and mocked RPC responses. They do not sign or submit mainnet transactions and are not a security audit. Successful type checks and builds do not prove that every asset or wallet transaction is supported.

## Project Layout

```text
app/burn/                  Burn page
app/absorb/                Omega Absorption UI and styles
app/config.ts              Solana network and Helius configuration
app/wallet-provider.tsx    Shared wallet and connection providers
components/token-burn.tsx  Token-burning interface
components/nft-burn.tsx    NFT-burning interface
lib/absorb.ts              Rent scanning, validation, and transactions
lib/burn-protection.ts     Protected stablecoin mint checks
public/absorb/             Accounts and Pump Reward artwork
tests/                    Offline regression tests
```
