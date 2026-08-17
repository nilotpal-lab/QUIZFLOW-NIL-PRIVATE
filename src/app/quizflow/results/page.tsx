'use client'
import { Suspense, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { subscribeToSession } from '@/quizflow/sessionStore'
import type { GameState, Player } from '@/quizflow/sessionStore'
import { buildAvatarUrl } from '@/quizflow/utils'
import { playLevelUpFanfare, playClickSound } from '@/quizflow/sound'

function ResultsInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pin = searchParams.get('pin') || ''
  const myPid = searchParams.get('pid') || ''

  const [gameState, setGameState] = useState<GameState | null>(null)
  const [confetti, setConfetti] = useState<Array<{ id: number; x: number; color: string; delay: number; size: number }>>([])
  const [activeBoard, setActiveBoard] = useState<'tactics' | 'mastery'>('tactics')
  const [sessionTimeout, setSessionTimeout] = useState(false)

  // Timeout guard if session is missing
  useEffect(() => {
    if (!pin) return
    const t = setTimeout(() => {
      if (!gameState) setSessionTimeout(true)
    }, 5000)
    return () => clearTimeout(t)
  }, [pin, gameState])

  // Live session subscription
  useEffect(() => {
    if (!pin) return
    const unsub = subscribeToSession(pin, (state) => {
      if (state) setGameState(state)
    })
    return unsub
  }, [pin])

  // Play victory fanfare & launch celebratory confetti
  useEffect(() => {
    if (!gameState) return
    playLevelUpFanfare()
    const colors = ['#D9364A', '#FFE57F', '#00E676', '#40C4FF', '#7C4DFF', '#FF4081']
    setConfetti(Array.from({ length: 25 }, (_, i) => ({
      id: i,
      x: ((i * 37) % 94) + 3,
      color: colors[i % colors.length],
      delay: (i * 0.12) % 2,
      size: 8 + (i % 6),
    })))
  }, [gameState?.pin])

  if (!gameState) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--paper)] p-4">
        <div className="hard bg-[var(--paper-2)] rounded-[var(--radius-card)] p-8 text-center max-w-[380px] w-full">
          {sessionTimeout ? (
            <>
              <div className="text-[48px] mb-3">🏁</div>
              <h2 className="font-display font-[800] text-[22px] mb-2">Results Not Found</h2>
              <p className="text-[13px] opacity-70 mb-6">This game session has ended or PIN {pin} is invalid.</p>
            </>
          ) : (
            <>
              <div className="text-[48px] mb-3 animate-[float_1.5s_ease-in-out_infinite]">⏳</div>
              <h2 className="font-display font-[800] text-[20px] mb-2">Loading Podium…</h2>
              <p className="text-[13px] opacity-70 mb-6">Calculating scores & ranking players…</p>
            </>
          )}
          <button
            onClick={() => router.push('/')}
            className="w-full h-[48px] hard btn-press bg-[var(--violet)] text-white rounded-[12px] font-display font-[800] text-[14px]"
          >
            ← Back to Home
          </button>
        </div>
      </div>
    )
  }

  const players = Object.values(gameState.players).sort((a, b) => b.score - a.score)
  const totalPlayers = players.length
  const me = myPid ? gameState.players[myPid] : null
  const first = players[0] || null
  const second = players[1] || null
  const third = players[2] || null

  // ── Calculate Performance Badges ──
  const metricsMap = players.map(p => {
    const ansCount = p.totalAnswered || (p.score > 0 ? 1 : 0)
    const corrCount = p.totalCorrect || (p.score > 0 ? 1 : 0)
    const totalTime = p.totalResponseTimeMs || 0
    const avgResponseMs = ansCount > 0 ? totalTime / ansCount : Infinity
    const accuracy = ansCount > 0 ? corrCount / ansCount : 0
    const streakVal = p.maxStreak ?? p.streak ?? 0

    return { id: p.id, avgResponseMs, accuracy, streakVal, ansCount }
  })

  // ⚡ Speed Demon
  let speedDemonId: string | null = null
  let minAvgMs = Infinity
  metricsMap.forEach(m => {
    if (m.ansCount > 0 && m.avgResponseMs < minAvgMs && m.avgResponseMs > 0) {
      minAvgMs = m.avgResponseMs
      speedDemonId = m.id
    }
  })

  // 🎯 Sharpshooter
  const sharpshooterIds = new Set(
    metricsMap.filter(m => m.ansCount > 0 && m.accuracy === 1).map(m => m.id)
  )

  // 🔥 Fire Starter
  let fireStarterId: string | null = null
  let maxStreakVal = 1
  metricsMap.forEach(m => {
    if (m.streakVal > maxStreakVal) {
      maxStreakVal = m.streakVal
      fireStarterId = m.id
    }
  })

  const renderBadges = (pId: string) => {
    const badges = []
    if (pId === speedDemonId) {
      badges.push(
        <span key="speed" className="hard bg-[#E0F5FF] text-[var(--ink)] text-[10px] font-display font-[800] px-2 py-0.5 rounded-[6px]">
          ⚡ SPEED DEMON
        </span>
      )
    }
    if (sharpshooterIds.has(pId)) {
      badges.push(
        <span key="sharp" className="hard bg-[#D6FFF4] text-[var(--ink)] text-[10px] font-display font-[800] px-2 py-0.5 rounded-[6px]">
          🎯 SHARPSHOOTER
        </span>
      )
    }
    if (pId === fireStarterId) {
      badges.push(
        <span key="fire" className="hard bg-[#FFEBEA] text-[var(--cherry)] text-[10px] font-display font-[800] px-2 py-0.5 rounded-[6px]">
          🔥 FIRE STARTER
        </span>
      )
    }
    return badges.length > 0 ? (
      <div className="flex gap-1.5 flex-wrap justify-center mt-1.5">
        {badges}
      </div>
    ) : null
  }

  return (
    <div className="min-h-screen bg-[var(--paper)] selection:bg-[#FFE57F] flex flex-col justify-between relative overflow-x-hidden">
      {/* Celebratory Confetti */}
      {confetti.map(c => (
        <div
          key={c.id}
          className="fixed pointer-events-none z-30"
          style={{
            top: -20,
            left: `${c.x}%`,
            width: c.size,
            height: c.size,
            backgroundColor: c.color,
            borderRadius: 2,
            border: '1px solid #10100F',
            animation: `confettiFall 4s ${c.delay}s ease-in infinite`
          }}
        />
      ))}

      {/* Top Bar */}
      <nav className="sticky top-0 z-40 bg-[var(--paper)] border-b-[3px] border-[var(--ink)]">
        <div className="max-w-[1280px] mx-auto px-4 md:px-6 h-[64px] flex items-center justify-between">
          <div className="font-display font-[800] text-[24px] tracking-tight flex items-center gap-1 cursor-pointer" onClick={() => router.push('/quizflow')}>
            <span>⚡</span> QuizFlow
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => router.push('/quizflow')} className="hard bg-white rounded-full px-3.5 py-1.5 text-[12px] font-display font-bold">
              🏠 Home
            </button>
            <button onClick={() => router.push('/quizflow/host/new')} className="hard bg-[var(--violet)] text-white rounded-full px-3.5 py-1.5 text-[12px] font-display font-bold">
              🎮 Host New Game
            </button>
          </div>
        </div>
      </nav>

      {/* Main Podium Arena */}
      <main className="max-w-[960px] w-full mx-auto px-4 md:px-6 py-8 flex-1 flex flex-col items-center">
        
        {/* Title Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 hard bg-[var(--sun)] px-4 py-1.5 rounded-full font-display font-[800] text-[13px] mb-3">
            <span>🏆</span> LIVE GAME RESULTS
          </div>
          <h1 className="font-display font-[900] text-[36px] md:text-[48px] tracking-tight leading-none uppercase">
            FINAL RESULTS!
          </h1>
          <p className="text-[14px] opacity-70 mt-2 font-display">
            {gameState.quiz.title} · {totalPlayers} {totalPlayers === 1 ? 'Player' : 'Players'} Competed
          </p>
        </div>

        {/* 🏛️ 3D OLYMPIC PODIUM (SILVER 2ND, GOLD 1ST, BRONZE 3RD) */}
        <section className="w-full max-w-[680px] mb-10">
          <div className="grid grid-cols-3 gap-2 md:gap-4 items-end justify-center">
            
            {/* 🥈 2ND PLACE (SILVER - LEFT) */}
            <div className="flex flex-col items-center">
              {second ? (
                <>
                  <div className="relative mb-2">
                    <div className="w-[64px] h-[64px] md:w-[72px] h-[72px] rounded-full bg-[#C0C0C0] border-[3px] border-[var(--ink)] shadow-[3px_3px_0px_#10100F] overflow-hidden flex items-center justify-center text-[32px]">
                      <img src={buildAvatarUrl(second.avatarSeed, second.avatarStyle as any, 72)} alt={second.nickname} className="w-full h-full object-cover" />
                    </div>
                    <span className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-white border-[2px] border-[var(--ink)] flex items-center justify-center text-[14px] font-display font-[800]">
                      🥈
                    </span>
                  </div>
                  <div className="font-display font-[800] text-[14px] md:text-[16px] truncate max-w-[110px] text-center">{second.nickname}</div>
                  <div className="font-display font-[700] text-[12px] opacity-70 mb-2">{second.score.toLocaleString()} pts</div>
                </>
              ) : (
                <div className="text-center mb-2 opacity-40">
                  <div className="w-[52px] h-[52px] rounded-full border-[2px] border-dashed border-[var(--ink)] mx-auto flex items-center justify-center text-[18px]">🥈</div>
                  <div className="font-display text-[12px] mt-1">—</div>
                </div>
              )}
              {/* Stepped Pedestal */}
              <div className="w-full h-[170px] md:h-[200px] hard bg-[#C0C0C0] rounded-t-[16px] flex flex-col items-center justify-end pb-4 relative overflow-hidden">
                <div className="absolute top-3 left-1/2 -translate-x-1/2 w-16 h-[2px] bg-white/40 rounded-full" />
                <div className="font-display font-[900] text-[36px] md:text-[44px] text-white select-none">2</div>
                <div className="font-display font-[800] text-[10px] tracking-widest text-[var(--ink)] uppercase">SILVER</div>
              </div>
            </div>

            {/* 👑 1ST PLACE (GOLD CHAMPION - CENTER) */}
            <div className="flex flex-col items-center z-10">
              {first ? (
                <>
                  <div className="relative mb-2">
                    <div className="absolute -top-7 left-1/2 -translate-x-1/2 text-[26px] animate-[float_2s_ease-in-out_infinite]">
                      👑
                    </div>
                    <div className="w-[78px] h-[78px] md:w-[90px] md:h-[90px] rounded-full bg-[#FFD700] border-[4px] border-[var(--ink)] shadow-[4px_4px_0px_#10100F] overflow-hidden flex items-center justify-center text-[40px]">
                      <img src={buildAvatarUrl(first.avatarSeed, first.avatarStyle as any, 90)} alt={first.nickname} className="w-full h-full object-cover" />
                    </div>
                    <span className="absolute -top-1 -right-1 text-[14px] animate-[starTwinkle_1.2s_ease-in-out_infinite]">✨</span>
                    <span className="absolute -bottom-1 -left-1 text-[12px] animate-[starTwinkle_1.4s_ease-in-out_infinite]">⭐</span>
                  </div>
                  <div className="font-display font-[900] text-[16px] md:text-[20px] truncate max-w-[130px] text-center text-[var(--ink)]">{first.nickname}</div>
                  <div className="font-display font-[800] text-[14px] md:text-[16px] text-[#00701A] mb-2">{first.score.toLocaleString()} pts</div>
                </>
              ) : null}
              {/* Tallest Center Pedestal */}
              <div className="w-full h-[230px] md:h-[270px] hard bg-[#FFD700] rounded-t-[20px] flex flex-col items-center justify-end pb-5 relative overflow-hidden">
                <div className="absolute top-0 inset-x-0 h-[6px] bg-white/50" />
                <div className="font-display font-[900] text-[54px] md:text-[64px] text-[var(--ink)] leading-none select-none">1</div>
                <div className="font-display font-[900] text-[11px] tracking-widest text-[var(--ink)] uppercase mt-1">CHAMPION</div>
              </div>
            </div>

            {/* 🥉 3RD PLACE (BRONZE - RIGHT) */}
            <div className="flex flex-col items-center">
              {third ? (
                <>
                  <div className="relative mb-2">
                    <div className="w-[60px] h-[60px] md:w-[68px] md:h-[68px] rounded-full bg-[#CD7F32] border-[3px] border-[var(--ink)] shadow-[3px_3px_0px_#10100F] overflow-hidden flex items-center justify-center text-[30px]">
                      <img src={buildAvatarUrl(third.avatarSeed, third.avatarStyle as any, 68)} alt={third.nickname} className="w-full h-full object-cover" />
                    </div>
                    <span className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-white border-[2px] border-[var(--ink)] flex items-center justify-center text-[14px] font-display font-[800]">
                      🥉
                    </span>
                  </div>
                  <div className="font-display font-[800] text-[14px] md:text-[16px] truncate max-w-[110px] text-center">{third.nickname}</div>
                  <div className="font-display font-[700] text-[12px] opacity-70 mb-2">{third.score.toLocaleString()} pts</div>
                </>
              ) : (
                <div className="text-center mb-2 opacity-40">
                  <div className="w-[52px] h-[52px] rounded-full border-[2px] border-dashed border-[var(--ink)] mx-auto flex items-center justify-center text-[18px]">🥉</div>
                  <div className="font-display text-[12px] mt-1">—</div>
                </div>
              )}
              {/* Stepped Pedestal */}
              <div className="w-full h-[130px] md:h-[150px] hard bg-[#CD7F32] rounded-t-[16px] flex flex-col items-center justify-end pb-3 relative overflow-hidden">
                <div className="font-display font-[900] text-[32px] md:text-[38px] text-white select-none">3</div>
                <div className="font-display font-[800] text-[10px] tracking-widest text-white uppercase">BRONZE</div>
              </div>
            </div>

          </div>
        </section>

        {/* 🎖️ PERSONALIZED PLAYER CELEBRATION CARD */}
        {me && (
          <div className="w-full max-w-[680px] hard bg-[var(--paper-2)] rounded-[var(--radius-card)] p-5 md:p-6 mb-6 flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4 text-center md:text-left">
              <div className="w-[60px] h-[60px] rounded-full border-[3px] border-[var(--ink)] bg-white overflow-hidden shrink-0 shadow-[2px_2px_0px_#10100F]">
                <img src={buildAvatarUrl(me.avatarSeed, me.avatarStyle as any, 60)} alt={me.nickname} className="w-full h-full object-cover" />
              </div>
              <div>
                <h3 className="font-display font-[800] text-[18px] md:text-[20px]">
                  {first?.id === me.id ? '🎉 YOU ARE THE CHAMPION!' : second?.id === me.id || third?.id === me.id ? '🥈 PODIUM FINISH!' : '💪 SOLID PERFORMANCE!'}
                </h3>
                <p className="text-[13px] opacity-70 font-display">
                  {me.nickname} · Rank #{players.findIndex(p => p.id === me.id) + 1} of {totalPlayers}
                </p>
                {renderBadges(me.id)}
              </div>
            </div>

            <div className="flex gap-2 shrink-0">
              <div className="hard bg-white rounded-[10px] px-3.5 py-2 text-center">
                <div className="font-display text-[10px] font-[800] opacity-60 uppercase">Score</div>
                <div className="font-display font-[800] text-[18px] text-[#00701A]">{me.score.toLocaleString()}</div>
              </div>
              <div className="hard bg-white rounded-[10px] px-3.5 py-2 text-center">
                <div className="font-display text-[10px] font-[800] opacity-60 uppercase">Correct</div>
                <div className="font-display font-[800] text-[18px]">{me.totalCorrect || 0}/{me.totalAnswered || 0}</div>
              </div>
              <div className="hard bg-white rounded-[10px] px-3.5 py-2 text-center">
                <div className="font-display text-[10px] font-[800] opacity-60 uppercase">Streak</div>
                <div className="font-display font-[800] text-[18px] text-[var(--cherry)]">{me.maxStreak ?? me.streak ?? 0}x</div>
              </div>
            </div>
          </div>
        )}

        {/* 📊 FULL LEADERBOARD WITH DUAL BOARD SWITCHER */}
        <section className="w-full max-w-[680px] hard bg-[var(--paper)] rounded-[var(--radius-card)] p-5 md:p-6 mb-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mb-5 border-b-[2px] border-[var(--ink)] pb-4">
            <h3 className="font-display font-[800] text-[14px] uppercase tracking-wider">
              FULL LEADERBOARD ({totalPlayers} {totalPlayers === 1 ? 'PLAYER' : 'PLAYERS'})
            </h3>
            
            {/* Dual Board Toggle */}
            <div className="hard bg-[var(--paper-2)] p-1 rounded-full flex gap-1">
              <button
                onClick={() => { playClickSound(); setActiveBoard('tactics') }}
                className={`font-display text-[11px] font-[800] px-3 py-1 rounded-full transition-all ${
                  activeBoard === 'tactics' ? 'bg-[var(--sun)] text-[var(--ink)] shadow-[2px_2px_0px_#10100F]' : 'opacity-70'
                }`}
              >
                ⚡ Tactics Board
              </button>
              <button
                onClick={() => { playClickSound(); setActiveBoard('mastery') }}
                className={`font-display text-[11px] font-[800] px-3 py-1 rounded-full transition-all ${
                  activeBoard === 'mastery' ? 'bg-[var(--mint)] text-[var(--ink)] shadow-[2px_2px_0px_#10100F]' : 'opacity-70'
                }`}
              >
                🎯 Mastery Board
              </button>
            </div>
          </div>

          {/* Roster List */}
          <div className="space-y-2.5">
            {(activeBoard === 'mastery'
              ? [...players].sort((a, b) => {
                  const aAcc = a.totalAnswered ? (a.totalCorrect || 0) / a.totalAnswered : 0
                  const bAcc = b.totalAnswered ? (b.totalCorrect || 0) / b.totalAnswered : 0
                  return bAcc - aAcc
                })
              : players
            ).map((p, idx) => {
              const accPct = p.totalAnswered ? Math.round(((p.totalCorrect || 0) / p.totalAnswered) * 100) : 0
              const isTop = idx === 0
              return (
                <div
                  key={p.id}
                  className={`hard rounded-[12px] p-3.5 flex items-center justify-between gap-3 transition-all ${
                    p.id === myPid ? 'bg-[#F3E8FF] border-[var(--violet)]' : 'bg-[var(--paper-2)]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-display font-[900] text-[16px] min-w-[28px] text-center">
                      {idx === 0 ? '👑' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`}
                    </span>
                    <div className="w-[42px] h-[42px] rounded-full border-[2px] border-[var(--ink)] bg-white overflow-hidden shrink-0">
                      <img src={buildAvatarUrl(p.avatarSeed, p.avatarStyle as any, 42)} alt={p.nickname} className="w-full h-full object-cover" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-display font-[800] text-[14px] truncate">
                        {p.nickname} {p.id === myPid && <span className="text-[11px] text-[var(--violet)]">(You)</span>}
                      </div>
                      {renderBadges(p.id)}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="font-display font-[900] text-[15px] text-[var(--ink)]">
                      {activeBoard === 'mastery' ? `🎯 ${accPct}% Acc` : `${p.score.toLocaleString()} pts`}
                    </div>
                    <div className="text-[11px] font-display opacity-60">
                      {p.totalCorrect || 0}/{p.totalAnswered || 0} Correct · {p.maxStreak ?? p.streak ?? 0}x Streak
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* 📖 QUESTION-BY-QUESTION EDUCATIONAL REVIEW ACCORDION */}
        {gameState.quiz?.questions && gameState.quiz.questions.length > 0 && (
          <section className="w-full max-w-[680px] hard bg-[var(--paper)] rounded-[var(--radius-card)] p-5 md:p-6 mb-8">
            <div className="flex items-center justify-between gap-3 mb-5 border-b-[2px] border-[var(--ink)] pb-4">
              <div>
                <h3 className="font-display font-[800] text-[14px] uppercase tracking-wider">
                  📖 Question-by-Question Review
                </h3>
                <p className="text-[12px] opacity-70 mt-0.5">Mastery explanations and diagnostic misconceptions</p>
              </div>
              <span className="badge badge-sun text-[11px] font-bold">
                {gameState.quiz.questions.length} Concepts
              </span>
            </div>

            <div className="space-y-4">
              {gameState.quiz.questions.map((qItem, qIdx) => (
                <div key={qIdx} className="hard bg-[var(--paper-2)] rounded-[12px] p-4 border-[2px] border-[var(--ink)]">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <span className="font-display font-[900] text-[12px] bg-[var(--ink)] text-[var(--paper)] px-2 py-0.5 rounded-[4px] shrink-0">
                      Q{qIdx + 1}
                    </span>
                    <h4 className="font-display font-[700] text-[14px] leading-snug flex-1 text-[var(--ink)]">
                      {qItem.prompt}
                    </h4>
                  </div>

                  {/* Choice Pills */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 mb-3">
                    {qItem.choices.map((choice, cIdx) => {
                      const isCorrect = cIdx === qItem.correct_index
                      return (
                        <div
                          key={cIdx}
                          className={`px-3 py-2 rounded-[8px] border-[1.5px] text-[12px] font-medium flex items-center justify-between gap-2 ${
                            isCorrect
                              ? 'bg-[var(--mint)] border-[#00A872] font-bold text-[var(--ink)] shadow-[1px_1px_0px_#10100F]'
                              : 'bg-white border-black/10 text-black/70'
                          }`}
                        >
                          <span>{String.fromCharCode(65 + cIdx)}. {choice}</span>
                          {isCorrect && <span className="font-bold text-[#00701A]">✓ Correct</span>}
                        </div>
                      )
                    })}
                  </div>

                  {/* Explanation & Misconceptions */}
                  {qItem.explanation && (
                    <div className="mt-2 text-[12px] bg-[#FFF8EB] border-[1.5px] border-[#FFE57F] p-2.5 rounded-[8px] text-[var(--ink)]">
                      <span className="font-bold">💡 Core Explanation: </span>
                      <span className="opacity-90">{qItem.explanation}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 🎮 ACTION CTA DECK */}
        <div className="w-full max-w-[680px] grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
          <button
            onClick={() => { playClickSound(); router.push('/quizflow/host/new') }}
            className="h-[52px] hard btn-press bg-[var(--ink)] text-white rounded-[12px] font-display font-[800] text-[14px] flex items-center justify-center gap-2"
          >
            <span>🎮</span> Play Again
          </button>
          <button
            onClick={() => { playClickSound(); router.push('/quizflow/practice') }}
            className="h-[52px] hard btn-press bg-[var(--sun)] text-[var(--ink)] rounded-[12px] font-display font-[800] text-[14px] flex items-center justify-center gap-2"
          >
            <span>🎴</span> Review in Practice Mode
          </button>
          <button
            onClick={() => { playClickSound(); router.push('/quizflow') }}
            className="h-[52px] hard btn-press bg-white text-[var(--ink)] rounded-[12px] font-display font-[800] text-[14px] flex items-center justify-center gap-2"
          >
            <span>🏠</span> Back to Home
          </button>
        </div>

      </main>

      {/* Footer */}
      <footer className="border-t-[3px] border-[var(--ink)] bg-[var(--paper-2)] py-3 text-center font-display text-[11px] tracking-wide opacity-60">
        ⚡ QuizFlow Results Podium · Space Grotesk + Inter · Neo-Brutalist Memphis Aesthetics
      </footer>

      <style>{`
        @keyframes confettiFall {
          0% { transform: translateY(-20px) rotate(0deg); opacity: 1; }
          100% { transform: translateY(110vh) rotate(720deg); opacity: 0; }
        }
      `}</style>
    </div>
  )
}

export default function ResultsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-[var(--paper)] font-display text-[20px] font-bold">
        Loading Results…
      </div>
    }>
      <ResultsInner />
    </Suspense>
  )
}
