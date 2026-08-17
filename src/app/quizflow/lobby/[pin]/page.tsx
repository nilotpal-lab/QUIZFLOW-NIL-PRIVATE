'use client'
import { useEffect, useState, useCallback, useRef, Suspense } from 'react'
import Link from 'next/link'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { subscribeToSession, joinSessionAsync, sendReaction } from '@/quizflow/sessionStore'
import type { GameState } from '@/quizflow/sessionStore'
import { buildAvatarUrl, safeGetSessionStorage, safeSetSessionStorage } from '@/quizflow/utils'
import { playClickSound } from '@/quizflow/sound'
import { FloatingReactions } from '@/quizflow/FloatingReactions'

// Feature Flag: Suspended for live freshers event
const ENABLE_EMOJI_REACTIONS = false

function LobbyInner() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pin = params.pin as string

  const pidFromUrl = searchParams.get('pid')

  const [playerId] = useState(() => {
    if (pidFromUrl) {
      safeSetSessionStorage('qf_pid_' + pin, pidFromUrl)
      return pidFromUrl
    }
    const saved = safeGetSessionStorage('qf_pid_' + pin)
    if (saved) return saved
    const newId = 'player_' + Date.now() + '_' + Math.random().toString(36).slice(2)
    safeSetSessionStorage('qf_pid_' + pin, newId)
    return newId
  })

  const [nickname] = useState(() => {
    const fromUrl = searchParams.get('nickname') || searchParams.get('nick')
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

  const [gameState, setGameState]  = useState<GameState | null>(null)
  const [joined, setJoined]        = useState(false)
  const [error, setError]          = useState('')
  const [avatarRotation, setAvatarRotation] = useState(0)
  const [dots, setDots]            = useState('.')
  const hasNavigatedRef            = useRef(false)

  const handleAvatarFlip = () => {
    setAvatarRotation(r => r + 360)
    playClickSound()
  }

  // Keep screen awake while waiting in lobby
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

  // Prefetch play and results routes for instantaneous transition
  useEffect(() => {
    if (pin && playerId) {
      router.prefetch(`/quizflow/play?pin=${pin}&pid=${playerId}&nickname=${encodeURIComponent(nickname)}&seed=${encodeURIComponent(avatarSeed)}&style=${avatarStyle}`)
      router.prefetch(`/quizflow/results?pin=${pin}&pid=${playerId}`)
    }
  }, [pin, playerId, nickname, avatarSeed, avatarStyle, router])

  // Animated waiting dots
  useEffect(() => {
    const t = setInterval(() => setDots(d => d.length >= 3 ? '.' : d + '.'), 600)
    return () => clearInterval(t)
  }, [])

  // Join room with auto-retry across any device / laptop / phone
  useEffect(() => {
    if (joined) return
    let isMounted = true
    let attempt = 0
    const maxAttempts = 6

    const tryJoin = () => {
      joinSessionAsync(pin, { id: playerId, nickname, avatarSeed, avatarStyle }).then((result) => {
        if (!isMounted) return
        if (result === 'ok') {
          setError('')
          setJoined(true)
        } else if (result === 'ended') {
          setError(`🚫 Game Over: Room PIN ${pin} has already ended. Please ask your host for the new Game PIN.`)
        } else if (result === 'not_found') {
          attempt++
          if (attempt < maxAttempts) {
            setTimeout(tryJoin, 400)
          } else {
            setError(`Room PIN ${pin} not found or has ended. Please check with host.`)
          }
        } else if (result === 'duplicate') {
          setError('Nickname already taken! Go back and pick another.')
        } else if (result === 'locked') {
          setError('This room is locked. Ask your teacher to unlock it.')
        }
      })
    }

    tryJoin()

    return () => {
      isMounted = false
    }
  }, [pin, nickname, avatarSeed, avatarStyle, playerId, joined])

  // Subscribe to session state changes
  useEffect(() => {
    const unsub = subscribeToSession(pin, (state) => {
      setGameState(state)
    })
    return unsub
  }, [pin])

  // Navigate smoothly when game starts or advances (including boss_frenzy)
  useEffect(() => {
    if (!gameState || hasNavigatedRef.current) return
    if (['question_active', 'question_reveal', 'leaderboard', 'boss_frenzy'].includes(gameState.status)) {
      hasNavigatedRef.current = true
      if (typeof window !== 'undefined' && window.navigator?.vibrate) {
        try { window.navigator.vibrate(40) } catch {}
      }
      router.push(`/quizflow/play?pin=${pin}&pid=${playerId}&nickname=${encodeURIComponent(nickname)}&seed=${encodeURIComponent(avatarSeed)}&style=${avatarStyle}`)
    }
    if (gameState.status === 'ended') {
      hasNavigatedRef.current = true
      router.push(`/quizflow/results?pin=${pin}&pid=${playerId}`)
    }
  }, [gameState?.status, pin, playerId, nickname, avatarSeed, avatarStyle, router])

  const playerCount = gameState ? Object.keys(gameState.players).length : 0
  const players     = gameState ? Object.values(gameState.players) : []

  if (error) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)' }}>
      <div className="card anim-scale-in" style={{ padding: '40px 32px', maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 700, marginBottom: 12, color: 'var(--cherry)' }}>{error}</div>
        <a href="/quizflow"><button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }}>← Go Back</button></a>
      </div>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--paper)', position: 'relative' }}>
      <FloatingReactions reactions={gameState?.reactions} />

      {/* Header */}
      <header className="top-bar" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px' }}>
        <div style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 800, color: 'var(--paper)' }}>
          QuizFlow <span className="badge badge-sun" style={{ fontSize: 10, verticalAlign: 'middle' }}>LOBBY</span>
        </div>
        <div className="pin-display" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 700, color: 'var(--ink)', textTransform: 'uppercase' }}>PIN</span>
          <span className="pin-code" style={{ fontSize: 26 }}>{pin}</span>
        </div>
        <div style={{ color: 'var(--paper)', fontSize: 14, fontFamily: 'Inter', fontWeight: 600 }}>
          👥 {playerCount} joined
        </div>
      </header>

      {/* Main Content */}
      <div style={{
        flex: 1,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', padding: '32px 20px', gap: 28
      }}>

        {/* Central card */}
        <div className="card anim-scale-in" style={{ padding: '36px 48px', textAlign: 'center', maxWidth: 480, width: '100%' }}>

          {/* Your avatar + name (360 flip on tap) */}
          <div
            className="avatar-ring"
            onClick={handleAvatarFlip}
            style={{
              width: 80, height: 80, margin: '0 auto 10px',
              cursor: 'pointer',
              transform: `rotate(${avatarRotation}deg)`,
              transition: 'transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)',
              userSelect: 'none'
            }}
            title="Tap to flip 360°!"
          >
            <img src={buildAvatarUrl(avatarSeed, avatarStyle, 80)} alt={nickname} width={80} height={80} />
          </div>
          <div
            onClick={handleAvatarFlip}
            style={{ fontSize: 11, color: 'var(--violet)', fontFamily: 'Space Grotesk', fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}
          >
            🔄 Tap avatar to flip!
          </div>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 22, fontWeight: 800, color: 'var(--ink)' }}>{nickname}</div>
          <div style={{ color: 'var(--ink)', fontSize: 13, fontFamily: 'Inter', marginTop: 4, opacity: 0.6 }}>
            You&apos;re in the lobby! ✅
          </div>

          {/* Emoji Reaction Buttons (Suspended for Freshers Event) */}
          {ENABLE_EMOJI_REACTIONS && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px dashed var(--ink)' }}>
              <div style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 800, textTransform: 'uppercase', color: 'var(--ink)', marginBottom: 10, opacity: 0.7 }}>
                Send Live Emoji Reaction
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                {['🔥', '👑', '⚡', '🚀', '🎃'].map(emoji => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      playClickSound()
                      sendReaction(pin, emoji, nickname)
                    }}
                    className="btn"
                    style={{
                      fontSize: 22,
                      padding: '6px 12px',
                      background: 'var(--paper)',
                      border: '2px solid var(--ink)',
                      boxShadow: '2px 2px 0 var(--ink)',
                      cursor: 'pointer',
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* PIN display */}
          <div className="pin-display" style={{ margin: '20px auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 700, textTransform: 'uppercase', color: 'var(--ink)' }}>Game PIN</span>
            <span className="pin-code" style={{ fontSize: 28 }}>{pin}</span>
          </div>

          {/* Waiting status */}
          <div style={{ marginTop: 8 }}>
            <div style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.01em' }}>
              Waiting for teacher to start{dots}
            </div>
            <div style={{ color: 'var(--ink)', fontSize: 13, fontFamily: 'Inter', marginTop: 6, opacity: 0.55 }}>
              {gameState?.quiz.title || 'Loading quiz info…'}
            </div>
          </div>

          {/* Animated 3-dot indicator */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 20 }}>
            {[0,1,2].map(i => (
              <div key={i} style={{
                width: 10, height: 10, borderRadius: '50%',
                background: 'var(--violet)',
                border: '1.5px solid var(--ink)',
                animation: `pulse-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>

          {/* Leave button */}
          <Link href="/quizflow" style={{ display: 'block', marginTop: 24 }}>
            <button className="btn btn-primary" style={{ width: '100%' }}>← Leave Lobby</button>
          </Link>
        </div>

        {/* Players joined grid */}
        {players.length > 0 && (
          <div className="card anim-fade-up" style={{ padding: 20, width: '100%', maxWidth: 560 }}>
            <div style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 700, color: 'var(--ink)', textTransform: 'uppercase', marginBottom: 14, opacity: 0.6 }}>
              Players in Room ({playerCount})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {players.map(p => (
                <div key={p.id} className="lb-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderRadius: 99 }}>
                  <div className="avatar-ring" style={{ width: 28, height: 28 }}>
                    <img src={buildAvatarUrl(p.avatarSeed, p.avatarStyle as any, 28)} alt={p.nickname} width={28} height={28} />
                  </div>
                  <span style={{ fontFamily: 'Space Grotesk', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{p.nickname}</span>
                  {p.id === playerId && <span className="badge badge-sky" style={{ fontSize: 9, padding: '2px 6px' }}>YOU</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse-dot {
          0%, 100% { transform: scale(1); opacity: 0.4; }
          50% { transform: scale(1.5); opacity: 1; }
        }
      `}</style>
    </div>
  )
}

export default function LobbyPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)', fontFamily: 'Space Grotesk', color: 'var(--ink)', fontSize: 20, fontWeight: 700 }}>
        Loading Lobby…
      </div>
    }>
      <LobbyInner />
    </Suspense>
  )
}
