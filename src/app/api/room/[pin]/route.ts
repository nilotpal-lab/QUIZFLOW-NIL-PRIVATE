import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/* ================================================================
   QuizFlow — Cloud Room Relay Server
   Server-authoritative answer evaluation, coin awards, anti-cheat.
   Zero-configuration cross-device multiplayer state relay.
   ================================================================ */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

declare global {
  // eslint-disable-next-line no-var
  var __qf_rooms: Map<string, { state: any; updatedAt: number }> | undefined
  // Server-only answer keys — never sent to clients during question_active
  var __qf_answerKeys: Map<string, number[]> | undefined
}

if (!global.__qf_rooms) global.__qf_rooms = new Map()
if (!global.__qf_answerKeys) global.__qf_answerKeys = new Map()

const rooms = global.__qf_rooms
const answerKeys = global.__qf_answerKeys

function getTmpPath(pin: string) {
  return path.join(os.tmpdir(), `qf_room_${pin}.json`)
}

function getKeyPath(pin: string) {
  return path.join(os.tmpdir(), `qf_key_${pin}.json`)
}

function readTmpRoom(pin: string) {
  try {
    const file = getTmpPath(pin)
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed?.state) return parsed
    }
  } catch {}
  return null
}

// Debounced tmp-disk persistence. A busy game can POST dozens of times per
// second; writing synchronously on every POST blocks the event loop and can
// make the relay stall under a full classroom. At most one write per pin per
// 300ms window, always with the latest state.
const _pendingWrites = new Map<string, { data: { state: any; updatedAt: number }; timer: ReturnType<typeof setTimeout> }>()

function writeTmpRoom(pin: string, data: { state: any; updatedAt: number }) {
  const existing = _pendingWrites.get(pin)
  if (existing) {
    existing.data = data
    return
  }
  const entry: { data: { state: any; updatedAt: number }; timer: ReturnType<typeof setTimeout> } = {
    data,
    timer: setTimeout(() => {
      _pendingWrites.delete(pin)
      try {
        fs.writeFileSync(getTmpPath(pin), JSON.stringify(entry.data), 'utf8')
      } catch {}
    }, 300)
  }
  _pendingWrites.set(pin, entry)
}

// Supabase DB persistence.
// Joins, room creation, and status transitions write immediately and are awaited (forceImmediate=true).
// Rapid in-game answer submissions debounce at 1500ms to reduce DB pressure during 150-player games.
const _realtimeChannels = new Map<string, any>()

function getSupabaseRealtimeChannel(pin: string) {
  if (!supabase) return null
  let ch = _realtimeChannels.get(pin)
  if (!ch) {
    ch = supabase.channel(`qf_room_${pin}`, {
      config: { broadcast: { self: true } }
    })
    ch.subscribe()
    _realtimeChannels.set(pin, ch)
  }
  return ch
}

async function broadcastToSupabaseRealtime(pin: string, event: string, payload: any) {
  try {
    const ch = getSupabaseRealtimeChannel(pin)
    if (ch) {
      let broadcastPayload = payload
      if (event === 'state_sync' && payload && payload.players) {
        const topTactics = payload.tacticsRankings?.slice(0, 10) || []
        const topMastery = payload.masteryRankings?.slice(0, 10) || []
        broadcastPayload = {
          ...payload,
          players: Object.fromEntries(topTactics.map((p: any) => [p.id, p])),
          tacticsRankings: topTactics,
          masteryRankings: topMastery,
        }
      }
      await ch.send({
        type: 'broadcast',
        event,
        payload: broadcastPayload
      })
    }
  } catch (err) {
    console.warn(`[Realtime Broadcast Warning] room_${pin}:`, err)
  }
}

async function performSupabaseWrite(pin: string, current: any): Promise<void> {
  if (!supabase || !current) return
  try {
    const { error } = await supabase.from('quizzes').upsert({
      id: 'room_' + pin,
      host_id: current.hostId || 'host_live',
      title: current.quiz?.title || 'Live Room ' + pin,
      description: 'Live active game session',
      question_count: current.quiz?.questions?.length || 0,
      quiz_data: current,
      is_draft: false,
      updated_at: new Date().toISOString()
    })
    if (error) console.warn(`[Supabase Upsert Error] room_${pin}:`, error.message)
  } catch (err) {
    console.warn(`[QuizFlow Relay] Supabase write failed for room ${pin}:`, err)
  }
}

function loadAnswerKeys(pin: string): number[] {
  if (answerKeys.has(pin)) {
    const mem = answerKeys.get(pin)!
    if (mem.length > 0) return mem
  }
  try {
    const kf = getKeyPath(pin)
    if (fs.existsSync(kf)) {
      const keys = JSON.parse(fs.readFileSync(kf, 'utf8'))
      if (Array.isArray(keys) && keys.length > 0) {
        answerKeys.set(pin, keys)
        return keys
      }
    }
  } catch {}
  return []
}

function saveAnswerKeys(pin: string, keys: number[]) {
  if (!Array.isArray(keys) || keys.length === 0) return
  answerKeys.set(pin, keys)
  try {
    fs.writeFileSync(getKeyPath(pin), JSON.stringify(keys), 'utf8')
  } catch {}
}

/**
 * Extract and cache answer keys from state if present.
 */
function extractAndSaveKeysFromState(pin: string, state: any) {
  if (state?.quiz?.questions && Array.isArray(state.quiz.questions)) {
    const keys = state.quiz.questions.map((q: any) => (typeof q?.correct_index === 'number' ? q.correct_index : -1))
    if (keys.some((k: number) => k >= 0)) {
      saveAnswerKeys(pin, keys)
    }
  }
}

/**
 * Strip correct_index from quiz questions in client-facing state.
 * correct_index is only injected back into state when status === 'question_reveal' or game has ended.
 */
function sanitizeStateForClient(state: any, pin: string): any {
  if (!state?.quiz?.questions) return state

  const isActive = state.status === 'question_active' || state.status === 'boss_frenzy'
  if (!isActive) return state // reveal/leaderboard/ended/lobby: send full state

  return {
    ...state,
    quiz: {
      ...state.quiz,
      questions: state.quiz.questions.map((q: any) => {
        const { correct_index, ...safeQ } = q
        return safeQ
      })
    }
  }
}

/** Compute coin award based on question difficulty, response speed, accuracy, and streak */
function computeCoins(difficulty: string, responseTimeMs: number, isCorrect: boolean, streak: number = 0): number {
  if (!isCorrect) {
    // 3 participation coins even on wrong answers to keep student engagement high
    return 3
  }
  const base = difficulty === 'hard' ? 25 : difficulty === 'medium' ? 18 : 12
  const speedBonus = responseTimeMs < 5000 ? 8 : responseTimeMs < 10000 ? 4 : 0
  const streakBonus = streak >= 2 ? 5 : 0
  return base + speedBonus + streakBonus
}

/** Compute points with difficulty multiplier, speed decay, streak bonus, and bid multiplier */
function computePoints(
  timeRemainingMs: number,
  totalTimeMs: number,
  streak: number,
  powerUpActive: boolean,
  bidMultiplier: number,
  difficulty: string
): number {
  const diffMult = difficulty === 'hard' ? 1.5 : difficulty === 'medium' ? 1.25 : 1
  const ratio = Math.max(0, Math.min(1, (timeRemainingMs || 0) / (totalTimeMs || 20000)))
  const speedFactor = 0.5 + 0.5 * ratio
  const streakMultiplier = 1 + Math.min((streak || 0) * 0.1, 0.5)
  const multiplier = (powerUpActive ? 2 : 1) * (bidMultiplier || 1) * diffMult
  const pts = Math.round(Math.max(50, 1000 * speedFactor * streakMultiplier * multiplier))
  return Math.min(12000, pts)
}

const noCacheHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'Surrogate-Control': 'no-store',
  'Pragma': 'no-cache',
  'Expires': '0'
}

export async function GET(
  req: Request,
  { params }: { params: { pin: string } }
) {
  const pin = params?.pin?.trim().toUpperCase()
  if (!pin) {
    return NextResponse.json({ error: 'PIN required' }, { status: 400, headers: noCacheHeaders })
  }

  // 1. Check in-memory map
  let room = rooms.get(pin)
  if (room?.state) {
    extractAndSaveKeysFromState(pin, room.state)
    return NextResponse.json({
      success: true, pin,
      state: sanitizeStateForClient(room.state, pin),
      updatedAt: room.updatedAt
    }, { headers: noCacheHeaders })
  }

  // 2. Check disk /tmp cache fallback
  const tmp = readTmpRoom(pin)
  if (tmp?.state) {
    rooms.set(pin, tmp)
    extractAndSaveKeysFromState(pin, tmp.state)
    loadAnswerKeys(pin)
    return NextResponse.json({
      success: true, pin,
      state: sanitizeStateForClient(tmp.state, pin),
      updatedAt: tmp.updatedAt
    }, { headers: noCacheHeaders })
  }

  // 3. Fallback to Supabase Cloud Database if serverless lambda was cold
  if (supabase) {
    try {
      const fetchPromise = supabase
        .from('quizzes')
        .select('quiz_data, updated_at')
        .eq('id', 'room_' + pin)
        .maybeSingle()
      const timeoutPromise = new Promise<{ data: any; error: any }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 3000)
      )
      const res = await Promise.race([fetchPromise, timeoutPromise])
      const data = res?.data

      if (data?.quiz_data) {
        const item = {
          state: data.quiz_data,
          updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : Date.now()
        }
        rooms.set(pin, item)
        writeTmpRoom(pin, item)
        extractAndSaveKeysFromState(pin, data.quiz_data)
        loadAnswerKeys(pin)
        return NextResponse.json({
          success: true, pin,
          state: sanitizeStateForClient(data.quiz_data, pin),
          updatedAt: item.updatedAt
        }, { headers: noCacheHeaders })
      }
    } catch {
      // Graceful fallback
    }
  }

  return NextResponse.json({ error: 'Room not found', pin }, { status: 404, headers: noCacheHeaders })
}

export async function POST(
  req: Request,
  { params }: { params: { pin: string } }
) {
  const pin = params?.pin?.trim().toUpperCase()
  if (!pin) {
    return NextResponse.json({ error: 'PIN required' }, { status: 400, headers: noCacheHeaders })
  }

  try {
    const body = await req.json()
    const { state, action, player, reaction } = body

    let current = rooms.get(pin)?.state

    // If memory is empty, check /tmp disk first
    if (!current) {
      const tmp = readTmpRoom(pin)
      if (tmp?.state) {
        current = tmp.state
        rooms.set(pin, tmp)
        extractAndSaveKeysFromState(pin, current)
      }
    }

    // If still empty and no state is being pushed directly, attempt to restore from Supabase
    if (!current && !state && supabase) {
      try {
        const fetchPromise = supabase
          .from('quizzes')
          .select('quiz_data, updated_at')
          .eq('id', 'room_' + pin)
          .maybeSingle()
        const timeoutPromise = new Promise<{ data: any; error: any }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 3000)
        )
        const res = await Promise.race([fetchPromise, timeoutPromise])
        const data = res?.data
        if (data?.quiz_data) {
          current = data.quiz_data
          const item = {
            state: current,
            updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : Date.now()
          }
          rooms.set(pin, item)
          writeTmpRoom(pin, item)
          extractAndSaveKeysFromState(pin, current)
        }
      } catch {}
    }

    // ── Handle actions ─────────────────────────────────────────────

    if (state) {
      // Full state sync (host broadcasting state)
      extractAndSaveKeysFromState(pin, state)

      if (current) {
        // Monotonically merge players to prevent host from overwriting server-evaluated scores & answers
        const mergedPlayers: Record<string, any> = { ...(current.players || {}) }
        const isStatusStart = current.status === 'lobby' && (state.status === 'question_active' || state.status === 'boss_frenzy')
        const isNewQuestion = (state.currentQuestionIndex ?? 0) > (current.currentQuestionIndex ?? 0) ||
          ((state.currentQuestionIndex ?? 0) === (current.currentQuestionIndex ?? 0) && (state.questionStartedAt ?? 0) > (current.questionStartedAt ?? 0) && state.status === 'question_active') ||
          isStatusStart

        const allPids = Array.from(new Set([
          ...Object.keys(current.players || {}),
          ...Object.keys(state.players || {})
        ]))

        allPids.forEach(pid => {
          const sPlayer = current.players?.[pid]
          const p = state.players?.[pid]

          if (!sPlayer && p) {
            mergedPlayers[pid] = p
          } else if (sPlayer && !p) {
            mergedPlayers[pid] = sPlayer
          } else if (sPlayer && p) {
            const score = Math.max(p.score || 0, sPlayer.score || 0)
            const streak = Math.max(p.streak || 0, sPlayer.streak || 0)
            const maxStreak = Math.max(p.maxStreak || 0, sPlayer.maxStreak || 0, streak)
            const totalCorrect = Math.max(p.totalCorrect || 0, sPlayer.totalCorrect || 0)
            const totalAnswered = Math.max(p.totalAnswered || 0, sPlayer.totalAnswered || 0)
            const totalResponseTimeMs = Math.max(p.totalResponseTimeMs || 0, sPlayer.totalResponseTimeMs || 0)
            const coins = Math.max(p.coins || 0, sPlayer.coins || 0)
            const violations = Math.max(p.violations || 0, sPlayer.violations || 0)
            const flagged = sPlayer.flagged || p.flagged || false
            const frenzyScore = Math.max(p.frenzyScore || 0, sPlayer.frenzyScore || 0)

            if (isNewQuestion) {
              // Advanced to new question -> reset per-question flags
              mergedPlayers[pid] = {
                ...sPlayer,
                ...p,
                score,
                streak,
                maxStreak,
                totalCorrect,
                totalAnswered,
                totalResponseTimeMs,
                coins,
                violations,
                flagged,
                frenzyScore,
                rank: p.rank ?? sPlayer.rank ?? 0,
                tacticsRank: p.tacticsRank ?? sPlayer.tacticsRank,
                masteryRank: p.masteryRank ?? sPlayer.masteryRank,
                hasAnswered: false,
                selectedIndex: null,
                lastAnswerCorrect: null,
                lastPointsEarned: 0
              }
            } else {
              // Same question -> preserve server evaluated answer and score
              const hasAnswered = Boolean(sPlayer.hasAnswered || p.hasAnswered)
              const selectedIndex = sPlayer.hasAnswered && sPlayer.selectedIndex !== null
                ? sPlayer.selectedIndex
                : (p.selectedIndex ?? sPlayer.selectedIndex)
              const lastAnswerCorrect = sPlayer.hasAnswered && sPlayer.lastAnswerCorrect !== null
                ? sPlayer.lastAnswerCorrect
                : (p.lastAnswerCorrect ?? sPlayer.lastAnswerCorrect)
              const lastPointsEarned = sPlayer.hasAnswered
                ? (sPlayer.lastPointsEarned ?? 0)
                : Math.max(sPlayer.lastPointsEarned || 0, p.lastPointsEarned || 0)

              mergedPlayers[pid] = {
                ...sPlayer,
                ...p,
                score,
                streak,
                maxStreak,
                totalCorrect,
                totalAnswered,
                totalResponseTimeMs,
                coins,
                violations,
                flagged,
                frenzyScore,
                rank: p.rank ?? sPlayer.rank ?? 0,
                tacticsRank: p.tacticsRank ?? sPlayer.tacticsRank,
                masteryRank: p.masteryRank ?? sPlayer.masteryRank,
                hasAnswered,
                selectedIndex,
                lastAnswerCorrect,
                lastPointsEarned
              }
            }
          }
        })

        // Preserve questions that contain correct_index if incoming host payload stripped them
        let preservedQuestions = state.quiz?.questions
        if (current.quiz?.questions && Array.isArray(current.quiz.questions) && Array.isArray(preservedQuestions)) {
          preservedQuestions = preservedQuestions.map((q: any, i: number) => {
            const curQ = current.quiz.questions[i]
            if (typeof q?.correct_index !== 'number' && typeof curQ?.correct_index === 'number') {
              return { ...q, correct_index: curQ.correct_index }
            }
            return q
          })
        }

        current = {
          ...state,
          quiz: {
            ...(state.quiz || current.quiz),
            questions: preservedQuestions || current.quiz?.questions
          },
          players: mergedPlayers,
          bossHealth: Math.min(state.bossHealth ?? 100, current.bossHealth ?? 100)
        }
      } else {
        current = state
      }

    } else if (action === 'submit_answer' && current) {
      // SECURITY: Validate that question is currently active
      if (current.status !== 'question_active') {
        return NextResponse.json({
          error: 'Question is not currently active for answer submission.',
          status: current.status,
          pin
        }, { status: 400, headers: noCacheHeaders })
      }

      const { playerId, selectedIndex, powerUpActive, timeRemainingMs, responseTimeMs } = body
      const p = current.players?.[playerId]

      if (p && !p.hasAnswered) {
        const now = Date.now()
        const qIdx = current.currentQuestionIndex ?? 0
        const q = current.quiz?.questions?.[qIdx]
        const totalTimeMs = q?.time_limit_ms ?? 20000

        // Server-authoritative time evaluation (prevents client time forgery)
        const serverTimeRemainingMs = current.isPaused
          ? Math.max(0, current.pausedTimeRemainingMs ?? 0)
          : Math.max(0, (current.questionEndsAt ?? (now + totalTimeMs)) - now)
        const serverElapsedMs = Math.max(0, now - (current.questionStartedAt ?? (now - totalTimeMs)))

        // Effective time bounded by server clock with 1500ms network tolerance
        const effectiveTimeRemainingMs = Math.min(
          typeof timeRemainingMs === 'number' ? timeRemainingMs : serverTimeRemainingMs,
          serverTimeRemainingMs + 1500
        )
        const effectiveResponseTimeMs = Math.max(
          typeof responseTimeMs === 'number' ? responseTimeMs : serverElapsedMs,
          serverElapsedMs > 1000 ? serverElapsedMs - 1500 : 0
        )

        // Check frozen status
        if (p.frozenUntil && p.frozenUntil > now) {
          // Player is frozen — record response but award 0 points
          const frozenPlayer = {
            ...p,
            hasAnswered: true,
            selectedIndex,
            lastAnswerCorrect: false,
            lastPointsEarned: 0
          }
          current = { ...current, players: { ...current.players, [playerId]: frozenPlayer } }
        } else {
          // Look up correct answer from server-only key store or server quiz questions
          const keys = loadAnswerKeys(pin)
          const correctIdx = (typeof keys[qIdx] === 'number' && keys[qIdx] >= 0)
            ? keys[qIdx]
            : (typeof q?.correct_index === 'number' ? q.correct_index : -1)

          const difficulty = q?.difficulty ?? 'medium'
          const isCorrect = correctIdx >= 0 && selectedIndex === correctIdx

          // Anti-bot security: sub-100ms answers on long questions flagged as suspicious
          const isSuspiciousBot = effectiveResponseTimeMs < 100 && totalTimeMs >= 5000

          let points = 0
          const newStreak = isCorrect ? (p.streak || 0) + 1 : 0
          const bidMultiplier = p.bidMultiplier ?? 1

          if (isCorrect && !isSuspiciousBot) {
            points = computePoints(effectiveTimeRemainingMs, totalTimeMs, p.streak || 0, powerUpActive, bidMultiplier, difficulty)
          } else if (current.gameMode === 'boss_raid') {
            points = -5
          }

          // Boss health calculation for Boss Raid mode
          let bossHp = current.bossHealth ?? 100
          if (current.gameMode === 'boss_raid' && isCorrect && !isSuspiciousBot) {
            bossHp = Math.max(0, bossHp - 10)
          }

          // Coin award computation
          const coinsEarned = computeCoins(difficulty, effectiveResponseTimeMs, isCorrect && !isSuspiciousBot, p.streak || 0)

          const updatedPlayer = {
            ...p,
            hasAnswered: true,
            selectedIndex,
            lastAnswerCorrect: isCorrect,
            lastPointsEarned: points,
            score: Math.max(0, (p.score || 0) + points),
            streak: newStreak,
            maxStreak: Math.max(p.maxStreak || 0, newStreak),
            totalCorrect: (p.totalCorrect || 0) + (isCorrect ? 1 : 0),
            totalAnswered: (p.totalAnswered || 0) + 1,
            totalResponseTimeMs: (p.totalResponseTimeMs || 0) + effectiveResponseTimeMs,
            coins: (p.coins || 0) + coinsEarned,
            bidMultiplier: 1 // securely consume active bid multiplier
          }

          const updatedPlayers = { ...current.players, [playerId]: updatedPlayer }
          current = { ...current, bossHealth: bossHp, players: updatedPlayers }

          // Broadcast submit_answer to Host WebSocket channel for instant real-time scoreboard update
          broadcastToSupabaseRealtime(pin, 'submit_answer', {
            pin,
            playerId,
            data: {
              selectedIndex,
              correct: isCorrect,
              points,
              responseTimeMs: effectiveResponseTimeMs
            }
          })
        }
      }

    } else if (action === 'frenzy_answer' && current) {
      if (current.status !== 'boss_frenzy') {
        return NextResponse.json({
          error: 'Boss frenzy mode is not active.',
          pin
        }, { status: 400, headers: noCacheHeaders })
      }

      const { playerId, selectedIndex, frenzyIndex } = body
      const frenzy = current.bossFrenzy
      if (frenzy?.active && frenzyIndex === frenzy.currentFrenzyIndex) {
        const keys = loadAnswerKeys(pin)
        const qIdx = frenzy.questionIndices?.[frenzyIndex]
        const correctIdx = (typeof keys[qIdx] === 'number' && keys[qIdx] >= 0)
          ? keys[qIdx]
          : (typeof current.quiz?.questions?.[qIdx]?.correct_index === 'number' ? current.quiz.questions[qIdx].correct_index : -1)
        const isCorrect = correctIdx >= 0 && selectedIndex === correctIdx

        const newScores = { ...frenzy.frenzyScores }
        if (isCorrect) newScores[playerId] = (newScores[playerId] || 0) + 1

        const nextIdx = frenzyIndex + 1
        const isLast = nextIdx >= (frenzy.questionIndices?.length ?? 10)
        const isTimeUp = Date.now() > frenzy.endsAt

        let updatedPlayers = { ...current.players }
        if (isLast || isTimeUp) {
          // Award 200pts per correct frenzy answer to all players
          Object.entries(newScores).forEach(([pid, correct]) => {
            if (updatedPlayers[pid]) {
              updatedPlayers[pid] = {
                ...updatedPlayers[pid],
                score: (updatedPlayers[pid].score || 0) + (correct as number) * 200,
                frenzyScore: correct as number
              }
            }
          })
        }

        current = {
          ...current,
          players: updatedPlayers,
          bossFrenzy: {
            ...frenzy,
            currentFrenzyIndex: isLast ? frenzyIndex : nextIdx,
            frenzyScores: newScores,
            active: !isLast && !isTimeUp,
            questionStartedAt: Date.now()
          },
          status: (isLast || isTimeUp) ? 'ended' : 'boss_frenzy'
        }
      }

    } else if (action === 'buy_powerup' && current) {
      const { playerId, powerUpType, targetId } = body
      const p = current.players?.[playerId]
      const COSTS: Record<string, number> = {
        freeze_player: 15, freeze_all: 25, bid_2x: 10, bid_3x: 20, bid_4x: 35
      }
      const cost = COSTS[powerUpType] ?? 999

      if (p && (p.coins || 0) >= cost) {
        const updatedPlayers = { ...current.players }
        updatedPlayers[playerId] = { ...p, coins: (p.coins || 0) - cost }

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
        current = { ...current, players: updatedPlayers }
      }

    } else if (action === 'report_violation' && current) {
      const { playerId } = body
      const p = current.players?.[playerId]
      if (p) {
        const violations = (p.violations || 0) + 1
        const flagged = violations >= 3
        const updatedPlayer = { ...p, violations, flagged }
        current = { ...current, players: { ...current.players, [playerId]: updatedPlayer } }
      }

    } else if (action === 'join' && player) {
      if (!current) {
        current = {
          pin,
          status: 'lobby',
          gameMode: 'classic',
          bossHealth: 100,
          bossMaxHealth: 100,
          quiz: { title: 'Live Room ' + pin, questions: [] },
          currentQuestionIndex: 0,
          questionStartedAt: 0,
          questionEndsAt: 0,
          players: {},
          hostId: 'host_live',
          createdAt: 0
        }
      }

      // Reject new joins if room has already ended to protect database and server load
      if (current.status === 'ended') {
        return NextResponse.json({
          error: 'This game has already ended and is no longer accepting players.',
          ended: true,
          pin
        }, { status: 410, headers: noCacheHeaders })
      }

      const latestTmp = readTmpRoom(pin)
      const allKnownPlayers = {
        ...(latestTmp?.state?.players || {}),
        ...(current.players || {})
      }
      const existingPlayer = allKnownPlayers[player.id]

      current = {
        ...current,
        players: {
          ...allKnownPlayers,
          [player.id]: {
            ...player,
            score: existingPlayer ? (existingPlayer.score || 0) : 0,
            streak: existingPlayer ? (existingPlayer.streak || 0) : 0,
            maxStreak: existingPlayer ? (existingPlayer.maxStreak || 0) : 0,
            totalCorrect: existingPlayer ? (existingPlayer.totalCorrect || 0) : 0,
            totalAnswered: existingPlayer ? (existingPlayer.totalAnswered || 0) : 0,
            totalResponseTimeMs: existingPlayer ? (existingPlayer.totalResponseTimeMs || 0) : 0,
            rank: existingPlayer ? (existingPlayer.rank || 0) : 0,
            lastAnswerCorrect: existingPlayer ? existingPlayer.lastAnswerCorrect : null,
            lastPointsEarned: existingPlayer ? (existingPlayer.lastPointsEarned || 0) : 0,
            hasAnswered: existingPlayer ? Boolean(existingPlayer.hasAnswered) : false,
            selectedIndex: existingPlayer ? existingPlayer.selectedIndex : null,
            joinedAt: existingPlayer ? existingPlayer.joinedAt : Date.now(),
            connected: true,
            coins: existingPlayer ? (existingPlayer.coins || 0) : 0,
            frenzyScore: existingPlayer ? (existingPlayer.frenzyScore || 0) : 0
          }
        }
      }

      if (player) {
        broadcastToSupabaseRealtime(pin, 'player_join', { pin, player })
      }

    } else if (action === 'reaction' && reaction && current) {
      const reactions = [...(current.reactions || []), reaction].slice(-25)
      current = { ...current, reactions }
      broadcastToSupabaseRealtime(pin, 'reaction', { pin, reaction })
    }

    if (!current) {
      return NextResponse.json({ error: 'Cannot update non-existent room', pin }, { status: 404, headers: noCacheHeaders })
    }

    // 1. Update in-memory Map & disk tmp cache
    const item = { state: current, updatedAt: Date.now() }
    rooms.set(pin, item)
    writeTmpRoom(pin, item)

    // 2. Supabase Realtime & DB Sync
    if (supabase) {
      broadcastToSupabaseRealtime(pin, 'state_sync', current)
    }

    return NextResponse.json({
      success: true, pin,
      state: sanitizeStateForClient(current, pin),
      updatedAt: Date.now()
    }, { headers: noCacheHeaders })

  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Failed to update room' },
      { status: 500, headers: noCacheHeaders }
    )
  }
}
