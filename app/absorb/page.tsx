"use client"

import Link from 'next/link'
import Image from 'next/image'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { ArrowLeft, ArrowUpRight, Check, ExternalLink, RefreshCw, Zap } from 'lucide-react'
import { SiteHeader } from '@/components/site-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { addLeaderboardPoints } from '@/components/leaderboard'
import { MAX_RENT_ACCOUNTS, rentTotals, recoveryAmounts, estimatedRentLabel, createRentReview, prepareRentRecovery, scanRentCategories, selectRentBatch, submitRentRecovery } from '@/lib/absorb'
import type { RentAccount, RentKind, RecoveryKind } from '@/lib/absorb'
import { createRecoveryDiagnostics } from '@/lib/recovery-diagnostics'
import styles from './absorb.module.css'

const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(9)
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`
const titles = { token: 'Accounts', pump: 'Pump Reward', both: 'Accounts + Pump Reward' }
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Request failed. Please try again.').replace(/api-key=[^\s&"']+/gi, 'api-key=[redacted]')
type Scan = { accounts: RentAccount[]; error: string | null; loading: boolean }
const emptyScan = (loading = false): Record<RentKind, Scan> => ({ token: { accounts: [], error: null, loading }, pump: { accounts: [], error: null, loading } })
type Review = ReturnType<typeof createRentReview>

export default function AbsorbPage() {
  const { publicKey, signTransaction } = useWallet()
  const { connection } = useConnection()
  const wallet = publicKey?.toBase58() ?? ''
  const current = useRef({ wallet, connection, session: 0 })
  if (current.current.wallet !== wallet || current.current.connection !== connection) {
    current.current = { wallet, connection, session: current.current.session + 1 }
  }
  const session = current.current.session
  const request = useRef(0)
  const actionLock = useRef(false)
  const [scan, setScan] = useState(emptyScan)
  const [scanOwner, setScanOwner] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('Preparing transaction…')
  const [selectedKinds, setSelectedKinds] = useState<Record<RentKind, boolean>>({ token: true, pump: false })
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<{ signature: string; kind: RecoveryKind; confirmed: boolean } | null>(null)
  const reviewHeading = useRef<HTMLHeadingElement>(null)
  const cluster = process.env.NEXT_PUBLIC_SOLANA_NETWORK === 'devnet' ? '?cluster=devnet' : ''

  const isCurrent = useCallback(() => current.current.session === session, [session])
  const refresh = useCallback(async () => {
    const id = ++request.current
    setReview(null)
    setScan(emptyScan(!!wallet))
    setScanOwner(wallet)
    if (!wallet) { setLoading(false); return }
    setLoading(true)
    const user = new PublicKey(wallet)
    await scanRentCategories(connection, user, (type, result) => {
      if (!isCurrent() || id !== request.current) return
      setScan(previous => ({ ...previous, [type]: { accounts: result.accounts, error: result.error ? errorText(result.error) : null, loading: false } }))
    })
    if (!isCurrent() || id !== request.current) return
    setLoading(false)
  }, [wallet, connection, isCurrent])

  useEffect(() => {
    setError(null)
    setReceipt(null)
    void refresh()
    return () => { request.current++ }
  }, [refresh])

  useEffect(() => {
    if (!review) return
    reviewHeading.current?.focus({ preventScroll: true })
    reviewHeading.current?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }, [review])

  const prepare = (type: RecoveryKind, accounts: RentAccount[]) => {
    if (!wallet || actionLock.current) return
    setError(null)
    setReceipt(null)
    setReview(null)
    try {
      setReview(createRentReview(type, accounts))
    } catch (err) { if (isCurrent()) setError(errorText(err)) }
  }

  const recover = async () => {
    if (!review || !wallet || !signTransaction || actionLock.current) return
    actionLock.current = true
    setBusy(true)
    setProgress('Preparing transaction…')
    setError(null)
    const diagnostics = createRecoveryDiagnostics(cluster ? 'devnet' : 'mainnet-beta', () => {})
    diagnostics.note('recovery.start', { accountCount: review.accounts.length })
    let sent = false
    try {
      // Revalidate the exact reviewed accounts and update the blockhash before signing.
      const fresh = await diagnostics.measure('prepare', () => prepareRentRecovery(connection, new PublicKey(wallet), review.kind, review.accounts, diagnostics))
      if (!isCurrent()) return
      setProgress('Waiting for wallet approval…')
      const signed = await diagnostics.measure('wallet.approval', () => signTransaction(fresh.transaction))
      diagnostics.signed(signed.signature)
      void diagnostics.sampleHeight(connection, 'height.wallet-approved')
      if (!isCurrent()) return
      const signature = await diagnostics.measure('submit', () => submitRentRecovery(connection, signed, fresh, isCurrent, signature => {
        sent = true
        if (isCurrent()) { setReceipt({ signature, kind: review.kind, confirmed: false }); setReview(null) }
      }, stage => {
        if (isCurrent()) setProgress({ validating: 'Validating signed transaction…', sending: 'Sending transaction…', confirming: 'Waiting for network confirmation…' }[stage])
      }, diagnostics))
      diagnostics.note('recovery.confirmed')
      if (isCurrent()) setReceipt({ signature, kind: review.kind, confirmed: true })
      // Keep optional leaderboard writes sequential, but do not block the
      // confirmed receipt, balance refresh, or next recovery batch on them.
      void (async () => { try {
        const referral = localStorage.getItem('referral_code') || undefined
        for (let i = 0; i < review.accounts.length; i++) {
          await addLeaderboardPoints(wallet, 'absorb', i === 0 ? fresh.fee / LAMPORTS_PER_SOL : 0, referral)
        }
      } catch { /* Optional leaderboard does not affect recovery. */ } })()
      if (isCurrent()) void refresh()
    } catch (err) {
      if (isCurrent()) {
        setError(`${errorText(err)}${sent ? ' Check the transaction below before retrying; confirmation may be delayed.' : ''}`)
        // Diagnostic reads only, bounded to 2.5 seconds and never used to resend.
        await diagnostics.inspectFailure(connection)
        if (sent) void refresh()
      }
    } finally { actionLock.current = false; setBusy(false) }
  }

  const selection = (['token', 'pump'] as const).filter(type => selectedKinds[type])
  const recoveryKind: RecoveryKind = selection.length === 2 ? 'both' : selection[0] ?? 'token'
  const selectedResults = selection.map(type => scanOwner === wallet ? scan[type] : { accounts: [], error: null, loading: true })
  const selectedLoading = selectedResults.some(result => result.loading)
  const selectedAccounts = selectedResults.flatMap(result => result.accounts)
  const eligible = selectedAccounts.filter(account => !account.blocked)
  const batch = useMemo(() => {
    if (!wallet || scanOwner !== wallet) return []
    const accounts = (['token', 'pump'] as const).flatMap(type => selectedKinds[type] ? scan[type].accounts : [])
    return selectRentBatch(accounts, new PublicKey(wallet))
  }, [wallet, scanOwner, scan, selectedKinds])
  const totals = rentTotals(batch)
  const scanError = selectedResults.map((result, index) => result.error ? `${titles[selection[index]]}: ${result.error}` : '').filter(Boolean).join(' ')

  const toggleKind = (type: RentKind) => {
    if (actionLock.current) return
    setSelectedKinds(previous => ({ ...previous, [type]: !previous[type] }))
    setReview(null)
    setError(null)
  }

  return (
    <div className="relative min-h-screen">
      <SiteHeader />
      <main className="container relative px-4 py-8 sm:py-12">
        <Link href="/" className="mb-8 inline-flex items-center text-red-400/80 hover:text-primary"><ArrowLeft className="mr-2 h-4 w-4" />Back to Arena</Link>
        <div className={`mx-auto max-w-[900px] space-y-6 ${styles.absorb}`}>
          <div className="text-center">
            <h1 className="power-text text-4xl font-bold tracking-tighter sm:text-5xl">Omega Absorption</h1>
            <p className="mt-4 text-red-200/70">Unused accounts. Reclaimed power.</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{wallet ? `Wallet: ${short(wallet)}` : 'Connect your wallet to scan for recoverable rent.'}</p>
            <Button variant="outline" onClick={() => { setError(null); void refresh() }} disabled={!wallet || loading || busy}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />{loading ? 'Scanning…' : 'Refresh'}</Button>
          </div>
          {error && <div role="alert" className="rounded border border-red-500/40 bg-red-500/10 p-4 text-sm break-words">{error}</div>}
          {busy && <p role="status" aria-live="polite" className="text-center text-sm text-muted-foreground">{progress}</p>}
          {receipt && (
            <div role="status" className="rounded border border-green-500/40 bg-green-500/10 p-4">
              <p>{titles[receipt.kind]} — {receipt.confirmed ? 'recovery confirmed.' : 'submitted; confirmation not yet verified.'}</p>
              <a className="mt-2 inline-flex items-center gap-2 text-sm underline" href={`https://solscan.io/tx/${receipt.signature}${cluster}`} target="_blank" rel="noopener noreferrer">{short(receipt.signature)}<ExternalLink className="h-4 w-4" /></a>
            </div>
          )}
          <div className="space-y-5">
            <p className="text-center text-sm text-muted-foreground">Select one or both · Recover together in one transaction</p>
            <div role="group" aria-label="Choose rent recovery types" className={styles.choices}>
              {(['token', 'pump'] as const).map(type => {
                const result = scanOwner === wallet ? scan[type] : { accounts: [], error: null, loading: !!wallet }
                const eligible = result.accounts.filter(account => !account.blocked)
                const ready = !!wallet && scanOwner === wallet && !result.loading && !result.error
                return (
                  <button key={type} type="button" aria-label={titles[type]} aria-pressed={selectedKinds[type]} aria-controls="rent-recovery-summary" onClick={() => toggleKind(type)} disabled={busy} className={`${styles.choice} ${type === 'pump' ? styles.pump : ''}`}>
                    <span className={styles.orb} aria-hidden="true">
                      <Image src={type === 'token' ? '/absorb/accounts.png' : '/absorb/pump-reward.png'} alt="" fill sizes="(max-width: 540px) 124px, 190px" className={styles.artwork} />
                      <span className={styles.selectedMark}><Check size={14} strokeWidth={3} /></span>
                    </span>
                    <span className={styles.choiceTitle}>{titles[type]}</span>
                    <span className={styles.choiceSubtitle}>{type === 'token' ? 'SPL & Token-2022' : 'Pump rent & cashback'}</span>
                    <span className={styles.availableLabel}>{result.error ? 'Scan unavailable' : result.loading ? 'Scanning…' : 'Estimated rent'}</span>
                    <span className={styles.amount}>{ready ? estimatedRentLabel(eligible.length, type) : '—'} <span>SOL</span></span>
                    <span className={styles.count}>{ready ? `${eligible.length} eligible account${eligible.length === 1 ? '' : 's'}` : result.error ? 'Refresh to retry' : wallet ? 'Checking eligibility' : 'Connect to discover'}</span>
                    <span className={styles.selectionLabel}>{selectedKinds[type] ? 'Selected' : 'Select'}</span>
                  </button>
                )
              })}
            </div>
            <Card id="rent-recovery-summary" className={styles.detailsCard}>
  <CardHeader>
    <CardTitle className="flex items-center gap-2">
      <Zap className="h-5 w-5 text-primary" />
      {selection.length ? titles[recoveryKind] : 'Choose your accounts'}
    </CardTitle>

    <CardDescription>
      {!selection.length
        ? 'Select Accounts, Pump Reward, or both above.'
        : 'Recover your selected accounts together with one wallet approval.'}
    </CardDescription>
  </CardHeader>

  <CardContent className="space-y-5">
    {scanError ? (
      <p role="alert" className="text-sm text-red-400">
        Scan failed: {scanError} Refresh or deselect the unavailable category to continue.
      </p>
    ) : (
      <>
        <p role="status" className="text-sm text-muted-foreground">
          {!selection.length
            ? 'Nothing selected.'
            : !wallet
              ? 'Connect your wallet above to get started.'
              : selectedLoading
                ? 'Finding eligible accounts…'
                : `${eligible.length} account${eligible.length === 1 ? '' : 's'} ready for recovery`}
        </p>

        {wallet && selection.length > 0 && !selectedLoading && selectedAccounts.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No accounts found for your selection.
          </p>
        )}

        {eligible.length > batch.length && (
          <p className="text-sm text-muted-foreground">
            This transaction includes {batch.length} of {eligible.length} eligible accounts.
            Batches use a {MAX_RENT_ACCOUNTS}-account cap and fit Solana's transaction-size limit. Remaining accounts stay available for another batch.
          </p>
        )}
      </>
    )}

    <Button
      className={styles.recoverButton}
      disabled={
        !wallet ||
        !signTransaction ||
        selectedLoading ||
        busy ||
        !!scanError ||
        !batch.length ||
        !selection.length
      }
      onClick={() => void prepare(recoveryKind, batch)}
    >
      {busy ? (
        <>
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          {progress}
        </>
      ) : (
        <>
          Review & recover in 1 transaction
          <ArrowUpRight className="ml-2 h-4 w-4" />
        </>
      )}
    </Button>

    <p className="text-center text-xs text-muted-foreground">
      One transaction · One wallet approval · No token burns
    </p>
  </CardContent>
</Card>
          </div>
          {review && <Card className={styles.detailsCard}>
            <CardHeader><h2 ref={reviewHeading} tabIndex={-1} className="text-xl font-semibold outline-none">Recover {review.accounts.length} account{review.accounts.length === 1 ? '' : 's'}</h2></CardHeader>
            <CardContent className="space-y-4 text-sm">
              {review.accounts.some(account => (account.pump?.cashbackLamports ?? 0) > 0) && <p className="text-muted-foreground">
                Includes {sol(review.accounts.reduce((sum, account) => sum + recoveryAmounts(account).cashback, 0))} SOL cashback. Cashback is claimed before eligible Pump accounts close.
                {review.accounts.some(account => account.pump?.close === false) && ' Accounts with other pending rewards stay open.'}
              </p>}
              <div className="flex flex-wrap gap-3"><Button onClick={() => void recover()} disabled={busy}>{busy ? progress : 'Approve in wallet'}</Button><Button variant="outline" onClick={() => setReview(null)} disabled={busy}>Cancel</Button></div>
            </CardContent>
          </Card>}
        </div>
      </main>
    </div>
  )
}
