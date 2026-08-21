/* ================================================================
   QuizFlow — Saved Quizzes & Drafts Store
   Manages teacher quizzes, drafts, and preset quizzes.
   ================================================================ */

import type { AIGeneratedQuiz } from './types'

export interface SavedQuizItem {
  id: string
  title: string
  description: string
  language: string
  bloomLevel: string
  questionCount: number
  quiz: AIGeneratedQuiz
  isDraft: boolean
  createdAt: number
  updatedAt: number
}

const QUIZZES_KEY = 'qf_saved_quizzes'

const DEFAULT_PRESET_QUIZZES: SavedQuizItem[] = [
  {
    id: 'preset_photosynthesis',
    title: 'Photosynthesis & Solar Biology',
    description: 'An interactive quiz covering solar energy conversion, chloroplasts, and cellular respiration.',
    language: 'English',
    bloomLevel: 'Recall',
    questionCount: 3,
    isDraft: false,
    createdAt: Date.now() - 3 * 86400 * 1000,
    updatedAt: Date.now() - 3 * 86400 * 1000,
    quiz: {
      title: 'Photosynthesis & Solar Biology',
      description: 'An interactive quiz covering solar energy conversion, chloroplasts, and cellular respiration.',
      language: 'English',
      bloomLevel: 'Recall',
      questions: [
        {
          prompt: 'What is the process by which plants convert sunlight into food?',
          choices: ['Cellular Respiration', 'Photosynthesis', 'Fermentation', 'Transpiration'],
          correct_index: 1,
          difficulty: 'easy',
          explanation: 'Photosynthesis occurs in chloroplasts using chlorophyll to capture light energy.',
          bloom_level: 'Recall',
          misconceptions: [
            'Cellular respiration breaks down glucose to release energy.',
            '',
            'Fermentation is an anaerobic process.',
            'Transpiration is water evaporation through stomata.'
          ],
          time_limit_ms: 20000
        },
        {
          prompt: 'Which organelle is responsible for hosting photosynthesis in plant cells?',
          choices: ['Mitochondria', 'Nucleus', 'Chloroplast', 'Ribosome'],
          correct_index: 2,
          difficulty: 'medium',
          explanation: 'Chloroplasts contain chlorophyll pigments that absorb light wavelengths.',
          bloom_level: 'Recall',
          misconceptions: [
            'Mitochondria perform cellular respiration to generate ATP.',
            'The nucleus houses genomic DNA.',
            '',
            'Ribosomes translate mRNA into protein chains.'
          ],
          time_limit_ms: 15000
        },
        {
          prompt: 'What are the main outputs (products) of photosynthesis?',
          choices: ['Carbon Dioxide & Water', 'Glucose & Oxygen', 'Nitrogen & ATP', 'Lactic Acid & CO2'],
          correct_index: 1,
          difficulty: 'easy',
          explanation: 'The chemical reaction produces 6O2 + C6H12O6 (Glucose and Oxygen).',
          bloom_level: 'Comprehension',
          misconceptions: [
            'Carbon dioxide and water are the required inputs/reactants.',
            '',
            'Atmospheric nitrogen is not a product.',
            'Lactic acid is a byproduct of anaerobic muscle fermentation.'
          ],
          time_limit_ms: 20000
        }
      ]
    }
  },
  {
    id: 'preset_quantum_physics',
    title: 'Quantum Mechanics & Wave-Particle Duality',
    description: 'Explore wave-particle duality, Heisenberg uncertainty principle, and electron spin.',
    language: 'English',
    bloomLevel: 'Application',
    questionCount: 3,
    isDraft: false,
    createdAt: Date.now() - 5 * 86400 * 1000,
    updatedAt: Date.now() - 5 * 86400 * 1000,
    quiz: {
      title: 'Quantum Mechanics & Wave-Particle Duality',
      description: 'Explore wave-particle duality, Heisenberg uncertainty principle, and electron spin.',
      language: 'English',
      bloomLevel: 'Application',
      questions: [
        {
          prompt: 'In a double-slit experiment, what pattern forms on the screen when single electrons are fired one by one over time?',
          choices: ['Two sharp parallel lines', 'An interference pattern of bright and dark fringes', 'A uniform circular smudge', 'A single central dot'],
          correct_index: 1,
          difficulty: 'medium',
          explanation: 'Each single electron interferes with its own wave probability distribution, forming fringes over time.',
          bloom_level: 'Application',
          misconceptions: [
            'Classical particles create two lines, but quantum wavefunctions display interference.',
            '',
            'Uniform smudging occurs without coherent phase relationship.',
            'Single dots represent single impacts, not the accumulated pattern.'
          ],
          time_limit_ms: 20000
        },
        {
          prompt: 'According to Heisenberg Uncertainty Principle, what two properties cannot be simultaneously measured with absolute precision?',
          choices: ['Position and Momentum', 'Mass and Charge', 'Energy and Temperature', 'Velocity and Acceleration'],
          correct_index: 0,
          difficulty: 'easy',
          explanation: 'Δx · Δp ≥ ℏ / 2 dictates that precise position knowledge increases momentum uncertainty.',
          bloom_level: 'Recall',
          misconceptions: [
            '',
            'Mass and electric charge are intrinsic static particle constants.',
            'Energy and temperature relate to thermal ensembles, not conjugate quantum variables.',
            'Velocity and acceleration are derivative kinematic pairs in classical mechanics.'
          ],
          time_limit_ms: 15000
        },
        {
          prompt: 'What physical concept explains why microscopic particles can pass through energy barriers higher than their total energy?',
          choices: ['Quantum Tunneling', 'Thermal Convection', 'Photoelectric Emission', 'Blackbody Radiation'],
          correct_index: 0,
          difficulty: 'hard',
          explanation: 'Quantum wavefunctions have non-zero probability amplitudes inside and beyond thin potential barriers.',
          bloom_level: 'Analysis',
          misconceptions: [
            '',
            'Convection is bulk fluid heat movement.',
            'Photoelectric effect involves photon absorption liberating electrons.',
            'Blackbody radiation is thermal electromagnetic emission.'
          ],
          time_limit_ms: 20000
        }
      ]
    }
  }
]

import { getHostUser } from './authStore'

function getStorageKey(): string {
  if (typeof window === 'undefined') return QUIZZES_KEY
  const user = getHostUser()
  if (user && user.email) {
    return `qf_saved_quizzes_${user.email.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
  }
  return QUIZZES_KEY
}

export function getSavedQuizzes(): SavedQuizItem[] {
  if (typeof window === 'undefined') return DEFAULT_PRESET_QUIZZES
  const key = getStorageKey()
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
      }
    }
    // Initialize default presets if empty
    localStorage.setItem(key, JSON.stringify(DEFAULT_PRESET_QUIZZES))
    return DEFAULT_PRESET_QUIZZES
  } catch (err) {
    console.warn('Failed to load saved quizzes from storage:', err)
    return DEFAULT_PRESET_QUIZZES
  }
}

export function getQuizById(id: string): SavedQuizItem | null {
  const quizzes = getSavedQuizzes()
  return quizzes.find(q => q.id === id) || null
}

import { syncQuizToSupabase, deleteQuizFromSupabase, purgeQuizzesFromSupabase } from './supabaseClient'

export function saveQuizDraft(quiz: AIGeneratedQuiz, isDraft = true, id?: string): SavedQuizItem {
  const quizzes = getSavedQuizzes()
  const quizId = id || 'quiz_' + Date.now()
  const existingIdx = quizzes.findIndex(q => q.id === quizId)

  const newItem: SavedQuizItem = {
    id: quizId,
    title: quiz.title || 'Untitled Quiz',
    description: quiz.description || 'AI Generated Quiz',
    language: quiz.language || 'English',
    bloomLevel: quiz.bloomLevel || 'Recall',
    questionCount: quiz.questions?.length || 0,
    quiz,
    isDraft,
    createdAt: existingIdx >= 0 ? quizzes[existingIdx].createdAt : Date.now(),
    updatedAt: Date.now()
  }

  if (existingIdx >= 0) {
    quizzes[existingIdx] = newItem
  } else {
    quizzes.unshift(newItem)
  }

  if (typeof window !== 'undefined') {
    const key = getStorageKey()
    localStorage.setItem(key, JSON.stringify(quizzes))
    syncQuizToSupabase(newItem)
  }
  return newItem
}

export function deleteSavedQuiz(id: string): boolean {
  let quizzes = getSavedQuizzes()
  quizzes = quizzes.filter(q => q.id !== id)
  if (typeof window !== 'undefined') {
    const key = getStorageKey()
    localStorage.setItem(key, JSON.stringify(quizzes))
    deleteQuizFromSupabase(id)
  }
  return true
}

export function purgeAllSavedQuizzes(): boolean {
  if (typeof window !== 'undefined') {
    const key = getStorageKey()
    localStorage.setItem(key, JSON.stringify([]))
    purgeQuizzesFromSupabase()
  }
  return true
}
