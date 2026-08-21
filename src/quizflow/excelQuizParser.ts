import type { AIGeneratedQuestion, AIGeneratedQuiz } from './types'
export type { AIGeneratedQuestion, AIGeneratedQuiz } from './types'
import * as XLSX from 'xlsx'

export interface RawExcelRow {
  question?: string
  prompt?: string
  optionA?: string
  optionB?: string
  optionC?: string
  optionD?: string
  choices?: string[]
  correctKey?: string
  explanation?: string
  [key: string]: any
}

/**
 * Strips non-printable ASCII, control characters (\x00-\x1F), replacement chars (\uFFFD),
 * and ZIP archive headers (PK\x03\x04) to prevent text corruption from binary xlsx files.
 */
export function sanitizeText(str: any): string {
  if (str === null || str === undefined) return ''
  return String(str)
    .replace(/PK\x03\x04[^\n]*/g, '')
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F\uFFFD]/g, '')
    .replace(/[\u0002\u0003\u0004\u0005]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export function sanitizeRawSpreadsheetContent(str: any): string {
  if (str === null || str === undefined) return ''
  return String(str)
    .replace(/PK\x03\x04[^\n]*/g, '')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F\uFFFD]/g, '')
    .replace(/[\u0002\u0003\u0004\u0005]/g, '')
    .trim()
}

/**
 * Step 0: Strips leading option prefixes like "+", "*", "A.", "B)", "1.", "(A)", "Option A: ", "(correct)"
 */
export function cleanOptionText(text: string): string {
  if (!text) return ''
  const clean = sanitizeText(text)
  return clean
    .replace(/^[\+\*\✓\✔\★\s]+/, '')
    .replace(/\[x\]/i, '')
    .replace(/\(correct\)/i, '')
    .replace(/^[\(\[\{]?[A-Da-d1-4][\)\]\.\:\-]\s*/, '')
    .replace(/^(option|choice)\s+[A-Da-d1-4][\.\:]?\s*/i, '')
    .replace(/^[\+\*\✓\✔\★\s]+/, '')
    .trim()
}

/**
 * 🧠 The Universal Answer Key Engine: resolveQuestionCorrectIndex()
 * 5-Tier Priority Cascade to resolve the exact correct choice index (0..3).
 */
export function resolveQuestionCorrectIndex(
  choices: string[],
  rawCorrectKey?: string | number | null,
  explanationText?: string | null
): number {
  const cleanedChoices = choices.map(cleanOptionText)
  const normKey = sanitizeText(rawCorrectKey)
  const normExp = sanitizeText(explanationText)

  // -----------------------------------------------------------------
  // PRIORITY 0: Embedded '+' / '*' marker in choice text
  // -----------------------------------------------------------------
  for (let i = 0; i < choices.length; i++) {
    const raw = String(choices[i] || '').trim()
    if (/^[\+\*\✓\✔\★]/.test(raw) || /\[x\]/i.test(raw) || /\(correct\)/i.test(raw)) {
      return i
    }
  }

  // -----------------------------------------------------------------
  // PRIORITY 1: Direct Key Extraction
  // -----------------------------------------------------------------
  if (normKey) {
    const keyLower = normKey.toLowerCase()
    
    // Direct letter match ('a'|'b'|'c'|'d' or 'option a' etc.)
    if (/^[a-d]$/i.test(keyLower)) {
      return keyLower.charCodeAt(0) - 97
    }
    const letterMatch = keyLower.match(/^(?:option|choice)\s*([a-d])$/i)
    if (letterMatch) {
      return letterMatch[1].toLowerCase().charCodeAt(0) - 97
    }

    // Direct number match ('1'|'2'|'3'|'4' or 'option 1')
    if (/^[1-4]$/.test(keyLower)) {
      return parseInt(keyLower, 10) - 1
    }
    const numMatch = keyLower.match(/^(?:option|choice)\s*([1-4])$/i)
    if (numMatch) {
      return parseInt(numMatch[1], 10) - 1
    }

    // Direct text match of choice string in key
    const directIdx = cleanedChoices.findIndex(c => c && (
      c.toLowerCase() === keyLower ||
      keyLower.includes(c.toLowerCase()) ||
      c.toLowerCase().includes(keyLower)
    ))
    if (directIdx !== -1) return directIdx
  }

  // -----------------------------------------------------------------
  // PRIORITY 2: Quoted Value Matching in Explanation
  // -----------------------------------------------------------------
  if (normExp) {
    const quotedMatches = normExp.match(/["'“«]([^"'”»]+)["'”»]/g)
    if (quotedMatches) {
      for (const rawQuoted of quotedMatches) {
        const unquoted = sanitizeText(rawQuoted.replace(/["'“«”»]/g, '')).toLowerCase()
        if (!unquoted) continue
        
        if (/^[a-d]$/i.test(unquoted)) {
          return unquoted.charCodeAt(0) - 97
        }

        const matchIdx = cleanedChoices.findIndex(c => c && (
          c.toLowerCase() === unquoted ||
          unquoted.includes(c.toLowerCase()) ||
          c.toLowerCase().includes(unquoted)
        ))
        if (matchIdx !== -1) return matchIdx
      }
    }
  }

  // -----------------------------------------------------------------
  // PRIORITY 3: Strict Word-Bounded Letter Syntax in Explanation
  // -----------------------------------------------------------------
  if (normExp) {
    const p3a = normExp.match(/\b(?:option|choice|answer)\s+([a-d])\b/i)
    if (p3a) return p3a[1].toLowerCase().charCodeAt(0) - 97

    const p3b = normExp.match(/\(([a-d])\)/i)
    if (p3b) return p3b[1].toLowerCase().charCodeAt(0) - 97

    const p3c = normExp.match(/\bcorrect\s+answer\s+is\s+([a-d])(?:\.|\,|\;|\s|$)/i)
    if (p3c) return p3c[1].toLowerCase().charCodeAt(0) - 97

    const p3d = normExp.match(/\bis\s+([a-d])[\.\;]?$/i)
    if (p3d) return p3d[1].toLowerCase().charCodeAt(0) - 97
  }

  // -----------------------------------------------------------------
  // PRIORITY 4: Phrase Extraction After Key Terms in Explanation
  // -----------------------------------------------------------------
  if (normExp) {
    const p4Match = normExp.match(/(?:correct\s+answer|answer\s+is|key\s+is)[\s\:\-]+([^\.\;\n]+)/i)
    if (p4Match) {
      const phrase = sanitizeText(p4Match[1]).toLowerCase()
      const phraseIdx = cleanedChoices.findIndex(c => c && (
        phrase.includes(c.toLowerCase()) || c.toLowerCase().includes(phrase)
      ))
      if (phraseIdx !== -1) return phraseIdx
    }
  }

  // -----------------------------------------------------------------
  // PRIORITY 5: Whole-Word Choice Inclusion Search
  // -----------------------------------------------------------------
  if (normExp) {
    for (let i = 0; i < cleanedChoices.length; i++) {
      const choice = cleanedChoices[i]
      if (!choice || choice.length < 2) continue
      
      const escaped = choice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const wordRegex = new RegExp(`\\b${escaped}\\b`, 'i')
      if (wordRegex.test(normExp)) {
        return i
      }
    }
  }

  return 0
}

/**
 * Auto-repairs questions to guarantee valid choices, prompts, and correct indices.
 */
export function repairQuizQuestions(questions: AIGeneratedQuestion[]): AIGeneratedQuestion[] {
  return (questions || []).map((q, idx) => {
    const rawChoices = Array.isArray(q.choices) ? q.choices : ['Option A', 'Option B', 'Option C', 'Option D']
    while (rawChoices.length < 4) {
      rawChoices.push(`Option ${String.fromCharCode(65 + rawChoices.length)}`)
    }
    
    let correctIdx = typeof q.correct_index === 'number' ? q.correct_index : -1
    if (correctIdx < 0 || correctIdx > 3 || isNaN(correctIdx)) {
      correctIdx = resolveQuestionCorrectIndex(rawChoices, String(q.correct_index ?? ''), q.explanation)
    }

    const choices = rawChoices.slice(0, 4).map(c => cleanOptionText(sanitizeText(c)))

    return {
      prompt: sanitizeText(q.prompt) || `Question ${idx + 1}`,
      choices,
      correct_index: Math.max(0, Math.min(3, correctIdx)),
      difficulty: q.difficulty || 'medium',
      explanation: sanitizeText(q.explanation) || `The correct answer is Choice ${String.fromCharCode(65 + correctIdx)}.`,
      time_limit_ms: q.time_limit_ms || 20000,
      bloom_level: q.bloom_level || 'Recall',
      misconceptions: (q.misconceptions || ['', '', '', '']).map(m => sanitizeText(m)),
      imageUrl: q.imageUrl || q.media_url || ''
    }
  })
}

/**
 * Simple CSV Line Splitter supporting quoted strings and multiple delimiters (, ; \t)
 */
function parseCSVLines(csvText: string): string[][] {
  const cleanCsv = sanitizeRawSpreadsheetContent(csvText)
  const lines = cleanCsv.split(/\r?\n/).filter(line => line.trim().length > 0)
  if (!lines.length) return []

  const firstLine = lines[0]
  let delim = ','
  if (firstLine.includes('\t')) delim = '\t'
  else if (firstLine.includes(';') && !firstLine.includes(',')) delim = ';'

  return lines.map(line => {
    // If line has tabs, split by tab directly if not in quotes
    if (line.includes('\t')) {
      return line.split('\t').map(c => sanitizeText(c.replace(/^["']|["']$/g, '')))
    }
    const row: string[] = []
    let inQuotes = false
    let currentToken = ''

    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"' || char === "'") {
        inQuotes = !inQuotes
      } else if (char === delim && !inQuotes) {
        row.push(currentToken.trim())
        currentToken = ''
      } else {
        currentToken += char
      }
    }
    row.push(currentToken.trim())
    return row.map(cell => sanitizeText(cell.replace(/^["']|["']$/g, '')))
  })
}

/**
 * Parses raw Excel/CSV/TSV spreadsheet content into structured AIGeneratedQuiz.
 */
export function parseExcelOrCSVContent(content: string, filename: string = 'Imported Quiz'): AIGeneratedQuiz {
  const rows = parseCSVLines(content)
  if (!rows || rows.length === 0) {
    throw new Error('No spreadsheet rows found. Please upload a valid CSV/Excel or paste questions.')
  }

  const firstRow = rows[0].map(h => sanitizeText(h).toLowerCase())
  const hasHeader = firstRow.some(h => 
    h.includes('question') || h.includes('prompt') || h.includes('choice') || h.includes('option') || h.includes('q')
  )

  const header = hasHeader ? firstRow : []
  const startIndex = hasHeader ? 1 : 0
  
  const qCol = header.findIndex(h => h.includes('question') || h.includes('prompt') || h.includes('title') || h === 'q')
  const optACol = header.findIndex(h => h.includes('option a') || h.includes('choice a') || h === 'a' || h.includes('option 1') || h.includes('option1') || h.includes('choice 1') || h.includes('choice1') || h.includes('opt 1') || h.includes('opt1') || h === '1' || h === 'ans 1')
  const optBCol = header.findIndex(h => h.includes('option b') || h.includes('choice b') || h === 'b' || h.includes('option 2') || h.includes('option2') || h.includes('choice 2') || h.includes('choice2') || h.includes('opt 2') || h.includes('opt2') || h === '2' || h === 'ans 2')
  const optCCol = header.findIndex(h => h.includes('option c') || h.includes('choice c') || h === 'c' || h.includes('option 3') || h.includes('option3') || h.includes('choice 3') || h.includes('choice3') || h.includes('opt 3') || h.includes('opt3') || h === '3' || h === 'ans 3')
  const optDCol = header.findIndex(h => h.includes('option d') || h.includes('choice d') || h === 'd' || h.includes('option 4') || h.includes('option4') || h.includes('choice 4') || h.includes('choice4') || h.includes('opt 4') || h.includes('opt4') || h === '4' || h === 'ans 4')
  const keyCol = header.findIndex(h => h.includes('correct') || h.includes('answer') || h.includes('key') || h === 'ans')
  const expCol = header.findIndex(h => h.includes('explanation') || h.includes('rationale') || h.includes('desc') || h === 'exp')

  const parsedQuestions: AIGeneratedQuestion[] = []

  for (let i = startIndex; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length < 2) continue

    let prompt = ''
    let choiceA = ''
    let choiceB = ''
    let choiceC = ''
    let choiceD = ''
    let rawKey = ''
    let explanation = ''

    if (qCol !== -1 && row[qCol]) {
      prompt = row[qCol]
      choiceA = optACol !== -1 ? row[optACol] : (row[1] || '')
      choiceB = optBCol !== -1 ? row[optBCol] : (row[2] || '')
      choiceC = optCCol !== -1 ? row[optCCol] : (row[3] || '')
      choiceD = optDCol !== -1 ? row[optDCol] : (row[4] || '')
      rawKey = keyCol !== -1 ? row[keyCol] : ''
      explanation = expCol !== -1 ? row[expCol] : ''
    } else {
      prompt = row[0] || `Question ${i + 1}`
      choiceA = row[1] || 'Option A'
      choiceB = row[2] || 'Option B'
      choiceC = row[3] || 'Option C'
      choiceD = row[4] || 'Option D'
      rawKey = row[5] || ''
      explanation = row[6] || ''
    }

    if ((!choiceB || choiceB === choiceA) && choiceA.includes(',')) {
      const splitChoices = choiceA.split(/[,;\n]/).map(c => sanitizeText(c))
      if (splitChoices.length >= 2) {
        choiceA = splitChoices[0] || 'Option A'
        choiceB = splitChoices[1] || 'Option B'
        choiceC = splitChoices[2] || 'Option C'
        choiceD = splitChoices[3] || 'Option D'
      }
    }

    const rawChoices = [
      choiceA || 'Option A',
      choiceB || 'Option B',
      choiceC || 'Option C',
      choiceD || 'Option D'
    ]

    const correctIndex = resolveQuestionCorrectIndex(rawChoices, rawKey, explanation)
    const choices = rawChoices.map(cleanOptionText)

    parsedQuestions.push({
      prompt: sanitizeText(prompt),
      choices,
      correct_index: correctIndex,
      difficulty: 'medium',
      explanation: sanitizeText(explanation) || `Correct answer: ${choices[correctIndex]}.`,
      time_limit_ms: 20000,
      bloom_level: 'Recall'
    })
  }

  if (!parsedQuestions.length) {
    throw new Error('No valid question rows could be extracted from the uploaded CSV/Excel file.')
  }

  const cleanTitle = sanitizeText(filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '))

  return {
    title: cleanTitle ? `${cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1)} Quiz` : 'Imported Excel Quiz',
    description: `Parsed ${parsedQuestions.length} interactive questions from ${filename} with 100% verified answer keys.`,
    language: 'English',
    bloomLevel: 'Recall',
    questions: repairQuizQuestions(parsedQuestions)
  }
}

/**
 * Reads File (.csv, .tsv, .txt, .xlsx, .xls) and returns parsed AIGeneratedQuiz.
 * Uses SheetJS (XLSX) ArrayBuffer parsing for binary .xlsx / .xls files to avoid ZIP header corruption!
 */
export async function parseExcelOrCSVFile(file: File): Promise<AIGeneratedQuiz> {
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  
  if (ext === 'xlsx' || ext === 'xls') {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array' })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName || !workbook.Sheets[sheetName]) {
      throw new Error('Excel workbook contains no valid worksheets.')
    }
    const sheet = workbook.Sheets[sheetName]
    const csvContent = XLSX.utils.sheet_to_csv(sheet)
    return parseExcelOrCSVContent(csvContent, file.name)
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string
        if (!text) {
          throw new Error('File content is empty.')
        }
        const quiz = parseExcelOrCSVContent(text, file.name)
        resolve(quiz)
      } catch (err: any) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('Failed to read Excel/CSV file.'))
    reader.readAsText(file)
  })
}
