/* ================================================================
   QuizFlow — Supabase Cloud Database Client & Hybrid Sync Adapter
   Supports direct Supabase PostgreSQL Cloud DB sync with fallback.
   ================================================================ */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { HostUser } from './authStore'
import type { SavedQuizItem } from './quizStore'
import type { SessionHistoryRecord } from './historyStore'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// ── Lazy singleton — never runs at module parse time ──────────────
let _supabase: SupabaseClient | null | false = false   // false = not yet resolved

function getSupabaseClient(): SupabaseClient | null {
  // Already resolved — return cached result
  if (_supabase !== false) return _supabase

  // Validate config
  if (
    !supabaseUrl ||
    !supabaseAnonKey ||
    supabaseUrl.includes('placeholder') ||
    supabaseAnonKey.includes('placeholder')
  ) {
    _supabase = null
    return null
  }

  // Server-side (Node.js / Vercel Serverless API Routes)
  if (typeof window === 'undefined') {
    try {
      _supabase = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false }
      })
      return _supabase
    } catch {
      _supabase = null
      return null
    }
  }

  // Client-side (Browser) - Probe storage access
  let storageOk = false
  try {
    const testKey = '__qf_storage_probe__'
    localStorage.setItem(testKey, '1')
    localStorage.removeItem(testKey)
    storageOk = true
  } catch {
    storageOk = false
  }

  try {
    if (storageOk) {
      _supabase = createClient(supabaseUrl, supabaseAnonKey, {
        realtime: { params: { eventsPerSecond: 20 } }
      })
    } else {
      // Storage is blocked (private/incognito/strict mobile settings)
      // Use in-memory auth so the app still works, just not persistent
      _supabase = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: false,
          detectSessionInUrl: false,
          storage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
          }
        },
        realtime: { params: { eventsPerSecond: 20 } }
      })
    }
  } catch (err) {
    console.warn('[QuizFlow Supabase] Client initialization failed silently:', err)
    _supabase = null
  }

  return _supabase
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    supabaseUrl &&
    supabaseAnonKey &&
    !supabaseUrl.includes('placeholder') &&
    !supabaseAnonKey.includes('placeholder')
  )
}

// Safe no-op channel for offline / unconfigured fallback
const noopChannel = {
  send: async () => {},
  on: () => noopChannel,
  subscribe: (cb?: (status: string) => void) => {
    if (cb) cb('CLOSED')
    return noopChannel
  }
}

/**
 * Always use this export or getSupabase().
 * Safe for SSR, mobile Chrome, Safari incognito, and offline mode.
 */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getSupabaseClient()
    if (!client) {
      if (prop === 'channel') return () => noopChannel
      if (prop === 'removeChannel') return () => {}
      if (prop === 'from') return () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: null, error: null }) }), maybeSingle: async () => ({ data: null, error: null }) }),
        upsert: async () => ({ data: null, error: null }),
        insert: async () => ({ data: null, error: null }),
        update: async () => ({ data: null, error: null }),
        delete: async () => ({ data: null, error: null })
      })
      return undefined
    }
    const value = (client as unknown as Record<string | symbol, unknown>)[prop]
    if (typeof value === 'function') return value.bind(client)
    return value
  }
}) as SupabaseClient | null

// Re-export a nullable version for code that checks `if (getSupabase())`
export function getSupabase(): SupabaseClient | null {
  return getSupabaseClient()
}

/* ================================================================
   SQL DDL SCHEMA (Run this in Supabase SQL Editor if creating tables)
   ================================================================
   
   CREATE TABLE IF NOT EXISTS hosts (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     school TEXT,
     avatar_seed TEXT,
     created_at TIMESTAMPTZ DEFAULT NOW()
   );

   CREATE TABLE IF NOT EXISTS quizzes (
     id TEXT PRIMARY KEY,
     host_id TEXT,
     title TEXT NOT NULL,
     description TEXT,
     language TEXT DEFAULT 'English',
     bloom_level TEXT DEFAULT 'Recall',
     question_count INT DEFAULT 0,
     quiz_data JSONB NOT NULL,
     is_draft BOOLEAN DEFAULT false,
     created_at TIMESTAMPTZ DEFAULT NOW(),
     updated_at TIMESTAMPTZ DEFAULT NOW()
   );

   CREATE TABLE IF NOT EXISTS session_history (
     id TEXT PRIMARY KEY,
     pin TEXT NOT NULL,
     quiz_title TEXT NOT NULL,
     language TEXT,
     bloom_level TEXT,
     total_questions INT,
     total_players INT,
     winner_name TEXT,
     winner_score INT,
     class_accuracy_percent INT,
     completed_at TIMESTAMPTZ DEFAULT NOW(),
     players_summary JSONB,
     question_stats JSONB
   );
   ================================================================ */

// ── Supabase Cloud Sync Helpers ──────────────────────────────────

export async function syncHostUserToSupabase(user: HostUser) {
  const client = getSupabaseClient()
  if (!client) return null
  try {
    const { data, error } = await client.from('hosts').upsert({
      id: user.id,
      name: user.name,
      email: user.email,
      school: user.school,
      avatar_seed: user.avatarSeed
    })
    if (error) console.warn('Supabase Host Sync Warning:', error.message)
    return data
  } catch (err) {
    console.warn('Supabase Host Sync Exception:', err)
    return null
  }
}

export async function syncQuizToSupabase(item: SavedQuizItem, hostId?: string) {
  const client = getSupabaseClient()
  if (!client) return null
  try {
    const { data, error } = await client.from('quizzes').upsert({
      id: item.id,
      host_id: hostId || 'host_demo',
      title: item.title,
      description: item.description,
      language: item.language,
      bloom_level: item.bloomLevel,
      question_count: item.questionCount,
      quiz_data: item.quiz,
      is_draft: item.isDraft,
      updated_at: new Date(item.updatedAt).toISOString()
    })
    if (error) console.warn('Supabase Quiz Sync Warning:', error.message)
    return data
  } catch (err) {
    console.warn('Supabase Quiz Sync Exception:', err)
    return null
  }
}

export async function syncSessionHistoryToSupabase(rec: SessionHistoryRecord) {
  const client = getSupabaseClient()
  if (!client) return null
  try {
    const { data, error } = await client.from('session_history').upsert({
      id: rec.id,
      pin: rec.pin,
      quiz_title: rec.quizTitle,
      language: rec.language,
      bloom_level: rec.bloomLevel,
      total_questions: rec.totalQuestions,
      total_players: rec.totalPlayers,
      winner_name: rec.winnerName,
      winner_score: rec.winnerScore,
      class_accuracy_percent: rec.classAccuracyPercent,
      completed_at: new Date(rec.completedAt).toISOString(),
      players_summary: rec.playersSummary,
      question_stats: rec.questionStats
    })
    if (error) console.warn('Supabase History Sync Warning:', error.message)
    return data
  } catch (err) {
    console.warn('Supabase History Sync Exception:', err)
    return null
  }
}

export async function syncCommunityQuizToSupabase(quizItem: any) {
  const client = getSupabaseClient()
  if (!client || !quizItem || !quizItem.id) return null
  try {
    const { data, error } = await client.from('quizzes').upsert({
      id: quizItem.id,
      host_id: 'community_creator',
      title: quizItem.title,
      description: quizItem.description || '',
      language: quizItem.quiz?.language || 'English',
      bloom_level: quizItem.bloomLevel || 'Comprehension',
      question_count: quizItem.questionCount || quizItem.quiz?.questions?.length || 0,
      quiz_data: quizItem,
      is_draft: false,
      updated_at: new Date(quizItem.createdAt || Date.now()).toISOString()
    })
    if (error) console.warn('Supabase Community Quiz Sync Warning:', error.message)
    return data
  } catch (err) {
    console.warn('Supabase Community Quiz Sync Exception:', err)
    return null
  }
}

export async function deleteQuizFromSupabase(id: string) {
  const client = getSupabaseClient()
  if (!client || !id) return null
  try {
    const { data, error } = await client.from('quizzes').delete().eq('id', id)
    if (error) console.warn('[Supabase Quiz Delete Warning]:', error.message)
    return data
  } catch (err) {
    console.warn('[Supabase Quiz Delete Exception]:', err)
    return null
  }
}

export async function purgeQuizzesFromSupabase() {
  const client = getSupabaseClient()
  if (!client) return null
  try {
    const { data, error } = await client.from('quizzes').delete().neq('id', '__keep_none__')
    if (error) console.warn('[Supabase Purge Quizzes Warning]:', error.message)
    return data
  } catch (err) {
    console.warn('[Supabase Purge Quizzes Exception]:', err)
    return null
  }
}

