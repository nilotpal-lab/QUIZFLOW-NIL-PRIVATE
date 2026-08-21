import { NextResponse } from 'next/server'

/* ================================================================
   QUADRUPLE-TIER AI ROUTER (Gemini ➔ Groq ➔ OpenRouter ➔ Fallback)
   Full Multilingual & Topic-Locked AI Engine
   ================================================================ */

function sanitizeText(str: any): string {
  if (str === null || str === undefined) return ''
  return String(str)
    .replace(/PK\x03\x04[^\n]*/g, '')
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F\uFFFD]/g, '')
    .replace(/[\u0002\u0003\u0004\u0005]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const LANGUAGE_SCRIPT_MAP: Record<string, string> = {
  Hindi: 'Devanagari script (हिंदी)',
  Marathi: 'Devanagari script (मराठी)',
  Bengali: 'Bengali script (বাংলা)',
  Gujarati: 'Gujarati script (ગુજરાતી)',
  Tamil: 'Tamil script (தமிழ்)',
  Telugu: 'Telugu script (తెలుగు)',
  French: 'French (Français)',
  German: 'German (Deutsch)',
  Spanish: 'Spanish (Español)',
  Japanese: 'Japanese (日本語)',
  English: 'English',
}

function randomizeQuizAnswers(quiz: any) {
  if (!quiz || !Array.isArray(quiz.questions)) return quiz

  const randomizedQuestions = quiz.questions.map((q: any) => {
    if (!Array.isArray(q.choices) || q.choices.length <= 1) return q

    const items = q.choices.map((text: string, origIdx: number) => ({
      text,
      origIdx,
      misconception: Array.isArray(q.misconceptions) ? q.misconceptions[origIdx] || '' : ''
    }))

    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[items[i], items[j]] = [items[j], items[i]]
    }

    const newChoices = items.map((item: any) => item.text)
    const newMisconceptions = items.map((item: any) => item.misconception)
    const newCorrectIndex = items.findIndex((item: any) => item.origIdx === q.correct_index)

    return {
      ...q,
      choices: newChoices,
      correct_index: newCorrectIndex >= 0 ? newCorrectIndex : 0,
      misconceptions: newMisconceptions
    }
  })

  return {
    ...quiz,
    questions: randomizedQuestions
  }
}

function buildSystemPrompt(questionCount = 5, gradeLevel = '8th grade', targetLanguage = 'English', bloomLevel = 'Recall') {
  const scriptHint = LANGUAGE_SCRIPT_MAP[targetLanguage] || targetLanguage
  return `
You are an expert educational quiz creation engine.
Return EXACTLY one valid JSON object matching the schema below.
Do NOT wrap in markdown code blocks.
Do NOT include commentary, intro, or outro text.
Target reading level: ${gradeLevel}.
Bloom's Taxonomy Cognitive Level: ${bloomLevel}.
Level Guidelines:
- Recall: Focus on remembering facts, terms, definitions, and basic concepts.
- Comprehension: Focus on explaining ideas, understanding concepts, and interpreting facts.
- Application: Focus on applying knowledge to new scenarios, solving problems in context.
- Analysis: Focus on breaking down information, identifying patterns, cause/effect, and critical comparison.

CRITICAL RANDOMIZATION MANDATE: You MUST randomly distribute correct_index across 0, 1, 2, and 3 for the questions in the quiz. Do NOT put the correct answer at index 0 or index 1 for all questions.

LANGUAGE MANDATE: All text (title, description, questions, choices, explanations, misconceptions) MUST be strictly in ${targetLanguage} using ${scriptHint}.

JSON Output Schema:
{
  "title": "Quiz Title in ${targetLanguage}",
  "description": "Short description in ${targetLanguage}",
  "language": "${targetLanguage}",
  "bloomLevel": "${bloomLevel}",
  "questions": [
    {
      "prompt": "Question text in ${targetLanguage}?",
      "choices": ["Choice A in ${targetLanguage}", "Choice B in ${targetLanguage}", "Choice C in ${targetLanguage}", "Choice D in ${targetLanguage}"],
      "correct_index": 2,
      "difficulty": "medium",
      "explanation": "Explanation in ${targetLanguage}",
      "bloom_level": "${bloomLevel}",
      "misconceptions": [
        "Diagnostic 1-sentence misconception explanation for Choice A in ${targetLanguage}",
        "Diagnostic 1-sentence misconception explanation for Choice B in ${targetLanguage}",
        "",
        "Diagnostic 1-sentence misconception explanation for Choice D in ${targetLanguage}"
      ],
      "time_limit_ms": 20000
    }
  ]
}
`
}

async function callGeminiAPI(systemPrompt: string, userPrompt: string) {
  const geminiKey = process.env.GEMINI_API_KEY
  if (!geminiKey) return null

  // Working models in priority order for this project's Gemini key
  const models = ['gemini-flash-latest', 'gemma-4-31b-it', 'gemini-2.0-flash', 'gemini-2.5-flash']
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: `${systemPrompt}\n\nUser Request:\n${userPrompt}` }]
            }
          ]
        })
      })

      if (res.ok) {
        const data = await res.json()
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text
        if (text) {
          const cleaned = text.replace(/```json|```/g, '').trim()
          const parsed = JSON.parse(cleaned)
          if (parsed && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
            return { quiz: parsed, provider: `Gemini (${model})` }
          }
        }
      }
    } catch (err) {
      console.warn(`Gemini API call failed for model ${model}:`, err)
    }
  }
  return null
}

async function callGroqAPI(systemPrompt: string, userPrompt: string) {
  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) return null

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 8000
      })
    })

    if (res.ok) {
      const data = await res.json()
      const content = data.choices?.[0]?.message?.content
      if (content) {
        const cleaned = content.replace(/```json|```/g, '').trim()
        const parsed = JSON.parse(cleaned)
        if (parsed && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
          return { quiz: parsed, provider: `Groq (Llama-3.3)` }
        }
      }
    }
  } catch (err) {
    console.warn('Groq API call failed:', err)
  }
  return null
}

async function callOpenRouterAPI(systemPrompt: string, userPrompt: string) {
  const openrouterKey = process.env.OPENROUTER_API_KEY
  if (!openrouterKey) return null

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-instruct',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 8000
      })
    })

    if (res.ok) {
      const data = await res.json()
      const content = data.choices?.[0]?.message?.content
      if (content) {
        const cleaned = content.replace(/```json|```/g, '').trim()
        const parsed = JSON.parse(cleaned)
        if (parsed && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
          return { quiz: parsed, provider: `OpenRouter (Llama-3.3)` }
        }
      }
    }
  } catch (err) {
    console.warn('OpenRouter API call failed:', err)
  }
  return null
}

function generateFallbackQuiz(promptText: string, count: number, targetLang: string, bloomLevel: string) {
  const templates = [
    {
      prompt: (t: string) => `Which of the following best defines the core principle of ${t}?`,
      choices: (t: string) => [`The foundational mechanism or process of ${t}`, `A secondary decorative element of ${t}`, `An unrelated auxiliary system`, `A common misunderstanding about ${t}`],
      correct_index: 0,
      explanation: (t: string) => `The core principle forms the basis of all operations in ${t}.`,
      misconceptions: (t: string) => [
        '',
        `Decorative elements are aesthetic and not part of the core definition of ${t}.`,
        `Auxiliary systems support the process but are not the definition.`,
        `Confusing the concept with common errors leads to flawed execution of ${t}.`
      ]
    },
    {
      prompt: (t: string) => `What is typically considered the primary prerequisite or first step when initiating ${t}?`,
      choices: (t: string) => [`Conducting thorough research and planning for ${t}`, `Applying final cosmetic finishes to ${t}`, `Immediate execution without prior analysis of ${t}`, `Skipping initial feasibility reviews`],
      correct_index: 0,
      explanation: (t: string) => `Proper planning and research prevent failures in ${t}.`,
      misconceptions: (t: string) => [
        '',
        `Applying final finishes is the last step, not the prerequisite.`,
        `Immediate execution leads to high rates of errors in ${t}.`,
        `Skipping analysis causes fundamental structural problems.`
      ]
    },
    {
      prompt: (t: string) => `Which component plays the most critical role in the overall process of ${t}?`,
      choices: (t: string) => [`The primary active subsystem of ${t}`, `The external protective housing of ${t}`, `The user interface wrapper`, `The transit container`],
      correct_index: 0,
      explanation: (t: string) => `The active subsystem drives the core logic and functionality of ${t}.`,
      misconceptions: (t: string) => [
        '',
        `External housing provides protection but is not the key active subsystem of ${t}.`,
        `The wrapper simplifies interaction but does not perform the work of ${t}.`,
        `Transit containers are for transport, not operations.`
      ]
    },
    {
      prompt: (t: string) => `What is the main objective or ultimate goal of executing ${t}?`,
      choices: (t: string) => [`To achieve maximum efficiency and stability in ${t}`, `To consume resources unnecessarily during ${t}`, `To increase project complexity`, `To delay public deployment`],
      correct_index: 0,
      explanation: (t: string) => `The main goal is to deliver a stable, high-performance outcome for ${t}.`,
      misconceptions: (t: string) => [
        '',
        `Consuming resources is a cost, not the objective of ${t}.`,
        `Complexity should be minimized, not increased.`,
        `Deployment delay is a project risk, not the goal.`
      ]
    },
    {
      prompt: (t: string) => `What is a common error or pitfall to avoid when dealing with ${t}?`,
      choices: (t: string) => [`Underestimating the structural requirements of ${t}`, `Over-testing the system components of ${t}`, `Documenting the entire process`, `Following safety protocols`],
      correct_index: 0,
      explanation: (t: string) => `Failing to account for load, capacity, or constraints is a frequent failure point in ${t}.`,
      misconceptions: (t: string) => [
        '',
        `Over-testing increases reliability, it is not a mistake.`,
        `Documentation is a best practice, not a mistake.`,
        `Safety protocols prevent accidents.`
      ]
    },
    {
      prompt: (t: string) => `Which approach is most effective for optimizing performance in ${t}?`,
      choices: (t: string) => [`Iterative refining based on measurement data in ${t}`, `Doubling resources without analysis of ${t}`, `Ignoring performance bottlenecks`, `Disabling diagnostic logging`],
      correct_index: 0,
      explanation: (t: string) => `Data-driven iteration is the gold standard for optimization in ${t}.`,
      misconceptions: (t: string) => [
        '',
        `Adding resources is expensive and often doesn't solve bottlenecks in ${t}.`,
        `Ignoring bottlenecks leads to system degradation.`,
        `Diagnostic logs are necessary to find optimization points.`
      ]
    },
    {
      prompt: (t: string) => `What safety measure or risk mitigation is essential during ${t}?`,
      choices: (t: string) => [`Implementing fail-safes and redundancy for ${t}`, `Maximizing speed at all costs in ${t}`, `Eliminating all inspection checks`, `Hiding error reports`],
      correct_index: 0,
      explanation: (t: string) => `Redundancy ensures the system fails safely under stress in ${t}.`,
      misconceptions: (t: string) => [
        '',
        `Maximizing speed without safety controls is dangerous for ${t}.`,
        `Eliminating checks increases the likelihood of critical failures.`,
        `Hiding errors prevents fixing them.`
      ]
    },
    {
      prompt: (t: string) => `How is the success or quality of ${t} typically verified?`,
      choices: (t: string) => [`Rigorous compliance testing and benchmarking of ${t}`, `Assuming the system works perfectly without tests`, `Asking untrained users for approval`, `Only checking the visual appearance of ${t}`],
      correct_index: 0,
      explanation: (t: string) => `Testing against benchmarks verifies the functional compliance of ${t}.`,
      misconceptions: (t: string) => [
        '',
        `Assuming perfection leads to undetected production defects in ${t}.`,
        `Untrained users cannot verify engineering compliance.`,
        `Visual checks do not guarantee internal structural integrity of ${t}.`
      ]
    },
    {
      prompt: (t: string) => `Which tool or resource is indispensable for the practical application of ${t}?`,
      choices: (t: string) => [`Standardized precision instruments for ${t}`, `Improvised household alternatives`, `Uncalibrated manual tools`, `Obsolete machinery`],
      correct_index: 0,
      explanation: (t: string) => `Precision instruments ensure accuracy and safety during the assembly of ${t}.`,
      misconceptions: (t: string) => [
        '',
        `Household alternatives lack the required precision and tolerance for ${t}.`,
        `Uncalibrated tools introduce safety hazards and errors.`,
        `Obsolete machinery is inefficient and prone to failure.`
      ]
    },
    {
      prompt: (t: string) => `What modern technological advancement has most significantly impacted ${t}?`,
      choices: (t: string) => [`Smart sensors and automated control systems for ${t}`, `Manual hand-cranked overrides`, `Analog dial indicators`, `Paper-based logging books`],
      correct_index: 0,
      explanation: (t: string) => `Automation and real-time telemetry have revolutionized the tracking of ${t}.`,
      misconceptions: (t: string) => [
        '',
        `Hand-cranked overrides are back-ups, not modern innovations.`,
        `Analog dials are legacy technology.`,
        `Paper logs are slow and prone to human entry errors.`
      ]
    }
  ];

  const questions = Array.from({ length: count }, (_, i) => {
    const tpl = templates[i % templates.length];
    return {
      prompt: tpl.prompt(promptText),
      choices: tpl.choices(promptText),
      correct_index: tpl.correct_index,
      difficulty: i % 3 === 0 ? 'easy' : i % 3 === 1 ? 'medium' : 'hard',
      explanation: tpl.explanation(promptText),
      bloom_level: bloomLevel,
      misconceptions: tpl.misconceptions(promptText),
      time_limit_ms: 20000
    };
  });

  return {
    title: `${promptText.slice(0, 45)} Quiz`,
    description: `Interactive ${count}-question quiz generated for ${promptText}`,
    language: targetLang,
    bloomLevel: bloomLevel,
    questions
  };
}

function differentiateFallback(currentQuiz: any, action: string, targetLang: string, bloomLevel: string, promptText: string) {
  let quiz = currentQuiz;
  if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    quiz = generateFallbackQuiz(promptText, 5, targetLang, bloomLevel);
  }

  const updatedQuiz = JSON.parse(JSON.stringify(quiz));
  updatedQuiz.bloomLevel = bloomLevel;
  updatedQuiz.language = targetLang;

  const dictionary: Record<string, Record<string, string>> = {
    Hindi: {
      'Quiz': 'प्रश्नोत्तरी (Quiz)',
      'Question': 'प्रश्न',
      'What': 'क्या',
      'Which': 'कौन सा',
      'How': 'कैसे',
      'Why': 'क्यों',
      'first step': 'पहला चरण (First Step)',
      'making a train': 'ट्रेन बनाना',
      'scratch': 'शुरुआत से (Scratch)',
      'Design': 'डिजाइनिंग (Design)',
      'Assembly': 'असेंबली (Assembly)',
      'Painting': 'पेंटिंग (Painting)',
      'Testing': 'परीक्षण (Testing)'
    },
    Spanish: {
      'Quiz': 'Cuestionario',
      'Question': 'Pregunta',
      'What': 'Qué',
      'Which': 'Cuál',
      'first step': 'primer paso',
      'Design': 'Diseño',
      'Assembly': 'Ensamblaje',
      'Painting': 'Pintura',
      'Testing': 'Pruebas'
    },
    French: {
      'Quiz': 'Quiz',
      'Question': 'Question',
      'What': 'Quel',
      'Which': 'Lequel',
      'Design': 'Conception',
      'Assembly': 'Assemblage'
    }
  };

  const langDict = dictionary[targetLang] || {};

  function translateText(str: string): string {
    if (!str || typeof str !== 'string') return str;
    let res = str;
    for (const [key, val] of Object.entries(langDict)) {
      const reg = new RegExp(`\\b${key}\\b`, 'gi');
      res = res.replace(reg, val);
    }
    return res;
  }

  if (action === 'translate') {
    updatedQuiz.title = translateText(updatedQuiz.title || 'Quiz');
    updatedQuiz.description = translateText(updatedQuiz.description || 'Educational Quiz');
  }

  updatedQuiz.questions = updatedQuiz.questions.map((q: any, i: number) => {
    let prompt = q.prompt;
    let difficulty = q.difficulty || 'medium';
    let choices = [...q.choices];
    let misconceptions = [...(q.misconceptions || ['', '', '', ''])];
    let explanation = q.explanation || '';

    if (action === 'translate') {
      prompt = translateText(prompt);
      choices = choices.map(c => translateText(c));
      explanation = translateText(explanation);
      misconceptions = misconceptions.map(m => translateText(m));
    } else if (action === 'add_scenarios') {
      const scenarioPrefixes = [
        `As the chief project manager leading the effort on ${promptText}, you are faced with a key decision: `,
        `During the initial setup and deployment of ${promptText}, a critical question arises: `,
        `Imagine you are advising a client on best practices for ${promptText}. They ask: `,
        `A quality assurance inspector reviewing the progress of ${promptText} raises this query: `,
        `To ensure maximum efficiency while executing ${promptText}, how would you solve the following challenge? `,
        `While conducting a safety audit on ${promptText}, you must determine: `,
        `A colleague asks you to explain a critical operational mechanism of ${promptText}: `,
        `In a professional environment focused on ${promptText}, how is this specific issue addressed? `,
        `Your engineering team is troubleshooting a bottleneck in ${promptText}: `,
        `During a training session for new technicians learning about ${promptText}, the instructor asks: `
      ];
      const prefix = scenarioPrefixes[i % scenarioPrefixes.length];
      if (!prompt.includes(prefix)) {
        const strippedPrompt = prompt.replace(/^Question \d+:\s*/i, '');
        const firstLetter = strippedPrompt.charAt(0).toLowerCase();
        const rest = strippedPrompt.slice(1);
        prompt = `${prefix}${firstLetter}${rest}`;
      }
    } else if (action === 'simplify') {
      difficulty = 'easy';
      prompt = prompt
        .replace(/fundamental aspect/gi, 'basic part')
        .replace(/primary prerequisite/gi, 'first step')
        .replace(/initiating/gi, 'starting')
        .replace(/critical role/gi, 'big part')
        .replace(/objective or ultimate goal/gi, 'main goal')
        .replace(/executing/gi, 'doing')
        .replace(/optimizing performance/gi, 'making it better')
        .replace(/fail-safes and redundancy/gi, 'backup plans')
        .replace(/rigorous compliance testing/gi, 'thorough testing')
        .replace(/precision instruments/gi, 'accurate tools');
      explanation = `Simple explanation: ${explanation}`;
    } else if (action === 'harder_distractors') {
      difficulty = 'hard';
      misconceptions = misconceptions.map((m, idx) => {
        if (idx === q.correct_index) return '';
        return m ? `${m} This distractor is highly plausible because it mimics a common trap.` : `This option represents a common trap in ${promptText}.`;
      });
    }

    return {
      ...q,
      prompt,
      difficulty,
      choices,
      misconceptions,
      explanation,
      bloom_level: bloomLevel
    };
  });

  return updatedQuiz;
}

export async function POST(req: Request) {
  try {
    const { topic, sourceText, url, count = 5, gradeLevel = '8th grade', action, currentQuiz, targetLang = 'English', bloomLevel = 'Recall' } = await req.json()

    const promptText = topic || sourceText || (url ? `Quiz from URL: ${url}` : 'General Science and Technology')
    const questionCount = Math.max(1, Math.min(20, Number(count) || 5))
    const scriptHint = LANGUAGE_SCRIPT_MAP[targetLang] || targetLang

    // ── ACTION: AI DIFFERENTIATE / ADAPT / TRANSLATE ──
    if (action) {
      const totalQCount = currentQuiz && Array.isArray(currentQuiz.questions) && currentQuiz.questions.length > 0
        ? currentQuiz.questions.length
        : questionCount

      const adaptSystemPrompt = `You are an expert educational quiz adaptation and translation engine.
Return EXACTLY one valid JSON object. Do NOT wrap in markdown code blocks. Do NOT include extra commentary.
Target Bloom's Taxonomy Level: ${bloomLevel}.
LANGUAGE MANDATE: Output MUST be strictly in ${targetLang} using ${scriptHint}.

JSON Output Schema:
{
  "title": "Title in ${targetLang}",
  "description": "Description in ${targetLang}",
  "language": "${targetLang}",
  "bloomLevel": "${bloomLevel}",
  "questions": [
    {
      "prompt": "Question text in ${targetLang}?",
      "choices": ["Choice A", "Choice B", "Choice C", "Choice D"],
      "correct_index": 0,
      "difficulty": "medium",
      "explanation": "Explanation in ${targetLang}",
      "bloom_level": "${bloomLevel}",
      "misconceptions": [
        "",
        "Diagnostic misconception for Choice B",
        "Diagnostic misconception for Choice C",
        "Diagnostic misconception for Choice D"
      ],
      "time_limit_ms": 20000
    }
  ]
}`

      let diffInstruction = ''
      if (action === 'add_scenarios') {
        diffInstruction = `Topic: "${promptText}". Rewrite ALL ${totalQCount} questions to place each one in a vivid, realistic real-world scenario related to ${promptText} at Bloom's level ${bloomLevel}. Ensure output is in ${targetLang} (${scriptHint}).\nBase Quiz:\n${JSON.stringify(currentQuiz)}`
      } else if (action === 'simplify') {
        diffInstruction = `Topic: "${promptText}". Simplify vocabulary and reading level of ALL ${totalQCount} questions for elementary students while preserving Bloom's level ${bloomLevel}. Ensure output is in ${targetLang} (${scriptHint}).\nBase Quiz:\n${JSON.stringify(currentQuiz)}`
      } else if (action === 'harder_distractors') {
        diffInstruction = `Topic: "${promptText}". Make wrong answer choices (distractors) across ALL ${totalQCount} questions highly plausible and challenging with clear 1-sentence diagnostic misconception explanations. Ensure output is in ${targetLang} (${scriptHint}).\nBase Quiz:\n${JSON.stringify(currentQuiz)}`
      } else if (action === 'translate') {
        diffInstruction = `Topic: "${promptText}". Translate title, description, ALL ${totalQCount} questions, choices, explanations, and misconceptions into fluent ${targetLang} using ${scriptHint}. Preserve question order and choices order. Do NOT leave any text in English if target is ${targetLang}.\nBase Quiz:\n${JSON.stringify(currentQuiz)}`
      }

      if (diffInstruction) {
        // Priority 1: Gemini API
        const geminiRes = await callGeminiAPI(adaptSystemPrompt, diffInstruction)
        if (geminiRes) {
          return NextResponse.json({ success: true, quiz: randomizeQuizAnswers(geminiRes.quiz), provider: `${geminiRes.provider} (${action})` })
        }

        // Priority 2: Groq API
        const groqRes = await callGroqAPI(adaptSystemPrompt, diffInstruction)
        if (groqRes) {
          return NextResponse.json({ success: true, quiz: randomizeQuizAnswers(groqRes.quiz), provider: `${groqRes.provider} (${action})` })
        }

        // Priority 3: OpenRouter API
        const openrouterRes = await callOpenRouterAPI(adaptSystemPrompt, diffInstruction)
        if (openrouterRes) {
          return NextResponse.json({ success: true, quiz: randomizeQuizAnswers(openrouterRes.quiz), provider: `${openrouterRes.provider} (${action})` })
        }
      }

      // Fallback Engine
      const fallbackQuiz = differentiateFallback(currentQuiz, action, targetLang, bloomLevel, promptText)
      return NextResponse.json({
        success: true,
        quiz: randomizeQuizAnswers(fallbackQuiz),
        provider: `Topic-Locked Fallback Engine (${action} ${fallbackQuiz.questions.length} Qs - ${bloomLevel})`
      })
    }

    // ── STANDARD GENERATION: NEW QUIZ ──
    const systemPrompt = buildSystemPrompt(questionCount, gradeLevel, targetLang, bloomLevel)
    let userPrompt = ''
    if (sourceText && typeof sourceText === 'string' && sourceText.length > 30) {
      userPrompt = `Generate a ${questionCount}-question quiz in ${targetLang} (${scriptHint}) targeting Bloom's Taxonomy level "${bloomLevel}" based strictly on the following source material:\n\nSOURCE TITLE / CONTEXT: "${promptText}"\n\nSOURCE TEXT / TRANSCRIPT / DOCUMENT CONTENT:\n${sourceText.slice(0, 10000)}\n\nEnsure questions test deep understanding, key facts, concepts, definitions, and relationships presented in the source material. Include 1-sentence diagnostic misconception explanations for each distractor choice.`
    } else {
      userPrompt = `Generate a ${questionCount}-question quiz in ${targetLang} (${scriptHint}) targeting Bloom's Taxonomy level "${bloomLevel}" specifically on the topic: "${promptText}". Make questions clear, deep, educational, and accurate. Include 1-sentence diagnostic misconception explanations for each distractor choice.`
    }

    // Priority 1: Gemini API
    const geminiRes = await callGeminiAPI(systemPrompt, userPrompt)
    if (geminiRes) {
      return NextResponse.json({ success: true, quiz: randomizeQuizAnswers(geminiRes.quiz), provider: geminiRes.provider })
    }

    // Priority 2: Groq API
    const groqRes = await callGroqAPI(systemPrompt, userPrompt)
    if (groqRes) {
      return NextResponse.json({ success: true, quiz: randomizeQuizAnswers(groqRes.quiz), provider: groqRes.provider })
    }

    // Priority 3: OpenRouter API
    const openrouterRes = await callOpenRouterAPI(systemPrompt, userPrompt)
    if (openrouterRes) {
      return NextResponse.json({ success: true, quiz: randomizeQuizAnswers(openrouterRes.quiz), provider: openrouterRes.provider })
    }

    // Priority 4: Smart Local Fallback Engine
    const fallbackQuiz = generateFallbackQuiz(promptText, questionCount, targetLang, bloomLevel)
    return NextResponse.json({
      success: true,
      quiz: randomizeQuizAnswers(fallbackQuiz),
      provider: `Topic-Locked Fallback Engine (${fallbackQuiz.questions.length} Qs - ${bloomLevel})`
    })

  } catch (error) {
    console.error('Quiz Generation API Error:', error)
    return NextResponse.json({ success: false, error: 'Failed to generate quiz' }, { status: 500 })
  }
}
