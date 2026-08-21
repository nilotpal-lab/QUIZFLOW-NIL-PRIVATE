'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createSession } from '@/quizflow/sessionStore'
import { getSavedQuizzes, saveQuizDraft, deleteSavedQuiz, purgeAllSavedQuizzes, type SavedQuizItem } from '@/quizflow/quizStore'
import { parseExcelOrCSVFile } from '@/quizflow/excelQuizParser'
import type { AIGeneratedQuiz } from '@/quizflow/types'
import { useRouter } from 'next/navigation'


function formatExactTime(ts?: number) {
  if (!ts) return 'N/A'
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  })
}

export default function HostNewPage() {
  const router = useRouter()
  const [savedQuizzes, setSavedQuizzes] = useState<SavedQuizItem[]>([])
  const [selectedQuiz, setSelectedQuiz] = useState<AIGeneratedQuiz | null>(null)
  const [selectedKey, setSelectedKey] = useState<string>('')
  const [gameMode, setGameModeState] = useState<'classic' | 'boss_raid' | 'tournament'>('classic')
  const [creating, setCreating] = useState(false)
  const [previewQuiz, setPreviewQuiz] = useState<AIGeneratedQuiz | null>(null)

  const handleEditQuizInStudio = (item: SavedQuizItem) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('quizflow_edit_draft', JSON.stringify(item.quiz))
      router.push('/quizflow/studio')
    }
  }

  useEffect(() => {
    const saved = getSavedQuizzes()
    setSavedQuizzes(saved)
    // Auto-select first quiz if available
    if (saved.length > 0) {
      setSelectedQuiz(saved[0].quiz)
      setSelectedKey(`saved_${saved[0].id}`)
    }
  }, [])

  const launchQuiz = (quiz: AIGeneratedQuiz) => {
    if (!quiz || !quiz.questions || quiz.questions.length === 0) {
      alert('Cannot host a quiz with 0 questions. Please add questions first.')
      return
    }
    setCreating(true)
    const state = createSession(quiz, 'host-' + Date.now(), gameMode)
    const hostPath = '/quizflow/host'
    setTimeout(() => {
      router.push(`${hostPath}?pin=${state.pin}`)
    }, 250)
  }

  const handleStart = () => {
    if (!selectedQuiz) return
    launchQuiz(selectedQuiz)
  }

  const handleExcelImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const importedQuiz = await parseExcelOrCSVFile(file)
      saveQuizDraft(importedQuiz, false)
      const updated = getSavedQuizzes()
      setSavedQuizzes(updated)
      setSelectedQuiz(importedQuiz)
      setSelectedKey(`saved_${updated[0]?.id || Date.now()}`)
      alert(`📊 Successfully imported "${importedQuiz.title}" with ${importedQuiz.questions.length} questions & 100% verified answer keys! Click '🚀 Host Game' below to launch.`)
    } catch (err: any) {
      alert(`⚠️ Excel Import Failed: ${err?.message || 'Invalid spreadsheet structure.'}`)
    } finally {
      e.target.value = ''
    }
  }

  const handleDeleteQuiz = (id: string, title: string) => {
    if (confirm(`Are you sure you want to delete "${title}"? This will permanently delete it from both local storage and cloud database.`)) {
      deleteSavedQuiz(id)
      const updated = getSavedQuizzes()
      setSavedQuizzes(updated)
      if (updated.length > 0) {
        setSelectedQuiz(updated[0].quiz)
        setSelectedKey(`saved_${updated[0].id}`)
      } else {
        setSelectedQuiz(null)
        setSelectedKey('')
      }
    }
  }

  const handlePurgeAll = () => {
    if (confirm('🚨 ARE YOU SURE? This will PERMANENTLY PURGE ALL saved quizzes and drafts from both LocalStorage and Supabase Cloud Database!')) {
      purgeAllSavedQuizzes()
      setSavedQuizzes([])
      setSelectedQuiz(null)
      setSelectedKey('')
    }
  }

  return (
    <div className="page-wrapper memphis-bg" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div className="top-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 800 }}>⚡ QuizFlow</span>
          <span className="badge badge-sun">📡 HOST COMMAND</span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Link href="/quizflow/dashboard"><button className="btn btn-sm" style={{ background: 'var(--paper)', color: 'var(--ink)' }}>📊 Dashboard</button></Link>
          <Link href="/quizflow"><button className="btn btn-sm" style={{ background: 'var(--paper)', color: 'var(--ink)' }}>← Home</button></Link>
        </div>
      </div>

      <div style={{ maxWidth: 1000, width: '100%', margin: '0 auto', padding: '32px 20px', flex: 1 }}>

        {/* Header */}
        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <div className="badge badge-cherry" style={{ marginBottom: 10, fontSize: 12 }}>🎮 SELECT OR CREATE QUIZ</div>
          <h1 style={{ fontFamily: 'Space Grotesk', fontSize: 36, fontWeight: 900, marginBottom: 6 }}>
            Host a Live Game
          </h1>
          <p style={{ color: '#555', fontSize: 15, fontFamily: 'Inter' }}>
            Choose how you want to create your quiz, or pick from ready-to-play decks below.
          </p>
        </div>

        {/* TOP SECTION: CHOOSE HOW TO CREATE QUIZ */}
        <div style={{ marginBottom: 40 }}>
          <div style={{ textAlign: 'center', marginBottom: 18 }}>
            <span className="badge badge-sun" style={{ fontSize: 11, marginBottom: 8, display: 'inline-block' }}>
              ⚡ CHOOSE CREATION METHOD
            </span>
            <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 24, fontWeight: 900, color: 'var(--ink)' }}>
              How would you like to create your quiz?
            </h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
            
            {/* OPTION 1: CREATE WITH AI */}
            <Link href="/quizflow/studio" style={{ textDecoration: 'none' }}>
              <div
                className="btn-press card"
                style={{
                  padding: 24,
                  border: '3px solid var(--ink)',
                  borderRadius: 18,
                  background: 'var(--sun)',
                  boxShadow: '5px 5px 0px #10100F',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  height: '100%',
                  transition: 'all 0.15s ease'
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <span className="badge badge-ink" style={{ fontSize: 11 }}>🤖 10-SEC GENERATOR</span>
                    <span style={{ fontSize: 28 }}>✨</span>
                  </div>
                  <div style={{ fontFamily: 'Space Grotesk', fontSize: 22, fontWeight: 900, color: 'var(--ink)', marginBottom: 8 }}>
                    Create with AI
                  </div>
                  <p style={{ fontFamily: 'Inter', fontSize: 13.5, color: 'var(--ink)', opacity: 0.85, lineHeight: 1.5, marginBottom: 18 }}>
                    Enter any topic, paste textbook notes, documents, or YouTube URLs. QuizFlow AI instantly generates questions with Bloom's levels and explanations.
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '2px solid var(--ink)', paddingTop: 14 }}>
                  <span style={{ fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 14, color: 'var(--ink)' }}>
                    Launch AI Studio
                  </span>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'white', border: '2px solid var(--ink)', display: 'grid', placeItems: 'center', fontWeight: 900 }}>
                    →
                  </div>
                </div>
              </div>
            </Link>

            {/* OPTION 2: CREATE MANUALLY */}
            <Link href="/quizflow/studio?mode=manual" style={{ textDecoration: 'none' }}>
              <div
                className="btn-press card"
                style={{
                  padding: 24,
                  border: '3px solid var(--ink)',
                  borderRadius: 18,
                  background: 'var(--mint)',
                  boxShadow: '5px 5px 0px #10100F',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  height: '100%',
                  transition: 'all 0.15s ease'
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <span className="badge badge-ink" style={{ fontSize: 11 }}>✍️ CUSTOM BUILDER</span>
                    <span style={{ fontSize: 28 }}>📝</span>
                  </div>
                  <div style={{ fontFamily: 'Space Grotesk', fontSize: 22, fontWeight: 900, color: 'var(--ink)', marginBottom: 8 }}>
                    Create Manually
                  </div>
                  <p style={{ fontFamily: 'Inter', fontSize: 13.5, color: 'var(--ink)', opacity: 0.85, lineHeight: 1.5, marginBottom: 18 }}>
                    Type your own custom questions, answer choices (A, B, C, D), mark correct answers, customize timers, and add your own teaching explanations.
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '2px solid var(--ink)', paddingTop: 14 }}>
                  <span style={{ fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 14, color: 'var(--ink)' }}>
                    Start Manual Quiz Builder
                  </span>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'white', border: '2px solid var(--ink)', display: 'grid', placeItems: 'center', fontWeight: 900 }}>
                    →
                  </div>
                </div>
              </div>
            </Link>

            {/* OPTION 3: IMPORT EXCEL / CSV */}
            <label style={{ textDecoration: 'none', cursor: 'pointer', display: 'block' }}>
              <input
                type="file"
                accept=".csv,.xlsx,.xls,.tsv,.txt"
                onChange={handleExcelImport}
                style={{ display: 'none' }}
              />
              <div
                className="btn-press card"
                style={{
                  padding: 24,
                  border: '3px solid var(--ink)',
                  borderRadius: 18,
                  background: '#00E676',
                  boxShadow: '5px 5px 0px #10100F',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  height: '100%',
                  transition: 'all 0.15s ease'
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <span className="badge badge-ink" style={{ fontSize: 11 }}>📊 SPREADSHEET IMPORT</span>
                    <span style={{ fontSize: 28 }}>📊</span>
                  </div>
                  <div style={{ fontFamily: 'Space Grotesk', fontSize: 22, fontWeight: 900, color: 'var(--ink)', marginBottom: 8 }}>
                    Import Excel / CSV
                  </div>
                  <p style={{ fontFamily: 'Inter', fontSize: 13.5, color: 'var(--ink)', opacity: 0.85, lineHeight: 1.5, marginBottom: 18 }}>
                    Upload any Excel (.xlsx, .csv) spreadsheet. QuizFlow automatically extracts questions, choices (A, B, C, D), and green answer keys.
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '2px solid var(--ink)', paddingTop: 14 }}>
                  <span style={{ fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 14, color: 'var(--ink)' }}>
                    Upload Spreadsheet
                  </span>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'white', border: '2px solid var(--ink)', display: 'grid', placeItems: 'center', fontWeight: 900 }}>
                    →
                  </div>
                </div>
              </div>
            </label>

          </div>
        </div>

        {/* SECTION 1: YOUR SAVED & CREATED QUIZZES */}
        {savedQuizzes.length > 0 && (
          <div style={{ marginBottom: 36 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
              <div style={{ fontFamily: 'Space Grotesk', fontSize: 13, fontWeight: 900, color: '#888', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                ✅ LIBRARY-READY QUIZZES ({savedQuizzes.length}) — PUBLISHED OR PRESET, READY TO HOST
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  onClick={handlePurgeAll}
                  className="btn btn-sm btn-press"
                  style={{ background: 'var(--cherry)', color: '#fff', border: '2px solid var(--ink)', boxShadow: '2px 2px 0 var(--ink)', borderRadius: 10, padding: '6px 12px', fontSize: 12, fontWeight: 800 }}
                  title="Purge all drafts from local storage & Supabase cloud"
                >
                  🗑️ Purge All
                </button>
                <label className="btn btn-sm btn-mint cursor-pointer btn-press" style={{ background: '#00E676', border: '2px solid var(--ink)', boxShadow: '2px 2px 0 var(--ink)', borderRadius: 10, padding: '6px 14px', color: 'var(--ink)', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>
                  📊 Import Excel / CSV
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls,.tsv,.txt"
                    onChange={handleExcelImport}
                    style={{ display: 'none' }}
                  />
                </label>
                <Link href="/quizflow/studio">
                  <button className="btn btn-sm btn-violet" style={{ fontSize: 12 }}>✨ + Create in Studio</button>
                </Link>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 20 }}>
              {savedQuizzes.map((item) => (
                <div
                  key={item.id}
                  className="card"
                  style={{
                    padding: '22px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    border: '3px solid var(--ink)',
                    borderRadius: 22,
                    background: 'var(--paper)',
                    boxShadow: '5px 5px 0 var(--ink)'
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span
                        style={{
                          background: item.isDraft ? 'var(--cherry)' : '#00E676',
                          color: item.isDraft ? '#fff' : '#10100F',
                          padding: '4px 10px',
                          borderRadius: 8,
                          fontSize: 11,
                          fontWeight: 900,
                          fontFamily: 'Space Grotesk',
                          textTransform: 'uppercase',
                          border: '2px solid var(--ink)'
                        }}
                      >
                        {item.isDraft ? '📝 DRAFT' : '✅ READY'}
                      </span>
                      <span style={{ fontSize: 11, color: '#666', fontFamily: 'Inter', fontWeight: 600 }}>
                        Updated {formatExactTime(item.updatedAt)}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                      <h3 style={{ fontFamily: 'Space Grotesk', fontSize: 19, fontWeight: 900, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {item.title}
                      </h3>
                      <button
                        onClick={() => setPreviewQuiz(item.quiz)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color: '#555' }}
                        title="Quick preview questions"
                      >
                        👁 Preview
                      </button>
                    </div>

                    <p style={{ fontSize: 13, color: '#666', fontFamily: 'Inter', marginBottom: 14, lineHeight: 1.4 }}>
                      {item.description || 'Interactive live quiz ready to host'}
                    </p>

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
                      <span style={{ background: '#10100F', color: '#FFF', padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 900, textTransform: 'uppercase', fontFamily: 'Space Grotesk' }}>
                        {item.quiz.questions?.length || 0} QUESTIONS
                      </span>
                      <span style={{ background: '#38BDF8', color: '#10100F', border: '2px solid #10100F', padding: '3px 12px', borderRadius: 20, fontSize: 11, fontWeight: 900, textTransform: 'uppercase', fontFamily: 'Space Grotesk' }}>
                        {item.language || 'ENGLISH'}
                      </span>
                      <span style={{ background: '#A78BFA', color: '#FFF', border: '2px solid #10100F', padding: '3px 12px', borderRadius: 20, fontSize: 11, fontWeight: 900, textTransform: 'uppercase', fontFamily: 'Space Grotesk' }}>
                        {item.bloomLevel || 'RECALL'}
                      </span>
                    </div>
                  </div>

                  {/* 2x2 Action Buttons Layout */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, borderTop: '2px solid var(--ink)', paddingTop: 16 }}>
                    <button
                      onClick={() => launchQuiz(item.quiz)}
                      className="btn-press"
                      style={{
                        background: '#FFD54F',
                        color: '#10100F',
                        border: '2.5px solid #10100F',
                        boxShadow: '3px 3px 0 #10100F',
                        borderRadius: 12,
                        padding: '10px 0',
                        fontSize: 13,
                        fontWeight: 900,
                        textAlign: 'center',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6
                      }}
                    >
                      🚀 Host Game
                    </button>
                    <button
                      onClick={() => setPreviewQuiz(item.quiz)}
                      className="btn-press"
                      style={{
                        background: 'var(--paper)',
                        color: '#10100F',
                        border: '2.5px solid #10100F',
                        boxShadow: '3px 3px 0 #10100F',
                        borderRadius: 12,
                        padding: '10px 0',
                        fontSize: 13,
                        fontWeight: 900,
                        textAlign: 'center',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6
                      }}
                    >
                      👁 Preview
                    </button>
                    <button
                      onClick={() => handleEditQuizInStudio(item)}
                      className="btn-press"
                      style={{
                        background: 'var(--paper)',
                        color: '#10100F',
                        border: '2.5px solid #10100F',
                        boxShadow: '3px 3px 0 #10100F',
                        borderRadius: 12,
                        padding: '10px 0',
                        fontSize: 13,
                        fontWeight: 900,
                        textAlign: 'center',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6
                      }}
                    >
                      ✏️ Edit Studio
                    </button>
                    <button
                      onClick={() => handleDeleteQuiz(item.id, item.title)}
                      className="btn-press"
                      style={{
                        background: '#FFF',
                        color: '#E53935',
                        border: '2.5px solid #E53935',
                        boxShadow: '3px 3px 0 rgba(229,57,53,0.3)',
                        borderRadius: 12,
                        padding: '10px 0',
                        fontSize: 13,
                        fontWeight: 900,
                        textAlign: 'center',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6
                      }}
                    >
                      🗑️ Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* SECTION 2: QUICK-START AI STUDIO CTA */}
        {savedQuizzes.length === 0 && (
          <div style={{ marginBottom: 36 }}>
            <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 800, color: 'var(--ink)', marginBottom: 14 }}>
              🌟 Get Started
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
              <Link href="/quizflow/studio" style={{ textDecoration: 'none' }}>
                <div
                  style={{
                    height: '100%', minHeight: 180, padding: 22,
                    border: '2px dashed var(--ink)',
                    borderRadius: 16,
                    background: 'var(--paper-2)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    gap: 8, cursor: 'pointer',
                    boxShadow: '3px 3px 0 var(--ink)',
                    transition: 'transform 0.15s, box-shadow 0.15s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translate(-2px,-2px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '5px 5px 0 var(--ink)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = ''; (e.currentTarget as HTMLDivElement).style.boxShadow = '3px 3px 0 var(--ink)'; }}
                >
                  <div style={{ fontSize: 36 }}>✨</div>
                  <div style={{ fontFamily: 'Space Grotesk', fontSize: 16, fontWeight: 800, color: 'var(--violet)' }}>Create with AI Studio</div>
                  <div style={{ color: '#666', fontSize: 12, textAlign: 'center', fontFamily: 'Inter' }}>Generate on any custom topic in seconds</div>
                </div>
              </Link>
              <Link href="/quizflow/practice" style={{ textDecoration: 'none' }}>
                <div
                  style={{
                    height: '100%', minHeight: 180, padding: 22,
                    border: '2px solid var(--ink)',
                    borderRadius: 16,
                    background: 'var(--sun)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    gap: 8, cursor: 'pointer',
                    boxShadow: '3px 3px 0 var(--ink)',
                    transition: 'transform 0.15s, box-shadow 0.15s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translate(-2px,-2px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '5px 5px 0 var(--ink)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = ''; (e.currentTarget as HTMLDivElement).style.boxShadow = '3px 3px 0 var(--ink)'; }}
                >
                  <div style={{ fontSize: 36 }}>📚</div>
                  <div style={{ fontFamily: 'Space Grotesk', fontSize: 16, fontWeight: 800, color: 'var(--ink)' }}>Browse Quiz Library</div>
                  <div style={{ color: '#555', fontSize: 12, textAlign: 'center', fontFamily: 'Inter' }}>Host from 6+ verified community decks</div>
                </div>
              </Link>
            </div>
          </div>
        )}

        {/* SECTION 3: GAME MODE SELECTOR & LAUNCH */}
        <div className="card" style={{ padding: 28, border: '3px solid var(--ink)', boxShadow: '5px 5px 0 var(--ink)' }}>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <span className="badge badge-sun" style={{ marginBottom: 8, fontSize: 11 }}>🎮 SELECT GAME MODE</span>
            <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 24, fontWeight: 900, color: 'var(--ink)', margin: 0 }}>
              How do you want to play?
            </h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 24 }}>
            {/* MODE 1: CLASSIC */}
            <div
              onClick={() => setGameModeState('classic')}
              style={{
                padding: 20,
                border: '3px solid var(--ink)',
                borderRadius: 16,
                background: gameMode === 'classic' ? 'var(--sun)' : 'var(--paper)',
                boxShadow: gameMode === 'classic' ? '5px 5px 0 var(--ink)' : '2px 2px 0 var(--ink)',
                transform: gameMode === 'classic' ? 'translate(-2px,-2px)' : 'none',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                position: 'relative'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 32 }}>🎯</span>
                {gameMode === 'classic' && <span className="badge badge-mint" style={{ fontSize: 10 }}>ACTIVE</span>}
              </div>
              <div style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 900, color: 'var(--ink)', marginBottom: 4 }}>
                Classic Mode
              </div>
              <div style={{ fontFamily: 'Inter', fontSize: 12.5, color: '#555', lineHeight: 1.4 }}>
                Speed &amp; accuracy leaderboard battle. Perfect for live classroom competition.
              </div>
            </div>

            {/* MODE 2: BOSS RAID */}
            <div
              onClick={() => setGameModeState('boss_raid')}
              style={{
                padding: 20,
                border: '3px solid var(--ink)',
                borderRadius: 16,
                background: gameMode === 'boss_raid' ? 'var(--cherry)' : 'var(--paper)',
                color: gameMode === 'boss_raid' ? 'white' : 'var(--ink)',
                boxShadow: gameMode === 'boss_raid' ? '5px 5px 0 var(--ink)' : '2px 2px 0 var(--ink)',
                transform: gameMode === 'boss_raid' ? 'translate(-2px,-2px)' : 'none',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                position: 'relative'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 32 }}>🐉</span>
                {gameMode === 'boss_raid' && <span className="badge badge-sun" style={{ fontSize: 10 }}>ACTIVE</span>}
              </div>
              <div style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 900, color: gameMode === 'boss_raid' ? 'white' : 'var(--ink)', marginBottom: 4 }}>
                Boss Raid Mode
              </div>
              <div style={{ fontFamily: 'Inter', fontSize: 12.5, color: gameMode === 'boss_raid' ? 'rgba(255,255,255,0.9)' : '#555', lineHeight: 1.4 }}>
                Co-Op class battle! Students unite to damage the Boss HP with correct answers.
              </div>
            </div>

            {/* MODE 3: MULTI-ROUND TOURNAMENT */}
            <div
              onClick={() => setGameModeState('tournament')}
              style={{
                padding: 20,
                border: '3px solid var(--ink)',
                borderRadius: 16,
                background: gameMode === 'tournament' ? 'linear-gradient(135deg, #a78bfa 0%, #f472b6 100%)' : 'var(--paper)',
                color: gameMode === 'tournament' ? 'white' : 'var(--ink)',
                boxShadow: gameMode === 'tournament' ? '5px 5px 0 var(--ink)' : '2px 2px 0 var(--ink)',
                transform: gameMode === 'tournament' ? 'translate(-2px,-2px)' : 'none',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                position: 'relative'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 32 }}>🏆</span>
                {gameMode === 'tournament' ? (
                  <span className="badge badge-sun" style={{ fontSize: 10 }}>ACTIVE</span>
                ) : (
                  <span className="badge badge-mint" style={{ fontSize: 10 }}>NEW</span>
                )}
              </div>
              <div style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 900, color: gameMode === 'tournament' ? 'white' : 'var(--ink)', marginBottom: 4 }}>
                Multi-Round Tournament
              </div>
              <div style={{ fontFamily: 'Inter', fontSize: 12.5, color: gameMode === 'tournament' ? 'rgba(255,255,255,0.9)' : '#555', lineHeight: 1.4 }}>
                Multi-round elimination! Set AI rules (bottom 30%, top 5) for multi-quiz rounds.
              </div>
            </div>
          </div>

          {/* LAUNCH / CONFIGURE BUTTON */}
          {gameMode === 'tournament' ? (
            <Link href="/quizflow/host/tournament" style={{ width: '100%', textDecoration: 'none', display: 'flex', justifyContent: 'center' }}>
              <button
                className="btn btn-primary btn-lg"
                style={{
                  width: '100%', maxWidth: 520, fontSize: 18, padding: '16px 24px',
                  background: 'linear-gradient(135deg, #a78bfa 0%, #7C4DFF 100%)',
                  color: 'white', border: '3px solid var(--ink)', boxShadow: '4px 4px 0 var(--ink)',
                  fontFamily: 'Space Grotesk', fontWeight: 900, cursor: 'pointer'
                }}
              >
                🏆 Configure Multi-Round Tournament →
              </button>
            </Link>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
              <button
                className="btn btn-primary btn-lg"
                onClick={handleStart}
                disabled={!selectedQuiz || creating}
                style={{ width: '100%', maxWidth: 520, fontSize: 18, padding: '16px 24px' }}
              >
                {creating
                  ? '🚀 Creating Room...'
                  : selectedQuiz
                    ? `🚀 Launch ${gameMode === 'boss_raid' ? 'Boss Raid' : 'Classic'} Room: ${selectedQuiz.title.slice(0, 24)}...`
                    : '← Select a Quiz Above'}
              </button>
            </div>
          )}
        </div>

        {/* QUESTION PREVIEW MODAL */}
        {previewQuiz && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(16, 16, 15, 0.75)',
              backdropFilter: 'blur(6px)',
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 20
            }}
            onClick={() => setPreviewQuiz(null)}
          >
            <div
              className="card anim-scale-in"
              style={{
                maxWidth: 720,
                width: '100%',
                maxHeight: '85vh',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--paper)',
                border: '3px solid var(--ink)',
                borderRadius: 24,
                boxShadow: '8px 8px 0 var(--ink)',
                overflow: 'hidden'
              }}
              onClick={e => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div style={{ padding: '20px 24px', borderBottom: '3px solid var(--ink)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#FFFCF5' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ background: '#00E676', color: '#10100F', padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 900, fontFamily: 'Space Grotesk' }}>
                      👁 PREVIEW
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#666' }}>
                      {previewQuiz.questions?.length || 0} Questions
                    </span>
                  </div>
                  <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 900, color: 'var(--ink)' }}>
                    {previewQuiz.title}
                  </h2>
                </div>
                <button
                  onClick={() => setPreviewQuiz(null)}
                  style={{ background: '#FFF', border: '2px solid var(--ink)', borderRadius: 10, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 900, cursor: 'pointer' }}
                >
                  ✕
                </button>
              </div>

              {/* Questions Scrollable List */}
              <div style={{ padding: '20px 24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
                {previewQuiz.questions?.map((q, idx) => (
                  <div
                    key={idx}
                    style={{
                      background: '#FFF',
                      border: '2px solid var(--ink)',
                      borderRadius: 14,
                      padding: '16px 18px',
                      boxShadow: '3px 3px 0 var(--ink)'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                      <div style={{ fontFamily: 'Space Grotesk', fontSize: 14, fontWeight: 900, color: 'var(--ink)' }}>
                        <span style={{ background: 'var(--sun)', padding: '2px 6px', borderRadius: 6, marginRight: 8, fontSize: 11 }}>Q{idx + 1}</span>
                        {q.prompt}
                      </div>
                      <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', background: '#F1F5F9', padding: '2px 8px', borderRadius: 12, border: '1px solid #CBD5E1' }}>
                        {q.difficulty || 'Medium'}
                      </span>
                    </div>

                    {/* Choices */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                      {q.choices.map((choice, cIdx) => {
                        const isCorrect = cIdx === q.correct_index
                        return (
                          <div
                            key={cIdx}
                            style={{
                              padding: '8px 12px',
                              borderRadius: 8,
                              fontSize: 12,
                              fontFamily: 'Inter',
                              fontWeight: isCorrect ? 800 : 500,
                              background: isCorrect ? '#D6FFF4' : '#F8FAFC',
                              border: isCorrect ? '2px solid #00E676' : '1.5px solid #E2E8F0',
                              color: isCorrect ? '#007A3D' : '#334155',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6
                            }}
                          >
                            <span style={{ fontWeight: 900 }}>{String.fromCharCode(65 + cIdx)}.</span>
                            <span>{choice}</span>
                            {isCorrect && <span style={{ marginLeft: 'auto', fontSize: 13 }}>✓</span>}
                          </div>
                        )
                      })}
                    </div>

                    {q.explanation && (
                      <div style={{ fontSize: 11, color: '#64748B', fontFamily: 'Inter', background: '#F8FAFC', padding: '6px 10px', borderRadius: 6, borderLeft: '3px solid #00E676' }}>
                        💡 <strong>Explanation:</strong> {q.explanation}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Modal Footer */}
              <div style={{ padding: '16px 24px', borderTop: '2px solid var(--ink)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#FFFCF5' }}>
                <button
                  onClick={() => setPreviewQuiz(null)}
                  className="btn btn-sm"
                  style={{ background: 'var(--paper)', border: '2px solid var(--ink)', borderRadius: 10, fontWeight: 800 }}
                >
                  Close Preview
                </button>
                <button
                  onClick={() => {
                    const q = previewQuiz
                    setPreviewQuiz(null)
                    launchQuiz(q)
                  }}
                  className="btn btn-sun btn-sm"
                  style={{ fontWeight: 900 }}
                >
                  🚀 Host This Quiz Now
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

