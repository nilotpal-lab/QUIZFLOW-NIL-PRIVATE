/* ================================================================
   QuizFlow — Session Store
   Real-time sync via localStorage + BroadcastChannel.
   Works across tabs in the same browser — perfect for classroom demos
   and full Supabase migration later.
   ================================================================ */

import type { AIGeneratedQuiz } from './types'
import { safeGetLocalStorage, safeSetLocalStorage, safeGetSessionStorage, safeSetSessionStorage } from './utils'
import { repairQuizQuestions } from './excelQuizParser'

export type GameStatus =
  | 'lobby'           // Waiting for host to start
  | 'question_active' // Question is live, timer running
  | 'question_reveal' // Answer revealed, waiting for next
  | 'leaderboard'     // Between-question leaderboard
  | 'boss_frenzy'     // Final rapid-fire 10Q 60s mode
  | 'ended'           // Game over, final results

export type GameMode = 'classic' | 'boss_raid' | 'tournament'

export interface Reaction {
  id: string
  emoji: string
  senderName?: string
  createdAt: number
}

export interface Player {
  id: string
  nickname: string
  avatarSeed: string
  avatarStyle: string
  score: number
  streak: number
  maxStreak?: number
  totalCorrect?: number
  totalAnswered?: number
  totalResponseTimeMs?: number
  rank: number
  tacticsRank?: number
  masteryRank?: number
  lastAnswerCorrect: boolean | null
  lastPointsEarned: number
  hasAnswered: boolean
  lastAnsweredQIdx?: number
  selectedIndex: number | null
  joinedAt: number
  connected: boolean
  // Coin economy
  coins: number
  coinPowerUps?: import('./types').ActiveCoinPowerUp[]  // active coin power-ups
  bidMultiplier?: number  // active bid multiplier (2x/3x/4x) for next question
  frozenUntil?: number    // ms timestamp — player answers blocked until then
  // Anti-cheat
  violations?: number
  flagged?: boolean
  // Boss frenzy
  frenzyScore?: number  // correct answers in boss frenzy
}

export interface GameState {
  pin: string
  status: GameStatus
  gameMode?: GameMode
  bossHealth?: number
  bossMaxHealth?: number
  masteryRankings?: Player[]
  tacticsRankings?: Player[]
  quiz: AIGeneratedQuiz
  currentQuestionIndex: number
  questionStartedAt: number   // timestamp ms
  questionEndsAt: number      // timestamp ms
  players: Record<string, Player>
  hostId: string
  revealCorrectIndex: number | null  // set when revealing
  createdAt: number
  reactions?: Reaction[]
  isPaused?: boolean
  pausedTimeRemainingMs?: number
  aliasMode?: boolean
  phaseEpoch?: number   // Monotonic phase/transition epoch timestamp
  // Multi-round tournament fields
  tournamentConfig?: import('./types').TournamentConfig
  currentRound?: number
  eliminatedPlayers?: string[]  // player IDs eliminated from tournament
  tournamentRoundLabel?: string // e.g. "Round 2 of 3"
  // Boss Frenzy finale
  bossFrenzy?: import('./types').BossFrenzyState
}

const CHANNEL_NAME = 'quizflow_session'
const STORE_PREFIX  = 'qf_session_'

// ── Ranking Helpers ───────────────────────────────────────────────

export function getTacticsRankings(players: Record<string, Player> | Player[]): Player[] {
  const list = Array.isArray(players) ? [...players] : Object.values(players)
  return list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const aStreak = a.maxStreak ?? a.streak ?? 0
    const bStreak = b.maxStreak ?? b.streak ?? 0
    if (bStreak !== aStreak) return bStreak - aStreak
    return (a.totalResponseTimeMs || 0) - (b.totalResponseTimeMs || 0)
  })
}

export function getMasteryRankings(players: Record<string, Player> | Player[]): Player[] {
  const list = Array.isArray(players) ? [...players] : Object.values(players)
  return list.sort((a, b) => {
    const aAns = a.totalAnswered || 0
    const bAns = b.totalAnswered || 0
    const aAcc = aAns > 0 ? (a.totalCorrect || 0) / aAns : 0
    const bAcc = bAns > 0 ? (b.totalCorrect || 0) / bAns : 0
    if (bAcc !== aAcc) return bAcc - aAcc
    if ((b.totalCorrect || 0) !== (a.totalCorrect || 0)) return (b.totalCorrect || 0) - (a.totalCorrect || 0)
    return (a.totalResponseTimeMs || 0) - (b.totalResponseTimeMs || 0)
  })
}

// ── Monotonic Non-Destructive State Merging ────────────────────────
export function mergeGameStates(current: GameState | null, incoming: GameState | null): GameState | null {
  if (!current) return incoming
  if (!incoming) return current

  // 1. Session Identity & Re-creation Precedence
  // If incoming has a newer createdAt AND both/neither have quiz questions, a new session was created on the same PIN.
  const curCreated = current.createdAt || 0
  const inCreated = incoming.createdAt || 0
  const curHasQuestions = (current.quiz?.questions?.length || 0) > 0
  const inHasQuestions = (incoming.quiz?.questions?.length || 0) > 0

  if (inCreated > curCreated && (!curHasQuestions || inHasQuestions)) {
    return incoming
  }
  if (curCreated > inCreated && (!inHasQuestions || curHasQuestions)) {
    return current
  }

  // 2. Multi-Round Tournament Causal Ordering
  const curRound = current.currentRound ?? (current.tournamentConfig?.currentRoundIndex !== undefined ? current.tournamentConfig.currentRoundIndex + 1 : 1)
  const inRound = incoming.currentRound ?? (incoming.tournamentConfig?.currentRoundIndex !== undefined ? incoming.tournamentConfig.currentRoundIndex + 1 : 1)
  const isRoundAdvancement = inRound > curRound
  const isRoundRegression = curRound > inRound

  // 3. Question Index & Start Timestamp Progression
  const currentQ = current.currentQuestionIndex ?? 0
  const incomingQ = incoming.currentQuestionIndex ?? 0
  const currentStartedAt = current.questionStartedAt ?? 0
  const incomingStartedAt = incoming.questionStartedAt ?? 0

  const isQuestionAdvancement = isRoundAdvancement || (!isRoundRegression && (
    incomingQ > currentQ ||
    (incomingQ === currentQ && incomingStartedAt > currentStartedAt && (incoming.status === 'question_active' || incoming.status === 'lobby'))
  ))
  const isQuestionRegression = isRoundRegression || (!isRoundAdvancement && (
    currentQ > incomingQ ||
    (currentQ === incomingQ && currentStartedAt > incomingStartedAt && (current.status === 'question_active' || current.status === 'lobby'))
  ))

  // 4. Base Selection via Monotonic Epochs & Causal Status Weights
  let base: GameState
  if (isRoundAdvancement || isQuestionAdvancement) {
    base = incoming
  } else if (isRoundRegression || isQuestionRegression) {
    base = current
  } else {
    // Same round, question, and start timestamp: check phaseEpoch if present
    const curEpoch = current.phaseEpoch ?? 0
    const inEpoch = incoming.phaseEpoch ?? 0

    if (inEpoch > curEpoch && inEpoch > 0) {
      base = incoming
    } else if (curEpoch > inEpoch && curEpoch > 0) {
      base = current
    } else {
      // Causal status weight ordering for same question:
      // lobby (0) -> question_active (1) -> question_reveal (2) -> leaderboard (3) -> boss_frenzy (4) -> ended (5)
      const statusWeight: Record<GameStatus, number> = {
        lobby: 0,
        question_active: 1,
        question_reveal: 2,
        leaderboard: 3,
        boss_frenzy: 4,
        ended: 5,
      }
      const inWeight = statusWeight[incoming.status] ?? 0
      const curWeight = statusWeight[current.status] ?? 0
      if (inWeight !== curWeight) {
        base = inWeight > curWeight ? incoming : current
      } else {
        // Same status: prefer incoming to adopt host timer/pause updates
        base = incoming
      }
    }
  }

  // 5. Merge players monotonically: never erase cumulative scores or streaks, but respect question reset!
  const mergedPlayers: Record<string, Player> = {}
  const allPlayerIds = Array.from(new Set([
    ...Object.keys(current.players || {}),
    ...Object.keys(incoming.players || {})
  ]))

  for (const pid of allPlayerIds) {
    const p1 = current.players?.[pid]
    const p2 = incoming.players?.[pid]
    if (!p1 && p2) {
      mergedPlayers[pid] = { ...p2 }
    } else if (p1 && !p2) {
      // Player exists locally but is absent from lightweight payload (e.g. not in top-10 broadcast).
      // Still reset per-question answer flags on question advancement so they can answer the new question.
      if (isRoundAdvancement || isQuestionAdvancement) {
        mergedPlayers[pid] = {
          ...p1,
          hasAnswered: false,
          selectedIndex: null,
          lastAnswerCorrect: null,
          lastPointsEarned: 0
        }
      } else {
        mergedPlayers[pid] = { ...p1 }
      }
    } else if (p1 && p2) {
      const score = Math.max(p1.score || 0, p2.score || 0)
      const maxStreak = Math.max(p1.maxStreak || 0, p2.maxStreak || 0, p1.streak || 0, p2.streak || 0)
      const totalCorrect = Math.max(p1.totalCorrect || 0, p2.totalCorrect || 0)
      const totalAnswered = Math.max(p1.totalAnswered || 0, p2.totalAnswered || 0)
      const totalResponseTimeMs = Math.max(p1.totalResponseTimeMs || 0, p2.totalResponseTimeMs || 0)
      const coins = Math.max(p1.coins || 0, p2.coins || 0)
      const violations = Math.max(p1.violations || 0, p2.violations || 0)
      const flagged = Boolean(p1.flagged || p2.flagged)
      const frozenUntil = Math.max(p1.frozenUntil || 0, p2.frozenUntil || 0)
      const bidMultiplier = Math.max(p1.bidMultiplier || 1, p2.bidMultiplier || 1)
      const frenzyScore = Math.max(p1.frenzyScore || 0, p2.frenzyScore || 0)
      const connected = Boolean(p1.connected || p2.connected)
      const coinPowerUps = p2.coinPowerUps || p1.coinPowerUps

      if (isRoundAdvancement || isQuestionAdvancement) {
        // Advanced to new question or tournament round -> reset per-question answer flags from incoming (Host)
        mergedPlayers[pid] = {
          ...p2,
          score,
          streak: p2.streak ?? p1.streak ?? 0,
          maxStreak,
          totalCorrect,
          totalAnswered,
          totalResponseTimeMs,
          coins,
          violations,
          flagged,
          frozenUntil,
          bidMultiplier: p2.bidMultiplier ?? 1,
          frenzyScore,
          connected,
          coinPowerUps,
          hasAnswered: p2.hasAnswered || false,
          selectedIndex: p2.selectedIndex ?? null,
          lastAnswerCorrect: p2.lastAnswerCorrect ?? null,
          lastPointsEarned: p2.lastPointsEarned ?? 0
        }
      } else if (isRoundRegression || isQuestionRegression) {
        // Keep current state
        mergedPlayers[pid] = {
          ...p1,
          score,
          maxStreak,
          totalCorrect,
          totalAnswered,
          totalResponseTimeMs,
          coins,
          violations,
          flagged,
          frozenUntil,
          frenzyScore,
          connected
        }
      } else {
        // Same question: causally determine answer flags and streak
        let selectedIndex: number | null
        let lastAnswerCorrect: boolean | null
        let lastPointsEarned: number
        let hasAnswered: boolean
        let currentStreak: number

        if (p1.hasAnswered && !p2.hasAnswered) {
          hasAnswered = true
          selectedIndex = p1.selectedIndex
          lastAnswerCorrect = p1.lastAnswerCorrect
          lastPointsEarned = p1.lastPointsEarned || 0
          currentStreak = p1.streak || 0
        } else if (!p1.hasAnswered && p2.hasAnswered) {
          hasAnswered = true
          selectedIndex = p2.selectedIndex
          lastAnswerCorrect = p2.lastAnswerCorrect
          lastPointsEarned = p2.lastPointsEarned || 0
          currentStreak = p2.streak || 0
        } else if (p1.hasAnswered && p2.hasAnswered) {
          hasAnswered = true
          selectedIndex = p2.selectedIndex ?? p1.selectedIndex
          lastAnswerCorrect = p2.lastAnswerCorrect !== null ? p2.lastAnswerCorrect : p1.lastAnswerCorrect
          lastPointsEarned = Math.max(p1.lastPointsEarned || 0, p2.lastPointsEarned || 0)

          if ((p2.totalAnswered || 0) > (p1.totalAnswered || 0)) {
            currentStreak = p2.streak || 0
          } else if ((p1.totalAnswered || 0) > (p2.totalAnswered || 0)) {
            currentStreak = p1.streak || 0
          } else {
            // Same answer count: if answer was wrong, streak is 0, never resurrect via Math.max
            currentStreak = (lastAnswerCorrect === false) ? 0 : Math.max(p1.streak || 0, p2.streak || 0)
          }
        } else {
          hasAnswered = false
          selectedIndex = null
          lastAnswerCorrect = null
          lastPointsEarned = 0
          currentStreak = p2.streak ?? p1.streak ?? 0
        }

        const preferredPlayer = (p2.joinedAt >= (p1.joinedAt || 0)) ? p2 : p1

        mergedPlayers[pid] = {
          ...preferredPlayer,
          score,
          streak: currentStreak,
          maxStreak,
          totalCorrect,
          totalAnswered,
          totalResponseTimeMs,
          coins,
          violations,
          flagged,
          frozenUntil,
          bidMultiplier,
          frenzyScore,
          connected,
          coinPowerUps,
          hasAnswered,
          selectedIndex,
          lastAnswerCorrect,
          lastPointsEarned
        }
      }
    }
  }

  // 6. Boss Health & Max Health Merging
  const bossMaxHealth = incoming.bossMaxHealth ?? current.bossMaxHealth ?? 100
  let bossHealth: number
  if (isRoundAdvancement) {
    bossHealth = incoming.bossHealth ?? bossMaxHealth
  } else {
    const h1 = current.bossHealth ?? bossMaxHealth
    const h2 = incoming.bossHealth ?? bossMaxHealth
    bossHealth = Math.min(h1, h2)
  }

  // 7. Boss Frenzy Merging
  let mergedBossFrenzy: import('./types').BossFrenzyState | undefined
  if (current.bossFrenzy || incoming.bossFrenzy) {
    const bf1 = current.bossFrenzy
    const bf2 = incoming.bossFrenzy
    if (!bf1) {
      mergedBossFrenzy = bf2 ? { ...bf2, frenzyScores: { ...(bf2.frenzyScores || {}) } } : undefined
    } else if (!bf2) {
      mergedBossFrenzy = bf1 ? { ...bf1, frenzyScores: { ...(bf1.frenzyScores || {}) } } : undefined
    } else {
      const isEnded = base.status === 'ended'
      const active = isEnded ? false : (bf1.active || bf2.active)
      const currentFrenzyIndex = Math.max(bf1.currentFrenzyIndex || 0, bf2.currentFrenzyIndex || 0)
      const questionStartedAt = Math.max(bf1.questionStartedAt || 0, bf2.questionStartedAt || 0)
      const endsAt = Math.max(bf1.endsAt || 0, bf2.endsAt || 0)
      const allPids = Array.from(new Set([
        ...Object.keys(bf1.frenzyScores || {}),
        ...Object.keys(bf2.frenzyScores || {})
      ]))
      const frenzyScores: Record<string, number> = {}
      for (const fpid of allPids) {
        frenzyScores[fpid] = Math.max(bf1.frenzyScores?.[fpid] || 0, bf2.frenzyScores?.[fpid] || 0)
      }
      mergedBossFrenzy = {
        active,
        endsAt,
        questionIndices: bf2.questionIndices || bf1.questionIndices || [],
        currentFrenzyIndex,
        questionStartedAt,
        frenzyScores
      }
    }
  }

  // 8. Reactions Merging (Deduplicate and sort by createdAt)
  const reactionMap = new Map<string, Reaction>()
  for (const rx of [...(current.reactions || []), ...(incoming.reactions || [])]) {
    if (rx?.id && !reactionMap.has(rx.id)) {
      reactionMap.set(rx.id, rx)
    }
  }
  const mergedReactions = Array.from(reactionMap.values())
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(-25)

  // 9. Tournament Eliminations & Config Merging
  const mergedEliminated = Array.from(new Set([
    ...(current.eliminatedPlayers || []),
    ...(incoming.eliminatedPlayers || [])
  ]))
  const mergedTournamentConfig = incoming.tournamentConfig || current.tournamentConfig
    ? {
        ...(incoming.tournamentConfig || current.tournamentConfig!),
        eliminations: {
          ...(current.tournamentConfig?.eliminations || {}),
          ...(incoming.tournamentConfig?.eliminations || {})
        }
      }
    : undefined

  // 10. Preserve anti-cheat answer keys stripped by server
  const baseQuiz = base.quiz && current.quiz && base.quiz.questions && current.quiz.questions
    ? {
        ...base.quiz,
        questions: base.quiz.questions.map((bq, i) => {
          const lq = current.quiz.questions[i]
          if (bq && lq && (bq.correct_index === undefined || bq.correct_index === null) && lq.correct_index !== undefined) {
            return { ...bq, correct_index: lq.correct_index }
          }
          return bq
        })
      }
    : base.quiz

  const tactics = getTacticsRankings(mergedPlayers)
  const mastery = getMasteryRankings(mergedPlayers)

  return {
    ...base,
    quiz: baseQuiz,
    bossHealth,
    bossMaxHealth,
    players: mergedPlayers,
    reactions: mergedReactions,
    bossFrenzy: mergedBossFrenzy,
    eliminatedPlayers: mergedEliminated.length > 0 ? mergedEliminated : undefined,
    tournamentConfig: mergedTournamentConfig,
    tacticsRankings: tactics.map((p, i) => ({ ...p, rank: i + 1, tacticsRank: i + 1 })),
    masteryRankings: mastery.map((p, i) => ({ ...p, masteryRank: i + 1 }))
  }
}

// ── Broadcast & Cross-Device Cloud Sync ───────────────────────────
import { supabase } from './supabaseClient'

let _channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null
  if (!_channel) _channel = new BroadcastChannel(CHANNEL_NAME)
  return _channel
}

function postRelay(pin: string, payload: GameState, immediate = false) {
  const status = payload?.status
  const qIdx = payload?.currentQuestionIndex ?? 0
  const round = payload?.currentRound ?? 1
  const epoch = payload?.phaseEpoch ?? 0
  // Flush immediately on status transitions, question index change, round change, phaseEpoch change, or explicit immediate flag
  const flushNow = immediate || (
    Boolean(status) && (
      _lastPostedStatus[pin] !== status ||
      _lastPostedQIdx[pin] !== qIdx ||
      _lastPostedRound[pin] !== round ||
      (_lastPostedPhaseEpoch[pin] !== epoch && epoch > 0)
    )
  )
  if (_relayTimers[pin]) {
    clearTimeout(_relayTimers[pin])
    delete _relayTimers[pin]
  }
  const doPost = () => {
    delete _relayTimers[pin]
    if (status) _lastPostedStatus[pin] = status
    _lastPostedQIdx[pin] = qIdx
    _lastPostedRound[pin] = round
    if (epoch > 0) _lastPostedPhaseEpoch[pin] = epoch
    fetch(`/api/room/${pin}?_t=${Date.now()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      },
      cache: 'no-store',
      body: JSON.stringify({ state: payload }),
    }).catch(() => {})
  }
  if (flushNow) doPost()
  else _relayTimers[pin] = setTimeout(doPost, 200)
}

function broadcast(pin: string, state?: GameState, relay = true, immediate = false) {
  const ch = getChannel()
  if (ch) ch.postMessage({ pin, ts: Date.now() })

  const payload = state || loadState(pin)
  if (typeof window === 'undefined' || !payload) return

  // 1. Cloud Room Relay Sync (Works across all laptops, phones, and tablets over the internet)
  if (relay) postRelay(pin, payload, immediate)

  // 2. Supabase Realtime WebSocket Sync (Lightweight payload < 25KB for instant <15ms delivery to 500+ phones)
  if (supabase) {
    try {
      if (!_relayChannels[pin]) {
        _relayChannels[pin] = supabase.channel(`qf_room_${pin}`, {
          config: { broadcast: { self: true } }
        })
        _relayChannels[pin].subscribe()
      }

      const topTactics = payload.tacticsRankings?.slice(0, 10) || []
      const topMastery = payload.masteryRankings?.slice(0, 10) || []
      const lightweightPayload = {
        ...payload,
        players: Object.fromEntries(topTactics.map(p => [p.id, p])),
        tacticsRankings: topTactics,
        masteryRankings: topMastery,
      }

      _relayChannels[pin].send({
        type: 'broadcast',
        event: 'state_sync',
        payload: lightweightPayload
      }).catch(() => {})
    } catch {
      // Graceful fallback if offline
    }
  }
}

// ── In-Memory & Storage helpers ──────────────────────────────────
const _memState: Record<string, GameState> = {}

// Change detection: fingerprint of the last state we served/wrote per pin.
// When a polled/merged state is byte-identical we skip localStorage writes AND
// return the same object reference, so React bails out of re-renders and the
// play/lobby effects that depend on the state object stop re-firing at 2.5Hz.
const _sigByPin: Record<string, string> = {}
const _servedByPin: Record<string, GameState> = {}

// Relay POST throttling: at most one POST per pin per 200ms window, flushed
// immediately when the session status changes so host transitions stay snappy.
const _relayTimers: Record<string, ReturnType<typeof setTimeout>> = {}
const _lastPostedStatus: Record<string, string> = {}
const _lastPostedQIdx: Record<string, number> = {}
const _lastPostedRound: Record<string, number> = {}
const _lastPostedPhaseEpoch: Record<string, number> = {}

// Cached Supabase broadcast channels per pin — creating a channel on every
// broadcast leaked sockets during busy games.
const _relayChannels: Record<string, any> = {}

function key(pin: string) { return STORE_PREFIX + pin }

export function saveState(state: GameState, opts?: { relay?: boolean; immediate?: boolean }): GameState {
  _memState[state.pin] = state
  const skipRelay = opts?.relay === false
  const immediate = opts?.immediate === true
  if (typeof window !== 'undefined') {
    try {
      const current = loadState(state.pin)
      const merged = mergeGameStates(current, state) || state
      _memState[state.pin] = merged

      // Security: strip correct_index from quiz questions before writing to localStorage
      // during question_active / boss_frenzy — prevents DevTools answer leakage.
      // Correct answers are restored to state from the server on question_reveal / ended.
      const isActive = merged.status === 'question_active' || merged.status === 'boss_frenzy'
      const storageState = isActive && merged.quiz?.questions ? {
        ...merged,
        quiz: {
          ...merged.quiz,
          questions: merged.quiz.questions.map((q: any) => {
            const { correct_index, ...safeQ } = q
            return safeQ
          })
        }
      } : merged

      const sig = JSON.stringify(storageState)
      if (sig === _sigByPin[state.pin]) {
        _memState[state.pin] = _servedByPin[state.pin] || merged
        return _memState[state.pin]
      }
      _sigByPin[state.pin] = sig
      _servedByPin[state.pin] = merged
      localStorage.setItem(key(state.pin), sig)
      broadcast(state.pin, _memState[state.pin], !skipRelay, immediate)
    } catch {}
  } else {
    broadcast(state.pin, _memState[state.pin], !skipRelay, immediate)
  }
  return _memState[state.pin]
}

export function loadState(pin: string): GameState | null {
  if (typeof window === 'undefined') return _memState[pin] || null
  try {
    const raw = localStorage.getItem(key(pin))
    if (raw) {
      const parsed = JSON.parse(raw) as GameState
      _memState[pin] = parsed
      return parsed
    }
  } catch {}
  return _memState[pin] || null
}

export async function fetchRemoteState(pin: string, maxRetries = 3): Promise<GameState | null> {
  if (typeof window === 'undefined') return null
  const cleanPin = pin.trim().toUpperCase()
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`/api/room/${cleanPin}?_t=${Date.now()}`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      })
      if (res.ok) {
        const data = await res.json()
        if (data?.state) {
          const local = loadState(cleanPin)
          const merged = mergeGameStates(local, data.state as GameState) || data.state
          // Identical to what we last served → return the SAME object reference.
          // React's Object.is bailout then skips the re-render entirely.
          const sig = JSON.stringify(merged)
          if (sig === _sigByPin[cleanPin]) {
            return _servedByPin[cleanPin] || (merged as GameState)
          }
          _memState[cleanPin] = merged
          _sigByPin[cleanPin] = sig
          _servedByPin[cleanPin] = merged
          try {
            localStorage.setItem(key(cleanPin), sig)
          } catch {}
          return merged as GameState
        }
      }
    } catch {}
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 250 * (attempt + 1)))
    }
  }
  return _memState[cleanPin] || null
}

export function deleteState(pin: string) {
  delete _memState[pin]
  delete _sigByPin[pin]
  delete _servedByPin[pin]
  delete _lastPostedStatus[pin]
  delete _lastPostedQIdx[pin]
  delete _lastPostedRound[pin]
  delete _lastPostedPhaseEpoch[pin]
  if (_relayTimers[pin]) {
    clearTimeout(_relayTimers[pin])
    delete _relayTimers[pin]
  }
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(key(pin))
    } catch {}
  }
  broadcast(pin)
}

// ── Batched Player Answer Throttling (Throttles 400+ student writes to 150ms batches) ─
const _batchedAnswers: Record<string, { timer: ReturnType<typeof setTimeout> | null; players: Record<string, Player> }> = {}

export function queueBatchedPlayerAnswer(pin: string, player: Player) {
  if (!_batchedAnswers[pin]) {
    _batchedAnswers[pin] = { timer: null, players: {} }
  }
  _batchedAnswers[pin].players[player.id] = player

  if (!_batchedAnswers[pin].timer) {
    _batchedAnswers[pin].timer = setTimeout(() => {
      const entry = _batchedAnswers[pin]
      if (!entry) return
      delete _batchedAnswers[pin]

      const current = loadState(pin)
      if (current) {
        saveState({
          ...current,
          players: {
            ...current.players,
            ...entry.players
          }
        })
      }
    }, 150)
  }
}

// ── Subscribe to changes ──────────────────────────────────────────
export function subscribeToSession(
  pin: string,
  callback: (state: GameState | null) => void
): () => void {
  if (typeof window === 'undefined') return () => {}

  // 1. Immediate read from local cache
  const local = loadState(pin)

  const notify = (state: GameState | null) => {
    if (!state) {
      callback(null)
      return
    }
    // ALWAYS pass a freshly cloned immutable snapshot with deep clones of players and nested collections
    // so React useState / useSyncExternalStore never bails out
    const clonedPlayers: Record<string, Player> = {}
    if (state.players) {
      for (const [id, p] of Object.entries(state.players)) {
        clonedPlayers[id] = {
          ...p,
          coinPowerUps: p.coinPowerUps ? [...p.coinPowerUps] : undefined
        }
      }
    }
    const clonedState: GameState = {
      ...state,
      players: clonedPlayers,
      tacticsRankings: state.tacticsRankings ? state.tacticsRankings.map(p => ({ ...p })) : undefined,
      masteryRankings: state.masteryRankings ? state.masteryRankings.map(p => ({ ...p })) : undefined,
      reactions: state.reactions ? [...state.reactions] : undefined,
      eliminatedPlayers: state.eliminatedPlayers ? [...state.eliminatedPlayers] : undefined,
      bossFrenzy: state.bossFrenzy ? {
        ...state.bossFrenzy,
        questionIndices: [...(state.bossFrenzy.questionIndices || [])],
        frenzyScores: { ...(state.bossFrenzy.frenzyScores || {}) }
      } : undefined,
      tournamentConfig: state.tournamentConfig ? {
        ...state.tournamentConfig,
        rounds: state.tournamentConfig.rounds ? [...state.tournamentConfig.rounds] : [],
        eliminations: { ...(state.tournamentConfig.eliminations || {}) }
      } : undefined
    }
    callback(clonedState)
  }

  if (local) notify(local)

  // 2. Fetch from Cloud Room Relay (for other devices on the internet)
  fetchRemoteState(pin).then(remote => {
    if (remote) notify(remote)
  })

  // 3. BroadcastChannel (instant 0ms cross-tab same browser)
  let ch: BroadcastChannel | null = null
  let onMsg: ((e: MessageEvent) => void) | null = null
  if (typeof BroadcastChannel !== 'undefined') {
    ch = new BroadcastChannel(CHANNEL_NAME)
    onMsg = (e: MessageEvent) => {
      if (e.data?.pin === pin) notify(loadState(pin))
    }
    ch.addEventListener('message', onMsg)
  }

  // 4. StorageEvent (same-tab fallback)
  const onStorage = (e: StorageEvent) => {
    if (e.key === key(pin)) notify(loadState(pin))
  }
  window.addEventListener('storage', onStorage)

  // 5. Cloud Room Relay Polling — responsive 1000ms polling with instant wake recovery.
  // Combines zero-latency Supabase WebSockets with rapid 1s HTTP fallback so no mobile
  // device experiences delayed question transitions if a network packet drops.
  let lastPollAt = 0
  const poll = (force = false) => {
    if (typeof document !== 'undefined' && document.hidden && !force) return
    const now = Date.now()
    const minInterval = force ? 0 : 1000 // 1000ms fast sync
    if (now - lastPollAt < minInterval) return
    lastPollAt = now
    fetchRemoteState(pin).then(remote => {
      if (remote) notify(remote)
    })
  }
  const pollInterval = setInterval(() => poll(false), 1000)
  const onVisible = () => { if (!document.hidden) { lastPollAt = 0; poll(true) } }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)

  // 6. Supabase Realtime WebSocket subscription (zero-latency internet sync)
  let sbSub: any = null
  if (supabase) {
    try {
      if (!_relayChannels[pin]) {
        _relayChannels[pin] = supabase.channel(`qf_room_${pin}`, {
          config: { broadcast: { self: true } }
        })
      }
      sbSub = _relayChannels[pin]
      sbSub
        .on('broadcast', { event: 'state_sync' }, (res: any) => {
          if (res?.payload && res.payload.pin === pin) {
            const current = loadState(pin)
            const merged = mergeGameStates(current, res.payload) || res.payload
            _memState[pin] = merged
            try {
              localStorage.setItem(key(pin), JSON.stringify(merged))
            } catch {}
            notify(merged)
          }
        })
        .on('broadcast', { event: 'player_join' }, (res: any) => {
          if (res?.payload?.player && res?.payload?.pin === pin) {
            const current = loadState(pin)
            if (current) {
              const existing = current.players?.[res.payload.player.id]
              const updated = {
                ...current,
                players: {
                  ...current.players,
                  [res.payload.player.id]: {
                    ...res.payload.player,
                    score: existing ? existing.score : 0,
                    streak: existing ? existing.streak : 0,
                    maxStreak: existing ? existing.maxStreak : 0,
                    totalCorrect: existing ? existing.totalCorrect : 0,
                    totalAnswered: existing ? existing.totalAnswered : 0,
                    totalResponseTimeMs: existing ? existing.totalResponseTimeMs : 0,
                    rank: existing ? existing.rank : 0,
                    lastAnswerCorrect: existing ? existing.lastAnswerCorrect : null,
                    lastPointsEarned: existing ? existing.lastPointsEarned : 0,
                    hasAnswered: existing ? existing.hasAnswered : false,
                    selectedIndex: existing ? existing.selectedIndex : null,
                    joinedAt: existing ? existing.joinedAt : Date.now(),
                    connected: true,
                  }
                }
              }
              saveState(updated)
            }
          }
        })
        .on('broadcast', { event: 'submit_answer' }, (res: any) => {
          if (res?.payload?.playerId && res?.payload?.pin === pin) {
            const current = loadState(pin)
            if (!current || !current.players?.[res.payload.playerId]) return
            const p = current.players[res.payload.playerId]

            // CRITICAL DUPLICATE SCORING GUARD:
            // Never award points more than ONCE per question index!
            const qIdx = current.currentQuestionIndex ?? 0
            if (p.hasAnswered || p.lastAnsweredQIdx === qIdx) {
              return
            }

            const data = res.payload.data || {}
            const isCorrect = Boolean(data.correct)
            const points = Number(data.points) || 0

            const updatedPlayer: Player = {
              ...p,
              hasAnswered: true,
              lastAnsweredQIdx: qIdx,
              selectedIndex: typeof data.selectedIndex === 'number' ? data.selectedIndex : p.selectedIndex,
              lastAnswerCorrect: isCorrect,
              score: (p.score || 0) + points,
              lastPointsEarned: points,
              totalAnswered: (p.totalAnswered || 0) + 1,
              totalCorrect: (p.totalCorrect || 0) + (isCorrect ? 1 : 0),
              totalResponseTimeMs: (p.totalResponseTimeMs || 0) + (Number(data.responseTimeMs) || 0),
              streak: isCorrect ? (p.streak || 0) + 1 : 0,
              maxStreak: isCorrect ? Math.max(p.maxStreak || 0, (p.streak || 0) + 1) : (p.maxStreak || 0)
            }

            queueBatchedPlayerAnswer(pin, updatedPlayer)
          }
        })
        .on('broadcast', { event: 'request_state' }, () => {
          const current = loadState(pin)
          if (current) {
            sbSub.send({
              type: 'broadcast',
              event: 'state_sync',
              payload: current
            }).catch(() => {})
          }
        })
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            sbSub.send({
              type: 'broadcast',
              event: 'request_state',
              payload: { pin }
            }).catch(() => {})
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            // Rapidly recover state via HTTP fallback if WebSocket encounters transient network blip
            lastPollAt = 0
            poll(true)
          }
        })
    } catch {
      // Offline fallback
    }
  }

  return () => {
    clearInterval(pollInterval)
    document.removeEventListener('visibilitychange', onVisible)
    if (ch && onMsg) {
      ch.removeEventListener('message', onMsg)
      ch.close()
    }
    window.removeEventListener('storage', onStorage)
    if (sbSub && supabase) {
      try {
        supabase.removeChannel(sbSub)
      } catch {}
    }
  }
}

export function shuffleQuizChoices(quiz: AIGeneratedQuiz): AIGeneratedQuiz {
  if (!quiz || !Array.isArray(quiz.questions)) return quiz

  const shuffledQuestions = quiz.questions.map(q => {
    if (!Array.isArray(q.choices) || q.choices.length <= 1) return q

    const choiceItems = q.choices.map((text, origIdx) => ({
      text,
      origIdx,
      misconception: Array.isArray(q.misconceptions) ? q.misconceptions[origIdx] || '' : ''
    }))

    for (let i = choiceItems.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[choiceItems[i], choiceItems[j]] = [choiceItems[j], choiceItems[i]]
    }

    const newChoices = choiceItems.map(item => item.text)
    const newMisconceptions = choiceItems.map(item => item.misconception)
    const newCorrectIndex = choiceItems.findIndex(item => item.origIdx === q.correct_index)

    return {
      ...q,
      choices: newChoices,
      correct_index: newCorrectIndex >= 0 ? newCorrectIndex : 0,
      misconceptions: newMisconceptions
    }
  })

  return {
    ...quiz,
    questions: shuffledQuestions
  }
}

// ── Host actions ──────────────────────────────────────────────────

export function createSession(quiz: AIGeneratedQuiz, hostId: string, gameMode: GameMode = 'classic'): GameState {
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const repairedQuiz: AIGeneratedQuiz = {
    ...quiz,
    questions: repairQuizQuestions(quiz.questions || [])
  }
  const shuffledQuiz = shuffleQuizChoices(repairedQuiz)
  const effectiveHostId = hostId || ('host_' + Date.now() + '_' + Math.random().toString(36).slice(2))
  const state: GameState = {
    pin,
    status: 'lobby',
    gameMode,
    bossHealth: 100,
    bossMaxHealth: 100,
    quiz: shuffledQuiz,
    currentQuestionIndex: 0,
    questionStartedAt: 0,
    questionEndsAt: 0,
    players: {},
    hostId: effectiveHostId,
    revealCorrectIndex: null,
    createdAt: Date.now(),
  }
  // Store host credentials on creator device
  safeSetSessionStorage('qf_host_token_' + pin, effectiveHostId)
  safeSetLocalStorage('qf_host_token_' + pin, effectiveHostId)
  saveState(state, { immediate: true })
  return state
}

/**
 * Validates whether the current browser/device is authorized to access host controls.
 */
export function isHostAuthorized(pin: string, stateHostId?: string): boolean {
  if (typeof window === 'undefined') return true
  if (!stateHostId) return true
  // 1. Check local / session host token stored during createSession
  const sessionToken = safeGetSessionStorage('qf_host_token_' + pin)
  const localToken   = safeGetLocalStorage('qf_host_token_' + pin)
  if (sessionToken && sessionToken === stateHostId) return true
  if (localToken && localToken === stateHostId) return true

  // 2. Check authenticated teacher host user
  try {
    const { getHostUser } = require('./authStore')
    const user = getHostUser()
    if (user?.id && user.id === stateHostId) return true
  } catch {}

  // 3. Demo / local dev / live host fallback
  if (
    stateHostId === 'host-demo' || 
    stateHostId === 'host_live' || 
    stateHostId.startsWith('host_demo_') || 
    stateHostId.startsWith('host_live') ||
    stateHostId.startsWith('host_anon')
  ) return true

  return false
}

export function setGameMode(pin: string, gameMode: GameMode) {
  const state = loadState(pin)
  if (!state) return
  saveState({ ...state, gameMode })
}

export function startGame(pin: string) {
  const state = loadState(pin)
  if (!state || !state.quiz?.questions?.length) return
  const q = state.quiz.questions[0]
  const timeLimit = q?.time_limit_ms || 20000
  const now = Date.now()
  saveState({
    ...state,
    status: 'question_active',
    currentQuestionIndex: 0,
    questionStartedAt: now,
    questionEndsAt: now + timeLimit,
    phaseEpoch: now,
    revealCorrectIndex: null,
    players: Object.fromEntries(
      Object.entries(state.players || {}).map(([id, p]) => [id, {
        ...p,
        hasAnswered: false,
        lastAnsweredQIdx: undefined,
        selectedIndex: null,
        lastAnswerCorrect: null,
        lastPointsEarned: 0
      }])
    )
  }, { immediate: true })
}

export function revealAnswer(pin: string) {
  const state = loadState(pin)
  if (!state || !state.quiz?.questions?.length) return
  const q = state.quiz.questions[state.currentQuestionIndex]
  const correctIdx = q?.correct_index ?? 0
  saveState({
    ...state,
    status: 'question_reveal',
    revealCorrectIndex: correctIdx,
    phaseEpoch: Date.now()
  }, { immediate: true })
}

export function showLeaderboard(pin: string) {
  const state = loadState(pin)
  if (!state) return
  
  const tactics = getTacticsRankings(state.players)
  const mastery = getMasteryRankings(state.players)
  const updated: Record<string, Player> = {}

  Object.values(state.players).forEach(p => {
    const tRank = tactics.findIndex(x => x.id === p.id) + 1
    const mRank = mastery.findIndex(x => x.id === p.id) + 1
    updated[p.id] = {
      ...p,
      rank: tRank,
      tacticsRank: tRank,
      masteryRank: mRank,
    }
  })

  saveState({
    ...state,
    status: 'leaderboard',
    players: updated,
    phaseEpoch: Date.now(),
    tacticsRankings: tactics.map((p, i) => ({ ...p, rank: i + 1, tacticsRank: i + 1 })),
    masteryRankings: mastery.map((p, i) => ({ ...p, masteryRank: i + 1 })),
  }, { immediate: true })
}

export function nextQuestion(pin: string) {
  const state = loadState(pin)
  if (!state || !state.quiz?.questions?.length) return
  const nextIdx = state.currentQuestionIndex + 1
  if (nextIdx >= state.quiz.questions.length) {
    endGame(pin)
    return
  }
  const q = state.quiz.questions[nextIdx]
  const timeLimit = q?.time_limit_ms || 20000
  const now = Date.now()
  const resetPlayers = Object.fromEntries(
    Object.entries(state.players || {}).map(([id, p]) => [id, {
      ...p,
      hasAnswered: false,
      lastAnsweredQIdx: undefined,
      selectedIndex: null,
      lastAnswerCorrect: null,
      lastPointsEarned: 0
    }])
  )
  saveState({
    ...state,
    status: 'question_active',
    currentQuestionIndex: nextIdx,
    questionStartedAt: now,
    questionEndsAt: now + timeLimit,
    phaseEpoch: now,
    revealCorrectIndex: null,
    players: resetPlayers,
  }, { immediate: true })
}

export function endGame(pin: string) {
  const state = loadState(pin)
  if (!state) return

  const tactics = getTacticsRankings(state.players)
  const mastery = getMasteryRankings(state.players)
  const updated: Record<string, Player> = {}

  Object.values(state.players).forEach(p => {
    const tRank = tactics.findIndex(x => x.id === p.id) + 1
    const mRank = mastery.findIndex(x => x.id === p.id) + 1
    updated[p.id] = {
      ...p,
      rank: tRank,
      tacticsRank: tRank,
      masteryRank: mRank,
    }
  })

  const finalState: GameState = {
    ...state,
    status: 'ended',
    phaseEpoch: Date.now(),
    players: updated,
    tacticsRankings: tactics.map((p, i) => ({ ...p, rank: i + 1, tacticsRank: i + 1 })),
    masteryRankings: mastery.map((p, i) => ({ ...p, masteryRank: i + 1 })),
  }

  saveState(finalState, { immediate: true })

  try {
    const { recordCompletedSession } = require('./historyStore')
    recordCompletedSession(finalState)
  } catch (e) {
    console.warn('Failed to record completed session history:', e)
  }
}

export function kickPlayer(pin: string, playerId: string) {
  const state = loadState(pin)
  if (!state) return
  const players = { ...state.players }
  delete players[playerId]
  saveState({ ...state, players, phaseEpoch: Date.now() }, { immediate: true })
}

/**
 * Eliminate players after a tournament round based on the elimination rule.
 * rule examples: "bottom 30%", "bottom 3", "score < 500", "only top 5 survive"
 */
export function eliminateRoundLosers(pin: string, roundNumber: number, rule: string): string[] {
  const state = loadState(pin)
  if (!state) return []

  const players = Object.values(state.players)
  if (players.length === 0) return []

  const sorted = getTacticsRankings(players)  // best -> worst
  let eliminated: string[] = []

  const ruleL = rule.toLowerCase().trim()

  // Pattern: "bottom X%"
  const pctMatch = ruleL.match(/bottom\s+(\d+)\s*%/)
  if (pctMatch) {
    const pct = parseInt(pctMatch[1]) / 100
    const cutCount = Math.floor(players.length * pct)
    eliminated = sorted.slice(sorted.length - cutCount).map(p => p.id)
  }

  // Pattern: "bottom X players" or "bottom X"
  const countMatch = !pctMatch && ruleL.match(/bottom\s+(\d+)/)
  if (countMatch) {
    const n = parseInt(countMatch[1])
    eliminated = sorted.slice(sorted.length - n).map(p => p.id)
  }

  // Pattern: "top X survive" or "only top X"
  const topMatch = ruleL.match(/top\s+(\d+)/)
  if (topMatch) {
    const n = parseInt(topMatch[1])
    eliminated = sorted.slice(n).map(p => p.id)
  }

  // Pattern: "score < N" or "score below N"
  const scoreMatch = ruleL.match(/score\s*(?:<|below|less than)\s*(\d+)/)
  if (scoreMatch) {
    const minScore = parseInt(scoreMatch[1])
    eliminated = players.filter(p => p.score < minScore).map(p => p.id)
  }

  // Pattern: "less than N correct" or "fewer than N correct"
  const correctMatch = ruleL.match(/(?:less than|fewer than|<)\s*(\d+)\s*correct/)
  if (correctMatch) {
    const minCorrect = parseInt(correctMatch[1])
    eliminated = players.filter(p => (p.totalCorrect || 0) < minCorrect).map(p => p.id)
  }

  // Record eliminations in tournamentConfig
  const tc = state.tournamentConfig
  const newEliminations = { ...(tc?.eliminations || {}), [roundNumber]: eliminated }
  const allEliminated = Array.from(new Set((state.eliminatedPlayers || []).concat(eliminated)))

  saveState({
    ...state,
    phaseEpoch: Date.now(),
    eliminatedPlayers: allEliminated,
    tournamentConfig: tc ? { ...tc, eliminations: newEliminations } : undefined
  }, { immediate: true })

  return eliminated
}

/**
 * Advance tournament to the next round:
 * 1. Run elimination rules for current round
 * 2. Load next round's quiz
 * 3. Reset per-question state for surviving players
 * 4. Transition status to 'lobby' or 'question_active'
 */
export function advanceTournamentRound(pin: string) {
  const state = loadState(pin)
  if (!state || !state.tournamentConfig) return

  const tc = state.tournamentConfig
  const currentRoundIdx = tc.currentRoundIndex ?? 0
  const nextRoundIdx = currentRoundIdx + 1

  // Run eliminations for current round
  const currentRoundConfig = tc.rounds[currentRoundIdx]
  if (currentRoundConfig) {
    eliminateRoundLosers(pin, currentRoundConfig.roundNumber, currentRoundConfig.eliminationRule)
  }

  // Refresh state after eliminations
  const freshState = loadState(pin) || state

  if (nextRoundIdx >= tc.rounds.length) {
    endGame(pin)
    return
  }

  const nextRoundConfig = tc.rounds[nextRoundIdx]
  const shuffledQuiz = shuffleQuizChoices(nextRoundConfig.quiz)

  const updatedTc = {
    ...tc,
    currentRoundIndex: nextRoundIdx
  }

  const resetPlayers = Object.fromEntries(
    Object.entries(freshState.players || {}).map(([id, p]) => [id, {
      ...p,
      hasAnswered: false,
      selectedIndex: null,
      lastAnswerCorrect: null,
      lastPointsEarned: 0
    }])
  )

  saveState({
    ...freshState,
    status: 'lobby',
    quiz: shuffledQuiz,
    currentQuestionIndex: 0,
    questionStartedAt: 0,
    questionEndsAt: 0,
    phaseEpoch: Date.now(),
    revealCorrectIndex: null,
    currentRound: nextRoundConfig.roundNumber,
    tournamentRoundLabel: `Round ${nextRoundConfig.roundNumber} of ${tc.rounds.length}`,
    tournamentConfig: updatedTc,
    players: resetPlayers
  }, { immediate: true })
}


export function togglePauseTimer(pin: string) {
  const state = loadState(pin)
  if (!state || state.status !== 'question_active') return
  if (state.isPaused) {
    const remaining = state.pausedTimeRemainingMs || 0
    saveState({
      ...state,
      isPaused: false,
      questionEndsAt: Date.now() + remaining,
      pausedTimeRemainingMs: undefined,
      phaseEpoch: Date.now(),
    }, { immediate: true })
  } else {
    const remaining = Math.max(0, state.questionEndsAt - Date.now())
    saveState({
      ...state,
      isPaused: true,
      pausedTimeRemainingMs: remaining,
      phaseEpoch: Date.now(),
    }, { immediate: true })
  }
}

export function extendTimer(pin: string, addMs: number = 15000) {
  const state = loadState(pin)
  if (!state || state.status !== 'question_active') return
  if (state.isPaused) {
    saveState({
      ...state,
      pausedTimeRemainingMs: (state.pausedTimeRemainingMs || 0) + addMs,
      phaseEpoch: Date.now(),
    }, { immediate: true })
  } else {
    saveState({
      ...state,
      questionEndsAt: state.questionEndsAt + addMs,
      phaseEpoch: Date.now(),
    }, { immediate: true })
  }
}

export function skipQuestion(pin: string) {
  const state = loadState(pin)
  if (!state) return
  if (state.status === 'question_active') {
    revealAnswer(pin)
  } else if (state.status === 'question_reveal') {
    showLeaderboard(pin)
  } else if (state.status === 'leaderboard') {
    const totalQ = state.quiz.questions.length
    if (state.currentQuestionIndex + 1 < totalQ) {
      nextQuestion(pin)
    } else {
      endGame(pin)
    }
  }
}

export function toggleAliasMode(pin: string) {
  const state = loadState(pin)
  if (!state) return
  saveState({
    ...state,
    aliasMode: !state.aliasMode,
    phaseEpoch: Date.now(),
  }, { immediate: true })
}


// ── Player actions ────────────────────────────────────────────────

export async function joinSessionAsync(
  pin: string,
  player: Omit<Player, 'score' | 'streak' | 'rank' | 'lastAnswerCorrect' | 'lastPointsEarned' | 'hasAnswered' | 'selectedIndex' | 'joinedAt' | 'connected' | 'coins' | 'violations' | 'flagged' | 'frenzyScore'>
): Promise<'ok' | 'not_found' | 'locked' | 'duplicate' | 'ended'> {
  const cleanPin = pin.trim().toUpperCase()
  let state = loadState(cleanPin)
  if (!state) {
    state = await fetchRemoteState(cleanPin, 4)
  }
  if (!state) return 'not_found'
  if (state.status === 'ended') return 'ended'

  // If this exact player ID is already registered, update player info & return ok (re-join)
  if (state.players && state.players[player.id]) {
    saveState({
      ...state,
      players: {
        ...state.players,
        [player.id]: {
          ...state.players[player.id],
          nickname: player.nickname,
          avatarSeed: player.avatarSeed,
          avatarStyle: player.avatarStyle,
          connected: true,
        }
      }
    })
    return 'ok'
  }

  // Check duplicate nickname for a DIFFERENT player ID
  const existing = state.players ? Object.values(state.players).find(
    p => p.nickname.toLowerCase() === player.nickname.toLowerCase()
  ) : null

  if (existing) {
    if (existing.id === player.id) return 'ok'
    return 'duplicate'
  }

  const newPlayer: Player = {
    ...player,
    score: 0, streak: 0, maxStreak: 0, totalCorrect: 0, totalAnswered: 0, totalResponseTimeMs: 0, rank: 0,
    lastAnswerCorrect: null,
    lastPointsEarned: 0,
    hasAnswered: false,
    selectedIndex: null,
    joinedAt: Date.now(),
    connected: true,
    coins: 0, // Coins earned through quiz answers & performance
    violations: 0,
    flagged: false,
    frenzyScore: 0,
  }

  const updatedState = { ...state, players: { ...(state.players || {}), [player.id]: newPlayer } }
  saveState(updatedState)

  // Direct cloud API sync for cross-device join guarantee
  if (typeof window !== 'undefined') {
    fetch(`/api/room/${cleanPin}?_t=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'join', player: newPlayer })
    }).catch(() => {})
  }

  return 'ok'
}

export function joinSession(
  pin: string,
  player: Omit<Player, 'score' | 'streak' | 'rank' | 'lastAnswerCorrect' | 'lastPointsEarned' | 'hasAnswered' | 'selectedIndex' | 'joinedAt' | 'connected' | 'coins' | 'violations' | 'flagged' | 'frenzyScore'>
): 'ok' | 'not_found' | 'locked' | 'duplicate' | 'ended' {
  const state = loadState(pin)
  if (!state) {
    // Trigger background remote fetch
    fetchRemoteState(pin).then(rem => {
      if (rem) {
        joinSessionAsync(pin, player)
      }
    })
    return 'ok' // Optimistic ok while remote state synchronizes
  }
  if (state.status === 'ended') return 'ended'

  if (state.players && state.players[player.id]) {
    saveState({
      ...state,
      players: {
        ...state.players,
        [player.id]: {
          ...state.players[player.id],
          nickname: player.nickname,
          avatarSeed: player.avatarSeed,
          avatarStyle: player.avatarStyle,
          connected: true,
        }
      }
    })
    return 'ok'
  }

  const existing = state.players ? Object.values(state.players).find(
    p => p.nickname.toLowerCase() === player.nickname.toLowerCase()
  ) : null

  if (existing) {
    if (existing.id === player.id) return 'ok'
    return 'duplicate'
  }

  const newPlayer: Player = {
    ...player,
    score: 0, streak: 0, maxStreak: 0, totalCorrect: 0, totalAnswered: 0, totalResponseTimeMs: 0, rank: 0,
    lastAnswerCorrect: null,
    lastPointsEarned: 0,
    hasAnswered: false,
    selectedIndex: null,
    joinedAt: Date.now(),
    connected: true,
    coins: 0, // Coins earned through quiz answers & performance
    violations: 0,
    flagged: false,
    frenzyScore: 0,
  }
  saveState({ ...state, players: { ...(state.players || {}), [player.id]: newPlayer } })
  return 'ok'
}

export function sendReaction(pin: string, emoji: string, senderName?: string) {
  const state = loadState(pin)
  if (!state) return
  const newReaction: Reaction = {
    id: 'rx_' + Date.now() + '_' + Math.random().toString(36).slice(2),
    emoji,
    senderName,
    createdAt: Date.now(),
  }
  const reactions = [...(state.reactions || []), newReaction].slice(-25)
  saveState({ ...state, reactions }, { relay: false })

  if (typeof window !== 'undefined') {
    fetch(`/api/room/${pin}?_t=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reaction', reaction: newReaction })
    }).catch(() => {})
  }
}

export function submitAnswer(pin: string, playerId: string, selectedIndex: number, powerUpActive = false) {
  const state = loadState(pin)
  if (!state || state.status !== 'question_active') return
  const player = state.players?.[playerId]
  if (!player || player.hasAnswered) return

  const q = state.quiz?.questions?.[state.currentQuestionIndex]
  if (!q) return

  const isKnownCorrect = (typeof q.correct_index === 'number') ? (selectedIndex === q.correct_index) : null
  const isCorrect = isKnownCorrect !== null ? isKnownCorrect : false
  const now = Date.now()
  const timeRemainingMs = state.isPaused
    ? Math.max(0, state.pausedTimeRemainingMs || 0)
    : Math.max(0, state.questionEndsAt - now)
  const totalTimeMs = q.time_limit_ms || 20000
  const responseTimeMs = Math.max(0, now - state.questionStartedAt)

  // SECURITY: Prevent sub-100ms automated script answers
  const isSuspiciousBot = responseTimeMs < 100 && totalTimeMs >= 5000

  let points = 0
  const newStreak = isCorrect ? player.streak + 1 : 0
  const bidMultiplier = player.bidMultiplier ?? 1
  const difficulty = q.difficulty || 'medium'
  const diffMult = difficulty === 'hard' ? 1.5 : difficulty === 'medium' ? 1.25 : 1

  if (isCorrect && !isSuspiciousBot) {
    const ratio = Math.max(0, Math.min(1, timeRemainingMs / totalTimeMs))
    const speedFactor = 0.5 + 0.5 * ratio
    const streakMultiplier = 1 + Math.min(player.streak * 0.1, 0.5)
    const multiplier = (powerUpActive ? 2 : 1) * bidMultiplier * diffMult
    points = Math.round(Math.max(50, 1000 * speedFactor * streakMultiplier * multiplier))
    
    // SECURITY: Mathematically clamp maximum points to stop score injection cheats
    points = Math.min(12000, points)
  } else {
    if (state.gameMode === 'boss_raid') {
      points = -5 // Boss attacks (-5 class points)
    }
  }

  // Coin award (generous for Freshers Event)
  const baseCoins = isCorrect ? (difficulty === 'hard' ? 25 : difficulty === 'medium' ? 18 : 12) : 3
  const speedCoinBonus = isCorrect && responseTimeMs < 5000 ? 8 : (isCorrect && responseTimeMs < 10000 ? 4 : 0)
  const streakCoinBonus = isCorrect && player.streak >= 2 ? 5 : 0
  const coinsEarned = baseCoins + speedCoinBonus + streakCoinBonus

  // Calculate Boss Health update for Boss Raid mode
  let currentBossHp = state.bossHealth ?? 100
  if (state.gameMode === 'boss_raid') {
    if (isCorrect && !isSuspiciousBot) {
      currentBossHp = Math.max(0, currentBossHp - 10) // On correct answers, reduce bossHealth by 10 points
    }
  }

  const updatedPlayer: Player = {
    ...player,
    hasAnswered: true,
    selectedIndex,
    lastAnswerCorrect: isKnownCorrect,
    lastPointsEarned: points,
    score: Math.max(0, player.score + points),
    streak: newStreak,
    maxStreak: Math.max(player.maxStreak || 0, newStreak),
    totalCorrect: (player.totalCorrect || 0) + (isCorrect ? 1 : 0),
    totalAnswered: (player.totalAnswered || 0) + 1,
    totalResponseTimeMs: (player.totalResponseTimeMs || 0) + responseTimeMs,
    coins: (player.coins || 0) + coinsEarned,
    bidMultiplier: 1, // reset bid multiplier after question is answered
  }

  const updatedPlayers = { ...state.players, [playerId]: updatedPlayer }
  const tactics = getTacticsRankings(updatedPlayers)
  const mastery = getMasteryRankings(updatedPlayers)

  // Skip the redundant full-state relay POST — the action POST below already
  // carries this answer to the server, which re-scores it authoritatively.
  saveState({
    ...state,
    bossHealth: currentBossHp,
    players: updatedPlayers,
    tacticsRankings: tactics,
    masteryRankings: mastery,
  }, { relay: false })

  // 1. Broadcast answer directly to Host Screen over Supabase Realtime WebSocket for instant 0ms arrival
  if (supabase) {
    try {
      if (!_relayChannels[pin]) {
        _relayChannels[pin] = supabase.channel(`qf_room_${pin}`, {
          config: { broadcast: { self: true } }
        })
        _relayChannels[pin].subscribe()
      }
      _relayChannels[pin].send({
        type: 'broadcast',
        event: 'submit_answer',
        payload: {
          pin,
          playerId,
          data: {
            selectedIndex,
            correct: isCorrect,
            points,
            responseTimeMs
          }
        }
      }).catch(() => {})
    } catch {}
  }

  // 2. Direct cloud API sync for cross-device answer submission guarantee
  if (typeof window !== 'undefined') {
    fetch(`/api/room/${pin}?_t=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'submit_answer',
        playerId,
        selectedIndex,
        powerUpActive,
        // Omit timeRemainingMs: server computes from questionEndsAt (server clock) for fairness.
        // Device clocks can drift ±5s on cheap Androids causing unfair speed scoring.
        responseTimeMs
      })
    }).catch(() => {})
  }
}

// ── Boss Frenzy ───────────────────────────────────────────────────

/**
 * Host triggers Boss Frenzy on the last question.
 * Picks up to 10 questions (cycling if quiz has fewer), starts 60s countdown.
 */
export function startBossFrenzy(pin: string) {
  const state = loadState(pin)
  if (!state || !state.quiz?.questions?.length) return

  const totalQ = state.quiz.questions.length
  const frenzyCount = 10
  const indices: number[] = []
  for (let i = 0; i < frenzyCount; i++) {
    indices.push(i % totalQ)
  }

  const now = Date.now()
  const bossFrenzy: import('./types').BossFrenzyState = {
    active: true,
    endsAt: now + 60000,
    questionIndices: indices,
    currentFrenzyIndex: 0,
    questionStartedAt: now,
    frenzyScores: Object.fromEntries(Object.keys(state.players).map(id => [id, 0]))
  }

  saveState({ ...state, status: 'boss_frenzy', bossFrenzy, phaseEpoch: now }, { immediate: true })
}

/**
 * Player submits an answer in boss frenzy mode.
 * Increments frenzyScore if correct; does NOT modify main score.
 * Advances to next rapid-fire question or ends frenzy if all 10 done.
 */
export function submitFrenzyAnswer(pin: string, playerId: string, selectedIndex: number) {
  const state = loadState(pin)
  if (!state || state.status !== 'boss_frenzy' || !state.bossFrenzy?.active) return

  const frenzy = state.bossFrenzy
  if (Date.now() > frenzy.endsAt) {
    endBossFrenzy(pin)
    return
  }

  const qIdx = frenzy.questionIndices[frenzy.currentFrenzyIndex]
  const q = state.quiz.questions[qIdx]
  if (!q) return

  const isCorrect = selectedIndex === q.correct_index
  const newFrenzyScores = { ...frenzy.frenzyScores }
  if (isCorrect) {
    newFrenzyScores[playerId] = (newFrenzyScores[playerId] || 0) + 1
  }

  const nextFrenzyIndex = frenzy.currentFrenzyIndex + 1
  const isLastQ = nextFrenzyIndex >= frenzy.questionIndices.length

  // Award bonus score from frenzy at the end
  let updatedPlayers = { ...state.players }
  if (isLastQ) {
    // Award 200pts per correct frenzy answer
    Object.entries(newFrenzyScores).forEach(([pid, correct]) => {
      if (updatedPlayers[pid]) {
        updatedPlayers[pid] = {
          ...updatedPlayers[pid],
          score: updatedPlayers[pid].score + correct * 200,
          frenzyScore: correct
        }
      }
    })
  }

  const updatedFrenzy: import('./types').BossFrenzyState = {
    ...frenzy,
    currentFrenzyIndex: isLastQ ? frenzy.currentFrenzyIndex : nextFrenzyIndex,
    questionStartedAt: Date.now(),
    frenzyScores: newFrenzyScores,
    active: !isLastQ
  }

  saveState({
    ...state,
    players: updatedPlayers,
    bossFrenzy: updatedFrenzy,
    phaseEpoch: Date.now(),
    status: isLastQ ? 'ended' : 'boss_frenzy'
  }, { relay: false })

  if (typeof window !== 'undefined') {
    fetch(`/api/room/${pin}?_t=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'frenzy_answer',
        playerId,
        selectedIndex,
        frenzyIndex: frenzy.currentFrenzyIndex
      })
    }).catch(() => {})
  }
}

/** Host manually ends boss frenzy early */
export function endBossFrenzy(pin: string) {
  const state = loadState(pin)
  if (!state || !state.bossFrenzy) return

  // Award 200pts per correct frenzy answer to all players
  const updatedPlayers = { ...state.players }
  const scores = state.bossFrenzy.frenzyScores || {}
  Object.entries(scores).forEach(([pid, correct]) => {
    if (updatedPlayers[pid]) {
      updatedPlayers[pid] = {
        ...updatedPlayers[pid],
        score: updatedPlayers[pid].score + correct * 200,
        frenzyScore: correct
      }
    }
  })

  saveState({
    ...state,
    players: updatedPlayers,
    status: 'ended',
    phaseEpoch: Date.now(),
    bossFrenzy: { ...state.bossFrenzy, active: false }
  }, { immediate: true })
}

// ── Anti-Cheat Violation Reporting ───────────────────────────────

export function reportViolation(pin: string, playerId: string, reason: string) {
  if (typeof window === 'undefined') return
  fetch(`/api/room/${pin}?_t=${Date.now()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'report_violation', playerId, reason })
  }).catch(() => {})
}

// ── Coin Economy ─────────────────────────────────────────────────

/**
 * Award coins to a player (called after server confirms correct answer).
 * difficulty → coin award: easy=5, medium=8, hard=12; fast (<5s) → +3 bonus
 */
export function awardCoins(pin: string, playerId: string, difficulty: 'easy' | 'medium' | 'hard', responseTimeMs: number) {
  const state = loadState(pin)
  if (!state) return
  const player = state.players[playerId]
  if (!player) return

  const base = difficulty === 'easy' ? 5 : difficulty === 'medium' ? 8 : 12
  const bonus = responseTimeMs < 5000 ? 3 : 0
  const earned = base + bonus

  saveState({
    ...state,
    players: {
      ...state.players,
      [playerId]: { ...player, coins: (player.coins || 0) + earned }
    }
  })
}

/**
 * Spend coins to buy a power-up (client-side optimistic, server validates).
 * Returns true if purchase succeeded.
 */
export function buyPowerUp(
  pin: string,
  playerId: string,
  powerUpType: import('./types').CoinPowerUpType,
  targetId?: string
): boolean {
  const state = loadState(pin)
  if (!state) return false
  const player = state.players[playerId]
  if (!player) return false

  // Cost map
  const COSTS: Record<string, number> = {
    freeze_player: 15,
    freeze_all: 25,
    bid_2x: 10,
    bid_3x: 20,
    bid_4x: 35
  }
  const cost = COSTS[powerUpType] ?? 999
  if ((player.coins || 0) < cost) return false

  // Deduct coins
  const updatedPlayers = { ...state.players }
  updatedPlayers[playerId] = { ...player, coins: player.coins - cost }

  // Apply effect
  if (powerUpType === 'bid_2x' || powerUpType === 'bid_3x' || powerUpType === 'bid_4x') {
    const mult = powerUpType === 'bid_2x' ? 2 : powerUpType === 'bid_3x' ? 3 : 4
    updatedPlayers[playerId] = { ...updatedPlayers[playerId], bidMultiplier: mult }
  } else if (powerUpType === 'freeze_player' && targetId && updatedPlayers[targetId]) {
    updatedPlayers[targetId] = { ...updatedPlayers[targetId], frozenUntil: Date.now() + 6000 }
  } else if (powerUpType === 'freeze_all') {
    const freezeEnd = Date.now() + 4000
    Object.keys(updatedPlayers).forEach(pid => {
      if (pid !== playerId) {
        updatedPlayers[pid] = { ...updatedPlayers[pid], frozenUntil: freezeEnd }
      }
    })
  }

  // Skip the redundant full-state relay POST — the action POST below applies
  // the purchase server-side for all other devices.
  saveState({ ...state, players: updatedPlayers }, { relay: false })

  // Sync to server
  if (typeof window !== 'undefined') {
    fetch(`/api/room/${pin}?_t=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'buy_powerup',
        playerId,
        powerUpType,
        targetId
      })
    }).catch(() => {})
  }

  return true
}

