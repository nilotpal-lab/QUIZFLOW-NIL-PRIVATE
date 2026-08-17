'use client'
import { Suspense } from 'react'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import {
  subscribeToSession, submitAnswer, submitFrenzyAnswer, reportViolation, buyPowerUp,
  fetchRemoteState, joinSessionAsync
} from '@/quizflow/sessionStore'
import type { GameState } from '@/quizflow/sessionStore'
import { buildAvatarUrl, POWER_UPS, calculatePoints, formatPoints, safeGetSessionStorage, safeSetSessionStorage } from '@/quizflow/utils'
import type { PowerUpType, CoinPowerUpType } from '@/quizflow/types'
import { SHOP_ITEMS } from '@/quizflow/coinShop'
import {
  playClickSound, playLockInSound, playCountdownTick,
  playCorrectSound, playWrongSound, playPowerUpSound, playStreakSound,
  playWrongBuzzer
} from '@/quizflow/sound'
import { speakText, stopSpeech, toggleSpeech, isSpeaking } from '@/quizflow/speech'
import { useAntiCheat, requestFullscreen } from '@/quizflow/antiCheat'
import ParticleField from '@/quizflow/ParticleField'
import { useScreenShake, DamageParticles, BossHealthBar } from '@/quizflow/BossVFX'
import StreakBadge from '@/quizflow/StreakBadge'

// Feature Flag: Suspended TTS audio narration for Freshers Event
const ENABLE_TTS_AUDIO = false

function ScorePopup({ points, onDone }: { points: number; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 1400); return () => clearTimeout(t) }, [onDone])
  return <div className="score-popup" style={{ top: '38%', left: '50%', transform: 'translateX(-50%)' }}>{formatPoints(points)} ✨</div>
}

function StudentPlayScreen() {
  const searchParams = useSearchParams()
  const router       = useRouter()

  const pin        = searchParams.get('pin')      || ''
  const playerId   = searchParams.get('pid')      || ''

  const [nickname] = useState(() => {
    const fromUrl = searchParams.get('nickname')
    if (fromUrl) {
      safeSetSessionStorage(`qf_nick_${pin}`, fromUrl)
      return fromUrl
    }
    return safeGetSessionStorage(`qf_nick_${pin}`, 'Player')
  })

  const [avatarSeed] = useState(() => {
    const fromUrl = searchParams.get('seed')
    if (fromUrl) {
      safeSetSessionStorage(`qf_seed_${pin}`, fromUrl)
      return fromUrl
    }
    return safeGetSessionStorage(`qf_seed_${pin}`, 'Totoro')
  })

  const [avatarStyle] = useState(() => {
    const fromUrl = searchParams.get('style')
    if (fromUrl) {
      safeSetSessionStorage(`qf_style_${pin}`, fromUrl)
      return fromUrl
    }
    return safeGetSessionStorage(`qf_style_${pin}`, 'custom')
  })

  const [gameState, setGameState]       = useState<GameState | null>(null)
  const [timeMs, setTimeMs]             = useState(20000)
  const [usedPowers, setUsedPowers]     = useState<Set<PowerUpType>>(new Set())
  const [hiddenChoices, setHiddenChoices] = useState<Set<number>>(new Set())
  const [frozen, setFrozen]             = useState(false)
  const [doubleActive, setDoubleActive] = useState(false)
  const [showPopup, setShowPopup]       = useState(false)
  const [popupPoints, setPopupPoints]   = useState(0)
  const [prevQIndex, setPrevQIndex]     = useState(-1)
  const [playedRevealSound, setPlayedRevealSound] = useState(false)
  const [activeBoard, setActiveBoard]   = useState<'tactics' | 'mastery'>('tactics')
  const [isTTSActive, setIsTTSActive]   = useState(false)
  const [sessionTimeout, setSessionTimeout] = useState(false)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)
  const freezeTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Coin shop state
  const [showCoinShop, setShowCoinShop] = useState(false)
  const [shopTarget, setShopTarget]     = useState<string | null>(null)

  // Boss frenzy timer
  const [frenzyTimeLeft, setFrenzyTimeLeft] = useState(60)
  const [frenzyAnswered, setFrenzyAnswered] = useState(false)
  const frenzyIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // VFX state
  const { shakeStyle, triggerShake } = useScreenShake()
  const [particleTrigger, setParticleTrigger] = useState<'correct'|'wrong'|'streak'|null>(null)
  const [showDamageParticles, setShowDamageParticles] = useState(false)
  const [prevStreak, setPrevStreak] = useState(0)
  const [prevAnswerCorrect, setPrevAnswerCorrect] = useState<boolean|null>(null)
  const [responseStartMs] = useState(() => Date.now())
  const [answerResponseMs, setAnswerResponseMs] = useState<number|undefined>(undefined)

  const me = gameState?.players?.[playerId]
  const q  = gameState?.quiz?.questions?.[gameState?.currentQuestionIndex ?? 0] ?? null
  const totalTime = q?.time_limit_ms ?? 20000
  const timePct   = totalTime > 0 ? timeMs / totalTime : 0
  const seconds   = Math.ceil(timeMs / 1000)

  // Anti-cheat shield integration with fullscreen enforcement + violation reporting
  const { violationCount, showWarning, dismissWarning, lastReason, fullscreenActive, fullscreenSupported, enterFullscreen } = useAntiCheat({
    enabled: gameState?.status === 'question_active' || gameState?.status === 'question_reveal' || gameState?.status === 'boss_frenzy',
    blockCopyPaste: true,
    blockContextMenu: true,
    enforceFullscreen: true,
    onViolation: () => {
      playWrongBuzzer()
    },
    onViolationReport: (reason) => {
      if (pin && playerId) reportViolation(pin, playerId, reason)
    }
  })

  // Screen WakeLock management to keep display awake during active quiz play
  useEffect(() => {
    let wakeLock: any = null
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await (navigator as any).wakeLock.request('screen')
        }
      } catch {}
    }
    requestWakeLock()

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      if (wakeLock) {
        try { wakeLock.release() } catch {}
      }
    }
  }, [])

  // Subscribe to session
  useEffect(() => {
    const unsub = subscribeToSession(pin, (state) => {
      setGameState(state)
    })
    return unsub
  }, [pin])

  // Re-sync immediately on tab visible or when device comes back online
  useEffect(() => {
    const onSync = () => {
      if (document.visibilityState === 'visible' && pin) {
        fetchRemoteState(pin).then(remote => {
          if (remote) setGameState(remote)
        })
        if (gameState?.status === 'question_active' && gameState.questionEndsAt) {
          const remaining = Math.max(0, gameState.questionEndsAt - Date.now())
          setTimeMs(remaining)
        }
      }
    }
    document.addEventListener('visibilitychange', onSync)
    window.addEventListener('online', onSync)
    return () => {
      document.removeEventListener('visibilitychange', onSync)
      window.removeEventListener('online', onSync)
    }
  }, [pin, gameState?.status, gameState?.questionEndsAt])

  // Session timeout & unregistered player auto-recovery
  useEffect(() => {
    if (!pin || !playerId) {
      router.push(pin ? `/quizflow/join?pin=${pin}` : '/quizflow/join')
      return
    }
    const t = setTimeout(() => {
      if (!gameState) {
        setSessionTimeout(true)
      } else if (gameState.players && !gameState.players[playerId]) {
        // Optimistically attempt to re-register player into session before ejecting
        joinSessionAsync(pin, { id: playerId, nickname, avatarSeed, avatarStyle }).then(res => {
          if (res !== 'ok') {
            router.push(`/quizflow/join?pin=${pin}`)
          }
        })
      }
    }, 12000) // 12s: matches host timeout; WebSocket + cold-start can take >6s on slow mobile
    return () => clearTimeout(t)
  }, [pin, playerId, gameState, nickname, avatarSeed, avatarStyle, router])

  // Navigate away when game ends
  useEffect(() => {
    if (!gameState) return
    if (gameState.status === 'ended') {
      stopSpeech()
      router.push(`/quizflow/results?pin=${pin}&pid=${playerId}`)
    }
  }, [gameState?.status, pin, playerId, router])

  // Comprehensive reset when question changes (preserve cumulative score & used power-ups across session)
  useEffect(() => {
    if (!gameState) return
    const qIdx = gameState.currentQuestionIndex
    if (qIdx !== prevQIndex) {
      setPrevQIndex(qIdx)
      setHiddenChoices(new Set())
      if (freezeTimerRef.current) {
        clearTimeout(freezeTimerRef.current)
        freezeTimerRef.current = null
      }
      setFrozen(false)
      setDoubleActive(false)
      setPlayedRevealSound(false)
      setIsTTSActive(false)
      stopSpeech()
      setShowPopup(false)
      setPopupPoints(0)
      setAnswerResponseMs(undefined)
      setShowDamageParticles(false)
      setParticleTrigger(null)
      setShowCoinShop(false)
      if (gameState.status === 'question_active' && gameState.questionEndsAt) {
        const remaining = Math.max(0, gameState.questionEndsAt - Date.now())
        setTimeMs(remaining)
      }
    }
  }, [gameState?.currentQuestionIndex, prevQIndex, gameState?.status, gameState?.questionEndsAt])

  // Cleanup speech and timer on unmount
  useEffect(() => {
    return () => {
      stopSpeech()
      if (freezeTimerRef.current) {
        clearTimeout(freezeTimerRef.current)
      }
    }
  }, [])

  // Play reveal sound audio & haptic vibration when status changes to question_reveal
  useEffect(() => {
    if (!gameState || gameState.status !== 'question_reveal' || playedRevealSound) return
    setPlayedRevealSound(true)
    const mePlayer = gameState.players[playerId]
    const isCorrect = mePlayer?.lastAnswerCorrect
    const streak = mePlayer?.streak ?? 0
    if (isCorrect) {
      playCorrectSound()
      if (typeof window !== 'undefined' && window.navigator?.vibrate) {
        try { window.navigator.vibrate([40, 60, 40]) } catch {}
      }
      // Trigger correct particle burst
      setParticleTrigger('correct')
      setTimeout(() => setParticleTrigger(null), 900)
      // Streak VFX
      if (streak >= 3) {
        setTimeout(playStreakSound, 400)
        setParticleTrigger('streak')
        setTimeout(() => setParticleTrigger(null), 1100)
      }
      // Update prev streak for badge
      if (streak !== prevStreak) {
        setPrevStreak(streak)
      }
    } else if (mePlayer?.hasAnswered) {
      playWrongSound()
      if (typeof window !== 'undefined' && window.navigator?.vibrate) {
        try { window.navigator.vibrate([100, 50, 100]) } catch {}
      }
      // Boss raid screen shake + damage on wrong
      if (gameState.gameMode === 'boss_raid') {
        triggerShake(8)
        setShowDamageParticles(true)
      } else {
        triggerShake(4)
      }
      setParticleTrigger('wrong')
      setTimeout(() => setParticleTrigger(null), 500)
    }
    setPrevAnswerCorrect(isCorrect ?? null)
  }, [gameState?.status, playedRevealSound, playerId, gameState, prevStreak, triggerShake])

  // Local timer (cosmetic — synced with server ends_at)
  useEffect(() => {
    if (!gameState || gameState.status !== 'question_active') {
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }
    if (gameState.isPaused) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      const remaining = Math.max(0, gameState.pausedTimeRemainingMs || 0)
      setTimeMs(remaining)
      return
    }
    if (frozen) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }

    const currentQ = gameState.quiz.questions[gameState.currentQuestionIndex]
    const totalDuration = currentQ?.time_limit_ms ?? 20000

    let lastSec = Math.ceil((gameState.questionEndsAt - Date.now()) / 1000)
    const tick = () => {
      const remaining = gameState.questionEndsAt - Date.now()
      const currentSec = Math.ceil(remaining / 1000)
      setTimeMs(Math.max(0, remaining))
      if (currentSec !== lastSec && currentSec > 0) {
        lastSec = currentSec
        // Silence ticking sound if player already locked in their answer
        if (!me?.hasAnswered) {
          const urgency = totalDuration > 0 ? 1 - Math.max(0, remaining) / totalDuration : 0
          playCountdownTick(urgency)
        }
      }
      if (remaining <= 0 && intervalRef.current) clearInterval(intervalRef.current)
    }
    tick()
    intervalRef.current = setInterval(tick, 100)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [gameState?.status, gameState?.currentQuestionIndex, gameState?.questionEndsAt, gameState?.isPaused, gameState?.pausedTimeRemainingMs, frozen, gameState, me?.hasAnswered])

  // ── Boss Frenzy countdown timer ──
  useEffect(() => {
    if (gameState?.status !== 'boss_frenzy' || !gameState.bossFrenzy?.active) {
      if (frenzyIntervalRef.current) clearInterval(frenzyIntervalRef.current)
      return
    }
    const endsAt = gameState.bossFrenzy.endsAt
    const tick = () => {
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
      setFrenzyTimeLeft(left)
    }
    tick()
    frenzyIntervalRef.current = setInterval(tick, 500)
    return () => { if (frenzyIntervalRef.current) clearInterval(frenzyIntervalRef.current) }
  }, [gameState?.status, gameState?.bossFrenzy?.endsAt, gameState?.bossFrenzy?.active])

  // Reset frenzy answered flag on frenzy question change
  useEffect(() => {
    setFrenzyAnswered(false)
  }, [gameState?.bossFrenzy?.currentFrenzyIndex])

  // ── ELIMINATED STATE ──
  const isEliminated = gameState?.eliminatedPlayers?.includes(playerId)
  if (isEliminated && gameState?.status !== 'ended') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)', padding: 20 }}>
        <div className="card anim-scale-in" style={{ padding: '48px 36px', textAlign: 'center', maxWidth: 400 }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>💀</div>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 28, fontWeight: 900, color: 'var(--cherry)', marginBottom: 8 }}>
            You&apos;ve Been Eliminated
          </div>
          <div style={{ fontFamily: 'Inter', fontSize: 15, color: '#555', marginBottom: 8 }}>
            {gameState?.tournamentRoundLabel || 'This round'}
          </div>
          {gameState?.tournamentConfig?.parsedRules && (
            <div style={{ padding: '12px 14px', background: '#FFE4E7', border: '2px solid var(--cherry)', borderRadius: 12, fontFamily: 'Inter', fontSize: 13, textAlign: 'left', marginBottom: 20 }}>
              <strong>Tournament Rules:</strong><br/>
              {gameState.tournamentConfig.parsedRules.split('\n').slice(0,3).map((l,i) => <div key={i}>{l}</div>)}
            </div>
          )}
          <div style={{ fontFamily: 'Inter', fontSize: 13, color: '#888', marginBottom: 24 }}>
            You can still watch the game continue.
          </div>
          <a href="/quizflow">
            <button className="btn btn-primary" style={{ width: '100%' }}>← Back to Home</button>
          </a>
        </div>
      </div>
    )
  }

  const handleAnswer = useCallback((idx: number) => {
    if (!gameState || gameState.status !== 'question_active') return
    if (me?.hasAnswered) return

    if (typeof window !== 'undefined' && window.navigator?.vibrate) {
      try { window.navigator.vibrate(35) } catch {}
    }

    playLockInSound()
    // Record response time for speed badge
    const elapsed = gameState.questionStartedAt > 0 ? Date.now() - gameState.questionStartedAt : undefined
    setAnswerResponseMs(elapsed)

    if (q) {
      const isCorrect = idx === q.correct_index
      const bidMult = me?.bidMultiplier ?? 1
      const result = calculatePoints(timeMs, totalTime, isCorrect, me?.streak || 0, doubleActive || bidMult > 1)
      // Scale raw points by bid multiplier to match server-authoritative score shown in popup
      const displayPoints = bidMult > 1 && !doubleActive ? Math.min(12000, Math.round(result.points * bidMult)) : result.points
      setPopupPoints(displayPoints)
      setShowPopup(true)
    }
    submitAnswer(pin, playerId, idx, doubleActive)
  }, [gameState, me, q, timeMs, totalTime, doubleActive, pin, playerId])

  const usePowerUp = (type: PowerUpType) => {
    // Guard: power-ups only valid during active unanswered question
    if (isRevealed || hasAnswered) return
    if (usedPowers.has(type)) return
    setUsedPowers(prev => {
      const next = new Set<PowerUpType>()
      prev.forEach(p => next.add(p))
      next.add(type)
      return next
    })

    if (typeof window !== 'undefined' && window.navigator?.vibrate) {
      try { window.navigator.vibrate([25, 40, 50]) } catch {}
    }

    if (type === 'fifty_fifty' && q && q.correct_index !== undefined) {
      playPowerUpSound('5050')
      const wrong = q.choices.map((_, i) => i).filter(i => i !== q.correct_index)
      setHiddenChoices(new Set(wrong.sort(() => Math.random() - 0.5).slice(0, Math.min(2, wrong.length))))
    } else if (type === 'time_freeze') {
      playPowerUpSound('freeze')
      setFrozen(true)
      if (freezeTimerRef.current) clearTimeout(freezeTimerRef.current)
      freezeTimerRef.current = setTimeout(() => setFrozen(false), 5000)
    } else if (type === 'double_points') {
      playPowerUpSound('double')
      setDoubleActive(true)
    }
  }

  const handleToggleTTS = (text: string) => {
    playClickSound()
    const active = toggleSpeech(text)
    setIsTTSActive(active)
  }

  // answer-btn bg colors (light tints per design)
  const answerBgColors = [
    { bg: '#FFE4E7', border: 'var(--cherry)' }, // A cherry-light
    { bg: '#E0F5FF', border: 'var(--sky)' },    // B sky-light
    { bg: '#FFF8D6', border: 'var(--sun)' },    // C sun-light
    { bg: '#D6FFF4', border: 'var(--mint)' },   // D mint-light
  ]
  const answerGlyphs = ['▲', '◆', '●', '■']

  // ── LOBBY STATE ──
  if (!gameState || gameState.status === 'lobby') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)' }}>
        <div className="card anim-scale-in" style={{ padding: '48px 40px', textAlign: 'center', maxWidth: 380 }}>
          {sessionTimeout && !gameState ? (
            <>
              <div style={{ fontSize: 48, marginBottom: 16 }}>😕</div>
              <div style={{ fontFamily: 'Space Grotesk', fontSize: 22, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>Session Not Found</div>
              <div style={{ fontFamily: 'Inter', fontSize: 14, color: '#666', marginBottom: 24 }}>PIN <strong>{pin}</strong> doesn't exist or has expired.</div>
              <a href="/quizflow">
                <button className="btn btn-primary" style={{ width: '100%' }}>← Back to Quiz Select</button>
              </a>
            </>
          ) : (
            <>
              <div className="avatar-ring" style={{ width: 80, height: 80, margin: '0 auto 16px' }}>
                <img src={buildAvatarUrl(avatarSeed, avatarStyle, 80)} alt={nickname} width={80} height={80} />
              </div>
              <div style={{ fontFamily: 'Space Grotesk', fontSize: 22, fontWeight: 800, color: 'var(--ink)' }}>{nickname}</div>
              <div style={{ color: 'var(--ink)', fontSize: 14, fontFamily: 'Inter', marginTop: 8, opacity: 0.55 }}>
                {!gameState ? 'Connecting to game room…' : 'Waiting for teacher to start the game…'}
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 24 }}>
                {[0,1,2].map(i => (
                  <div key={i} style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--violet)', border: '1.5px solid var(--ink)', animation: `pulse-dot 1.2s ease-in-out ${i*0.2}s infinite` }} />
                ))}
              </div>
            </>
          )}
        </div>
        <style>{`@keyframes pulse-dot{0%,100%{transform:scale(1);opacity:0.4}50%{transform:scale(1.5);opacity:1}}`}</style>
      </div>
    )
  }

  // ── LEADERBOARD STATE ──
  if (gameState.status === 'leaderboard') {
    const sorted = activeBoard === 'mastery'
      ? Object.values(gameState.players).sort((a,b) => {
          const aAcc = a.totalAnswered ? (a.totalCorrect || 0) / a.totalAnswered : 0
          const bAcc = b.totalAnswered ? (b.totalCorrect || 0) / b.totalAnswered : 0
          return bAcc - aAcc
        })
      : Object.values(gameState.players).sort((a,b) => b.score - a.score)

    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'var(--paper)' }}>
        <div style={{ width: '100%', maxWidth: 480 }}>
          <div className="card anim-scale-in" style={{ padding: '28px 24px' }}>
            <div style={{ textAlign: 'center', fontFamily: 'Space Grotesk', fontSize: 24, fontWeight: 800, marginBottom: 4, color: 'var(--ink)' }}>
              🏆 Leaderboard
            </div>
            <div style={{ textAlign: 'center', color: 'var(--ink)', fontSize: 13, marginBottom: 16, fontFamily: 'Inter', opacity: 0.55 }}>
              Q{gameState.currentQuestionIndex + 1} of {gameState.quiz.questions.length} complete
            </div>

            {/* Dual Leaderboard Toggle Button */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 20 }}>
              <button
                onClick={() => setActiveBoard('tactics')}
                style={{
                  fontSize: 12, fontFamily: 'Space Grotesk', fontWeight: 700, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
                  background: activeBoard === 'tactics' ? 'var(--sun)' : 'var(--paper-2)',
                  color: 'var(--ink)', border: '1.5px solid var(--ink)',
                  boxShadow: activeBoard === 'tactics' ? '2px 2px 0 var(--ink)' : 'none'
                }}
              >
                ⚡ Tactics Board
              </button>
              <button
                onClick={() => setActiveBoard('mastery')}
                style={{
                  fontSize: 12, fontFamily: 'Space Grotesk', fontWeight: 700, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
                  background: activeBoard === 'mastery' ? 'var(--mint)' : 'var(--paper-2)',
                  color: 'var(--ink)', border: '1.5px solid var(--ink)',
                  boxShadow: activeBoard === 'mastery' ? '2px 2px 0 var(--ink)' : 'none'
                }}
              >
                🎯 Mastery Board
              </button>
            </div>

            {sorted.slice(0, 8).map((p, i) => {
              const pAcc = p.totalAnswered ? Math.round(((p.totalCorrect || 0) / p.totalAnswered) * 100) : 0
              return (
                <div key={p.id} className="lb-row" style={{
                  padding: '10px 14px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12,
                  background: p.id === playerId ? 'var(--violet)' : undefined,
                }}>
                  <div style={{ fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 18, minWidth: 28, color: i === 0 ? 'var(--sun)' : i === 1 ? '#94A3B8' : i === 2 ? '#B47C3C' : 'var(--ink)' }}>
                    {i === 0 ? '👑' : `#${i+1}`}
                  </div>
                  <div className="avatar-ring" style={{ width: 36, height: 36 }}>
                    <img src={buildAvatarUrl(p.avatarSeed, p.avatarStyle as any, 36)} alt="" width={36} height={36} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: 'Space Grotesk', fontSize: 14, fontWeight: 700, color: p.id === playerId ? 'var(--paper)' : 'var(--ink)' }}>{p.nickname}{p.id === playerId && ' (You)'}</div>
                  </div>
                  <div style={{ fontFamily: 'Space Grotesk', fontSize: 15, fontWeight: 800, color: p.id === playerId ? 'var(--sun)' : 'var(--ink)' }}>
                    {activeBoard === 'mastery' ? `${pAcc}% Acc` : p.score.toLocaleString()}
                  </div>
                  {p.lastAnswerCorrect !== null && (
                    <span style={{ fontSize: 16 }}>{p.lastAnswerCorrect ? '✅' : '❌'}</span>
                  )}
                </div>
              )
            })}
            <div style={{ textAlign: 'center', color: 'var(--ink)', fontSize: 12, marginTop: 12, fontFamily: 'Inter', opacity: 0.5 }}>
              Next question loading…
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── BOSS FRENZY STATE ──
  if (gameState.status === 'boss_frenzy' && gameState.bossFrenzy) {
    const frenzy = gameState.bossFrenzy
    const frenzyQIdx = frenzy.questionIndices[frenzy.currentFrenzyIndex] ?? 0
    const frenzyQ = gameState.quiz.questions[frenzyQIdx]
    const frenzyColors = ['#FFE4E7', '#E0F5FF', '#FFF8D6', '#D6FFF4']
    const frenzyBorders = ['var(--cherry)', 'var(--sky)', 'var(--sun)', 'var(--mint)']
    const myFrenzyScore = frenzy.frenzyScores[playerId] ?? 0
    const isMeFrozen = me?.frozenUntil ? me.frozenUntil > Date.now() : false

    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#0A0A0B', color: '#fff', position: 'relative', overflow: 'hidden' }}>
        {/* Animated red glow background */}
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 20%, rgba(220,38,38,0.25) 0%, transparent 70%)', pointerEvents: 'none' }} />

        {/* Top bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', background: 'rgba(0,0,0,0.4)', borderBottom: '2px solid rgba(220,38,38,0.4)' }}>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 14, fontWeight: 800, color: '#FF4444' }}>💥 BOSS FRENZY</div>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 28, fontWeight: 900, color: frenzyTimeLeft <= 10 ? '#FF4444' : '#fff', animation: frenzyTimeLeft <= 10 ? 'pulse-dot 0.6s infinite' : 'none' }}>
            {frenzyTimeLeft}s
          </div>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 14, fontWeight: 700, color: '#FFD700' }}>
            ✅ {myFrenzyScore} correct
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ height: 6, background: 'rgba(255,255,255,0.1)' }}>
          <div style={{ height: '100%', background: 'linear-gradient(90deg, #FF4444, #FF8C00)', width: `${(frenzyTimeLeft / 60) * 100}%`, transition: 'width 0.5s linear' }} />
        </div>

        {/* Question counter */}
        <div style={{ textAlign: 'center', padding: '8px 0', fontFamily: 'Space Grotesk', fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.5)', letterSpacing: 2 }}>
          QUESTION {frenzy.currentFrenzyIndex + 1} / {frenzy.questionIndices.length}
        </div>

        {/* Question text */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '20px 20px 0' }}>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 'clamp(18px, 4vw, 26px)', fontWeight: 800, textAlign: 'center', marginBottom: 24, lineHeight: 1.3, color: '#fff', textShadow: '0 0 20px rgba(255,68,68,0.4)' }}>
            {frenzyQ?.prompt ?? 'Loading…'}
          </div>

          {/* Frozen overlay for frenzy */}
          {isMeFrozen && (
            <div style={{ textAlign: 'center', padding: '16px', background: 'rgba(100,200,255,0.1)', border: '2px solid #60CFFF', borderRadius: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 32, marginBottom: 4 }}>❄️</div>
              <div style={{ fontFamily: 'Space Grotesk', fontSize: 16, fontWeight: 800, color: '#60CFFF' }}>FROZEN!</div>
            </div>
          )}

          {/* Answer buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {(frenzyQ?.choices ?? []).map((choice, idx) => (
              <button
                key={idx}
                disabled={frenzyAnswered || isMeFrozen}
                onClick={() => {
                  if (frenzyAnswered || isMeFrozen) return
                  setFrenzyAnswered(true)
                  playLockInSound()
                  submitFrenzyAnswer(pin, playerId, idx)
                }}
                style={{
                  padding: '14px 12px',
                  background: frenzyColors[idx % 4],
                  color: '#111',
                  border: `2px solid ${frenzyBorders[idx % 4]}`,
                  borderRadius: 12,
                  fontFamily: 'Space Grotesk',
                  fontSize: 'clamp(13px, 2.5vw, 16px)',
                  fontWeight: 700,
                  cursor: frenzyAnswered || isMeFrozen ? 'not-allowed' : 'pointer',
                  opacity: frenzyAnswered ? 0.5 : 1,
                  transition: 'transform 0.1s',
                  boxShadow: '0 2px 0 rgba(0,0,0,0.3)'
                }}
              >
                {choice}
              </button>
            ))}
          </div>
        </div>

        {/* Frenzy scores sidebar */}
        <div style={{ padding: '12px 20px 24px', background: 'rgba(0,0,0,0.4)', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: 2, marginBottom: 8 }}>FRENZY SCORES</div>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
            {Object.entries(frenzy.frenzyScores)
              .sort(([,a],[,b]) => (b as number) - (a as number))
              .slice(0, 5)
              .map(([pid, score]) => {
                const p = gameState.players[pid]
                return p ? (
                  <div key={pid} style={{ textAlign: 'center', minWidth: 60, padding: '6px 8px', background: pid === playerId ? 'rgba(255,215,0,0.2)' : 'rgba(255,255,255,0.05)', borderRadius: 8, border: pid === playerId ? '1px solid gold' : '1px solid rgba(255,255,255,0.1)' }}>
                    <div style={{ fontFamily: 'Space Grotesk', fontSize: 16, fontWeight: 900, color: '#FFD700' }}>{score as number}</div>
                    <div style={{ fontFamily: 'Inter', fontSize: 10, color: 'rgba(255,255,255,0.6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 56 }}>{p.nickname}</div>
                  </div>
                ) : null
              })}
          </div>
        </div>
      </div>
    )
  }

  // ── QUESTION ACTIVE or REVEAL STATE ──
  const hasAnswered = me?.hasAnswered ?? false
  const isRevealed  = gameState.status === 'question_reveal'
  const myCorrect   = me?.lastAnswerCorrect
  const streakCount = me?.streak ?? 0

  return (
    <div
      className={`page-wrapper ${frozen ? 'frosted-freeze-container' : ''}`}
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--paper)', position: 'relative', ...shakeStyle }}
    >
      {/* 3D Particle Field background */}
      <ParticleField trigger={particleTrigger} active />

      {/* Damage particles (boss raid wrong answers) */}
      {showDamageParticles && (
        <DamageParticles count={14} color="damage" onDone={() => setShowDamageParticles(false)} />
      )}

      {/* Streak / Speed / Perfect badges */}
      <StreakBadge
        streak={streakCount}
        lastPointsEarned={me?.lastPointsEarned ?? 0}
        lastAnswerCorrect={me?.lastAnswerCorrect ?? null}
        responseMs={answerResponseMs}
        totalCorrect={me?.totalCorrect}
        totalAnswered={me?.totalAnswered}
      />

      {showPopup && <ScorePopup points={popupPoints} onDone={() => setShowPopup(false)} />}

      {/* FULLSCREEN PROMPT — shown when not fullscreen during active question and fullscreen is supported by browser */}
      {!fullscreenActive && fullscreenSupported && (gameState.status === 'question_active' || gameState.status === 'question_reveal') && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(10,10,11,0.92)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(8px)',
          pointerEvents: 'all',  // Block ALL touch/click events from reaching answer buttons underneath
          touchAction: 'none'
        }}>
          <div className="card anim-scale-in" style={{ maxWidth: 380, padding: '36px 28px', textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>⛶</div>
            <h3 style={{ fontFamily: 'Space Grotesk', fontSize: 22, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>Fullscreen Required</h3>
            <p style={{ fontFamily: 'Inter', fontSize: 14, color: '#666', marginBottom: 20, lineHeight: 1.5 }}>
              This quiz must be played in fullscreen to prevent cheating. Your quiz session is paused until you enter fullscreen.
            </p>
            <button
              onClick={() => enterFullscreen()}
              className="btn btn-primary"
              style={{ width: '100%', fontSize: 16, padding: '14px 20px' }}
            >
              Enter Fullscreen 🚀
            </button>
          </div>
        </div>
      )}

      {/* COIN SHOP MODAL DRAWER — STADIUM POP REDESIGN */}
      {showCoinShop && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 110,
          background: 'rgba(16, 16, 15, 0.75)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          backdropFilter: 'blur(6px)'
        }} onClick={() => setShowCoinShop(false)}>
          <div
            className="anim-scale-in"
            style={{
              width: '100%', maxWidth: 520, background: 'var(--paper)',
              borderRadius: '24px 24px 0 0', padding: '24px 20px 32px',
              border: '3px solid var(--ink)', borderBottom: 'none',
              boxShadow: '0 -6px 0 rgba(16,16,15,0.2)',
              maxHeight: '85vh', overflowY: 'auto'
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 24 }}>🛒</span>
                <span style={{ fontFamily: 'Space Grotesk', fontSize: 22, fontWeight: 900, color: 'var(--ink)' }}>STADIUM SHOP</span>
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'var(--sun)', border: '2px solid var(--ink)',
                borderRadius: 'var(--radius-pill)', padding: '4px 12px',
                boxShadow: '2px 2px 0 var(--ink)'
              }}>
                <span style={{ fontSize: 16 }}>🪙</span>
                <span style={{ fontFamily: 'Space Grotesk', fontSize: 16, fontWeight: 900, color: 'var(--ink)' }}>{me?.coins ?? 0}</span>
                <span style={{ fontSize: 10, fontWeight: 800, opacity: 0.75 }}>COINS</span>
              </div>
              <button
                onClick={() => setShowCoinShop(false)}
                style={{
                  background: 'var(--paper-2)', border: '2px solid var(--ink)',
                  borderRadius: '50%', width: 34, height: 34,
                  fontSize: 16, fontWeight: 800, cursor: 'pointer',
                  color: 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '2px 2px 0 var(--ink)'
                }}
              >✕</button>
            </div>

            {/* Boss Frenzy Lockout Notification */}
            {gameState?.status === 'boss_frenzy' ? (
              <div style={{
                padding: '20px 16px', background: '#FFE4E7',
                border: '2px solid var(--cherry)', borderRadius: 14,
                textAlign: 'center', marginBottom: 16
              }}>
                <div style={{ fontSize: 32, marginBottom: 6 }}>🔒</div>
                <div style={{ fontFamily: 'Space Grotesk', fontWeight: 900, fontSize: 16, color: 'var(--cherry)' }}>
                  BOSS FRENZY FINALE ACTIVE!
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginTop: 4 }}>
                  The power-up shop is disabled during the final rapid-fire round. Focus on speed & accuracy!
                </div>
              </div>
            ) : (
              <>
                {/* Active Bid Banner if armed */}
                {me?.bidMultiplier && me.bidMultiplier > 1 && (
                  <div style={{
                    padding: '10px 14px', background: '#FFE57F',
                    border: '2px solid var(--ink)', borderRadius: 12,
                    marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8,
                    boxShadow: '2px 2px 0 var(--ink)'
                  }}>
                    <span style={{ fontSize: 20 }}>⚡</span>
                    <div style={{ fontSize: 12, fontFamily: 'Space Grotesk', fontWeight: 800, color: 'var(--ink)' }}>
                      {me.bidMultiplier}× MULTIPLIER ARMED FOR YOUR NEXT QUESTION!
                    </div>
                  </div>
                )}

                {/* Items List */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {SHOP_ITEMS.map(item => {
                    const canAfford = (me?.coins ?? 0) >= item.cost
                    const isBid = item.type.startsWith('bid_')
                    const isItemActive = isBid && me?.bidMultiplier && (
                      (item.type === 'bid_2x' && me.bidMultiplier === 2) ||
                      (item.type === 'bid_3x' && me.bidMultiplier === 3) ||
                      (item.type === 'bid_4x' && me.bidMultiplier === 4)
                    )

                    return (
                      <div key={item.type} style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '12px 14px',
                        background: isItemActive ? '#FFFDE7' : canAfford ? 'var(--paper-2)' : '#F5F5F0',
                        border: isItemActive ? '2.5px solid #FFD700' : '2px solid var(--ink)',
                        borderRadius: 14,
                        boxShadow: isItemActive ? '3px 3px 0 #DAA520' : canAfford ? '3px 3px 0 var(--ink)' : 'none',
                        opacity: canAfford || isItemActive ? 1 : 0.55
                      }}>
                        <div style={{
                          width: 44, height: 44, borderRadius: 10,
                          background: isItemActive ? '#FFE57F' : 'var(--paper)',
                          border: '2px solid var(--ink)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 24, flexShrink: 0
                        }}>
                          {item.emoji}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: 'Space Grotesk', fontSize: 14, fontWeight: 800, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>{item.label}</span>
                            {isItemActive && <span className="badge badge-sun" style={{ fontSize: 9, padding: '1px 6px' }}>ACTIVE</span>}
                          </div>
                          <div style={{ fontFamily: 'Inter', fontSize: 11, color: 'var(--ink)', opacity: 0.75, lineHeight: 1.3, marginTop: 2 }}>
                            {item.description}
                          </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                          <div style={{
                            fontFamily: 'Space Grotesk', fontSize: 13, fontWeight: 900,
                            color: canAfford ? '#B8860B' : '#999', display: 'flex', alignItems: 'center', gap: 3
                          }}>
                            <span>🪙</span>
                            <span>{item.cost}</span>
                          </div>
                          {item.requiresTarget && canAfford && (
                            <select
                              style={{
                                fontSize: 11, border: '1.5px solid var(--ink)', borderRadius: 6,
                                padding: '3px 6px', maxWidth: 96, fontFamily: 'Space Grotesk', fontWeight: 700,
                                background: '#fff', color: 'var(--ink)'
                              }}
                              onChange={e => setShopTarget(e.target.value)}
                              defaultValue=""
                            >
                              <option value="" disabled>Pick Target</option>
                              {Object.values(gameState?.players || {})
                                .filter(p => p.id !== playerId)
                                .map(p => <option key={p.id} value={p.id}>{p.nickname}</option>)
                              }
                            </select>
                          )}
                          <button
                            disabled={!canAfford || !!isItemActive}
                            onClick={() => {
                              const target = item.requiresTarget ? shopTarget ?? undefined : undefined
                              if (item.requiresTarget && !target) {
                                alert('Please select a player to freeze first!')
                                return
                              }
                              const ok = buyPowerUp(pin, playerId, item.type as CoinPowerUpType, target)
                              if (ok) {
                                playPowerUpSound('double')
                                setShowCoinShop(false)
                              }
                            }}
                            style={{
                              padding: '6px 14px', fontFamily: 'Space Grotesk', fontSize: 12, fontWeight: 900,
                              background: isItemActive ? 'var(--mint)' : canAfford ? 'var(--sun)' : '#ccc',
                              color: 'var(--ink)',
                              border: '2px solid var(--ink)', borderRadius: 'var(--radius-btn)',
                              cursor: canAfford && !isItemActive ? 'pointer' : 'not-allowed',
                              boxShadow: canAfford && !isItemActive ? '2px 2px 0 var(--ink)' : 'none',
                              textTransform: 'uppercase'
                            }}
                          >
                            {isItemActive ? '✓ Armed' : 'Buy'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* SERVER-FROZEN OVERLAY — another player froze you via coin shop */}
      {me?.frozenUntil && me.frozenUntil > Date.now() && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 120,
          background: 'rgba(100,200,255,0.15)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(6px) brightness(0.8)',
          pointerEvents: 'all'
        }}>
          <div style={{ fontSize: 72, marginBottom: 8, animation: 'pulse-dot 1s infinite' }}>❄️</div>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 28, fontWeight: 900, color: '#60CFFF' }}>FROZEN!</div>
          <div style={{ fontFamily: 'Inter', fontSize: 15, color: '#aaa', marginTop: 8 }}>Someone used a power-up on you!</div>
        </div>
      )}

      {/* FOCUS SHIELD WARNING POPUP MODAL */}
      {showWarning && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 100,
          background: 'rgba(16, 16, 15, 0.65)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
          backdropFilter: 'blur(4px)'
        }}>
          <div className="card anim-scale-in" style={{
            maxWidth: 420,
            width: '100%',
            padding: '28px 24px',
            textAlign: 'center',
            background: 'var(--paper)',
            borderColor: 'var(--ink)',
            boxShadow: 'var(--shadow-hard-lg)'
          }}>
            <div style={{ fontSize: 44, marginBottom: 12 }}>🛡️</div>
            <h3 style={{ fontFamily: 'Space Grotesk', fontSize: 22, fontWeight: 800, color: 'var(--cherry)', marginBottom: 8 }}>
              FOCUS SHIELD WARNING
            </h3>
            <p style={{ fontFamily: 'Inter', fontSize: 14, color: 'var(--ink)', opacity: 0.8, marginBottom: 16, lineHeight: 1.45 }}>
              {lastReason === 'copy_paste_attempt'
                ? 'Copying and pasting is disabled during live quiz sessions to maintain academic integrity.'
                : 'Tab switch or window focus loss detected! Please keep your screen active and stay focused on the quiz.'}
            </p>
            <div style={{
              background: '#FFE4E7',
              border: '1.5px solid var(--cherry)',
              borderRadius: 10,
              padding: '10px 14px',
              marginBottom: 20,
              fontFamily: 'Space Grotesk',
              fontWeight: 700,
              fontSize: 13,
              color: 'var(--ink)'
            }}>
              ⚠️ Total Focus Losses / Violations: <span style={{ color: 'var(--cherry)', fontSize: 16 }}>{violationCount}</span>
            </div>
            <button
              onClick={() => {
                playClickSound()
                dismissWarning()
              }}
              style={{
                width: '100%',
                padding: '12px 20px',
                background: 'var(--sun)',
                color: 'var(--ink)',
                border: 'var(--line)',
                borderRadius: 'var(--radius-btn)',
                boxShadow: 'var(--shadow-hard)',
                fontFamily: 'Space Grotesk',
                fontWeight: 800,
                fontSize: 15,
                cursor: 'pointer'
              }}
            >
              I Understand & Resume Quiz 🎯
            </button>
          </div>
        </div>
      )}

      {/* 3x+ Streak Floating Flame Particles on screen sides */}
      {streakCount >= 3 && (
        <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 40 }}>
          <div className="streak-flame streak-flame-left" style={{ top: '25%' }}>🔥</div>
          <div className="streak-flame streak-flame-left" style={{ top: '50%', animationDelay: '0.4s' }}>🔥</div>
          <div className="streak-flame streak-flame-left" style={{ top: '75%', animationDelay: '0.8s' }}>🔥</div>
          <div className="streak-flame streak-flame-right" style={{ top: '25%', animationDelay: '0.2s' }}>🔥</div>
          <div className="streak-flame streak-flame-right" style={{ top: '50%', animationDelay: '0.6s' }}>🔥</div>
          <div className="streak-flame streak-flame-right" style={{ top: '75%', animationDelay: '1s' }}>🔥</div>
        </div>
      )}

      {/* Time Freeze Falling Snowflake Particles */}
      {frozen && (
        <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 45, overflow: 'hidden' }}>
          {[10, 25, 40, 58, 72, 88].map((leftPct, i) => (
            <div
              key={i}
              className="snowflake"
              style={{
                left: `${leftPct}%`,
                animationDelay: `${i * 0.5}s`,
                animationDuration: `${3 + (i % 3)}s`
              }}
            >
              ❄
            </div>
          ))}
        </div>
      )}

      {/* Frozen banner */}
      {frozen && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, background: 'var(--sky)', border: 'none', borderBottom: 'var(--line)', padding: '10px 20px', textAlign: 'center', fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 15, color: 'var(--ink)', pointerEvents: 'none' }}>
          ⏳ Time Frozen for 5s!
        </div>
      )}

      {/* TOP HUD BAR */}
      <div className="top-bar anim-fade-up" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', gap: 12 }}>
        {/* Rank + avatar + anti-cheat focus badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="avatar-ring" style={{ width: 40, height: 40 }}>
            <img src={buildAvatarUrl(avatarSeed, avatarStyle, 40)} alt="" width={40} height={40} />
          </div>
          <div>
            <div style={{ fontFamily: 'Space Grotesk', fontSize: 10, color: 'var(--paper)', lineHeight: 1, opacity: 0.7, textTransform: 'uppercase' }}>RANK</div>
            <div style={{ fontFamily: 'Space Grotesk', fontSize: 16, fontWeight: 800, color: 'var(--sun)', lineHeight: 1.2 }}>
              #{me?.rank || '?'} <span style={{ color: 'var(--paper)', fontSize: 11, fontWeight: 500, opacity: 0.7 }}>/ {Object.keys(gameState.players).length}</span>
            </div>
          </div>
          {/* Anti-cheat shield badge */}
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 8px',
            background: violationCount > 0 ? '#FFE4E7' : '#D6FFF4',
            border: '1.5px solid var(--ink)',
            borderRadius: 'var(--radius-pill)',
            boxShadow: '1.5px 1.5px 0px var(--ink)',
            fontFamily: 'Space Grotesk',
            fontSize: 10,
            fontWeight: 800,
            color: 'var(--ink)',
            marginLeft: 6
          }}>
            <span>{violationCount > 0 ? '⚠️' : '🛡️'}</span>
            <span>{violationCount > 0 ? `${violationCount} Violations` : 'Shield Active'}</span>
          </div>
        </div>

        {/* Timer countdown in center */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="play-timer-digit" style={{
            fontFamily: 'Space Grotesk', fontSize: 44, fontWeight: 900, lineHeight: 1,
            color: timePct > 0.5 ? 'var(--mint)' : timePct > 0.25 ? 'var(--sun)' : 'var(--cherry)',
            transition: 'color 0.5s',
            animation: seconds <= 5 && seconds > 0 ? 'jitter 0.1s infinite' : 'none'
          }}>
            {isRevealed ? '—' : seconds}
          </div>
          {frozen && <div style={{ fontSize: 10, color: 'var(--sky)', fontFamily: 'Space Grotesk', fontWeight: 700, textTransform: 'uppercase' }}>FROZEN</div>}
        </div>

        {/* Score + streak + bid indicator + coin shop button */}
        <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 10, color: 'var(--paper)', lineHeight: 1, opacity: 0.7, textTransform: 'uppercase' }}>SCORE</div>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 16, fontWeight: 800, color: 'var(--mint)' }}>⚡ {(me?.score ?? 0).toLocaleString()}</div>
          {/* Coin balance + shop button */}
          <button
            onClick={() => {
              if (gameState?.status === 'boss_frenzy') return
              playClickSound()
              setShowCoinShop(true)
            }}
            disabled={gameState?.status === 'boss_frenzy'}
            style={{
              marginTop: 4, display: 'flex', alignItems: 'center', gap: 5,
              background: gameState?.status === 'boss_frenzy' ? 'rgba(255,255,255,0.1)' : 'var(--sun)',
              border: '2px solid var(--ink)',
              borderRadius: 20, padding: '4px 10px',
              cursor: gameState?.status === 'boss_frenzy' ? 'not-allowed' : 'pointer',
              fontFamily: 'Space Grotesk', fontSize: 12, fontWeight: 900,
              color: 'var(--ink)',
              boxShadow: gameState?.status === 'boss_frenzy' ? 'none' : '2px 2px 0 var(--ink)',
              opacity: gameState?.status === 'boss_frenzy' ? 0.6 : 1
            }}
            title={gameState?.status === 'boss_frenzy' ? 'Shop disabled during Boss Frenzy' : 'Open Coin Shop'}
          >
            <span>{gameState?.status === 'boss_frenzy' ? '🔒' : '🪙'}</span>
            <span>{me?.coins ?? 0}</span>
            <span style={{ fontSize: 10, opacity: 0.8 }}>{gameState?.status === 'boss_frenzy' ? 'FRENZY' : 'SHOP'}</span>
          </button>
          {me?.bidMultiplier && me.bidMultiplier > 1 && (
            <div className="badge badge-sun anim-stamp-in" style={{
              marginTop: 4, fontSize: 10, padding: '3px 8px',
              background: '#FFD700', color: 'var(--ink)', border: '2px solid var(--ink)',
              boxShadow: '2px 2px 0 var(--ink)', fontFamily: 'Space Grotesk', fontWeight: 900
            }}>
              {me.bidMultiplier === 4 ? '💥 4× BID ARMED' : me.bidMultiplier === 3 ? '🔥 3× BID ARMED' : '⚡ 2× BID ARMED'} 🎯
            </div>
          )}
          {streakCount >= 5 ? (
            <div className="badge badge-sun anim-stamp-in" style={{ marginTop: 4, fontSize: 10, padding: '2px 8px', background: 'var(--sun)', color: 'var(--ink)', border: '1.5px solid var(--ink)' }}>
              SUPERCHARGED! ⚡
            </div>
          ) : streakCount > 1 ? (
            <div className="streak-badge" style={{ marginTop: 4, fontSize: 11, padding: '2px 8px' }}>🔥 {streakCount}x</div>
          ) : null}
        </div>
      </div>


      {/* BOSS RAID HEALTH BAR IN HUD (When gameMode === 'boss_raid') */}
      {gameState.gameMode === 'boss_raid' && (
        <div className="anim-fade-up" style={{
          background: 'var(--paper-2)',
          borderBottom: 'var(--line)',
          padding: '8px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          boxShadow: '0 2px 0 var(--ink)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 13, color: 'var(--ink)' }}>
            <span style={{ fontSize: 18 }}>🐉</span>
            <span>BOSS HP:</span>
            {(gameState.bossHealth ?? 100) === 0 && <span className="badge badge-mint" style={{ fontSize: 10 }}>DEFEATED! 🎉</span>}
          </div>
          <div style={{ flex: 1, maxWidth: 350 }}>
            <BossHealthBar
              health={gameState.bossHealth ?? 100}
              maxHealth={gameState.bossMaxHealth ?? 100}
              isFlashing={showDamageParticles}
            />
          </div>
        </div>
      )}

      {/* Timer bar */}
      <div style={{ padding: '0', position: 'relative' }}>
        <div className="timer-bar" style={{ borderRadius: 0, border: 'none', borderBottom: 'var(--line)', height: 8 }}>
          <div className="timer-bar-fill" style={{
            width: `${(isRevealed ? 0 : timePct) * 100}%`,
            background: timePct > 0.5 ? 'var(--mint)' : timePct > 0.25 ? 'var(--sun)' : 'var(--cherry)',
            transition: 'width 0.1s linear, background 0.5s'
          }} />
        </div>
      </div>

      <div className="play-content-area" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Question Card with Mobile Anti-Selection Shield & Hero Typography */}
        {q && (
          <div
            className={`card anim-scale-in ${doubleActive ? 'star-aura' : ''}`}
            onContextMenu={e => e.preventDefault()}
            style={{
              padding: '24px 22px', background: 'var(--surface-1)',
              userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
              <h2 style={{
                fontFamily: 'Space Grotesk', fontSize: 'clamp(20px, 3.6vw, 30px)',
                fontWeight: 800, lineHeight: 1.3, flex: 1, color: 'var(--ink)', margin: 0,
                userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none'
              }}>
                {q.prompt}
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {doubleActive && <span className="badge badge-sun">⭐ 2× DOUBLE</span>}
                {ENABLE_TTS_AUDIO && (
                  <button
                    type="button"
                    onClick={() => handleToggleTTS(q.prompt)}
                    style={{
                      padding: '8px 14px',
                      background: isTTSActive ? 'var(--sun)' : 'var(--paper)',
                      border: '2px solid var(--ink)',
                      borderRadius: 'var(--radius-btn)',
                      boxShadow: '2px 2px 0px var(--ink)',
                      fontFamily: 'Space Grotesk',
                      fontSize: 12,
                      fontWeight: 800,
                      color: 'var(--ink)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6
                    }}
                    title="Read question prompt aloud"
                    aria-label="Read question aloud"
                  >
                    <span>{isTTSActive ? '🔊' : '🔈'}</span>
                    <span>{isTTSActive ? 'Stop' : 'Listen'}</span>
                  </button>
                )}
              </div>
            </div>
            {(q.imageUrl || q.media_url) && (
              <div style={{ marginTop: 14, textAlign: 'center' }}>
                <img
                  src={q.imageUrl || q.media_url}
                  alt="Question Diagram"
                  style={{
                    maxHeight: 200,
                    maxWidth: '100%',
                    objectFit: 'contain',
                    borderRadius: 12,
                    border: '3px solid var(--ink)',
                    boxShadow: '3px 3px 0 var(--ink)',
                    margin: '0 auto',
                    background: 'var(--paper)'
                  }}
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.display = 'none'
                  }}
                />
              </div>
            )}
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--ink)', fontFamily: 'Space Grotesk', opacity: 0.6, fontWeight: 700 }}>
              QUESTION {gameState.currentQuestionIndex + 1} OF {gameState.quiz.questions.length}
            </div>
          </div>
        )}

        {/* Answer Grid (2×2 on Desktop, 1-Column Stacked on Mobile) with Mobile Shield */}
        {q && (
          <div
            className="quiz-answer-grid"
            onContextMenu={e => e.preventDefault()}
            style={{
              flex: 1,
              userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none'
            }}
          >
            {q.choices.map((choice, idx) => {
              const colors   = answerBgColors[idx]
              const isHidden = hiddenChoices.has(idx)
              const isCorrect = idx === q.correct_index
              const myPick    = me?.selectedIndex === idx

              let bg = colors.bg
              let borderColor = colors.border
              if (isRevealed) {
                if (isCorrect) { bg = 'var(--mint)'; borderColor = 'var(--ink)' }
                else if (myPick) { bg = 'var(--cherry)'; borderColor = 'var(--ink)' }
              }

              const btnClasses = [
                'answer-btn',
                doubleActive ? 'star-aura' : '',
                isHidden ? 'choice-dissolved' : '',
                myPick ? 'is-locked' : '',
                hasAnswered && !myPick && !isCorrect ? 'is-dimmed' : ''
              ].filter(Boolean).join(' ')

              return (
                <button
                  key={idx}
                  className={btnClasses}
                  onClick={() => handleAnswer(idx)}
                  disabled={hasAnswered || isRevealed || isHidden}
                  onContextMenu={e => e.preventDefault()}
                  style={{
                    position: 'relative',
                    minHeight: 88,
                    background: bg,
                    borderColor,
                    display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
                    userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
                    ...(myPick ? { transform: 'translate(3px, 3px)', boxShadow: '1px 1px 0 var(--ink)' } : {}),
                    ...(hasAnswered && !myPick && !isCorrect ? { opacity: 0.35 } : {})
                  }}
                >
                  {/* Floating LOCKED IN badge */}
                  {myPick && (
                    <span
                      className="badge badge-ink anim-scale-in"
                      style={{
                        position: 'absolute',
                        top: -12,
                        right: 12,
                        zIndex: 10,
                        boxShadow: '2px 2px 0 var(--ink)',
                        padding: '3px 9px',
                        fontSize: 11,
                        fontWeight: 800,
                        background: 'var(--ink)',
                        color: 'var(--paper)'
                      }}
                    >
                      LOCKED IN 🔒
                    </span>
                  )}
                  <div className="answer-glyph" style={{ color: borderColor, flexShrink: 0, fontSize: 18, fontWeight: 900 }}>{answerGlyphs[idx]}</div>
                  <span style={{ fontSize: 14, lineHeight: 1.35, textAlign: 'left', color: 'var(--ink)', fontFamily: 'Inter', fontWeight: 600, flex: 1, userSelect: 'none', WebkitUserSelect: 'none' }}>{choice}</span>
                  {isRevealed && isCorrect && <span style={{ marginLeft: 'auto', fontSize: 20, fontWeight: 800 }}>✓</span>}
                </button>
              )
            })}
          </div>
        )}

        {/* Waiting overlay: answer locked */}
        {hasAnswered && !isRevealed && (
          <div className="card anim-scale-in" style={{ padding: '16px 18px', textAlign: 'center', background: 'var(--mint)', borderColor: 'var(--ink)' }}>
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 16, color: 'var(--ink)' }}>
              ✅ Answer locked! Waiting for others…
            </div>
            <div style={{ color: 'var(--ink)', fontSize: 12, marginTop: 4, fontFamily: 'Inter', opacity: 0.65 }}>
              {Object.values(gameState.players).filter(p => p.hasAnswered).length} / {Object.keys(gameState.players).length} answered
            </div>
          </div>
        )}

        {/* Reveal feedback & Diagnostic Explanation TTS */}
        {isRevealed && me && (
          <div className={`card anim-scale-in ${streakCount >= 5 && myCorrect ? 'anim-shake' : ''}`} style={{
            padding: '18px 20px',
            background: myCorrect ? 'var(--mint)' : 'var(--cherry)',
            textAlign: 'center'
          }}>
            {myCorrect ? (
              <div>
                <div style={{ fontFamily: 'Space Grotesk', fontWeight: 900, fontSize: 20, color: 'var(--ink)' }}>
                  ✅ Correct! +{(me.lastPointsEarned ?? 0).toLocaleString()} pts
                </div>
                {me.lastPointsEarned > 1000 && (
                  <div style={{ fontSize: 12, fontFamily: 'Space Grotesk', fontWeight: 800, color: 'var(--ink)', opacity: 0.8, marginTop: 4 }}>
                    ⚡ Speed & Streak Multiplier Applied!
                  </div>
                )}
              </div>
            ) : me.selectedIndex !== null ? (
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 16, color: 'var(--paper)' }}>
                ❌ Wrong! The answer was: <span style={{ color: 'var(--sun)' }}>{q?.choices[q.correct_index]}</span>
              </div>
            ) : (
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 16, color: 'var(--paper)' }}>
                ⏰ Time&apos;s up! The answer was: <span style={{ color: 'var(--sun)' }}>{q?.choices[q?.correct_index ?? 0]}</span>
              </div>
            )}
            {q?.explanation && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div style={{ color: 'var(--ink)', fontSize: 13, fontFamily: 'Inter', opacity: 0.85, fontWeight: 500 }}>
                  💡 {q.explanation}
                </div>
                {ENABLE_TTS_AUDIO && (
                  <button
                    type="button"
                    onClick={() => handleToggleTTS(q.explanation || '')}
                    style={{
                      padding: '4px 12px',
                      background: 'var(--paper)',
                      border: '1.5px solid var(--ink)',
                      borderRadius: 'var(--radius-pill)',
                      boxShadow: '2px 2px 0px var(--ink)',
                      fontFamily: 'Space Grotesk',
                      fontSize: 11,
                      fontWeight: 800,
                      color: 'var(--ink)',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      marginTop: 4
                    }}
                  >
                    <span>🔊</span> Read Explanation
                  </button>
                )}
              </div>
            )}

            {/* Targeted Diagnostic Misconception Analysis */}
            {!myCorrect && me.selectedIndex !== null && (
              <div className="anim-scale-in" style={{
                marginTop: 12,
                padding: '12px 14px',
                background: 'var(--paper)',
                border: '2px solid var(--ink)',
                borderRadius: 12,
                boxShadow: '3px 3px 0 var(--ink)',
                textAlign: 'left',
                color: 'var(--ink)'
              }}>
                <div style={{
                  fontFamily: 'Space Grotesk',
                  fontWeight: 800,
                  fontSize: 12,
                  color: 'var(--cherry)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em'
                }}>
                  <span>🔍 Diagnostic Misconception Analysis</span>
                </div>
                <div style={{ fontFamily: 'Inter', fontSize: 13, fontWeight: 600, color: 'var(--ink)', lineHeight: 1.45 }}>
                  {q?.misconceptions?.[me.selectedIndex] || `Choosing "${q?.choices[me.selectedIndex]}" reflects a common misconception confusing it with ${q?.choices[q.correct_index]}.`}
                </div>
              </div>
            )}

            <div style={{ color: 'var(--ink)', fontSize: 11, marginTop: 10, fontFamily: 'Inter', opacity: 0.55 }}>Waiting for next question…</div>
          </div>
        )}

        {/* Bottom: Avatar + Power-up tray */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="avatar-ring" style={{ width: 48, height: 48 }}>
              <img src={buildAvatarUrl(avatarSeed, avatarStyle, 48)} alt={nickname} width={48} height={48} />
            </div>
            <span style={{ fontFamily: 'Space Grotesk', fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{nickname}</span>
          </div>
          {/* Power-up tray */}
          <div style={{ display: 'flex', gap: 8 }}>
            {POWER_UPS.map(p => (
              <button
                key={p.type}
                className={`powerup-btn ${usedPowers.has(p.type) ? 'used' : ''}`}
                onClick={() => usePowerUp(p.type)}
                title={`${p.label}: ${p.description}`}
                disabled={hasAnswered || isRevealed}
              >{p.emoji}</button>
            ))}
          </div>
        </div>
      </div>

      <style>{`@keyframes jitter{0%,100%{transform:translateX(0)}25%{transform:translateX(-2px)}75%{transform:translateX(2px)}}`}</style>
    </div>
  )
}

export default function PlayPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)', fontFamily: 'Space Grotesk', color: 'var(--ink)', fontSize: 20, fontWeight: 700 }}>
        Loading…
      </div>
    }>
      <StudentPlayScreen />
    </Suspense>
  )
}
