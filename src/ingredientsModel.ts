/** Gemini model id (Generative Language API). */
const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview'

const MAX_INPUT_CHARS = 24_000

/** User-facing status lines (no provider names). */
const PHRASES_INGREDIENTS = [
  'Thinking…',
  'Working on it…',
  'Squinting at tiny letters…',
  'Reading the fine print…',
  'Asking the cloud nicely…',
] as const

const PHRASES_SCORE = [
  'Pondering deeply…',
  'Judging your snacks…',
  'Doing brain things…',
  'Stroking chin thoughtfully…',
  'Almost there…',
  'Warming up the neurons…',
] as const

function randomPhrase<const T extends readonly string[]>(phrases: T): T[number] {
  return phrases[Math.floor(Math.random() * phrases.length)]!
}

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
  }>
  error?: { message?: string; code?: number }
}

export type HarmfulIngredient = {
  /** Exact concern: mechanism, nutrient, or condition — not vague hedging. */
  ingredient: string
  why: string
}

/** Gemini nutrition review: overall score + harmful items from the list. */
export type GeminiNutritionAnalysis = {
  score: number
  harmful: HarmfulIngredient[]
}

function getApiKey(): string {
  const key = import.meta.env.VITE_GEMINI_API_KEY
  if (typeof key === 'string' && key.length > 0) {
    return key.trim()
  }
  throw new Error(
    'Missing Gemini API key. Set GEMINI_API_KEY in .env (loaded via Vite) or VITE_GEMINI_API_KEY.',
  )
}

async function geminiGenerateContent(body: Record<string, unknown>): Promise<GeminiGenerateResponse> {
  const apiKey = getApiKey()
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL,
  )}:generateContent`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  })

  const data = (await res.json()) as GeminiGenerateResponse

  if (!res.ok) {
    const msg = data.error?.message ?? res.statusText ?? 'Request failed'
    throw new Error(msg)
  }

  return data
}

function getResponseText(data: GeminiGenerateResponse): string {
  const parts = data.candidates?.[0]?.content?.parts
  return parts?.map((p) => p.text ?? '').join('') ?? ''
}

function extractJsonObject(raw: string): string {
  const t = raw.trim()
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  const inner = fenced ? fenced[1].trim() : t
  const start = inner.indexOf('{')
  const end = inner.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return inner.slice(start, end + 1)
  }
  return inner
}

function parseNutritionAnalysisJson(raw: string): GeminiNutritionAnalysis {
  const text = extractJsonObject(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Invalid response format.')
  }

  const obj = parsed as Record<string, unknown>
  const scoreRaw = obj.score
  const scoreNum =
    typeof scoreRaw === 'number'
      ? scoreRaw
      : typeof scoreRaw === 'string'
        ? parseInt(scoreRaw, 10)
        : NaN
  const score = Math.min(100, Math.max(0, Number.isFinite(scoreNum) ? Math.round(scoreNum) : 0))

  const harmfulRaw = Array.isArray(obj.harmful) ? obj.harmful : []
  const harmful: HarmfulIngredient[] = harmfulRaw
    .map((h) => {
      const row = h as Record<string, unknown>
      return {
        ingredient: String(row.ingredient ?? '').trim(),
        why: String(row.why ?? row.reason ?? '').trim(),
      }
    })
    .filter((h) => h.ingredient.length > 0)

  return { score, harmful }
}

/**
 * Uses Gemini to score the ingredient list (0–100) and flag items with specific health/nutrition concerns.
 */
export async function analyzeNutritionFromIngredients(
  ingredientsList: string,
  onProgress?: (message: string) => void,
): Promise<GeminiNutritionAnalysis> {
  const text = ingredientsList.trim()
  if (!text) {
    return { score: 0, harmful: [] }
  }

  const clipped = text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}…` : text

  onProgress?.(randomPhrase(PHRASES_SCORE))

  const body: Record<string, unknown> = {
    systemInstruction: {
      role: 'system',
      parts: [
        {
          text:
            'You assess packaged food ingredient lists for nutrition quality. Respond ONLY with a JSON object (no markdown) with keys: "score" (integer 0–100, higher = better overall nutrition quality of this list) and "harmful" (array of objects with "ingredient" and "why"). Only include ingredients that appear in the user list. For each flagged item, "why" must state a concrete effect or mechanism: name the nutrient, body system, or condition (e.g. sodium and blood pressure, added sugar and blood glucose, trans fat and LDL cholesterol, common allergen/anaphylaxis risk, nitrites and processed meat, emulsifiers and gut irritation in some studies). One short sentence. Forbidden: vague hedging like "potential health risks", "may be harmful", "could cause issues", "might affect health", or generic wellness language. If you cannot state a specific risk, omit that ingredient from "harmful". If nothing warrants a concrete flag, use "harmful": [].',
        },
      ],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Evaluate this ingredient list:\n\n${clipped}`,
          },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.25,
    },
  }

  const data = await geminiGenerateContent(body)
  const out = getResponseText(data).trim()
  return parseNutritionAnalysisJson(out)
}

/**
 * Uses Google Gemini to list ingredients from OCR text (cloud API).
 */
export async function findIngredientsFromText(
  rawText: string,
  onProgress?: (message: string) => void,
): Promise<string> {
  const text = rawText.trim()
  if (!text) {
    return ''
  }

  const clipped = text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}…` : text

  onProgress?.(randomPhrase(PHRASES_INGREDIENTS))

  const body = {
    systemInstruction: {
      role: 'system',
      parts: [
        {
          text: 'You extract food ingredients from noisy OCR. Reply with only the ingredient list (comma-separated or one per line). No introduction or explanation.',
        },
      ],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Find all the ingredients in the following text:\n\n${clipped}`,
          },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0.2,
    },
  }

  const data = await geminiGenerateContent(body)
  return getResponseText(data).trim()
}
