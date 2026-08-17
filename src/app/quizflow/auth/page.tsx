'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  getHostUser,
  loginAsDemoHost,
  signUpHostAsync,
  loginHostAsync,
  loginHost,
  loginWithGoogleAsync,
  resendConfirmationEmailAsync,
  initAuthSync,
  type HostUser
} from '@/quizflow/authStore'

export default function TeacherAuthPage() {
  const router = useRouter()
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [name, setName]         = useState('')
  const [school, setSchool]     = useState('')
  const [user, setUser]         = useState<HostUser | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [authError, setAuthError]     = useState('')
  const [authNotice, setAuthNotice]   = useState('')

  useEffect(() => {
    // Check URL parameters for OAuth errors
    if (typeof window !== 'undefined') {
      const hash = window.location.hash
      const search = window.location.search
      if (hash.includes('error_description=') || search.includes('error_description=')) {
        const match = (hash + search).match(/error_description=([^&]+)/)
        if (match && match[1]) {
          const decoded = decodeURIComponent(match[1].replace(/\+/g, ' '))
          setAuthError(`Google Auth Notice: ${decoded}`)
        }
      }
    }

    const existing = getHostUser()
    if (existing) {
      setUser(existing)
      router.push('/quizflow/dashboard')
    }

    const unsubscribe = initAuthSync(updatedUser => {
      if (updatedUser) {
        setUser(updatedUser)
        router.push('/quizflow/dashboard')
      }
    })
    return () => unsubscribe()
  }, [router])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return

    setAuthError('')
    setAuthNotice('')
    setIsSubmitting(true)

    try {
      if (isSignUp) {
        const res = await signUpHostAsync(email.trim(), password, name.trim(), school.trim())
        setUser(res.user)
        if (res.message) {
          setAuthNotice(res.message)
        } else {
          router.push('/quizflow/dashboard')
        }
      } else {
        const loggedIn = await loginHostAsync(email.trim(), password)
        setUser(loggedIn)
        router.push('/quizflow/dashboard')
      }
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed. Please check your credentials.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleResendEmail = async () => {
    if (!email.trim()) {
      setAuthError('Please enter your email address above to resend the confirmation link.')
      return
    }
    setAuthError('')
    setIsSubmitting(true)
    try {
      const msg = await resendConfirmationEmailAsync(email.trim())
      setAuthNotice(msg)
    } catch (err: any) {
      setAuthError(err.message || 'Failed to resend confirmation email.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLocalBypassLogin = () => {
    if (!email.trim()) return
    setAuthError('')
    setAuthNotice('')
    const localUser = loginHost(email.trim())
    setUser(localUser)
    router.push('/quizflow/dashboard')
  }

  const handleGoogleLogin = async () => {
    setAuthError('')
    setAuthNotice('')
    setIsSubmitting(true)
    try {
      await loginWithGoogleAsync()
    } catch (err: any) {
      setAuthError(err.message || 'Google authentication failed. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDemoLogin = () => {
    setAuthError('')
    setAuthNotice('')
    const demo = loginAsDemoHost()
    setUser(demo)
    router.push('/quizflow/dashboard')
  }

  return (
    <div className="min-h-screen w-full bg-[var(--paper)] selection:bg-[var(--sun)] flex flex-col items-center justify-center p-4 md:p-6 text-[var(--ink)] relative">
      
      {/* BRANDING HEADER */}
      <div className="text-center mb-6">
        <Link href="/quizflow" className="inline-flex items-center gap-2.5 font-display font-[900] text-[32px] md:text-[38px] tracking-tight hover:opacity-90 transition-opacity">
          <span className="text-[36px] md:text-[42px] text-[var(--violet)] drop-shadow-[1px_1px_0px_var(--ink)]">⚡</span> QuizFlow Studio
        </Link>
        <div className="font-body text-[14px] md:text-[15px] font-semibold text-[var(--ink)] opacity-75 mt-1">
          Teacher &amp; Host Command Center
        </div>
      </div>

      {/* ALREADY LOGGED IN CARD */}
      {user ? (
        <div className="w-full max-w-[460px] hard bg-[var(--paper-2)] border-[3px] border-[var(--ink)] rounded-[var(--radius-card)] p-6 md:p-8 text-center animate-scale-in">
          <div className="hard bg-[var(--mint)] text-[var(--ink)] font-display font-bold text-[12px] uppercase px-3.5 py-1 rounded-full inline-block mb-3 border-[2px] border-[var(--ink)]">
            ✅ LOGGED IN SESSION
          </div>
          <h2 className="font-display font-[900] text-[24px] text-[var(--ink)] mb-1">
            {user.name}
          </h2>
          <div className="font-body text-[13px] font-semibold text-[var(--ink)] opacity-70 mb-6">
            {user.email} • {user.school}
          </div>
          <div className="flex gap-3 justify-center">
            <button className="hard btn-press bg-[var(--sun)] text-[var(--ink)] font-display font-[900] text-[15px] px-6 py-3 rounded-[12px] border-[2.5px] border-[var(--ink)] shadow-[3px_3px_0px_#10100F] cursor-pointer" onClick={() => router.push('/quizflow/dashboard')}>
              📊 Go to Dashboard →
            </button>
          </div>
        </div>
      ) : (
        /* LOGIN / SIGNUP CARD */
        <div className="w-full max-w-[480px] hard bg-[var(--paper-2)] border-[3px] border-[var(--ink)] rounded-[var(--radius-card)] p-6 md:p-8 shadow-[5px_5px_0px_#10100F] animate-scale-in">
          
          <div className="flex border-b-[3px] border-[var(--ink)] mb-6 rounded-t-[8px] overflow-hidden">
            <button
              type="button"
              onClick={() => { setIsSignUp(false); setAuthError(''); setAuthNotice(''); }}
              className={`flex-1 py-3 px-2 font-display font-[800] text-[14px] md:text-[15px] transition-colors cursor-pointer ${
                !isSignUp ? 'bg-[var(--sun)] text-[var(--ink)] border-b-[3px] border-[var(--ink)]' : 'bg-transparent text-[var(--ink)] opacity-60 hover:opacity-100'
              }`}
            >
              🔑 Teacher Login
            </button>
            <button
              type="button"
              onClick={() => { setIsSignUp(true); setAuthError(''); setAuthNotice(''); }}
              className={`flex-1 py-3 px-2 font-display font-[800] text-[14px] md:text-[15px] transition-colors cursor-pointer ${
                isSignUp ? 'bg-[var(--mint)] text-[var(--ink)] border-b-[3px] border-[var(--ink)]' : 'bg-transparent text-[var(--ink)] opacity-60 hover:opacity-100'
              }`}
            >
              ✨ Create Account
            </button>
          </div>

          {/* AUTH ERROR ALERT */}
          {authError && (
            <div className="hard bg-[var(--cherry)] text-white p-4 mb-5 rounded-[12px] border-[2.5px] border-[var(--ink)] flex flex-col gap-2 text-[13px] font-display font-bold leading-snug">
              <div className="flex items-start gap-2.5">
                <span className="text-[18px] shrink-0">⚠️</span>
                <div>
                  <div>{authError}</div>
                  {authError.toLowerCase().includes('email not confirmed') && (
                    <div className="mt-1 font-body text-[12px] opacity-90">
                      Supabase requires email verification link confirmation before signing in on a new browser.
                    </div>
                  )}
                </div>
              </div>

              {authError.toLowerCase().includes('email not confirmed') && (
                <div className="flex flex-col sm:flex-row gap-2 mt-2 pt-2 border-t border-white/20">
                  <button
                    type="button"
                    onClick={handleResendEmail}
                    className="hard btn-press bg-[var(--sun)] text-[var(--ink)] px-3 py-1.5 rounded-[8px] text-[12px] font-display font-extrabold border-[1.5px] border-[var(--ink)]"
                  >
                    📩 Resend Verification Link
                  </button>
                  <button
                    type="button"
                    onClick={handleLocalBypassLogin}
                    className="hard btn-press bg-white text-[var(--ink)] px-3 py-1.5 rounded-[8px] text-[12px] font-display font-extrabold border-[1.5px] border-[var(--ink)]"
                  >
                    🔓 Continue Session on Device →
                  </button>
                </div>
              )}
            </div>
          )}

          {/* AUTH NOTICE ALERT */}
          {authNotice && (
            <div className="hard bg-[var(--mint)] text-[var(--ink)] p-3.5 mb-5 rounded-[12px] border-[2.5px] border-[var(--ink)] flex items-start gap-2.5 text-[13px] font-display font-bold leading-snug">
              <span className="text-[16px] shrink-0">📩</span>
              <span>{authNotice}</span>
            </div>
          )}
          {/* 1-CLICK GOOGLE LOGIN BUTTON */}
          <div className="mb-5">
            <button
              type="button"
              onClick={handleGoogleLogin}
              className="w-full h-[50px] hard btn-press bg-white text-[var(--ink)] font-display font-[800] text-[15px] rounded-[12px] border-[3px] border-[var(--ink)] shadow-[3.5px_3.5px_0px_#10100F] cursor-pointer flex items-center justify-center gap-3 hover:bg-[#FAF9F5] transition-colors"
            >
              <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
              </svg>
              <span>Continue with Google</span>
            </button>
            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 h-[1.5px] bg-[var(--ink)] opacity-15"></div>
              <span className="text-[11px] font-display font-bold uppercase tracking-wider text-[var(--ink)] opacity-50">OR WITH EMAIL</span>
              <div className="flex-1 h-[1.5px] bg-[var(--ink)] opacity-15"></div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {isSignUp && (
              <div>
                <label className="block text-[11px] font-display font-[800] tracking-widest text-[var(--ink)] uppercase opacity-75 mb-1.5">
                  Full Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Prof. Alex Mercer"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                  className="w-full h-[48px] px-4 bg-white border-[3px] border-[var(--ink)] rounded-[12px] font-body text-[14px] font-semibold outline-none focus:ring-[3px] focus:ring-[#FFE57F] shadow-[3px_3px_0px_#10100F]"
                />
              </div>
            )}

            <div>
              <label className="block text-[11px] font-display font-[800] tracking-widest text-[var(--ink)] uppercase opacity-75 mb-1.5">
                Teacher Email
              </label>
              <input
                type="email"
                placeholder="teacher@school.edu"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full h-[48px] px-4 bg-white border-[3px] border-[var(--ink)] rounded-[12px] font-body text-[14px] font-semibold outline-none focus:ring-[3px] focus:ring-[#FFE57F] shadow-[3px_3px_0px_#10100F]"
              />
            </div>

            <div>
              <label className="block text-[11px] font-display font-[800] tracking-widest text-[var(--ink)] uppercase opacity-75 mb-1.5">
                Password (min 6 characters)
              </label>
              <input
                type="password"
                placeholder="••••••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                minLength={6}
                required
                className="w-full h-[48px] px-4 bg-white border-[3px] border-[var(--ink)] rounded-[12px] font-body text-[14px] font-semibold outline-none focus:ring-[3px] focus:ring-[#FFE57F] shadow-[3px_3px_0px_#10100F]"
              />
            </div>

            {isSignUp && (
              <div>
                <label className="block text-[11px] font-display font-[800] tracking-widest text-[var(--ink)] uppercase opacity-75 mb-1.5">
                  School / Institution
                </label>
                <input
                  type="text"
                  placeholder="e.g. Oakridge High School"
                  value={school}
                  onChange={e => setSchool(e.target.value)}
                  className="w-full h-[48px] px-4 bg-white border-[3px] border-[var(--ink)] rounded-[12px] font-body text-[14px] font-semibold outline-none focus:ring-[3px] focus:ring-[#FFE57F] shadow-[3px_3px_0px_#10100F]"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-2 w-full h-[52px] hard btn-press bg-[var(--violet)] text-white font-display font-[900] text-[16px] uppercase tracking-wide rounded-[12px] border-[3px] border-[var(--ink)] shadow-[4px_4px_0px_#10100F] cursor-pointer disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {isSubmitting
                ? '⏳ Authenticating...'
                : isSignUp
                ? '✨ Register Account →'
                : '🔑 Sign In →'}
            </button>
          </form>

          <hr className="border-[1.5px] border-[var(--ink)] opacity-20 my-6" />

          {/* 1-CLICK DEMO LOGIN */}
          <div className="text-center">
            <div className="text-[12px] font-body font-semibold opacity-70 mb-2.5">
              Testing or demonstrating QuizFlow?
            </div>
            <button
              type="button"
              onClick={handleDemoLogin}
              className="w-full py-3.5 px-4 hard btn-press bg-[var(--sun)] text-[var(--ink)] font-display font-[800] text-[14px] rounded-[12px] border-[2.5px] border-[var(--ink)] shadow-[3px_3px_0px_#10100F] cursor-pointer"
            >
              🎓 Instant Demo Teacher Login (Prof. Alex)
            </button>
          </div>

        </div>
      )}

      {/* BACK TO HOME */}
      <div className="mt-6">
        <Link href="/quizflow" className="font-display font-[800] text-[13px] text-[var(--ink)] hover:underline">
          ← Back to Main Page
        </Link>
      </div>

    </div>
  )
}

