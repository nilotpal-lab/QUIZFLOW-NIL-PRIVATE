'use client'
import { Suspense } from 'react'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import {
  subscribeToSession, startGame, revealAnswer,
  showLeaderboard, nextQuestion, endGame, kickPlayer, setGameMode,
  getTacticsRankings, getMasteryRankings,
  togglePauseTimer, extendTimer, skipQuestion, toggleAliasMode,
  advanceTournamentRound, startBossFrenzy, endBossFrenzy,
  isHostAuthorized
} from '@/quizflow/sessionStore'
import type { GameState, Player } from '@/quizflow/sessionStore'
import { buildAvatarUrl } from '@/quizflow/utils'
import { FloatingReactions } from '@/quizflow/FloatingReactions'
import { RealtimeLeaderboardModal } from '@/quizflow/RealtimeLeaderboardModal'

const ANONYMOUS_ALIASES = [
  '🕵️ Agent Falcon', '🥷 Stealth Ninja', '🦊 Clever Fox', '🚀 Cosmic Rover',
  '🦁 Brave Lion', '🦉 Wise Owl', '⚡ Turbo Cheetah', '🐬 Swift Dolphin',
  '🐼 Gentle Panda', '🐯 Mighty Tiger', '🦅 Sharp Eagle', '🐻 Bear Cub',
  '🦄 Magic Pony', '🐲 Dragon Flame', '🐺 Lone Wolf', '🦈 Star Shark'
]

function getDisplayName(player: { id: string; nickname: string }, index: number, isAliasMode: boolean) {
  if (!isAliasMode) return player.nickname
  const charSum = player.id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  const aliasName = ANONYMOUS_ALIASES[(charSum + index) % ANONYMOUS_ALIASES.length]
  return aliasName
}

function TeacherHostDashboard() {
  const searchParams = useSearchParams()
  const router       = useRouter()
  const pin          = searchParams.get('pin') || ''

  const [gameState, setGameState]           = useState<GameState | null>(null)
  const [copiedPin, setCopiedPin]           = useState(false)
  const [timeLeft, setTimeLeft]             = useState(0)
  const [activeBoard, setActiveBoard]       = useState<'tactics' | 'mastery'>('tactics')
  const [showLeaderboardModal, setShowLeaderboardModal] = useState(false)
  const [revealedIndex, setRevealedIndex]   = useState<number | null>(null)
  const [autoPacing, setAutoPacing]         = useState(true)
  const [isProjectorMode, setIsProjectorMode] = useState(false)
  const [autoAdvanceCountdown, setAutoAdvanceCountdown] = useState<number | null>(null)
  const [sessionTimeout, setSessionTimeout] = useState(false)
  const [frenzyTimeLeft, setFrenzyTimeLeft] = useState(60)

  const timerRef            = useRef<NodeJS.Timeout | null>(null)
  const autoAdvanceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const frenzyTimerRef      = useRef<NodeJS.Timeout | null>(null)

  const autoAdvanceDeadlineRef = useRef<number | null>(null)
  const lastAutoPhaseRef       = useRef<string | null>(null)

  // Redirect if no PIN
  useEffect(() => {
    if (!pin) router.push('/quizflow/host/new')
  }, [pin, router])

  // Subscribe to session
  useEffect(() => {
    if (!pin) return
    const unsub = subscribeToSession(pin, (state) => {
      setGameState(state)
    })
    return unsub
  }, [pin])

  // Session timeout detection
  useEffect(() => {
    if (!pin) return
    const t = setTimeout(() => {
      if (!gameState) setSessionTimeout(true)
    }, 6000)
    return () => clearTimeout(t)
  }, [pin, gameState])

  const qIdx   = gameState?.currentQuestionIndex || 0
  const totalQ = gameState?.quiz?.questions?.length || 0

  // Reset revealedIndex when question index changes
  useEffect(() => {
    setRevealedIndex(null)
  }, [gameState?.currentQuestionIndex])

  // Auto-pacing orchestrator (Auto-Reveal -> Auto-Leaderboard -> Auto-Next Question / Auto-Tournament Advance)
  useEffect(() => {
    if (!autoPacing || !gameState || !pin) {
      if (autoAdvanceTimerRef.current) clearInterval(autoAdvanceTimerRef.current)
      autoAdvanceDeadlineRef.current = null
      lastAutoPhaseRef.current = null
      setAutoAdvanceCountdown(null)
      return
    }

    const currentPhaseKey = `${gameState.status}_${gameState.currentQuestionIndex}_${gameState.currentRound || 1}`
    if (lastAutoPhaseRef.current !== currentPhaseKey) {
      lastAutoPhaseRef.current = currentPhaseKey
      if (gameState.status === 'question_reveal') {
        autoAdvanceDeadlineRef.current = Date.now() + 4000
      } else if (gameState.status === 'leaderboard') {
        autoAdvanceDeadlineRef.current = Date.now() + 5000
      } else {
        autoAdvanceDeadlineRef.current = null
        setAutoAdvanceCountdown(null)
      }
    }

    if (autoAdvanceDeadlineRef.current) {
      if (autoAdvanceTimerRef.current) clearInterval(autoAdvanceTimerRef.current)
      const tickAuto = () => {
        if (!autoAdvanceDeadlineRef.current) return
        const remaining = Math.max(0, Math.ceil((autoAdvanceDeadlineRef.current - Date.now()) / 1000))
        setAutoAdvanceCountdown(remaining)
        if (Date.now() >= autoAdvanceDeadlineRef.current) {
          autoAdvanceDeadlineRef.current = null
          setAutoAdvanceCountdown(null)
          if (autoAdvanceTimerRef.current) clearInterval(autoAdvanceTimerRef.current)

          if (gameState.status === 'question_reveal') {
            showLeaderboard(pin)
          } else if (gameState.status === 'leaderboard') {
            const isTournament = Boolean(gameState.tournamentConfig)
            const currentRoundIdx = gameState.tournamentConfig?.currentRoundIndex ?? 0
            const totalRounds = gameState.tournamentConfig?.rounds?.length ?? 0
            const hasNextRound = isTournament && currentRoundIdx + 1 < totalRounds

            if (qIdx + 1 < totalQ) {
              nextQuestion(pin)
            } else if (hasNextRound) {
              advanceTournamentRound(pin)
            } else {
              endGame(pin)
            }
          }
        }
      }
      tickAuto()
      autoAdvanceTimerRef.current = setInterval(tickAuto, 250)
    }

    return () => {
      if (autoAdvanceTimerRef.current) clearInterval(autoAdvanceTimerRef.current)
    }
  }, [gameState?.status, gameState?.currentQuestionIndex, gameState?.currentRound, autoPacing, pin, qIdx, totalQ, gameState?.tournamentConfig])

  // Host timer countdown & reveal when time expires
  useEffect(() => {
    clearInterval(timerRef.current!)
    if (!gameState || gameState.status !== 'question_active') { setTimeLeft(0); return }
    if (gameState.isPaused) {
      const remaining = Math.max(0, Math.ceil((gameState.pausedTimeRemainingMs || 0) / 1000))
      setTimeLeft(remaining)
      return
    }
    const tick = () => {
      const remaining = Math.max(0, gameState.questionEndsAt - Date.now())
      setTimeLeft(Math.ceil(remaining / 1000))
      if (remaining <= 0) {
        clearInterval(timerRef.current!)
        if (revealedIndex !== gameState.currentQuestionIndex) {
          setRevealedIndex(gameState.currentQuestionIndex)
          revealAnswer(pin)
        }
      }
    }
    tick()
    timerRef.current = setInterval(tick, 250)
    return () => clearInterval(timerRef.current!)
  }, [gameState?.status, gameState?.currentQuestionIndex, gameState?.questionEndsAt, gameState?.isPaused, gameState?.pausedTimeRemainingMs, pin, revealedIndex])

  // Auto-reveal when ALL joined players have answered (minimum 3s after start)
  useEffect(() => {
    if (!gameState || gameState.status !== 'question_active') return
    const playersList = Object.values(gameState.players || {})
    const elapsed = Date.now() - (gameState.questionStartedAt || 0)
    const allAnswered = playersList.length > 0 && playersList.every(p => p.hasAnswered)
    if (playersList.length > 0 && elapsed >= 3000 && allAnswered) {
      if (revealedIndex !== gameState.currentQuestionIndex) {
        setRevealedIndex(gameState.currentQuestionIndex)
        revealAnswer(pin)
      }
    }
  }, [gameState?.status, gameState?.players, gameState?.currentQuestionIndex, gameState?.questionStartedAt, pin, revealedIndex])

  // Boss Frenzy 60s Host Countdown Timer
  useEffect(() => {
    if (frenzyTimerRef.current) clearInterval(frenzyTimerRef.current)
    if (!gameState || gameState.status !== 'boss_frenzy' || !gameState.bossFrenzy?.active) {
      return
    }

    const endsAt = gameState.bossFrenzy.endsAt
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
      setFrenzyTimeLeft(remaining)
      if (remaining <= 0) {
        clearInterval(frenzyTimerRef.current!)
        endBossFrenzy(pin)
      }
    }
    tick()
    frenzyTimerRef.current = setInterval(tick, 500)
    return () => {
      if (frenzyTimerRef.current) clearInterval(frenzyTimerRef.current)
    }
  }, [gameState?.status, gameState?.bossFrenzy?.endsAt, gameState?.bossFrenzy?.active, pin])

  // Keyboard Shortcuts for Host Classroom Projection
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ignore keystrokes in text inputs
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return

    if (e.code === 'Space') {
      e.preventDefault()
      if (!gameState) return
      if (gameState.status === 'lobby') {
        if (Object.keys(gameState.players || {}).length > 0) startGame(pin)
      } else if (gameState.status === 'question_active') {
        revealAnswer(pin)
      } else if (gameState.status === 'question_reveal') {
        showLeaderboard(pin)
      } else if (gameState.status === 'leaderboard') {
        if (qIdx + 1 < totalQ) {
          nextQuestion(pin)
        } else if (gameState.tournamentConfig && (gameState.tournamentConfig.currentRoundIndex ?? 0) + 1 < (gameState.tournamentConfig.rounds?.length ?? 0)) {
          advanceTournamentRound(pin)
        } else {
          endGame(pin)
        }
      }
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault()
      if (gameState?.status === 'question_active') togglePauseTimer(pin)
    } else if (e.key === 'e' || e.key === 'E' || e.key === '+') {
      e.preventDefault()
      if (gameState?.status === 'question_active') extendTimer(pin, 15000)
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault()
      setShowLeaderboardModal(prev => !prev)
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault()
      toggleAliasMode(pin)
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault()
      setIsProjectorMode(prev => !prev)
    }
  }, [gameState, pin, qIdx, totalQ])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const copyPin = () => {
    navigator.clipboard.writeText(pin)
    setCopiedPin(true)
    setTimeout(() => setCopiedPin(false), 2000)
  }

  if (!gameState) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)' }}>
      <div className="card anim-scale-in" style={{ padding: 48, textAlign: 'center', maxWidth: 400 }}>
        {sessionTimeout ? (
          <>
            <div style={{ fontSize: 48, marginBottom: 16 }}>😕</div>
            <div style={{ fontFamily: 'Space Grotesk', fontSize: 22, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>Session Not Found</div>
            <div style={{ fontFamily: 'Inter', fontSize: 14, color: '#666', marginBottom: 24 }}>PIN <strong>{pin}</strong> doesn&apos;t exist or has expired.</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⏳</div>
            <div style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>Loading session…</div>
            <div style={{ fontFamily: 'Inter', fontSize: 13, color: '#888', marginBottom: 24 }}>Connecting to game room…</div>
          </>
        )}
        <a href="/quizflow/host/new">
          <button className="btn btn-primary" style={{ width: '100%' }}>← Back to Quiz Select</button>
        </a>
      </div>
    </div>
  )

  // Host Ownership & Authorization Guard
  if (gameState && !isHostAuthorized(pin, gameState.hostId)) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)', padding: 20 }}>
        <div className="card anim-scale-in" style={{ padding: '36px 28px', textAlign: 'center', maxWidth: 440, width: '100%', border: '3px solid var(--ink)', boxShadow: '4px 4px 0 var(--ink)' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🔒</div>
          <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 22, fontWeight: 900, color: 'var(--cherry)', marginBottom: 8 }}>
            Host Controls Restricted
          </h2>
          <p style={{ fontFamily: 'Inter', fontSize: 14, color: 'var(--ink)', opacity: 0.8, marginBottom: 20, lineHeight: 1.5 }}>
            This browser or device is not authenticated as the host for Game PIN <strong>{pin}</strong>. Host controls and question advancement are reserved exclusively for the teacher who started the session.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              onClick={() => router.push(`/quizflow/join?pin=${pin}`)}
              className="btn btn-sun"
              style={{ width: '100%', padding: '12px 18px', fontWeight: 800, fontSize: 14 }}
            >
              🎮 Join Game as Student
            </button>
            <button
              onClick={() => router.push('/quizflow/auth')}
              className="btn"
              style={{ width: '100%', padding: '10px 18px', fontWeight: 700, fontSize: 13, background: 'var(--paper-2)' }}
            >
              🔑 Teacher Login
            </button>
          </div>
        </div>
      </div>
    )
  }

  const players      = Object.values(gameState.players || {})
  const totalPlayers = players.length
  const answered     = players.filter(p => p.hasAnswered).length
  const q            = gameState.quiz?.questions?.[gameState.currentQuestionIndex]

  // Ranked players based on active leaderboard selection
  const rankedPlayers = activeBoard === 'mastery'
    ? getMasteryRankings(players)
    : getTacticsRankings(players)

  const sortedTop3 = [
    rankedPlayers[0] || null, // 1st
    rankedPlayers[1] || null, // 2nd
    rankedPlayers[2] || null, // 3rd
  ]

  // Answer distribution for current question
  const distColors = ['var(--cherry)', 'var(--sky)', 'var(--sun)', 'var(--mint)']
  const dist = q ? q.choices.map((text, i) => {
    const count = players.filter(p => p.selectedIndex === i).length
    const pct   = totalPlayers > 0 ? Math.round((count / totalPlayers) * 100) : 0
    return {
      label: String.fromCharCode(65 + i),
      text,
      count,
      pct,
      color: distColors[i % distColors.length],
      isCorrect: i === q.correct_index
    }
  }) : []

  const accuracy = totalPlayers > 0 && answered > 0
    ? Math.round((players.filter(p => p.lastAnswerCorrect).length / Math.max(1, answered)) * 100)
    : 0

  // ── LOBBY VIEW ──
  if (gameState.status === 'lobby') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--paper)', position: 'relative' }}>
        <FloatingReactions reactions={gameState?.reactions} />

        {/* Top bar */}
        <header className="top-bar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', gap: 12 }}>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 800, color: 'var(--paper)' }}>
            ⚡ QuizFlow <span className="badge badge-sun" style={{ fontSize: 10, verticalAlign: 'middle' }}>HOST LOBBY</span>
          </div>
          <div className="pin-display" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ink)' }}>GAME PIN</span>
            <span className="pin-code">{pin}</span>
            <button onClick={copyPin} className="btn btn-sm" style={{ background: 'var(--ink)', color: 'var(--paper)' }}>
              {copiedPin ? '✓ Copied!' : '📋 Copy'}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => setShowLeaderboardModal(true)}
              className="btn btn-sm btn-sun"
              style={{ padding: '8px 14px', fontSize: 12, fontWeight: 800, border: '2px solid var(--paper)', boxShadow: '2px 2px 0 var(--ink)' }}
              title="Show Real-Time Leaderboard on Projector Screen [Shortcut: L]"
            >
              🏆 Real-Time Leaderboard
            </button>
            <button
              onClick={() => toggleAliasMode(pin)}
              className={`btn btn-sm ${gameState?.aliasMode ? 'btn-violet' : ''}`}
              style={{ padding: '6px 12px', fontSize: 12, fontWeight: 700, border: '2px solid var(--paper)' }}
              title="Toggle Alias Mode to hide real student nicknames [Shortcut: A]"
            >
              {gameState?.aliasMode ? '🕵️ Alias Mode: ON' : '🕵️ Alias Mode: OFF'}
            </button>
            <button
              className="btn btn-mint btn-lg"
              style={{ opacity: totalPlayers === 0 ? 0.5 : 1 }}
              onClick={() => startGame(pin)}
              disabled={totalPlayers === 0}
              title="Start Live Quiz [Shortcut: Space]"
            >
              {totalPlayers === 0 ? '⏳ Waiting for players…' : `🎮 START GAME (${totalPlayers} joined) [Space]`}
            </button>
          </div>
        </header>

        {/* Tournament Lobby Banner */}
        {gameState.tournamentConfig && (
          <div className="anim-fade-up" style={{
            background: 'linear-gradient(135deg, #a78bfa 0%, #f472b6 100%)',
            color: 'white',
            padding: '12px 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            borderBottom: '3px solid var(--ink)',
            boxShadow: '0 3px 0 var(--ink)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 24 }}>🏆</span>
              <div>
                <div style={{ fontFamily: 'Space Grotesk', fontWeight: 900, fontSize: 16 }}>
                  TOURNAMENT ACTIVE — {gameState.tournamentRoundLabel || `Round ${(gameState.tournamentConfig.currentRoundIndex ?? 0) + 1} of ${gameState.tournamentConfig.rounds.length}`}
                </div>
                <div style={{ fontFamily: 'Inter', fontSize: 13, opacity: 0.95 }}>
                  Active Elimination Rule: <strong>{gameState.tournamentConfig.rounds[gameState.tournamentConfig.currentRoundIndex ?? 0]?.eliminationRule || 'Bottom 30% eliminated'}</strong>
                  {gameState.eliminatedPlayers && gameState.eliminatedPlayers.length > 0 && (
                    <span> • 💀 {gameState.eliminatedPlayers.length} Eliminated</span>
                  )}
                </div>
              </div>
            </div>
            <span className="badge badge-sun" style={{ fontSize: 12, padding: '4px 12px' }}>
              ROUND {(gameState.tournamentConfig.currentRoundIndex ?? 0) + 1} / {gameState.tournamentConfig.rounds.length}
            </span>
          </div>
        )}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 24 }}>
          {/* Game Mode Selector */}
          {!gameState.tournamentConfig && (
            <div className="card" style={{ padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ fontSize: 13, fontFamily: 'Space Grotesk', fontWeight: 800, color: 'var(--ink)' }}>GAME MODE:</span>
              <button
                onClick={() => setGameMode(pin, 'classic')}
                className={`btn btn-sm ${gameState.gameMode !== 'boss_raid' ? 'btn-sun' : ''}`}
                style={{ padding: '6px 14px', fontSize: 13, background: gameState.gameMode !== 'boss_raid' ? undefined : 'var(--paper-2)', color: 'var(--ink)' }}
              >
                🎯 Classic Mode
              </button>
              <button
                onClick={() => setGameMode(pin, 'boss_raid')}
                className={`btn btn-sm ${gameState.gameMode === 'boss_raid' ? 'btn-cherry' : ''}`}
                style={{ padding: '6px 14px', fontSize: 13, background: gameState.gameMode === 'boss_raid' ? undefined : 'var(--paper-2)', color: 'var(--ink)' }}
              >
                🐉 Boss Raid Mode
              </button>
            </div>
          )}

          <div style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 700, color: 'var(--ink)', textAlign: 'center' }}>
            📡 Students join at <strong>quizflow.app</strong> or enter Game PIN:
          </div>
          <div className="pin-display" style={{ padding: '24px 48px' }}>
            <span className="pin-code" style={{ fontSize: 80, letterSpacing: '0.18em' }}>{pin}</span>
          </div>
          <div style={{ color: 'var(--ink)', fontSize: 15, fontFamily: 'Inter', opacity: 0.75, display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>📚 {gameState.quiz?.title || 'QuizFlow Deck'} — {totalQ} questions</span>
            {gameState.gameMode === 'boss_raid' && (
              <span className="badge badge-cherry">🐉 Boss Raid Active (100 HP)</span>
            )}
          </div>

          {totalPlayers > 0 && (
            <div className="card anim-scale-in" style={{ padding: 24, width: '100%', maxWidth: 740 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontFamily: 'Space Grotesk', fontWeight: 800, color: 'var(--ink)', textTransform: 'uppercase', opacity: 0.7 }}>
                  Players Joined ({totalPlayers})
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink)', fontFamily: 'Inter', opacity: 0.6 }}>
                  Click ✕ to remove any inappropriate nickname
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {players.map((p, idx) => {
                  const isEliminated = gameState.eliminatedPlayers?.includes(p.id)
                  return (
                    <div
                      key={p.id}
                      className="lb-row"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 12px 6px 8px',
                        borderRadius: 99,
                        background: isEliminated ? '#FFE4E7' : p.flagged ? '#FFE4E7' : undefined,
                        border: isEliminated ? '1.5px solid var(--cherry)' : p.flagged ? '1.5px solid var(--cherry)' : undefined,
                        opacity: isEliminated ? 0.6 : 1
                      }}
                    >
                      <div className="avatar-ring" style={{ width: 32, height: 32 }}>
                        <img src={buildAvatarUrl(p.avatarSeed, p.avatarStyle as any, 32)} alt="" width={32} height={32} />
                      </div>
                      <span style={{ fontFamily: 'Space Grotesk', fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
                        {getDisplayName(p, idx, gameState?.aliasMode || false)}
                      </span>
                      {isEliminated && (
                        <span className="badge badge-cherry" style={{ fontSize: 9, padding: '2px 6px' }}>💀 Eliminated</span>
                      )}
                      {p.flagged && <span title={`${p.violations} violations`} style={{ fontSize: 12, color: 'var(--cherry)', fontWeight: 800 }}>⚑</span>}
                      <button onClick={() => kickPlayer(pin, p.id)} title="Kick player from session" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--cherry)', fontSize: 14, padding: '0 2px', fontWeight: 800 }}>✕</button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <RealtimeLeaderboardModal
          isOpen={showLeaderboardModal}
          onClose={() => setShowLeaderboardModal(false)}
          players={players}
          activeBoard={activeBoard}
          setActiveBoard={setActiveBoard}
          isAliasMode={gameState?.aliasMode || false}
          toggleAliasMode={() => toggleAliasMode(pin)}
          pin={pin}
          quizTitle={gameState.quiz?.title}
        />
      </div>
    )
  }

  // ── ENDED VIEW ──
  if (gameState.status === 'ended') {
    router.push(`/quizflow/results?pin=${pin}`)
    return null
  }

  // ── BOSS FRENZY HOST COMMAND CENTER VIEW ──
  if (gameState.status === 'boss_frenzy' && gameState.bossFrenzy) {
    const frenzy = gameState.bossFrenzy
    const frenzyQIdx = frenzy.questionIndices[frenzy.currentFrenzyIndex] ?? 0
    const frenzyQ = gameState.quiz?.questions?.[frenzyQIdx]
    const totalFrenzyDamage = Object.values(frenzy.frenzyScores || {}).reduce((a, b) => a + b, 0) * 200

    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#0A0A0B', color: '#fff', position: 'relative' }}>
        <FloatingReactions reactions={gameState?.reactions} />

        {/* Top bar */}
        <header style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 24px',
          background: 'rgba(0,0,0,0.8)',
          borderBottom: '3px solid #FF4444'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 900, color: '#FF4444' }}>
              💥 BOSS FRENZY RAPID-FIRE FINALE
            </span>
            <span className="badge badge-sun" style={{ fontSize: 11 }}>
              PIN: {pin}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'Space Grotesk', fontSize: 36, fontWeight: 900, color: frenzyTimeLeft <= 10 ? '#FF4444' : '#FFD700', lineHeight: 1 }}>
                {frenzyTimeLeft}s
              </div>
              <div style={{ fontSize: 10, fontFamily: 'Space Grotesk', color: '#aaa', textTransform: 'uppercase' }}>COUNTDOWN</div>
            </div>

            <button
              onClick={() => endBossFrenzy(pin)}
              className="btn"
              style={{ padding: '10px 20px', fontWeight: 900, background: '#FF4444', color: '#fff', border: '2px solid #fff', boxShadow: '3px 3px 0 #000' }}
            >
              ⏹ Finalize &amp; End Frenzy
            </button>
          </div>
        </header>

        {/* 60s Progress Bar */}
        <div style={{ height: 8, background: 'rgba(255,255,255,0.1)' }}>
          <div style={{
            height: '100%',
            background: 'linear-gradient(90deg, #FF4444, #FF8C00, #FFD700)',
            width: `${Math.max(0, Math.min(100, (frenzyTimeLeft / 60) * 100))}%`,
            transition: 'width 0.5s linear'
          }} />
        </div>

        {/* Frenzy Arena Grid */}
        <div style={{ flex: 1, padding: '24px 32px', display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24, maxWidth: 1300, width: '100%', margin: '0 auto' }}>
          {/* Active Question Card */}
          <div style={{ background: '#18181B', border: '3px solid #FF4444', borderRadius: 20, padding: 32, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', boxShadow: '0 0 30px rgba(255,68,68,0.2)' }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <span className="badge badge-cherry" style={{ fontSize: 12, padding: '4px 12px' }}>
                  ⚡ RAPID QUESTION {frenzy.currentFrenzyIndex + 1} OF {frenzy.questionIndices.length}
                </span>
                <span style={{ fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 13, color: '#FFD700' }}>
                  💥 +200 PTS PER HIT
                </span>
              </div>

              <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 26, fontWeight: 900, lineHeight: 1.3, marginBottom: 28, color: '#fff' }}>
                {frenzyQ?.prompt || 'Loading next rapid frenzy question...'}
              </h2>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {(frenzyQ?.choices || []).map((choice, ci) => (
                  <div
                    key={ci}
                    style={{
                      padding: '16px 20px',
                      background: ci === frenzyQ?.correct_index ? 'rgba(0, 230, 118, 0.2)' : 'rgba(255,255,255,0.06)',
                      border: ci === frenzyQ?.correct_index ? '2px solid #00E676' : '1px solid rgba(255,255,255,0.15)',
                      borderRadius: 14,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12
                    }}
                  >
                    <span style={{ fontFamily: 'Space Grotesk', fontWeight: 900, fontSize: 16, color: '#FFD700' }}>
                      {String.fromCharCode(65 + ci)}
                    </span>
                    <span style={{ fontFamily: 'Inter', fontWeight: 700, fontSize: 15, color: '#fff', flex: 1 }}>
                      {choice}
                    </span>
                    {ci === frenzyQ?.correct_index && (
                      <span style={{ color: '#00E676', fontWeight: 900, fontSize: 18 }}>✓</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 24, paddingTop: 18, borderTop: '1px solid rgba(255,255,255,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontFamily: 'Space Grotesk', fontSize: 14, color: '#aaa' }}>
                Total Frenzy Damage Dealt: <strong style={{ color: '#FFD700' }}>+{totalFrenzyDamage.toLocaleString()} PTS</strong>
              </div>
              <div style={{ fontFamily: 'Space Grotesk', fontSize: 13, color: '#FF4444', fontWeight: 800 }}>
                ⚡ Auto-advances across all connected player devices
              </div>
            </div>
          </div>

          {/* Frenzy Live Leaderboard */}
          <div style={{ background: '#18181B', border: '2px solid rgba(255,255,255,0.15)', borderRadius: 20, padding: 20, display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 900, fontSize: 15, color: '#FFD700', marginBottom: 14, letterSpacing: 1 }}>
              🔥 LIVE FRENZY HITS
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', flex: 1, maxHeight: 440 }}>
              {Object.entries(frenzy.frenzyScores || {})
                .sort(([, a], [, b]) => b - a)
                .map(([pid, hits], rankIdx) => {
                  const p = gameState.players?.[pid]
                  return (
                    <div
                      key={pid}
                      style={{
                        padding: '8px 12px',
                        background: rankIdx === 0 ? 'rgba(255,215,0,0.15)' : 'rgba(255,255,255,0.05)',
                        border: rankIdx === 0 ? '1.5px solid #FFD700' : '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 12,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontFamily: 'Space Grotesk', fontWeight: 900, fontSize: 13, color: rankIdx === 0 ? '#FFD700' : '#888' }}>
                          #{rankIdx + 1}
                        </span>
                        <div className="avatar-ring" style={{ width: 28, height: 28 }}>
                          <img src={buildAvatarUrl(p?.avatarSeed || 'P', p?.avatarStyle as any || 'custom', 28)} alt="" width={28} height={28} />
                        </div>
                        <span style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 13, color: '#fff', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p?.nickname || 'Player'}
                        </span>
                      </div>

                      <div style={{ textAlign: 'right' }}>
                        <span style={{ fontFamily: 'Space Grotesk', fontWeight: 900, fontSize: 14, color: '#00E676' }}>
                          {hits} Hits
                        </span>
                        <div style={{ fontSize: 10, color: '#FFD700', fontFamily: 'Space Grotesk' }}>
                          +{hits * 200} pts
                        </div>
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── GAME VIEW (question_active / question_reveal / leaderboard) ──
  const timePct = q ? Math.min(1, timeLeft / ((q.time_limit_ms || 20000) / 1000)) : 0

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--paper)', position: 'relative' }}>
      <FloatingReactions reactions={gameState?.reactions} />

      {/* TOP BAR */}
      <header className="top-bar anim-fade-up" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 800, color: 'var(--paper)' }}>
            ⚡ QuizFlow
          </div>
          <div className="pin-display" style={{ padding: '4px 14px' }}>
            <span style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ink)', marginRight: 8 }}>PIN</span>
            <span className="pin-code" style={{ fontSize: 20, letterSpacing: '0.14em' }}>{pin}</span>
          </div>
          {gameState.gameMode === 'boss_raid' && (
            <span className="badge badge-cherry" style={{ fontSize: 11, padding: '4px 10px', boxShadow: '2px 2px 0 var(--ink)' }}>
              🐉 BOSS RAID MODE
            </span>
          )}
        </div>

        {/* Live timer */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 70 }}>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 40, fontWeight: 900, color: timePct > 0.5 ? 'var(--mint)' : timePct > 0.25 ? 'var(--sun)' : 'var(--cherry)', lineHeight: 1, transition: 'color 0.5s' }}>
            {gameState.status === 'question_active' ? timeLeft : '—'}
          </div>
          <div style={{ fontSize: 10, color: 'var(--paper)', fontFamily: 'Space Grotesk', textTransform: 'uppercase', opacity: 0.7 }}>seconds</div>
        </div>

        {/* Top Bar Action Buttons */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {autoAdvanceCountdown !== null && (
            <div className="anim-pulse" style={{ background: 'var(--sun)', border: '2px solid var(--ink)', padding: '6px 12px', borderRadius: 6, fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, boxShadow: '2px 2px 0 var(--ink)' }}>
              <span>⚡ Auto-Next in {autoAdvanceCountdown}s</span>
            </div>
          )}

          {gameState.status === 'question_active' && (
            <button className="btn btn-cherry" style={{ padding: '8px 18px', fontWeight: 700 }} onClick={() => revealAnswer(pin)} title="Reveal correct answer to students [Shortcut: Space]">
              👁 Reveal Answer [Space]
            </button>
          )}
          {gameState.status === 'question_reveal' && (
            <button className="btn btn-violet" style={{ padding: '8px 18px', fontWeight: 700 }} onClick={() => showLeaderboard(pin)} title="Show Current Leaderboard [Shortcut: Space]">
              🏆 Show Leaderboard [Space]
            </button>
          )}
          {gameState.status === 'leaderboard' && qIdx + 1 < totalQ && (
            <button className="btn btn-sun" style={{ padding: '8px 18px', fontWeight: 700 }} onClick={() => nextQuestion(pin)} title="Advance to Next Question [Shortcut: Space]">
              Next Question ({qIdx + 2}/{totalQ}) → [Space]
            </button>
          )}
          {gameState.status === 'leaderboard' && qIdx + 1 >= totalQ && (
            gameState.tournamentConfig && (gameState.tournamentConfig.currentRoundIndex ?? 0) + 1 < (gameState.tournamentConfig.rounds?.length ?? 0) ? (
              <button
                className="btn btn-mint"
                style={{ padding: '8px 18px', fontWeight: 800, background: 'var(--mint)', color: 'var(--ink)' }}
                onClick={() => advanceTournamentRound(pin)}
                title="Advance to Next Tournament Round [Shortcut: Space]"
              >
                ⚔️ Start Round {(gameState.tournamentConfig.currentRoundIndex ?? 0) + 2}: {gameState.tournamentConfig.rounds[(gameState.tournamentConfig.currentRoundIndex ?? 0) + 1]?.quizTitle || 'Next Quiz'} →
              </button>
            ) : (
              <>
                <button
                  className="btn"
                  style={{ padding: '8px 18px', fontWeight: 800, background: '#FF4444', color: '#fff', border: '2px solid #111', boxShadow: '2px 2px 0 #111' }}
                  onClick={() => startBossFrenzy(pin)}
                  title="Launch 60s Boss Frenzy Rapid-Fire Finale!"
                >
                  💥 Boss Frenzy!
                </button>
                <button className="btn btn-primary" style={{ padding: '8px 18px', fontWeight: 700 }} onClick={() => endGame(pin)} title="End game and show final podium results [Shortcut: Space]">
                  🏁 End Game &amp; Show Results
                </button>
              </>
            )
          )}

          <button onClick={copyPin} className="btn btn-sm" style={{ background: 'var(--paper)', color: 'var(--ink)', border: 'var(--line)', boxShadow: 'var(--shadow-hard)', padding: '8px 12px', fontSize: 12 }}>
            {copiedPin ? '✓' : '📋'} {pin}
          </button>
        </div>
      </header>

      {/* TOURNAMENT ROUND BANNER */}
      {gameState.tournamentConfig && (
        <div className="anim-fade-up" style={{
          background: 'linear-gradient(135deg, #a78bfa 0%, #f472b6 100%)',
          color: 'white',
          padding: '10px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          borderBottom: '2px solid var(--ink)',
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>🏆</span>
            <div>
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 900, fontSize: 14 }}>
                TOURNAMENT MODE — {gameState.tournamentRoundLabel || `Round ${(gameState.tournamentConfig.currentRoundIndex ?? 0) + 1} of ${gameState.tournamentConfig.rounds.length}`}
              </div>
              <div style={{ fontFamily: 'Inter', fontSize: 12, opacity: 0.9 }}>
                Rule: {gameState.tournamentConfig.rounds[gameState.tournamentConfig.currentRoundIndex ?? 0]?.eliminationRule || 'Elimination active'}
                {gameState.eliminatedPlayers && gameState.eliminatedPlayers.length > 0 && (
                  <span> • 💀 {gameState.eliminatedPlayers.length} Eliminated</span>
                )}
              </div>
            </div>
          </div>

          {gameState.status === 'leaderboard' && (gameState.tournamentConfig.currentRoundIndex ?? 0) + 1 < gameState.tournamentConfig.rounds.length && (
            <button
              onClick={() => advanceTournamentRound(pin)}
              style={{
                padding: '6px 16px',
                background: 'var(--sun)',
                color: 'var(--ink)',
                border: '2px solid var(--ink)',
                borderRadius: 8,
                fontFamily: 'Space Grotesk',
                fontWeight: 800,
                fontSize: 13,
                cursor: 'pointer',
                boxShadow: '2px 2px 0 var(--ink)'
              }}
            >
              ⚔️ Advance to Next Round →
            </button>
          )}
        </div>
      )}

      {/* TEACHER LIVE CONTROL PANEL TOOLBAR */}
      <div className="anim-fade-up" style={{
        background: 'var(--paper-2)',
        borderBottom: 'var(--line)',
        padding: '8px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 800, textTransform: 'uppercase', color: 'var(--ink)', opacity: 0.75 }}>
            🎛️ Live Controls:
          </span>

          {/* ⚡ Auto-Pacing Toggle */}
          <button
            onClick={() => setAutoPacing(!autoPacing)}
            className="btn btn-sm"
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 800,
              border: '2px solid var(--ink)',
              boxShadow: '2px 2px 0 var(--ink)',
              background: autoPacing ? 'var(--mint)' : 'var(--paper)',
              color: 'var(--ink)'
            }}
            title="Toggle automatic countdown pacing"
          >
            {autoPacing ? '⚡ Auto-Pacing: ON' : '✋ Manual Pacing'}
          </button>

          {/* ⏸️ Pause / Resume */}
          <button
            onClick={() => togglePauseTimer(pin)}
            disabled={gameState.status !== 'question_active'}
            className={`btn btn-sm ${gameState.isPaused ? 'btn-sun' : ''}`}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              opacity: gameState.status !== 'question_active' ? 0.5 : 1,
              border: '2px solid var(--ink)',
              boxShadow: '2px 2px 0 var(--ink)',
              background: gameState.isPaused ? '#FFE57F' : 'var(--paper)'
            }}
            title="Pause or Resume Question Timer [Shortcut: P]"
          >
            {gameState.isPaused ? '▶️ Resume Timer [P]' : '⏸️ Pause Timer [P]'}
          </button>

          {/* ⏱️ +15s Extension */}
          <button
            onClick={() => extendTimer(pin, 15000)}
            disabled={gameState.status !== 'question_active'}
            className="btn btn-sm"
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              opacity: gameState.status !== 'question_active' ? 0.5 : 1,
              border: '2px solid var(--ink)',
              boxShadow: '2px 2px 0 var(--ink)',
              background: 'var(--paper)'
            }}
            title="Add 15 Seconds to Timer [Shortcut: E / +]"
          >
            ⏱️ +15s Extension [E]
          </button>

          {/* ⏭️ Skip Question */}
          <button
            onClick={() => skipQuestion(pin)}
            className="btn btn-sm"
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              border: '2px solid var(--ink)',
              boxShadow: '2px 2px 0 var(--ink)',
              background: 'var(--paper)'
            }}
            title="Skip Question / Advance Phase Immediately"
          >
            ⏭️ Skip Question
          </button>

          {gameState.isPaused && (
            <span className="badge badge-cherry" style={{ fontSize: 11 }}>
              ⏸️ TIMER PAUSED
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* 🏆 Real-Time Leaderboard Modal Toggle */}
          <button
            onClick={() => setShowLeaderboardModal(true)}
            className="btn btn-sm btn-sun"
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 800,
              border: '2px solid var(--ink)',
              boxShadow: '2px 2px 0 var(--ink)',
              background: '#FFE57F',
              color: 'var(--ink)'
            }}
            title="Open Real-Time Full-Screen Leaderboard View [Shortcut: L]"
          >
            🏆 Real-Time Leaderboard [L]
          </button>

          {/* 📺 Projector Mode Toggle */}
          <button
            onClick={() => setIsProjectorMode(!isProjectorMode)}
            className={`btn btn-sm ${isProjectorMode ? 'btn-sun' : ''}`}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              border: '2px solid var(--ink)',
              boxShadow: '2px 2px 0 var(--ink)',
              background: isProjectorMode ? '#FFE57F' : 'var(--paper)'
            }}
            title="Toggle full-width Projector Mode for classroom screens [Shortcut: M]"
            aria-label="Toggle Projector Mode"
          >
            {isProjectorMode ? '📺 Projector: ON' : '📺 Projector: OFF'}
          </button>

          {/* 🕵️ Alias Mode Toggle */}
          <button
            onClick={() => toggleAliasMode(pin)}
            className={`btn btn-sm ${gameState.aliasMode ? 'btn-violet' : ''}`}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              border: '2px solid var(--ink)',
              boxShadow: '2px 2px 0 var(--ink)',
              background: gameState.aliasMode ? '#E1BEE7' : 'var(--paper)'
            }}
            title="Hide real student nicknames on projector display [Shortcut: A]"
            aria-label="Toggle Alias Mode"
          >
            {gameState.aliasMode ? '🕵️ Alias: ON' : '🕵️ Alias: OFF'}
          </button>
        </div>
      </div>

      {/* BOSS RAID HEALTH BAR */}
      {gameState.gameMode === 'boss_raid' && (
        <div className="anim-fade-up" style={{
          background: 'var(--paper-2)',
          borderBottom: 'var(--line)',
          padding: '10px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          boxShadow: '0 4px 0 var(--ink)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 14, color: 'var(--ink)' }}>
            <span style={{ fontSize: 20 }}>🐉</span>
            <span>BOSS RAID HEALTH</span>
            {(gameState.bossHealth ?? 100) === 0 ? (
              <span className="badge badge-mint" style={{ fontSize: 11 }}>DEFEATED! 🎉</span>
            ) : (
              <span className="badge badge-cherry" style={{ fontSize: 11 }}>ACTIVE</span>
            )}
          </div>
          <div style={{ flex: 1, maxWidth: 450, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 13, fontFamily: 'Space Grotesk', fontWeight: 800, color: 'var(--ink)', whiteSpace: 'nowrap' }}>
              HP: {gameState.bossHealth ?? 100} / {gameState.bossMaxHealth ?? 100}
            </div>
            <div style={{ flex: 1, height: 18, background: 'var(--paper)', border: '2px solid var(--ink)', borderRadius: 9, overflow: 'hidden', boxShadow: '2px 2px 0 var(--ink)', position: 'relative' }}>
              <div style={{
                width: `${Math.max(0, Math.min(100, ((gameState.bossHealth ?? 100) / (gameState.bossMaxHealth ?? 100)) * 100))}%`,
                height: '100%',
                background: (gameState.bossHealth ?? 100) > 50 ? 'var(--mint)' : (gameState.bossHealth ?? 100) > 25 ? 'var(--sun)' : 'var(--cherry)',
                transition: 'width 0.4s ease, background 0.4s'
              }} />
            </div>
          </div>
        </div>
      )}

      {/* Live Timer progress bar */}
      <div className="timer-bar" style={{ borderRadius: 0, border: 'none', borderBottom: 'var(--line)', height: 8 }}>
        <div className="timer-bar-fill" style={{ width: `${timePct * 100}%`, background: timePct > 0.5 ? 'var(--mint)' : timePct > 0.25 ? 'var(--sun)' : 'var(--cherry)', transition: 'width 0.2s linear, background 0.5s' }} />
      </div>

      {/* MAIN THREE-COLUMN OR PROJECTOR FULL-SCREEN */}
      <div className="host-main-grid" style={{
        flex: 1,
        padding: isProjectorMode ? '24px 32px' : '16px 20px',
        display: 'grid',
        gridTemplateColumns: isProjectorMode ? '1fr' : '280px 1fr 300px',
        gap: 16,
        maxWidth: isProjectorMode ? 1200 : undefined,
        margin: isProjectorMode ? '0 auto' : undefined,
        width: '100%'
      }}>

        {/* LEFT: Live Analytics & Response Distribution */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Accuracy Gauge */}
          <div className="card anim-scale-in" style={{ padding: 20, textAlign: 'center' }}>
            <div style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 800, color: 'var(--ink)', textTransform: 'uppercase', marginBottom: 10, opacity: 0.7 }}>
              Class Accuracy
            </div>
            <div style={{ position: 'relative', width: 110, height: 110, margin: '0 auto 8px' }}>
              <svg width={110} height={110} style={{ transform: 'rotate(-90deg)' }}>
                <circle cx={55} cy={55} r={46} fill="none" stroke="var(--paper-2)" strokeWidth={10} />
                <circle cx={55} cy={55} r={46} fill="none" stroke="var(--mint)" strokeWidth={10}
                  strokeDasharray={2 * Math.PI * 46}
                  strokeDashoffset={2 * Math.PI * 46 * (1 - accuracy / 100)}
                  strokeLinecap="butt"
                  style={{ transition: 'stroke-dashoffset 0.8s ease' }}
                />
              </svg>
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ fontFamily: 'Space Grotesk', fontSize: 26, fontWeight: 900, color: 'var(--ink)' }}>{accuracy}%</div>
                <div style={{ fontSize: 9, color: 'var(--ink)', fontFamily: 'Space Grotesk', opacity: 0.6, textTransform: 'uppercase', fontWeight: 800 }}>ACCURACY</div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink)', fontFamily: 'Space Grotesk', fontWeight: 700 }}>
              {answered}/{totalPlayers} answered ({totalPlayers > 0 ? Math.round((answered / totalPlayers) * 100) : 0}%)
            </div>
          </div>

          {/* Response Distribution Bars */}
          <div className="card anim-scale-in" style={{ padding: 16, flex: 1 }}>
            <div style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 800, color: 'var(--ink)', textTransform: 'uppercase', marginBottom: 12, opacity: 0.7 }}>
              Response Distribution
            </div>
            {dist.map((item) => (
              <div key={item.label} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, color: 'var(--ink)', fontFamily: 'Space Grotesk', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>{item.label}. {item.text.slice(0, 18)}</span>
                    {item.isCorrect && gameState.status !== 'question_active' && (
                      <span className="badge badge-mint" style={{ fontSize: 9, padding: '1px 5px' }}>✓ CORRECT</span>
                    )}
                  </span>
                  <span style={{ color: 'var(--ink)', fontFamily: 'Space Grotesk', fontWeight: 700 }}>
                    {item.count} ({item.pct}%)
                  </span>
                </div>
                <div style={{ height: 10, background: 'var(--paper-2)', border: '1.5px solid var(--ink)', borderRadius: 0, overflow: 'hidden' }}>
                  <div style={{ width: `${item.pct}%`, height: '100%', background: item.color, transition: 'width 0.6s ease' }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CENTER: Question Prompt + Top Podium */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Question card */}
          <div className="card anim-scale-in" style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span className="badge badge-ink" style={{ fontSize: 11 }}>Question {qIdx + 1} of {totalQ}</span>
              <span style={{ fontSize: 12, color: 'var(--ink)', fontFamily: 'Space Grotesk', fontWeight: 700 }}>
                {gameState.status === 'question_active' ? `⏱ ${timeLeft}s left` : gameState.status === 'question_reveal' ? '✅ Answer Revealed' : '🏆 Leaderboard'}
              </span>
            </div>
            <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 800, lineHeight: 1.4, marginBottom: (q?.imageUrl || q?.media_url) ? 12 : 20, color: 'var(--ink)' }}>
              {q?.prompt}
            </h2>

            {(q?.imageUrl || q?.media_url) && (
              <div style={{ marginBottom: 16, textAlign: 'center' }}>
                <img
                  src={q.imageUrl || q.media_url}
                  alt="Question Diagram"
                  style={{
                    maxHeight: 220,
                    maxWidth: '100%',
                    objectFit: 'contain',
                    borderRadius: 12,
                    border: '3px solid var(--ink)',
                    boxShadow: '4px 4px 0 var(--ink)',
                    margin: '0 auto',
                    background: 'var(--paper-2)'
                  }}
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.display = 'none'
                  }}
                />
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {dist.map((choice, ci) => (
                <div key={choice.label} style={{
                  padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8,
                  border: 'var(--line)',
                  background: (gameState.status !== 'question_active' && choice.isCorrect) ? 'var(--mint)' : distColors[ci % distColors.length] + '20',
                  boxShadow: '2px 2px 0 var(--ink)'
                }}>
                  <span style={{ fontFamily: 'Space Grotesk', fontWeight: 900, fontSize: 14, color: 'var(--ink)' }}>{choice.label}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1, color: 'var(--ink)', fontFamily: 'Inter' }}>{choice.text}</span>
                  {gameState.status !== 'question_active' && choice.isCorrect && <span style={{ color: 'var(--ink)', fontSize: 16, fontWeight: 900 }}>✓</span>}
                  <span style={{ fontSize: 12, color: 'var(--ink)', fontFamily: 'Space Grotesk', opacity: 0.7, fontWeight: 700 }}>{choice.count}</span>
                </div>
              ))}
            </div>

            {/* Live Submissions progress bar */}
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                <span style={{ color: 'var(--ink)', fontFamily: 'Inter', opacity: 0.7, fontWeight: 600 }}>Live Submissions</span>
                <span style={{ fontFamily: 'Space Grotesk', fontWeight: 800, color: 'var(--ink)' }}>{answered} / {totalPlayers} Answered</span>
              </div>
              <div className="timer-bar">
                <div className="timer-bar-fill" style={{ width: `${totalPlayers > 0 ? (answered / totalPlayers) * 100 : 0}%` }} />
              </div>
            </div>
          </div>

          {/* Top-3 Podium + Dual Leaderboard Switcher */}
          <div className="card anim-scale-in" style={{ padding: 20, flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 800, color: 'var(--ink)', textTransform: 'uppercase', opacity: 0.7 }}>
                🏆 Top Podium ({activeBoard === 'mastery' ? 'Accuracy' : 'Tactics'})
              </div>
              {/* Dual Leaderboard Switcher */}
              <div style={{ display: 'flex', gap: 4, background: 'var(--paper-2)', padding: 3, borderRadius: 8, border: 'var(--line)' }}>
                <button
                  onClick={() => setActiveBoard('tactics')}
                  style={{
                    fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 700, padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
                    background: activeBoard === 'tactics' ? 'var(--sun)' : 'transparent',
                    color: 'var(--ink)', border: activeBoard === 'tactics' ? '1.5px solid var(--ink)' : 'none',
                    boxShadow: activeBoard === 'tactics' ? '1px 1px 0 var(--ink)' : 'none'
                  }}
                >
                  ⚡ Tactics Board
                </button>
                <button
                  onClick={() => setActiveBoard('mastery')}
                  style={{
                    fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 700, padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
                    background: activeBoard === 'mastery' ? 'var(--mint)' : 'transparent',
                    color: 'var(--ink)', border: activeBoard === 'mastery' ? '1.5px solid var(--ink)' : 'none',
                    boxShadow: activeBoard === 'mastery' ? '1px 1px 0 var(--ink)' : 'none'
                  }}
                >
                  🎯 Mastery Board
                </button>
              </div>
            </div>

            {/* 3-Column Podium with fixed columns */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, alignItems: 'end', minHeight: 150 }}>
              {/* 🥈 2ND PLACE (LEFT) */}
              <div style={{ gridColumn: 1 }}>
                {sortedTop3[1] ? (
                  <div className="card-sm" style={{ padding: 12, textAlign: 'center' }}>
                    <div className="avatar-ring" style={{ width: 44, height: 44, margin: '0 auto 6px' }}>
                      <img src={buildAvatarUrl(sortedTop3[1].avatarSeed, sortedTop3[1].avatarStyle as any, 44)} alt="" width={44} height={44} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ink)', fontFamily: 'Space Grotesk', fontWeight: 800, opacity: 0.7 }}>2ND</div>
                    <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 12, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {getDisplayName(sortedTop3[1], 1, gameState?.aliasMode || false)}
                    </div>
                    {sortedTop3[1].streak >= 2 && (
                      <div style={{ fontSize: 10, color: 'var(--cherry)', fontFamily: 'Space Grotesk', fontWeight: 800 }}>
                        🔥 {sortedTop3[1].streak} streak
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--sky)', fontFamily: 'Space Grotesk', fontWeight: 700 }}>
                      {activeBoard === 'mastery'
                        ? `${sortedTop3[1].totalAnswered ? Math.round(((sortedTop3[1].totalCorrect || 0) / sortedTop3[1].totalAnswered) * 100) : 0}% Acc`
                        : `${sortedTop3[1].score.toLocaleString()} pts`
                      }
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: 12, textAlign: 'center', border: '1.5px dashed rgba(0,0,0,0.15)', borderRadius: 12, fontSize: 11, color: '#888', fontFamily: 'Space Grotesk' }}>
                    🥈 2nd Open
                  </div>
                )}
              </div>

              {/* 🥇 1ST PLACE (CENTER - ELEVATED) */}
              <div style={{ gridColumn: 2 }}>
                {sortedTop3[0] ? (
                  <div className="card-sm" style={{ padding: 14, textAlign: 'center', transform: 'translateY(-8px)', background: activeBoard === 'mastery' ? 'var(--mint)' : 'var(--sun)', border: '3px solid var(--ink)', boxShadow: '4px 4px 0 var(--ink)' }}>
                    <div className="avatar-ring" style={{ width: 54, height: 54, margin: '0 auto 6px', border: '3px solid var(--ink)' }}>
                      <img src={buildAvatarUrl(sortedTop3[0].avatarSeed, sortedTop3[0].avatarStyle as any, 54)} alt="" width={54} height={54} />
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ink)', fontFamily: 'Space Grotesk', fontWeight: 900 }}>👑 1ST</div>
                    <div style={{ fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {getDisplayName(sortedTop3[0], 0, gameState?.aliasMode || false)}
                    </div>
                    {sortedTop3[0].streak >= 2 && (
                      <div style={{ fontSize: 11, color: 'var(--cherry)', fontFamily: 'Space Grotesk', fontWeight: 900 }}>
                        🔥 {sortedTop3[0].streak} streak
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: 'var(--ink)', fontFamily: 'Space Grotesk', fontWeight: 900 }}>
                      {activeBoard === 'mastery'
                        ? `${sortedTop3[0].totalAnswered ? Math.round(((sortedTop3[0].totalCorrect || 0) / sortedTop3[0].totalAnswered) * 100) : 0}% Acc`
                        : `${sortedTop3[0].score.toLocaleString()} pts`
                      }
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: 16, textAlign: 'center', border: '2px dashed rgba(0,0,0,0.2)', borderRadius: 14, fontSize: 12, color: '#888', fontFamily: 'Space Grotesk', fontWeight: 700 }}>
                    🥇 1st Open
                  </div>
                )}
              </div>

              {/* 🥉 3RD PLACE (RIGHT) */}
              <div style={{ gridColumn: 3 }}>
                {sortedTop3[2] ? (
                  <div className="card-sm" style={{ padding: 12, textAlign: 'center' }}>
                    <div className="avatar-ring" style={{ width: 44, height: 44, margin: '0 auto 6px' }}>
                      <img src={buildAvatarUrl(sortedTop3[2].avatarSeed, sortedTop3[2].avatarStyle as any, 44)} alt="" width={44} height={44} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ink)', fontFamily: 'Space Grotesk', fontWeight: 800, opacity: 0.6 }}>3RD</div>
                    <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 12, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {getDisplayName(sortedTop3[2], 2, gameState?.aliasMode || false)}
                    </div>
                    {sortedTop3[2].streak >= 2 && (
                      <div style={{ fontSize: 10, color: 'var(--cherry)', fontFamily: 'Space Grotesk', fontWeight: 800 }}>
                        🔥 {sortedTop3[2].streak} streak
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--sky)', fontFamily: 'Space Grotesk', fontWeight: 700 }}>
                      {activeBoard === 'mastery'
                        ? `${sortedTop3[2].totalAnswered ? Math.round(((sortedTop3[2].totalCorrect || 0) / sortedTop3[2].totalAnswered) * 100) : 0}% Acc`
                        : `${sortedTop3[2].score.toLocaleString()} pts`
                      }
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: 12, textAlign: 'center', border: '1.5px dashed rgba(0,0,0,0.15)', borderRadius: 12, fontSize: 11, color: '#888', fontFamily: 'Space Grotesk' }}>
                    🥉 3rd Open
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: Live Student Roster with Streaks & Answer Indicators */}
        <div className="card anim-scale-in" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 800, color: 'var(--ink)', textTransform: 'uppercase', opacity: 0.7 }}>
              {activeBoard === 'mastery' ? '🎯 Mastery Roster' : '⚡ Tactics Roster'} ({totalPlayers})
            </div>
            <div style={{ display: 'flex', gap: 6, fontSize: 11 }}>
              <span style={{ color: 'var(--mint)', fontFamily: 'Space Grotesk', fontWeight: 800 }}>● {answered}</span>
              <span style={{ color: 'var(--sun)', fontFamily: 'Space Grotesk', fontWeight: 800 }}>● {totalPlayers - answered}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1, maxHeight: 480 }}>
            {rankedPlayers.map((player, pIdx) => {
              const pAcc = player.totalAnswered ? Math.round(((player.totalCorrect || 0) / player.totalAnswered) * 100) : 0
              const isEliminated = gameState.eliminatedPlayers?.includes(player.id)

              return (
                <div
                  key={player.id}
                  className="lb-row"
                  style={{
                    padding: '6px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    opacity: isEliminated ? 0.5 : 1,
                    background: isEliminated ? '#FFE4E7' : undefined
                  }}
                >
                  <div className="avatar-ring" style={{ width: 32, height: 32, flexShrink: 0 }}>
                    <img src={buildAvatarUrl(player.avatarSeed, player.avatarStyle as any, 32)} alt="" width={32} height={32} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'Space Grotesk', fontSize: 12, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ink)' }}>
                        {getDisplayName(player, pIdx, gameState?.aliasMode || false)}
                      </span>
                      {player.streak >= 2 && (
                        <span style={{ fontSize: 10, color: 'var(--cherry)', fontWeight: 900, fontFamily: 'Space Grotesk' }}>
                          🔥{player.streak}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--ink)', fontFamily: 'Inter', opacity: 0.75, fontWeight: 600 }}>
                      {activeBoard === 'mastery'
                        ? `🎯 ${pAcc}% (${player.totalCorrect || 0}/${player.totalAnswered || 0})`
                        : `⚡ ${player.score.toLocaleString()} pts`
                      }
                      {isEliminated && ' • 💀 Out'}
                    </div>
                  </div>
                  <div
                    title={player.hasAnswered ? 'Answered' : 'Thinking...'}
                    style={{ width: 9, height: 9, borderRadius: '50%', background: player.hasAnswered ? 'var(--mint)' : 'var(--sun)', border: '1.5px solid var(--ink)', flexShrink: 0 }}
                  />
                  <button onClick={() => kickPlayer(pin, player.id)} title="Kick player" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--cherry)', fontSize: 13, padding: '2px', fontWeight: 800 }}>✕</button>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <RealtimeLeaderboardModal
        isOpen={showLeaderboardModal}
        onClose={() => setShowLeaderboardModal(false)}
        players={players}
        activeBoard={activeBoard}
        setActiveBoard={setActiveBoard}
        isAliasMode={gameState?.aliasMode || false}
        toggleAliasMode={() => toggleAliasMode(pin)}
        pin={pin}
        quizTitle={gameState.quiz?.title}
      />
    </div>
  )
}

export default function HostPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)', fontFamily: 'Space Grotesk', color: 'var(--ink)', fontSize: 20, fontWeight: 700 }}>
        Loading Host Dashboard…
      </div>
    }>
      <TeacherHostDashboard />
    </Suspense>
  )
}
