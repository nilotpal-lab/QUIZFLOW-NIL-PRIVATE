'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { getHostUser, logoutHostAsync, updateHostProfile, initAuthSync, type HostUser } from '@/quizflow/authStore'
import { getSavedQuizzes, deleteSavedQuiz, saveQuizDraft, type SavedQuizItem } from '@/quizflow/quizStore'
import { getSessionHistory, type SessionHistoryRecord } from '@/quizflow/historyStore'
import { createSession } from '@/quizflow/sessionStore'
import { generatePrintableWorksheet } from '@/quizflow/pdfGenerator'
import { publishQuizToCommunity } from '@/quizflow/communityStore'
import { parseExcelOrCSVFile } from '@/quizflow/excelQuizParser'

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

function formatDuration(startedAt?: number, completedAt?: number, durationMs?: number) {
  let ms = durationMs
  if (!ms && startedAt && completedAt) {
    ms = completedAt - startedAt
  }
  if (!ms || ms <= 0) return 'Under 1 min'
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  if (mins === 0) return `${secs}s`
  return `${mins}m ${secs}s`
}

// Feature Flag: Enabled for quiz creation, library saves, and global publishing
const ENABLE_GLOBAL_PUBLISH = true

export default function TeacherDashboard() {
  const router = useRouter()
  const [user, setUser] = useState<HostUser | null>(null)
  const [activeTab, setActiveTab] = useState<'quizzes' | 'history' | 'profile'>('quizzes')

  // Quizzes & History state
  const [allQuizzes, setAllQuizzes] = useState<SavedQuizItem[]>([])
  const [history, setHistory] = useState<SessionHistoryRecord[]>([])
  const [selectedHistory, setSelectedHistory] = useState<SessionHistoryRecord | null>(null)

  // History View Sub-mode ('timeline' | 'grouped')
  const [historyViewMode, setHistoryViewMode] = useState<'timeline' | 'grouped'>('timeline')
  const [expandedQuizTitle, setExpandedQuizTitle] = useState<string | null>(null)

  // Profile Form state
  const [profileName, setProfileName]     = useState('')
  const [profileSchool, setProfileSchool] = useState('')
  const [saveSuccess, setSaveSuccess]     = useState(false)

  const [isCheckingAuth, setIsCheckingAuth] = useState(true)
  const [isOAuthPending, setIsOAuthPending] = useState(false)

  useEffect(() => {
    // Check if returning from Google OAuth redirect with code or token
    const hasOAuthParams = typeof window !== 'undefined' && (
      window.location.search.includes('code=') ||
      window.location.hash.includes('access_token=') ||
      window.location.hash.includes('error=')
    )

    if (hasOAuthParams) {
      setIsOAuthPending(true)
    }

    const hostUser = getHostUser()
    if (hostUser) {
      setUser(hostUser)
      setProfileName(hostUser.name)
      setProfileSchool(hostUser.school)
      setIsCheckingAuth(false)
    } else if (!hasOAuthParams) {
      // If not logged in and no OAuth in progress, redirect after brief check
      const timer = setTimeout(() => {
        if (!getHostUser()) {
          router.push('/quizflow/auth')
        }
      }, 1500)
      return () => clearTimeout(timer)
    }

    const unsubscribe = initAuthSync(updatedUser => {
      setIsCheckingAuth(false)
      setIsOAuthPending(false)
      if (updatedUser) {
        setUser(updatedUser)
        setProfileName(updatedUser.name)
        setProfileSchool(updatedUser.school)
      } else if (!getHostUser() && !hasOAuthParams) {
        router.push('/quizflow/auth')
      }
    })

    setAllQuizzes(getSavedQuizzes())
    setHistory(getSessionHistory())

    return () => unsubscribe()
  }, [router])

  const draftQuizzes = allQuizzes.filter(q => q.isDraft)
  const libraryReadyQuizzes = allQuizzes.filter(q => !q.isDraft)

  const [toastMsg, setToastMsg] = useState<string | null>(null)

  const handlePublishGlobal = (item: SavedQuizItem) => {
    publishQuizToCommunity(item.quiz, user?.name)
    saveQuizDraft(item.quiz, false, item.id)
    setAllQuizzes(getSavedQuizzes())
    setToastMsg('🌐 Published to Global Community Library! Visible to all users.')
    setTimeout(() => setToastMsg(null), 4000)
  }

  const handleExcelImportDashboard = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const importedQuiz = await parseExcelOrCSVFile(file)
      saveQuizDraft(importedQuiz, false)
      setAllQuizzes(getSavedQuizzes())
      setToastMsg(`📊 Imported "${importedQuiz.title}" with ${importedQuiz.questions.length} questions & 100% verified answer keys!`)
      setTimeout(() => setToastMsg(null), 5000)
    } catch (err: any) {
      alert(`⚠️ Excel Import Failed: ${err?.message || 'Invalid spreadsheet structure.'}`)
    }
  }

  const handleLogout = async () => {
    await logoutHostAsync()
    router.push('/quizflow/auth')
  }

  const handleDeleteQuiz = (id: string) => {
    if (confirm('Are you sure you want to delete this draft quiz?')) {
      deleteSavedQuiz(id)
      setAllQuizzes(getSavedQuizzes())
    }
  }

  const handleHostSavedQuiz = (item: SavedQuizItem) => {
    const state = createSession(item.quiz, 'host-' + Date.now())
    router.push(`/quizflow/host?pin=${state.pin}`)
  }

  const handleEditQuizInStudio = (item: SavedQuizItem) => {
    localStorage.setItem('qf_saved_quiz', JSON.stringify(item.quiz))
    router.push('/quizflow/studio')
  }

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault()
    const updated = updateHostProfile({ name: profileName, school: profileSchool })
    if (updated) {
      setUser(updated)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
    }
  }

  // Group history runs by quiz title
  const groupedHistoryMap = history.reduce<Record<string, SessionHistoryRecord[]>>((acc, item) => {
    const title = item.quizTitle || 'Untitled Quiz'
    if (!acc[title]) acc[title] = []
    acc[title].push(item)
    return acc
  }, {})

  if (!user) {
    return (
      <div className="page-wrapper memphis-bg" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
        <div className="card anim-scale-in" style={{ maxWidth: 440, width: '100%', padding: '40px 28px', textAlign: 'center' }}>
          <div style={{ fontSize: 52, marginBottom: 12 }}>
            {isOAuthPending ? '✨' : '🎓'}
          </div>
          <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 24, fontWeight: 900, marginBottom: 8, color: 'var(--ink)' }}>
            {isOAuthPending ? 'Connecting Google Session' : 'Teacher Workspace'}
          </h2>
          <p style={{ fontFamily: 'Inter', fontSize: 14, color: '#555', marginBottom: 28, lineHeight: 1.5 }}>
            {isOAuthPending
              ? 'Finalizing your Google sign-in credentials...'
              : isCheckingAuth
                ? 'Verifying your teacher credentials...'
                : 'Please sign in or start a free teacher session to access your saved quizzes and class history.'}
          </p>

          {!isOAuthPending && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Link href="/quizflow/auth" style={{ textDecoration: 'none' }}>
                <button className="btn btn-primary" style={{ width: '100%', height: 48, fontSize: 15 }}>
                  🔑 Sign In to Teacher Workspace →
                </button>
              </Link>

              <Link href="/quizflow" style={{ textDecoration: 'none' }}>
                <button className="btn" style={{ width: '100%', height: 44, background: 'var(--paper)', border: '2px solid var(--ink)', color: 'var(--ink)' }}>
                  ← Return to Home
                </button>
              </Link>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="page-wrapper memphis-bg" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

      {/* TOP COMMAND CENTER BAR */}
      <div className="top-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Link href="/quizflow"><button className="btn btn-sm" style={{ background: 'var(--paper)', color: 'var(--ink)' }}>← Exit Dashboard</button></Link>
          <span style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 800 }}>📊 Teacher Workspace</span>
          <span className="badge badge-sun">🎓 {user.school}</span>
        </div>

        {/* Tab Buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { id: 'quizzes', label: `📝 My Quizzes (${allQuizzes.length})` },
            { id: 'history', label: `📊 Hosted Sessions (${history.length})` },
            { id: 'profile', label: `👤 Profile` }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className="btn btn-sm"
              style={{
                fontFamily: 'Space Grotesk', fontWeight: 800,
                background: activeTab === tab.id ? 'var(--mint)' : 'var(--paper)',
                color: 'var(--ink)'
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* User Info & Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link href="/quizflow/studio"><button className="btn btn-violet btn-sm">✨ + New AI Quiz</button></Link>
          <button className="btn btn-sm" style={{ background: 'var(--cherry)', color: '#fff' }} onClick={handleLogout}>
            🚪 Logout
          </button>
        </div>
      </div>

      {/* TOAST NOTIFICATION */}
      {toastMsg && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 100,
          background: 'var(--ink)', color: '#fff',
          padding: '12px 20px', borderRadius: 12, border: '2px solid var(--sun)',
          boxShadow: 'var(--shadow-hard-lg)', fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 14
        }}>
          {toastMsg}
        </div>
      )}

      {/* MAIN CONTAINER */}
      <div style={{ flex: 1, padding: 24, maxWidth: 1280, width: '100%', margin: '0 auto' }}>

        {/* TAB 1: ALL QUIZZES (drafts + library-ready) */}
        {activeTab === 'quizzes' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 24, fontWeight: 900, color: 'var(--ink)' }}>
                  📝 My Quizzes
                </h2>
                <div style={{ fontSize: 13, color: '#555', fontFamily: 'Inter' }}>
                  Create via AI Studio, upload directly from Excel / CSV, or host games instantly.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <label className="btn btn-mint btn-md cursor-pointer btn-press" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 900, background: '#00E676', border: '3px solid var(--ink)', boxShadow: '3px 3px 0 var(--ink)', borderRadius: 12, padding: '10px 18px', color: 'var(--ink)', fontSize: 13, cursor: 'pointer' }}>
                  📊 Import Excel / CSV Quiz
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls,.tsv,.txt"
                    onChange={handleExcelImportDashboard}
                    style={{ display: 'none' }}
                  />
                </label>
                <Link href="/quizflow/practice"><button className="btn btn-violet btn-md">🌐 Browse Community</button></Link>
                <Link href="/quizflow/studio"><button className="btn btn-sun btn-md">✨ Create in Studio →</button></Link>
              </div>
            </div>

            {allQuizzes.length === 0 ? (
              <div className="card" style={{ padding: 40, textAlign: 'center' }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>📝</div>
                <h3 style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 800 }}>No Quizzes Found</h3>
                <p style={{ fontSize: 14, color: '#666', marginBottom: 16 }}>Quizzes you save in AI Studio will appear here automatically.</p>
                <Link href="/quizflow/studio"><button className="btn btn-violet">✨ Open AI Studio</button></Link>
              </div>
            ) : (
              <div>
                {/* Draft Quizzes section */}
                {draftQuizzes.length > 0 && (
                  <div style={{ marginBottom: 28 }}>
                    <div style={{ fontFamily: 'Space Grotesk', fontSize: 13, fontWeight: 800, color: '#888', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
                      📝 DRAFT QUIZZES ({draftQuizzes.length}) — In progress, not yet published
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 20 }}>
                      {draftQuizzes.map(item => (
                        <div key={item.id} className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                          <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                              <span className="badge badge-cherry">📝 Draft</span>
                              <span style={{ fontSize: 11, color: '#666', fontFamily: 'Inter' }}>
                                Updated {formatExactTime(item.updatedAt)}
                              </span>
                            </div>
                            <h3 style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 6 }}>
                              {item.title}
                            </h3>
                            <p style={{ fontSize: 13, color: '#555', fontFamily: 'Inter', marginBottom: 14, lineHeight: 1.4 }}>
                              {item.description}
                            </p>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                              <span className="badge badge-ink">{item.quiz.questions?.length || item.questionCount} Questions</span>
                              <span className="badge badge-sky">{item.language}</span>
                              <span className="badge badge-violet">{item.bloomLevel}</span>
                            </div>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: ENABLE_GLOBAL_PUBLISH ? '1fr 1fr' : '1fr', gap: 8, borderTop: '2px solid var(--ink)', paddingTop: 14 }}>
                            <button className="btn btn-sun btn-sm" style={{ fontWeight: 800 }} onClick={() => handleHostSavedQuiz(item)}>🚀 Host Game</button>
                            {ENABLE_GLOBAL_PUBLISH && (
                              <button className="btn btn-violet btn-sm" style={{ fontWeight: 800, color: '#fff' }} onClick={() => handlePublishGlobal(item)}>🌐 Publish Global</button>
                            )}
                            <button className="btn btn-sm" style={{ background: 'var(--paper-2)', color: 'var(--ink)' }} onClick={() => handleEditQuizInStudio(item)}>✏️ Edit Studio</button>
                            <button className="btn btn-sm" style={{ background: 'var(--paper)', color: 'var(--cherry)', border: '1.5px solid var(--cherry)' }} onClick={() => handleDeleteQuiz(item.id)}>🗑️ Delete</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Library-ready / Preset Quizzes section */}
                {libraryReadyQuizzes.length > 0 && (
                  <div>
                    <div style={{ fontFamily: 'Space Grotesk', fontSize: 13, fontWeight: 800, color: '#888', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
                      ✅ LIBRARY-READY QUIZZES ({libraryReadyQuizzes.length}) — Published or preset, ready to host
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 20 }}>
                      {libraryReadyQuizzes.map(item => (
                        <div key={item.id} className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                          <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                              <span className="badge badge-mint">✅ Ready</span>
                              <span style={{ fontSize: 11, color: '#666', fontFamily: 'Inter' }}>
                                Updated {formatExactTime(item.updatedAt)}
                              </span>
                            </div>
                            <h3 style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 6 }}>
                              {item.title}
                            </h3>
                            <p style={{ fontSize: 13, color: '#555', fontFamily: 'Inter', marginBottom: 14, lineHeight: 1.4 }}>
                              {item.description}
                            </p>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                              <span className="badge badge-ink">{item.quiz.questions?.length || item.questionCount} Questions</span>
                              <span className="badge badge-sky">{item.language}</span>
                              <span className="badge badge-violet">{item.bloomLevel}</span>
                            </div>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: ENABLE_GLOBAL_PUBLISH ? '1fr 1fr' : '1fr', gap: 8, borderTop: '2px solid var(--ink)', paddingTop: 14 }}>
                            <button className="btn btn-sun btn-sm" style={{ fontWeight: 800 }} onClick={() => handleHostSavedQuiz(item)}>🚀 Host Game</button>
                            {ENABLE_GLOBAL_PUBLISH && (
                              <button className="btn btn-violet btn-sm" style={{ fontWeight: 800, color: '#fff' }} onClick={() => handlePublishGlobal(item)}>🌐 Publish Global</button>
                            )}
                            <button className="btn btn-sm" style={{ background: 'var(--paper-2)', color: 'var(--ink)' }} onClick={() => handleEditQuizInStudio(item)}>✏️ Edit</button>
                            <button className="btn btn-sm" style={{ background: 'var(--paper)', color: 'var(--cherry)', border: '1.5px solid var(--cherry)' }} onClick={() => handleDeleteQuiz(item.id)}>🗑️ Delete</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: HOSTED QUIZZES & SESSION HISTORY */}
        {activeTab === 'history' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 24, fontWeight: 900, color: 'var(--ink)' }}>
                  📊 Hosted Quizzes &amp; Session History
                </h2>
                <div style={{ fontSize: 13, color: '#555', fontFamily: 'Inter' }}>
                  Track every live room session hosted so far, including exact launch/end timestamps, participant scores, and multi-run history.
                </div>
              </div>

              {/* History View Mode Selector */}
              <div style={{ display: 'flex', gap: 6, background: 'var(--paper)', padding: 4, borderRadius: 10, border: '2px solid var(--ink)' }}>
                <button
                  onClick={() => setHistoryViewMode('timeline')}
                  className="btn btn-sm"
                  style={{
                    fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 12,
                    background: historyViewMode === 'timeline' ? 'var(--sun)' : 'transparent',
                    border: historyViewMode === 'timeline' ? '1.5px solid var(--ink)' : 'none'
                  }}
                >
                  🕒 All Runs Timeline
                </button>
                <button
                  onClick={() => setHistoryViewMode('grouped')}
                  className="btn btn-sm"
                  style={{
                    fontFamily: 'Space Grotesk', fontWeight: 800, fontSize: 12,
                    background: historyViewMode === 'grouped' ? 'var(--violet)' : 'transparent',
                    color: historyViewMode === 'grouped' ? '#fff' : 'var(--ink)',
                    border: historyViewMode === 'grouped' ? '1.5px solid var(--ink)' : 'none'
                  }}
                >
                  📚 Grouped by Quiz ({Object.keys(groupedHistoryMap).length})
                </button>
              </div>
            </div>

            {history.length === 0 ? (
              <div className="card" style={{ padding: 40, textAlign: 'center' }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>🎮</div>
                <h3 style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 800 }}>No Game Sessions Hosted Yet</h3>
                <p style={{ fontSize: 14, color: '#666', marginBottom: 16 }}>Host a quiz from Studio or Preset cards to record live classroom sessions and student analytics.</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: selectedHistory ? '1fr 440px' : '1fr', gap: 20 }}>
                
                {/* MODE 1: TIMELINE VIEW */}
                {historyViewMode === 'timeline' && (
                  <div className="card" style={{ padding: 20 }}>
                    <div style={{ fontFamily: 'Space Grotesk', fontSize: 14, fontWeight: 800, marginBottom: 12, color: '#666' }}>
                      Showing all {history.length} hosted session runs (newest first)
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid var(--ink)', fontFamily: 'Space Grotesk', fontSize: 12, textTransform: 'uppercase' }}>
                          <th style={{ padding: 10 }}>PIN</th>
                          <th style={{ padding: 10 }}>Quiz Title</th>
                          <th style={{ padding: 10 }}>Launched Time</th>
                          <th style={{ padding: 10 }}>Ended Time</th>
                          <th style={{ padding: 10 }}>Duration</th>
                          <th style={{ padding: 10 }}>Players</th>
                          <th style={{ padding: 10 }}>Accuracy</th>
                          <th style={{ padding: 10 }}>Winner</th>
                          <th style={{ padding: 10, textAlign: 'right' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map(rec => (
                          <tr key={rec.id} style={{ borderBottom: '1px solid #eee', fontSize: 13, fontFamily: 'Inter' }}>
                            <td style={{ padding: 10, fontWeight: 800, fontFamily: 'Space Grotesk' }}>
                              <span className="badge badge-sun">{rec.pin}</span>
                            </td>
                            <td style={{ padding: 10, fontWeight: 700 }}>{rec.quizTitle}</td>
                            <td style={{ padding: 10, color: '#333', fontSize: 12, fontWeight: 600 }}>
                              {formatExactTime(rec.startedAt || (rec.completedAt - 600000))}
                            </td>
                            <td style={{ padding: 10, color: '#666', fontSize: 12 }}>
                              {formatExactTime(rec.completedAt)}
                            </td>
                            <td style={{ padding: 10, fontSize: 12, fontWeight: 700, color: 'var(--violet)' }}>
                              ⏱️ {formatDuration(rec.startedAt, rec.completedAt, rec.durationMs)}
                            </td>
                            <td style={{ padding: 10, fontWeight: 700 }}>👥 {rec.totalPlayers}</td>
                            <td style={{ padding: 10 }}>
                              <span className={`badge ${rec.classAccuracyPercent >= 70 ? 'badge-mint' : 'badge-cherry'}`}>
                                🎯 {rec.classAccuracyPercent}%
                              </span>
                            </td>
                            <td style={{ padding: 10, fontWeight: 700, color: 'var(--violet)' }}>
                              👑 {rec.winnerName} ({rec.winnerScore.toLocaleString()} pts)
                            </td>
                            <td style={{ padding: 10, textAlign: 'right' }}>
                              <button
                                className="btn btn-sm btn-violet"
                                onClick={() => setSelectedHistory(rec)}
                              >
                                🔍 Full Report
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* MODE 2: GROUPED BY QUIZ TITLE VIEW */}
                {historyViewMode === 'grouped' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {Object.entries(groupedHistoryMap).map(([title, runs]) => {
                      const isExpanded = expandedQuizTitle === title || Object.keys(groupedHistoryMap).length === 1
                      const latestRun = runs[0]
                      return (
                        <div key={title} className="card" style={{ padding: 20 }}>
                          <div
                            onClick={() => setExpandedQuizTitle(isExpanded ? null : title)}
                            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                          >
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                                <span className="badge badge-sun font-extrabold">
                                  🎮 Hosted {runs.length} {runs.length === 1 ? 'Time' : 'Times'}
                                </span>
                                <span style={{ fontSize: 12, color: '#666', fontFamily: 'Inter' }}>
                                  Latest Run: {formatExactTime(latestRun.completedAt)}
                                </span>
                              </div>
                              <h3 style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 900, color: 'var(--ink)' }}>
                                {title}
                              </h3>
                            </div>
                            <button className="btn btn-sm btn-sun">
                              {isExpanded ? '▲ Hide Runs' : `▼ View ${runs.length} Runs`}
                            </button>
                          </div>

                          {/* Expanded Runs List */}
                          {isExpanded && (
                            <div style={{ marginTop: 16, borderTop: '2px dashed var(--ink)', paddingTop: 14 }}>
                              <div style={{ fontFamily: 'Space Grotesk', fontSize: 13, fontWeight: 800, marginBottom: 10, color: 'var(--violet)' }}>
                                📋 All {runs.length} Hosted Runs for &quot;{title}&quot;:
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                {runs.map((run, idx) => (
                                  <div key={run.id} style={{ background: 'var(--paper)', border: '2px solid var(--ink)', borderRadius: 12, padding: 14 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span className="badge badge-ink font-bold">Run #{runs.length - idx}</span>
                                        <span className="badge badge-sun">PIN {run.pin}</span>
                                        <span style={{ fontSize: 12, fontWeight: 800, fontFamily: 'Space Grotesk', color: 'var(--violet)' }}>
                                          ⏱️ {formatDuration(run.startedAt, run.completedAt, run.durationMs)}
                                        </span>
                                      </div>
                                      <button
                                        className="btn btn-sm btn-violet"
                                        onClick={(e) => { e.stopPropagation(); setSelectedHistory(run); }}
                                      >
                                        🔍 Inspect Roster &amp; Scores
                                      </button>
                                    </div>

                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, fontSize: 12, fontFamily: 'Inter' }}>
                                      <div>🚀 <strong>Launched:</strong> {formatExactTime(run.startedAt || (run.completedAt - 600000))}</div>
                                      <div>🏁 <strong>Ended:</strong> {formatExactTime(run.completedAt)}</div>
                                      <div>👥 <strong>Players:</strong> {run.totalPlayers} Students</div>
                                      <div>🎯 <strong>Class Acc:</strong> {run.classAccuracyPercent}%</div>
                                      <div>👑 <strong>Winner:</strong> {run.winnerName} ({run.winnerScore.toLocaleString()} pts)</div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Session Detail Report Modal / Side Column */}
                {selectedHistory && (
                  <div className="card anim-scale-in" style={{ padding: 22, background: 'var(--paper)', border: '3px solid var(--ink)', boxShadow: '6px 6px 0 var(--ink)', height: 'fit-content' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <h3 style={{ fontFamily: 'Space Grotesk', fontSize: 19, fontWeight: 900 }}>
                        📊 Session Analytics (PIN {selectedHistory.pin})
                      </h3>
                      <button onClick={() => setSelectedHistory(null)} style={{ background: 'none', border: 'none', fontSize: 22, fontWeight: 900, cursor: 'pointer' }}>✕</button>
                    </div>

                    <div style={{ fontSize: 13, color: '#444', fontFamily: 'Inter', marginBottom: 14, lineHeight: 1.4 }}>
                      <strong>{selectedHistory.quizTitle}</strong>
                      <div style={{ fontSize: 11.5, color: '#666', marginTop: 4 }}>
                        🚀 Launched: {formatExactTime(selectedHistory.startedAt || (selectedHistory.completedAt - 600000))}<br/>
                        🏁 Ended: {formatExactTime(selectedHistory.completedAt)} ({formatDuration(selectedHistory.startedAt, selectedHistory.completedAt, selectedHistory.durationMs)})
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
                      <div style={{ background: '#FFF8E1', padding: 12, borderRadius: 10, border: '2px solid var(--ink)', textAlign: 'center' }}>
                        <div style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 800, color: '#666' }}>CLASS ACCURACY</div>
                        <div style={{ fontSize: 22, fontWeight: 900, fontFamily: 'Space Grotesk', color: 'var(--ink)' }}>{selectedHistory.classAccuracyPercent}%</div>
                      </div>
                      <div style={{ background: '#E8F8F5', padding: 12, borderRadius: 10, border: '2px solid var(--ink)', textAlign: 'center' }}>
                        <div style={{ fontSize: 11, fontFamily: 'Space Grotesk', fontWeight: 800, color: '#666' }}>TOP WINNER</div>
                        <div style={{ fontSize: 15, fontWeight: 900, fontFamily: 'Space Grotesk', color: 'var(--violet)' }}>👑 {selectedHistory.winnerName}</div>
                      </div>
                    </div>

                    {/* Student Roster Leaderboard with Detailed Scores */}
                    <h4 style={{ fontFamily: 'Space Grotesk', fontSize: 14, fontWeight: 900, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>🏅 Student Roster &amp; Scores ({selectedHistory.playersSummary?.length || 0})</span>
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto', marginBottom: 16, paddingRight: 4 }}>
                      {selectedHistory.playersSummary?.map(p => (
                        <div key={p.nickname} className="lb-row" style={{ padding: '8px 10px', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'white', border: '1.5px solid var(--ink)', borderRadius: 8 }}>
                          <span style={{ fontWeight: 800, fontFamily: 'Space Grotesk' }}>
                            #{p.rank} {p.nickname}
                          </span>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{ fontWeight: 800, color: 'var(--violet)' }}>{p.score.toLocaleString()} pts</span>
                            <span style={{ fontSize: 10, color: '#666', marginLeft: 6 }}>({p.totalCorrect}/{p.totalAnswered} · {p.accuracyPercent}%)</span>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Question Accuracy Breakdown */}
                    <h4 style={{ fontFamily: 'Space Grotesk', fontSize: 14, fontWeight: 900, marginBottom: 8 }}>
                      🎯 Question-by-Question Accuracy
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 200, overflowY: 'auto', paddingRight: 4 }}>
                      {selectedHistory.questionStats?.map((qs, i) => (
                        <div key={i} style={{ padding: 10, background: 'var(--paper-2)', borderRadius: 8, border: '1.5px solid var(--ink)', fontSize: 12 }}>
                          <div style={{ fontWeight: 700, marginBottom: 4 }}>Q{i + 1}: {qs.prompt}</div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 11, color: '#666' }}>{qs.correctCount}/{qs.totalResponses} Correct Responses</span>
                            <span className={`badge ${qs.accuracyPercent >= 70 ? 'badge-mint' : 'badge-cherry'}`} style={{ fontSize: 10 }}>
                              {qs.accuracyPercent}% Acc
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>

                  </div>
                )}

              </div>
            )}
          </div>
        )}

        {/* TAB 3: TEACHER PROFILE */}
        {activeTab === 'profile' && (
          <div className="card anim-scale-in" style={{ maxWidth: 540, margin: '0 auto', padding: 28 }}>
            <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 24, fontWeight: 900, color: 'var(--ink)', marginBottom: 6 }}>
              👤 Teacher Profile &amp; Preferences
            </h2>
            <p style={{ fontSize: 13, color: '#555', fontFamily: 'Inter', marginBottom: 20 }}>
              Update your host display name, school institution, and classroom profile.
            </p>

            {saveSuccess && (
              <div className="badge badge-mint" style={{ display: 'block', padding: 10, textAlign: 'center', marginBottom: 16, fontSize: 13 }}>
                ✅ Profile updated successfully!
              </div>
            )}

            <form onSubmit={handleSaveProfile} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontFamily: 'Space Grotesk', fontWeight: 800, textTransform: 'uppercase', color: '#555', marginBottom: 6 }}>
                  Host / Teacher Display Name
                </label>
                <input
                  type="text"
                  className="input"
                  value={profileName}
                  onChange={e => setProfileName(e.target.value)}
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontFamily: 'Space Grotesk', fontWeight: 800, textTransform: 'uppercase', color: '#555', marginBottom: 6 }}>
                  School / Institution
                </label>
                <input
                  type="text"
                  className="input"
                  value={profileSchool}
                  onChange={e => setProfileSchool(e.target.value)}
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontFamily: 'Space Grotesk', fontWeight: 800, textTransform: 'uppercase', color: '#555', marginBottom: 6 }}>
                  Teacher Email (Read Only)
                </label>
                <input
                  type="email"
                  className="input"
                  value={user.email}
                  disabled
                  style={{ opacity: 0.6, background: '#eee' }}
                />
              </div>

              <button type="submit" className="btn btn-primary btn-lg" style={{ marginTop: 10, padding: '14px' }}>
                💾 Save Profile Changes
              </button>
            </form>
          </div>
        )}

      </div>
    </div>
  )
}
