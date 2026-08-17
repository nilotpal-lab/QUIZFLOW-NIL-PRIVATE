'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  getCommunityQuizzes,
  fetchRemoteCommunityQuizzes,
  addQuizComment,
  incrementQuizPlays,
  publishQuizToCommunity,
  type CommunityQuiz,
  type QuizCategory
} from '@/quizflow/communityStore'
import { getSavedQuizzes, type SavedQuizItem } from '@/quizflow/quizStore'
import { getHostUser } from '@/quizflow/authStore'
import { createSession } from '@/quizflow/sessionStore'
import { speakText, stopSpeech } from '@/quizflow/speech'
import { playClickSound, playCorrectChime, playLevelUpFanfare } from '@/quizflow/sound'

const CATEGORIES: Array<{ id: QuizCategory | 'Founders'; label: string; icon: string }> = [
  { id: 'All', label: 'All Quizzes', icon: '🌐' },
  { id: 'Founders', label: 'Founder Picks', icon: '🏆' },
  { id: 'Sports', label: 'Sports & Games', icon: '⚽' },
  { id: 'Biology', label: 'Biology & Life', icon: '🧬' },
  { id: 'Mathematics', label: 'Maths & Logic', icon: '📐' },
  { id: 'Technology', label: 'Tech & Code', icon: '💻' },
  { id: 'History', label: 'History & Civics', icon: '📜' },
  { id: 'Science', label: 'Cosmology & Space', icon: '🔬' },
  { id: 'General Knowledge', label: 'General Knowledge', icon: '🧩' },
]

const CATEGORY_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  Sports: { bg: '#FFE4E7', border: '#FF5252', text: '#FF1744' },
  Biology: { bg: '#D9FDE8', border: '#00E676', text: '#00897B' },
  Mathematics: { bg: '#FFF9C4', border: '#FBC02D', text: '#F57F17' },
  Technology: { bg: '#EDE7FF', border: '#7C4DFF', text: '#512DA8' },
  'General Knowledge': { bg: '#F3E5F5', border: '#AB47BC', text: '#6A1B9A' },
  Default: { bg: '#FFF8EB', border: '#10100F', text: '#10100F' }
}

// Feature Flag: Suspended TTS audio narration for Freshers Event
const ENABLE_TTS_AUDIO = false

export default function CommunityPracticeHub() {
  const router = useRouter()
  const [quizzes, setQuizzes] = useState<CommunityQuiz[]>([])
  const [savedQuizzes, setSavedQuizzes] = useState<SavedQuizItem[]>([])
  const [selectedCategory, setSelectedCategory] = useState<QuizCategory | 'Founders'>('All')
  const [searchQuery, setSearchQuery] = useState('')
  const [difficultyFilter, setDifficultyFilter] = useState<string>('all')

  // Add to Library Modal state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [addModeTab, setAddModeTab] = useState<'dashboard' | 'studio'>('dashboard')

  // Preview Questions Modal
  const [previewQuiz, setPreviewQuiz] = useState<CommunityQuiz | null>(null)

  // Solo Practice Modal state
  const [practicingQuiz, setPracticingQuiz] = useState<CommunityQuiz | null>(null)
  const [currentQIdx, setCurrentQIdx] = useState(0)
  const [isFlipped, setIsFlipped] = useState(false)
  const [selectedOption, setSelectedOption] = useState<number | null>(null)
  const [practiceScore, setPracticeScore] = useState(0)
  const [practiceFinished, setPracticeFinished] = useState(false)
  const [isTTSActive, setIsTTSActive] = useState(false)

  // Comments & Rating Modal state
  const [commentingQuiz, setCommentingQuiz] = useState<CommunityQuiz | null>(null)
  const [reviewRating, setReviewRating] = useState(5)
  const [reviewerName, setReviewerName] = useState('')
  const [reviewComment, setReviewComment] = useState('')
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  const syncRemoteQuizzes = () => {
    fetchRemoteCommunityQuizzes().then(remote => {
      if (remote && Array.isArray(remote) && remote.length > 0) {
        setQuizzes(remote)
      }
    })
  }

  useEffect(() => {
    setQuizzes(getCommunityQuizzes())
    setSavedQuizzes(getSavedQuizzes())
    
    // Initial fetch from cloud/server API
    syncRemoteQuizzes()

    // Real-time polling every 4 seconds so new global posts appear live
    const interval = setInterval(syncRemoteQuizzes, 4000)
    return () => clearInterval(interval)
  }, [])

  const showToast = (msg: string) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), 3500)
  }

  // Filter quizzes
  const filteredQuizzes = quizzes.filter(q => {
    if (selectedCategory === 'Founders' && !q.isFounder) return false
    if (selectedCategory !== 'All' && selectedCategory !== 'Founders' && q.category !== selectedCategory) return false
    if (difficultyFilter !== 'all' && q.difficulty !== difficultyFilter) return false
    if (searchQuery.trim()) {
      const qry = searchQuery.toLowerCase()
      const matchTitle = q.title.toLowerCase().includes(qry)
      const matchDesc = q.description.toLowerCase().includes(qry)
      const matchTags = q.tags.some(t => t.toLowerCase().includes(qry))
      const matchCategory = q.category.toLowerCase().includes(qry)
      if (!matchTitle && !matchDesc && !matchTags && !matchCategory) return false
    }
    return true
  })

  // Import / Publish a saved quiz from dashboard to community library
  const handlePublishSavedQuiz = (savedItem: SavedQuizItem) => {
    playClickSound()
    const user = getHostUser()
    const author = user?.name || 'Teacher Creator'
    const newQuiz = publishQuizToCommunity(savedItem.quiz, author)
    setQuizzes(getCommunityQuizzes())
    playLevelUpFanfare()
    showToast(`✅ "${newQuiz.title}" published to Library under ${newQuiz.category}!`)
    setIsAddModalOpen(false)
  }

  // Launch live hosting
  const handleHostQuiz = (quizItem: CommunityQuiz) => {
    playClickSound()
    incrementQuizPlays(quizItem.id)
    try {
      const state = createSession(quizItem.quiz, 'host_founder_' + Date.now())
      router.push(`/quizflow/host?pin=${state.pin}`)
    } catch (err) {
      console.error('Failed to create host session:', err)
      showToast('❌ Failed to create room. Please try again.')
    }
  }

  // Start solo practice
  const handleStartPractice = (quizItem: CommunityQuiz) => {
    playClickSound()
    incrementQuizPlays(quizItem.id)
    setPreviewQuiz(null)
    setPracticingQuiz(quizItem)
    setCurrentQIdx(0)
    setIsFlipped(false)
    setSelectedOption(null)
    setPracticeScore(0)
    setPracticeFinished(false)
    stopSpeech()
    setIsTTSActive(false)
  }

  // Next question in practice
  const handlePracticeNext = () => {
    playClickSound()
    stopSpeech()
    setIsTTSActive(false)
    if (!practicingQuiz) return
    if (currentQIdx + 1 >= practicingQuiz.quiz.questions.length) {
      setPracticeFinished(true)
      playLevelUpFanfare()
    } else {
      setCurrentQIdx(prev => prev + 1)
      setIsFlipped(false)
      setSelectedOption(null)
    }
  }

  // Prev question in practice
  const handlePracticePrev = () => {
    playClickSound()
    stopSpeech()
    setIsTTSActive(false)
    if (currentQIdx > 0) {
      setCurrentQIdx(prev => prev - 1)
      setIsFlipped(false)
      setSelectedOption(null)
    }
  }

  // Answer selection in practice
  const handleSelectPracticeOption = (optIdx: number) => {
    if (selectedOption !== null || !practicingQuiz) return
    const questions = practicingQuiz.quiz?.questions || []
    const currentQ = questions[currentQIdx]
    if (!currentQ) return

    setSelectedOption(optIdx)
    const isCorrect = optIdx === currentQ.correct_index
    if (isCorrect) {
      playCorrectChime()
      setPracticeScore(prev => prev + 1)
    } else {
      playClickSound()
    }
    setIsFlipped(true)
  }

  // Text to speech toggle
  const handleToggleTTS = (text: string) => {
    if (isTTSActive) {
      stopSpeech()
      setIsTTSActive(false)
    } else {
      speakText(text)
      setIsTTSActive(true)
    }
  }

  // Submit comment & rating
  const handleSubmitReview = (e: React.FormEvent) => {
    e.preventDefault()
    if (!commentingQuiz || !reviewComment.trim()) return
    const updated = addQuizComment(
      commentingQuiz.id,
      reviewerName || 'Community Teacher',
      reviewRating,
      reviewComment
    )
    if (updated) {
      setQuizzes(getCommunityQuizzes())
      setCommentingQuiz(updated)
      setReviewComment('')
      showToast('⭐ Review & Rating submitted successfully!')
    }
  }

  return (
    <div className="min-h-screen bg-[#F6F1E7] text-[#10100F] selection:bg-[#FFE57F] flex flex-col relative grain">
      
      {/* Styles Injection */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700;800&family=Space+Grotesk:wght@600;700;800;900&display=swap');
        .sg { font-family: 'Space Grotesk', sans-serif; }
        .hard { box-shadow: 4px 4px 0px #10100F; }
        .hard-lg { box-shadow: 6px 6px 0px #10100F; }
        .soft { box-shadow: 2px 2px 0px #10100F; }
        .hard-white { box-shadow: 2px 2px 0px rgba(255,255,255,0.22); }
        .btn-press:active { transform: translate(2px,2px); box-shadow: 1px 1px 0px #10100F; }
        .grain:before {
          content:''; position:absolute; inset:0; pointer-events:none; opacity:0.025;
          background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
        }
        @keyframes scale-in { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
        .animate-scale-in { animation: scale-in 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>

      {/* TOAST NOTIFICATION */}
      {toastMsg && (
        <div className="fixed top-20 right-5 z-[250] bg-[#10100F] text-[#FFFCF5] px-5 py-3 rounded-[12px] hard border-[2px] border-white/20 text-[13px] font-bold animate-scale-in">
          {toastMsg}
        </div>
      )}

      {/* HEADER BAR (68px ink) */}
      <header className="h-[68px] bg-[#10100F] border-b-[3px] border-[#10100F] flex items-center justify-between px-4 md:px-8 sticky top-0 z-50 shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/quizflow">
            <button className="h-10 px-3.5 bg-[#FFFCF5] border-[3px] border-[#10100F] rounded-[12px] text-[13px] font-bold flex items-center gap-1.5 btn-press hard-white text-[#10100F]">
              <span>←</span> Exit
            </button>
          </Link>
          <div className="flex items-center gap-2 text-[#FFFCF5] sg font-extrabold text-[18px] md:text-[20px] tracking-[-0.03em]">
            <span className="w-8 h-8 bg-[#FFE57F] rounded-[8px] border-[2px] border-white/20 grid place-items-center text-[#10100F] text-[15px]">✦</span>
            QuizFlow Library &amp; Practice
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Add Quiz to Library Button */}
          <button
            onClick={() => {
              playClickSound()
              setSavedQuizzes(getSavedQuizzes())
              setIsAddModalOpen(true)
            }}
            className="h-10 px-4 bg-[#FFE57F] hover:bg-[#FFD54F] border-[3px] border-[#10100F] rounded-[12px] text-[13px] font-extrabold flex items-center gap-1.5 btn-press hard-white text-[#10100F]"
          >
            <span>➕</span> Add Quiz to Library
          </button>

          <Link href="/quizflow/studio" className="hidden sm:inline-block">
            <button className="h-10 px-4 bg-[#00E676] border-[3px] border-[#10100F] rounded-[12px] text-[13px] font-extrabold flex items-center gap-1.5 btn-press hard-white text-[#10100F]">
              <span>✨</span> AI Studio
            </button>
          </Link>
        </div>
      </header>

      {/* HERO BANNER */}
      <section className="bg-[#FFF8EB] border-b-[3px] border-[#10100F] py-8 px-4 md:px-8">
        <div className="max-w-[1280px] mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <div className="inline-flex items-center gap-2 bg-[#FFE57F] border-[2px] border-[#10100F] px-3 py-1 rounded-[20px] text-[11px] font-extrabold sg uppercase mb-2.5 soft">
              <span>✦</span> AI-Categorized &amp; Founder-Verified Quizzes
            </div>
            <h1 className="sg font-black text-[28px] md:text-[36px] tracking-[-0.03em] leading-tight text-[#10100F]">
              Discover, Practice &amp; Host Ready-to-Play Quizzes
            </h1>
            <p className="text-[14px] md:text-[15px] text-black/70 font-medium mt-1 max-w-[680px]">
              Click on any quiz to view all its questions, practice individually with flashcards, or host a live multiplayer game with your students!
            </p>
          </div>

          {/* Quick Stat Pill */}
          <div className="flex gap-3 shrink-0">
            <div className="bg-[#FFFCF5] border-[3px] border-[#10100F] rounded-[14px] p-3 text-center min-w-[110px] soft">
              <div className="sg font-black text-[20px] text-[#7C4DFF]">{quizzes.length}</div>
              <div className="text-[10px] font-bold text-black/60 uppercase">Available Decks</div>
            </div>
            <div className="bg-[#FFFCF5] border-[3px] border-[#10100F] rounded-[14px] p-3 text-center min-w-[110px] soft">
              <div className="sg font-black text-[20px] text-[#00E676]">100%</div>
              <div className="text-[10px] font-bold text-black/60 uppercase">Free to Host</div>
            </div>
          </div>
        </div>
      </section>

      {/* FILTER & CATEGORY NAVIGATION BAR */}
      <section className="bg-[#F6F1E7] border-b-[3px] border-[#10100F] py-4 px-4 md:px-8 sticky top-[68px] z-40 bg-opacity-95 backdrop-blur-sm">
        <div className="max-w-[1280px] mx-auto flex flex-col gap-4">
          
          {/* Categories Horizontal Carousel */}
          <div className="flex items-center gap-2 overflow-x-auto hide-scrollbar pb-1">
            {CATEGORIES.map(cat => (
              <button
                key={cat.id}
                onClick={() => {
                  playClickSound()
                  setSelectedCategory(cat.id)
                }}
                className={`h-10 px-4 rounded-[24px] border-[2.5px] text-[13px] font-extrabold shrink-0 flex items-center gap-1.5 transition-all btn-press ${
                  selectedCategory === cat.id
                    ? 'bg-[#10100F] text-[#FFFCF5] border-[#10100F] hard'
                    : 'bg-[#FFFCF5] text-[#10100F] border-[#10100F]/20 hover:border-[#10100F]'
                }`}
              >
                <span>{cat.icon}</span>
                <span>{cat.label}</span>
              </button>
            ))}
          </div>

          {/* Search & Difficulty Filter */}
          <div className="flex flex-col sm:flex-row items-center gap-3">
            <div className="relative flex-1 w-full">
              <input
                type="text"
                placeholder="🔍 Search topics or concepts (e.g. Mitochondria, World Cup, React)..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full h-11 bg-[#FFFCF5] border-[3px] border-[#10100F] rounded-[12px] px-4 text-[13px] font-semibold outline-none placeholder:text-black/40 soft"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-black/50 hover:text-black font-bold text-[14px]"
                >
                  ✕
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              <select
                value={difficultyFilter}
                onChange={e => setDifficultyFilter(e.target.value)}
                className="h-11 px-3 bg-[#FFFCF5] border-[3px] border-[#10100F] rounded-[12px] text-[13px] font-bold outline-none soft cursor-pointer w-full sm:w-auto"
              >
                <option value="all">🎯 All Difficulties</option>
                <option value="easy">🟢 Easy</option>
                <option value="medium">🟡 Medium</option>
                <option value="hard">🔴 Hard</option>
              </select>
            </div>
          </div>

        </div>
      </section>

      {/* MAIN QUIZ GRID */}
      <main className="max-w-[1280px] mx-auto p-4 md:p-8 flex-1 w-full">
        <div className="flex items-center justify-between mb-6">
          <h2 className="sg font-black text-[22px] tracking-[-0.02em] flex items-center gap-2">
            <span>📚</span>
            <span>
              {selectedCategory === 'All' ? 'All Verified Quizzes' : `${selectedCategory} Quizzes`} ({filteredQuizzes.length})
            </span>
          </h2>
        </div>

        {filteredQuizzes.length === 0 ? (
          <div className="bg-[#FFF8EB] border-[3px] border-[#10100F] rounded-[18px] hard p-10 text-center max-w-[540px] mx-auto mt-6">
            <div className="text-[44px] mb-2">🔍</div>
            <h3 className="sg font-black text-[20px]">No quizzes found</h3>
            <p className="text-[14px] text-black/60 font-medium mt-1 mb-5">
              Try adjusting your search query, or add your own quiz to this category!
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => {
                  setSelectedCategory('All')
                  setSearchQuery('')
                  setDifficultyFilter('all')
                }}
                className="h-10 px-5 bg-[#FFE57F] border-[2px] border-[#10100F] rounded-[10px] font-extrabold text-[13px] btn-press soft"
              >
                Clear Filters
              </button>
              <button
                onClick={() => {
                  setSavedQuizzes(getSavedQuizzes())
                  setIsAddModalOpen(true)
                }}
                className="h-10 px-5 bg-[#00E676] border-[2px] border-[#10100F] rounded-[10px] font-extrabold text-[13px] btn-press soft"
              >
                ➕ Add Quiz
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredQuizzes.map((item) => {
              const catTheme = CATEGORY_COLORS[item.category] || CATEGORY_COLORS.Default
              return (
                <div
                  key={item.id}
                  onClick={() => {
                    playClickSound()
                    setPreviewQuiz(item)
                  }}
                  className="bg-[#FFFCF5] border-[3px] border-[#10100F] rounded-[18px] hard hover:translate-y-[-2px] transition-all flex flex-col justify-between overflow-hidden group cursor-pointer"
                >
                  {/* Card Header & Badges */}
                  <div className="p-5">
                    <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
                      {/* Category Pill */}
                      <span
                        className="px-3 py-1 rounded-[20px] border-[2px] border-[#10100F] text-[11px] font-black uppercase sg tracking-[0.04em]"
                        style={{ background: catTheme.bg, color: catTheme.text }}
                      >
                        {item.category}
                      </span>

                      {/* Founder vs Community Badge */}
                      {item.isFounder ? (
                        <span className="px-2.5 py-0.5 rounded-[20px] bg-[#FFE57F] border-[2px] border-[#10100F] text-[11px] font-extrabold text-[#10100F] flex items-center gap-1 shadow-sm">
                          <span>✦</span> Founder Verified
                        </span>
                      ) : (
                        <span className="px-2.5 py-0.5 rounded-[20px] bg-black/5 border border-black/20 text-[11px] font-bold text-black/60">
                          👤 {item.authorName}
                        </span>
                      )}
                    </div>

                    {/* Quiz Title */}
                    <h3 className="sg font-black text-[18px] leading-[1.3] text-[#10100F] mb-2 group-hover:text-[#7C4DFF] transition-colors">
                      {item.title}
                    </h3>

                    {/* Description */}
                    <p className="text-[13px] text-black/70 font-medium line-clamp-2 leading-relaxed mb-4">
                      {item.description}
                    </p>

                    {/* Tags */}
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {item.tags.slice(0, 3).map((tag, idx) => (
                        <span key={idx} className="text-[11px] font-bold bg-[#FFF8EB] border border-[#10100F]/20 px-2 py-0.5 rounded-[6px] text-black/60">
                          #{tag}
                        </span>
                      ))}
                    </div>

                    {/* Stats HUD (Rating & Question Count) */}
                    <div className="flex items-center justify-between border-t border-black/10 pt-3 text-[12px] font-bold text-black/70">
                      <div className="flex items-center gap-1 text-[#F57F17]">
                        <span>⭐</span>
                        {item.reviewCount > 0 ? (
                          <>
                            <span className="font-extrabold text-[#10100F]">{item.rating}</span>
                            <span className="text-black/40 font-normal">({item.reviewCount} reviews)</span>
                          </>
                        ) : (
                          <span className="text-black/50 font-normal text-[11px]">No reviews yet</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="px-2 py-0.5 rounded-[6px] bg-[#EDE7FF] border border-[#7C4DFF]/30 text-[#7C4DFF] text-[11px] font-bold">
                          {item.questionCount} Questions
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Card Action Footer */}
                  <div className="bg-[#FFF8EB] border-t-[3px] border-[#10100F] p-3 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                    {/* Host Live Button */}
                    <button
                      onClick={() => handleHostQuiz(item)}
                      className="flex-1 h-10 bg-[#00E676] hover:bg-[#00C853] border-[2.5px] border-[#10100F] rounded-[10px] font-extrabold text-[12px] flex items-center justify-center gap-1.5 btn-press soft text-[#10100F]"
                      title="Launch live classroom lobby with game PIN"
                    >
                      <span>🚀</span> Host Live
                    </button>

                    {/* Solo Practice Button */}
                    <button
                      onClick={() => handleStartPractice(item)}
                      className="flex-1 h-10 bg-[#EDE7FF] hover:bg-[#D1C4E9] border-[2.5px] border-[#10100F] rounded-[10px] font-extrabold text-[12px] flex items-center justify-center gap-1.5 btn-press soft text-[#512DA8]"
                      title="Practice questions individually"
                    >
                      <span>🧠</span> Solo Practice
                    </button>

                    {/* Review Comments Trigger */}
                    <button
                      onClick={() => {
                        playClickSound()
                        setCommentingQuiz(item)
                      }}
                      className="w-10 h-10 bg-[#FFFCF5] hover:bg-[#FFE57F] border-[2.5px] border-[#10100F] rounded-[10px] grid place-items-center btn-press soft text-[14px]"
                      title="View & Post Reviews"
                    >
                      💬
                    </button>
                  </div>

                </div>
              )
            })}
          </div>
        )}
      </main>

      {/* ================================================================
          ADD QUIZ TO LIBRARY MODAL (Dashboard Import vs AI Studio)
          ================================================================ */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#FFF8EB] border-[4px] border-[#10100F] rounded-[22px] hard-lg max-w-[700px] w-full p-6 md:p-8 animate-scale-in max-h-[90vh] overflow-y-auto flex flex-col justify-between">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b-[2px] border-black/10 pb-4 mb-4">
              <div>
                <h3 className="sg font-black text-[22px] text-[#10100F]">
                  ➕ Add Quiz to Library
                </h3>
                <p className="text-[13px] text-black/70 font-medium">
                  Publish quizzes from your dashboard or create brand new ones with AI.
                </p>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="w-9 h-9 rounded-[10px] bg-[#FF5252] text-white border-[2px] border-[#10100F] font-bold text-[14px] btn-press grid place-items-center"
              >
                ✕
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b-[2px] border-black/10 mb-5 gap-3">
              <button
                onClick={() => setAddModeTab('dashboard')}
                className={`pb-2.5 px-4 font-black sg text-[14px] border-b-[3px] transition-colors ${
                  addModeTab === 'dashboard'
                    ? 'border-[#10100F] text-[#10100F]'
                    : 'border-transparent text-black/40 hover:text-black'
                }`}
              >
                📂 Import from Dashboard ({savedQuizzes.length})
              </button>
              <button
                onClick={() => setAddModeTab('studio')}
                className={`pb-2.5 px-4 font-black sg text-[14px] border-b-[3px] transition-colors ${
                  addModeTab === 'studio'
                    ? 'border-[#10100F] text-[#10100F]'
                    : 'border-transparent text-black/40 hover:text-black'
                }`}
              >
                ✨ Create New with AI Studio
              </button>
            </div>

            {/* TAB 1: Import from Dashboard */}
            {addModeTab === 'dashboard' && (
              <div>
                {savedQuizzes.length === 0 ? (
                  <div className="text-center py-8 bg-[#FFFCF5] border-[2px] border-dashed border-[#10100F]/30 rounded-[14px] p-6">
                    <div className="text-[36px] mb-2">📭</div>
                    <h4 className="sg font-black text-[16px]">No saved quizzes in Dashboard</h4>
                    <p className="text-[13px] text-black/60 font-medium mt-1 mb-4">
                      You don't have any quizzes in your dashboard yet. Use the AI Studio to generate your first quiz!
                    </p>
                    <Link href="/quizflow/studio">
                      <button className="h-10 px-5 bg-[#00E676] border-[2px] border-[#10100F] rounded-[10px] font-extrabold text-[13px] btn-press soft">
                        ✨ Create Quiz with AI Studio →
                      </button>
                    </Link>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 max-h-[380px] overflow-y-auto pr-1">
                    {savedQuizzes.map((item) => (
                      <div
                        key={item.id}
                        className="bg-[#FFFCF5] border-[2.5px] border-[#10100F] rounded-[14px] p-4 soft flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
                      >
                        <div className="flex-1">
                          <h4 className="sg font-black text-[16px] text-[#10100F]">{item.title}</h4>
                          <p className="text-[12px] text-black/60 font-medium line-clamp-1 mt-0.5">{item.description}</p>
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-[11px] font-bold bg-[#FFE57F] border border-[#10100F]/20 px-2 py-0.5 rounded-[6px]">
                              {item.questionCount || item.quiz.questions?.length} Questions
                            </span>
                            <span className="text-[11px] font-bold bg-black/5 px-2 py-0.5 rounded-[6px] text-black/60">
                              {item.bloomLevel || 'Recall'}
                            </span>
                          </div>
                        </div>

                        <button
                          onClick={() => handlePublishSavedQuiz(item)}
                          className="h-10 px-4 bg-[#00E676] hover:bg-[#00C853] border-[2px] border-[#10100F] rounded-[10px] font-black text-[12px] btn-press soft shrink-0 text-[#10100F] w-full sm:w-auto"
                        >
                          Publish to Library 🚀
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: Create with AI Studio */}
            {addModeTab === 'studio' && (
              <div className="bg-[#FFFCF5] border-[3px] border-[#10100F] rounded-[16px] p-6 soft text-center">
                <div className="text-[44px] mb-2">🪄</div>
                <h4 className="sg font-black text-[20px]">Generate a Brand New Quiz</h4>
                <p className="text-[13px] text-black/70 font-medium max-w-[460px] mx-auto mt-1 mb-6 leading-relaxed">
                  Enter any curriculum topic or paste notes. QuizFlow AI creates higher-order thinking questions with images, distractor explanations, and auto-categorization.
                </p>
                <Link href="/quizflow/studio">
                  <button
                    onClick={() => setIsAddModalOpen(false)}
                    className="h-12 px-6 bg-[#FFE57F] hover:bg-[#FFD54F] border-[3px] border-[#10100F] rounded-[14px] font-black text-[14px] btn-press hard text-[#10100F] inline-flex items-center gap-2"
                  >
                    <span>✨ Launch AI Studio</span>
                    <span>→</span>
                  </button>
                </Link>
              </div>
            )}

          </div>
        </div>
      )}

      {/* ================================================================
          VIEW QUESTIONS PREVIEW MODAL
          ================================================================ */}
      {previewQuiz && (
        <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#FFF8EB] border-[4px] border-[#10100F] rounded-[22px] hard-lg max-w-[760px] w-full p-6 md:p-8 animate-scale-in max-h-[90vh] overflow-y-auto flex flex-col justify-between">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b-[2px] border-black/10 pb-4 mb-4">
              <div>
                <span className="text-[11px] font-black uppercase sg bg-[#FFE57F] border border-[#10100F] text-[#10100F] px-2.5 py-0.5 rounded-[12px]">
                  {previewQuiz.category} · {previewQuiz.questionCount} Questions
                </span>
                <h3 className="sg font-black text-[22px] text-[#10100F] mt-1">
                  {previewQuiz.title}
                </h3>
                <p className="text-[13px] text-black/70 font-medium">
                  {previewQuiz.description}
                </p>
              </div>
              <button
                onClick={() => setPreviewQuiz(null)}
                className="w-9 h-9 rounded-[10px] bg-[#FF5252] text-white border-[2px] border-[#10100F] font-bold text-[14px] btn-press grid place-items-center shrink-0 ml-2"
              >
                ✕
              </button>
            </div>

            {/* Questions List */}
            <div className="flex flex-col gap-4 my-3">
              {previewQuiz.quiz.questions.map((q, idx) => (
                <div key={idx} className="bg-[#FFFCF5] border-[2.5px] border-[#10100F] rounded-[14px] p-4 soft">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[12px] font-black sg bg-[#10100F] text-white px-2.5 py-0.5 rounded-[10px]">
                      Q{idx + 1}
                    </span>
                    <span className="text-[11px] font-bold text-black/50 uppercase">
                      ⏱ {Math.round((q.time_limit_ms || 20000) / 1000)}s · {q.difficulty || 'medium'}
                    </span>
                  </div>

                  <h4 className="sg font-extrabold text-[15px] text-[#10100F] mb-3">
                    {q.prompt}
                  </h4>

                  {/* Optional Image */}
                  {q.imageUrl && (
                    <div className="mb-3">
                      <img
                        src={q.imageUrl}
                        alt="Question Media"
                        className="max-h-[140px] rounded-[8px] border border-[#10100F]/30 object-contain bg-black/5"
                        onError={e => (e.currentTarget.style.display = 'none')}
                      />
                    </div>
                  )}

                  {/* Options 2x2 */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                    {q.choices.map((c, ci) => {
                      const isCorrect = ci === q.correct_index
                      return (
                        <div
                          key={ci}
                          className={`p-2.5 rounded-[8px] border-[2px] text-[12px] font-bold flex items-center gap-2 ${
                            isCorrect ? 'bg-[#D9FDE8] border-[#00E676] text-[#00897B]' : 'bg-[#FFF8EB] border-[#10100F]/20 text-black/80'
                          }`}
                        >
                          <span className="w-5 h-5 rounded-full border border-[#10100F] grid place-items-center text-[10px] bg-white shrink-0">
                            {String.fromCharCode(65 + ci)}
                          </span>
                          <span className="flex-1 truncate">{c}</span>
                          {isCorrect && <span className="text-[13px] font-black">✓</span>}
                        </div>
                      )
                    })}
                  </div>

                  {q.explanation && (
                    <div className="text-[11px] text-black/60 font-medium bg-[#FFF8EB] border border-dashed border-black/20 p-2 rounded-[6px] mt-2">
                      💡 <strong>Explanation:</strong> {q.explanation}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Modal Actions Footer */}
            <div className="border-t-[2px] border-black/10 pt-4 flex gap-3 justify-end mt-2">
              <button
                onClick={() => handleStartPractice(previewQuiz)}
                className="h-11 px-5 bg-[#EDE7FF] hover:bg-[#D1C4E9] border-[2.5px] border-[#10100F] rounded-[12px] font-extrabold text-[13px] btn-press soft text-[#512DA8]"
              >
                🧠 Solo Practice
              </button>
              <button
                onClick={() => {
                  setPreviewQuiz(null)
                  handleHostQuiz(previewQuiz)
                }}
                className="h-11 px-5 bg-[#00E676] hover:bg-[#00C853] border-[2.5px] border-[#10100F] rounded-[12px] font-extrabold text-[13px] btn-press soft text-[#10100F]"
              >
                🚀 Host Live Game
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ================================================================
          SOLO PRACTICE MODAL ARENA
          ================================================================ */}
      {practicingQuiz && (
        <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#FFF8EB] border-[4px] border-[#10100F] rounded-[22px] hard-lg max-w-[680px] w-full p-6 md:p-8 animate-scale-in relative max-h-[90vh] overflow-y-auto flex flex-col justify-between">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b-[2px] border-black/10 pb-4 mb-4">
              <div>
                <span className="text-[11px] font-black uppercase sg bg-[#7C4DFF] text-white px-2.5 py-0.5 rounded-[12px]">
                  Solo Practice Mode
                </span>
                <h3 className="sg font-black text-[18px] md:text-[20px] text-[#10100F] mt-1 truncate max-w-[400px]">
                  {practicingQuiz.title}
                </h3>
              </div>
              <button
                onClick={() => {
                  stopSpeech()
                  setPracticingQuiz(null)
                }}
                className="w-9 h-9 rounded-[10px] bg-[#FF5252] text-white border-[2px] border-[#10100F] font-bold text-[14px] btn-press grid place-items-center"
              >
                ✕
              </button>
            </div>

            {practiceFinished ? (
              <div className="text-center py-8">
                <div className="text-[56px] mb-2 animate-bounce">🏆</div>
                <h2 className="sg font-black text-[24px] mb-2">Practice Session Complete!</h2>
                <p className="text-[15px] font-bold text-black/70 mb-4">
                  You scored <span className="text-[#00C853] text-[20px]">{practiceScore}</span> out of {practicingQuiz.quiz.questions.length} questions!
                </p>
                <div className="flex gap-3 justify-center mt-6">
                  <button
                    onClick={() => handleStartPractice(practicingQuiz)}
                    className="h-11 px-5 bg-[#FFE57F] border-[3px] border-[#10100F] rounded-[12px] font-extrabold text-[13px] btn-press soft"
                  >
                    🔄 Practice Again
                  </button>
                  <button
                    onClick={() => handleHostQuiz(practicingQuiz)}
                    className="h-11 px-5 bg-[#00E676] border-[3px] border-[#10100F] rounded-[12px] font-extrabold text-[13px] btn-press soft text-[#10100F]"
                  >
                    🚀 Host Live with Class
                  </button>
                </div>
              </div>
            ) : (
              <div>
                {/* Question Progress & TTS */}
                <div className="flex items-center justify-between mb-3 text-[12px] font-extrabold text-black/60">
                  <span>Question {currentQIdx + 1} of {practicingQuiz.quiz.questions.length}</span>
                  <div className="flex items-center gap-2">
                    {ENABLE_TTS_AUDIO && (
                      <button
                        onClick={() => {
                          const promptText = practicingQuiz.quiz?.questions?.[currentQIdx]?.prompt || ''
                          if (promptText) handleToggleTTS(promptText)
                        }}
                        className={`px-3 py-1 rounded-[8px] border-[2px] border-[#10100F] text-[11px] font-extrabold flex items-center gap-1.5 btn-press ${
                          isTTSActive ? 'bg-[#FFE57F]' : 'bg-white'
                        }`}
                      >
                        <span>{isTTSActive ? '🔊 Stop' : '🔈 Listen'}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Question Card */}
                <div className="bg-[#FFFCF5] border-[3px] border-[#10100F] rounded-[16px] p-5 hard mb-5">
                  <h4 className="sg font-black text-[18px] md:text-[20px] leading-[1.35] text-[#10100F] mb-4">
                    {practicingQuiz.quiz.questions[currentQIdx].prompt}
                  </h4>

                  {/* Optional Image */}
                  {practicingQuiz.quiz.questions[currentQIdx].imageUrl && (
                    <div className="mb-4 text-center">
                      <img
                        src={practicingQuiz.quiz.questions[currentQIdx].imageUrl}
                        alt="Question diagram"
                        className="max-h-[180px] w-full object-contain rounded-[10px] border-[2px] border-[#10100F] bg-black/5 mx-auto"
                        onError={e => (e.currentTarget.style.display = 'none')}
                      />
                    </div>
                  )}

                  {/* 2x2 Options Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {practicingQuiz.quiz.questions[currentQIdx].choices.map((choice, optIdx) => {
                      const isCorrect = optIdx === practicingQuiz.quiz.questions[currentQIdx].correct_index
                      const isChosen = selectedOption === optIdx
                      let btnBg = 'bg-[#FFF8EB] border-[#10100F] hover:bg-[#FFE57F]/40'
                      if (selectedOption !== null) {
                        if (isCorrect) btnBg = 'bg-[#D9FDE8] border-[#00E676] text-[#00897B]'
                        else if (isChosen) btnBg = 'bg-[#FFE4E7] border-[#FF5252] text-[#D50000]'
                      }
                      return (
                        <button
                          key={optIdx}
                          disabled={selectedOption !== null}
                          onClick={() => handleSelectPracticeOption(optIdx)}
                          className={`p-3 rounded-[10px] border-[2.5px] text-left text-[13px] font-extrabold flex items-start gap-2.5 transition-all btn-press ${btnBg}`}
                        >
                          <span className="w-5 h-5 rounded-full border-[2px] border-[#10100F] grid place-items-center text-[10px] bg-white shrink-0 mt-0.5">
                            {String.fromCharCode(65 + optIdx)}
                          </span>
                          <span className="flex-1 leading-snug">{choice}</span>
                          {selectedOption !== null && isCorrect && <span className="text-[14px]">✓</span>}
                          {selectedOption !== null && isChosen && !isCorrect && <span className="text-[14px]">✕</span>}
                        </button>
                      )
                    })}
                  </div>

                  {/* Explanation reveal */}
                  {isFlipped && (
                    <div className="mt-4 p-3.5 bg-[#FFF8EB] border-[2px] border-dashed border-[#10100F]/30 rounded-[10px] animate-scale-in">
                      <div className="text-[11px] font-black sg text-[#7C4DFF] uppercase tracking-[0.05em] mb-1">
                        💡 Explanation & Diagnostic Insight
                      </div>
                      <p className="text-[13px] text-black/80 font-medium leading-relaxed">
                        {practicingQuiz.quiz.questions[currentQIdx].explanation || 'Correct answer verified.'}
                      </p>
                    </div>
                  )}
                </div>

                {/* Footer Controls */}
                <div className="flex items-center justify-between gap-3">
                  <button
                    disabled={currentQIdx === 0}
                    onClick={handlePracticePrev}
                    className="h-10 px-4 bg-white border-[2.5px] border-[#10100F] rounded-[10px] font-extrabold text-[12px] disabled:opacity-40 btn-press soft"
                  >
                    ← Previous
                  </button>

                  <button
                    onClick={handlePracticeNext}
                    className="h-10 px-5 bg-[#FFE57F] hover:bg-[#FFD54F] border-[2.5px] border-[#10100F] rounded-[10px] font-extrabold text-[13px] btn-press soft"
                  >
                    {currentQIdx + 1 >= practicingQuiz.quiz.questions.length ? 'Finish Session 🏁' : 'Next Question →'}
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* ================================================================
          RATINGS & REVIEWS MODAL DRAWER
          ================================================================ */}
      {commentingQuiz && (
        <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#FFF8EB] border-[4px] border-[#10100F] rounded-[22px] hard-lg max-w-[560px] w-full p-6 md:p-8 animate-scale-in max-h-[90vh] overflow-y-auto">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b-[2px] border-black/10 pb-4 mb-4">
              <div>
                <h3 className="sg font-black text-[20px] text-[#10100F]">
                  ⭐ Ratings & Reviews
                </h3>
                <p className="text-[12px] font-bold text-black/60 truncate max-w-[380px]">
                  {commentingQuiz.title} {commentingQuiz.reviewCount > 0 ? `· ${commentingQuiz.rating} ★ (${commentingQuiz.reviewCount} reviews)` : '· Be the first to review!'}
                </p>
              </div>
              <button
                onClick={() => setCommentingQuiz(null)}
                className="w-9 h-9 rounded-[10px] bg-[#FF5252] text-white border-[2px] border-[#10100F] font-bold text-[14px] btn-press grid place-items-center"
              >
                ✕
              </button>
            </div>

            {/* Leave a review form */}
            <form onSubmit={handleSubmitReview} className="bg-[#FFFCF5] border-[3px] border-[#10100F] rounded-[14px] p-4 soft mb-6">
              <h4 className="sg font-black text-[14px] text-[#10100F] mb-2">Leave a Rating & Comment</h4>
              
              {/* Star selection */}
              <div className="flex items-center gap-1.5 mb-3">
                {[1, 2, 3, 4, 5].map(star => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setReviewRating(star)}
                    className="text-[24px] transition-transform hover:scale-125 focus:outline-none"
                  >
                    {star <= reviewRating ? '⭐' : '☆'}
                  </button>
                ))}
                <span className="text-[12px] font-bold text-black/60 ml-2">({reviewRating} out of 5)</span>
              </div>

              <input
                type="text"
                placeholder="Your Name (e.g. Teacher Alex, Student Maria)"
                value={reviewerName}
                onChange={e => setReviewerName(e.target.value)}
                className="w-full h-9 bg-[#FFF8EB] border-[2px] border-[#10100F]/30 rounded-[8px] px-3 text-[12px] font-bold outline-none mb-2.5"
              />

              <textarea
                placeholder="Write your feedback on this quiz..."
                value={reviewComment}
                onChange={e => setReviewComment(e.target.value)}
                rows={3}
                required
                className="w-full bg-[#FFF8EB] border-[2px] border-[#10100F]/30 rounded-[8px] p-2.5 text-[12px] font-medium outline-none resize-none mb-3"
              />

              <button
                type="submit"
                className="w-full h-10 bg-[#00E676] hover:bg-[#00C853] border-[2px] border-[#10100F] rounded-[10px] font-black text-[13px] btn-press soft text-[#10100F]"
              >
                Post Review ⭐
              </button>
            </form>

            {/* List of real comments */}
            <div className="flex flex-col gap-3">
              <h4 className="sg font-black text-[15px] text-[#10100F]">
                User Reviews ({commentingQuiz.comments?.length || 0})
              </h4>

              {(!commentingQuiz.comments || commentingQuiz.comments.length === 0) ? (
                <div className="text-center py-4 text-[13px] text-black/50 font-medium">
                  No reviews yet. Be the first to rate this quiz!
                </div>
              ) : (
                commentingQuiz.comments.map(c => (
                  <div key={c.id} className="bg-[#FFFCF5] border-[2px] border-[#10100F] rounded-[12px] p-3.5 soft">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-extrabold text-[13px] text-[#10100F]">{c.authorName}</span>
                      <span className="text-[12px] text-[#F57F17] font-bold">
                        {'⭐'.repeat(c.rating)}
                      </span>
                    </div>
                    <p className="text-[12px] text-black/80 font-medium leading-relaxed">
                      {c.text}
                    </p>
                  </div>
                ))
              )}
            </div>

          </div>
        </div>
      )}

    </div>
  )
}
