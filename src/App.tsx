import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { recognize } from 'tesseract.js'
import type { GeminiNutritionAnalysis } from './ingredientsModel'
import './App.css'

/** Internal pipeline stages (not shown as separate UI steps): read → ingredients → AI. */
const INTERNAL_STAGES = 3

type PipelinePhase = 'idle' | 'reading' | 'finding' | 'analyzing' | 'done'

type Screen = 'upload' | 'score'

function App() {
  const [screen, setScreen] = useState<Screen>('upload')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [status, setStatus] = useState('Add a label photo.')
  const [isReading, setIsReading] = useState(false)
  const [error, setError] = useState('')
  const [ingredientsText, setIngredientsText] = useState('')
  const [isIngredientsLoading, setIsIngredientsLoading] = useState(false)
  const [geminiNutrition, setGeminiNutrition] = useState<GeminiNutritionAnalysis | null>(null)
  const [isGeminiNutritionLoading, setIsGeminiNutritionLoading] = useState(false)
  const [pipelinePhase, setPipelinePhase] = useState<PipelinePhase>('idle')
  /** Remount file input after reset so the same file can be chosen again. */
  const [fileInputKey, setFileInputKey] = useState(0)

  const applyImageFile = useCallback((file: File | null) => {
    setImageFile(file)
    setIngredientsText('')
    setGeminiNutrition(null)
    setError('')
    setPipelinePhase('idle')
    setScreen('upload')
    setStatus(file ? 'Starting…' : 'Add a label photo.')
    if (!file) {
      setFileInputKey((k) => k + 1)
    }
  }, [])

  useEffect(() => {
    if (!imageFile) {
      setImageUrl(null)
      return
    }
    const nextUrl = URL.createObjectURL(imageFile)
    setImageUrl(nextUrl)
    return () => {
      URL.revokeObjectURL(nextUrl)
    }
  }, [imageFile])

  const fileSummary = useMemo(() => {
    if (!imageFile) {
      return 'Images only'
    }
    const sizeInMb = (imageFile.size / (1024 * 1024)).toFixed(2)
    return `${imageFile.name} · ${sizeInMb} MB`
  }, [imageFile])

  const pipelineBusy =
    pipelinePhase === 'reading' ||
    pipelinePhase === 'finding' ||
    pipelinePhase === 'analyzing'

  const internalStage = useMemo((): number => {
    if (pipelinePhase === 'reading' || isReading) {
      return 1
    }
    if (pipelinePhase === 'finding' || isIngredientsLoading) {
      return 2
    }
    if (pipelinePhase === 'analyzing' || isGeminiNutritionLoading) {
      return 3
    }
    if (pipelinePhase === 'done') {
      return 3
    }
    return 0
  }, [pipelinePhase, isReading, isIngredientsLoading, isGeminiNutritionLoading])

  const progressFraction = pipelineBusy || pipelinePhase === 'done' ? internalStage / INTERNAL_STAGES : 0

  const runFullPipeline = useCallback(async (file: File, signal: AbortSignal) => {
    setError('')
    setIngredientsText('')

    setPipelinePhase('reading')
    setStatus('Reading label…')
    setIsReading(true)

    let text = ''
    try {
      const result = await recognize(file, 'eng', {
        logger: ({ status: st, progress }) => {
          if (signal.aborted) {
            return
          }
          const pct = progress ? ` ${Math.round(progress * 100)}%` : ''
          setStatus(`Reading… ${st}${pct}`)
        },
      })
      if (signal.aborted) {
        return
      }
      text = result.data.text.trim()
    } catch (e) {
      console.error(e)
      if (!signal.aborted) {
        setError('Scan failed. Try better lighting and a flatter label.')
        setStatus('Could not read the label.')
        setPipelinePhase('idle')
      }
      return
    } finally {
      setIsReading(false)
    }

    if (signal.aborted) {
      return
    }

    if (!text) {
      setError('No text found on this image. Try a clearer photo.')
      setStatus('No text detected.')
      setPipelinePhase('idle')
      return
    }

    setPipelinePhase('finding')
    setStatus('Hunting the ingredient list…')
    setIsIngredientsLoading(true)
    let ingredients = ''
    try {
      const { findIngredientsFromText } = await import('./ingredientsModel')
      ingredients = await findIngredientsFromText(text, (msg) => {
        if (!signal.aborted) {
          setStatus(msg)
        }
      })
      if (signal.aborted) {
        return
      }
      setIngredientsText(ingredients)
    } catch (e) {
      console.error(e)
      if (!signal.aborted) {
        const detail = e instanceof Error ? e.message : String(e)
        setError(`Ingredients: ${detail}`)
        setStatus('Could not fetch ingredients.')
        setPipelinePhase('idle')
      }
      return
    } finally {
      setIsIngredientsLoading(false)
    }

    if (signal.aborted) {
      return
    }

    if (!ingredients.trim()) {
      setError('We could not build an ingredient list from this label.')
      setStatus('Add ingredients, then Retry.')
      setPipelinePhase('idle')
      return
    }

    setPipelinePhase('analyzing')
    setStatus('Crunching numbers…')
    setIsGeminiNutritionLoading(true)
    try {
      const { analyzeNutritionFromIngredients } = await import('./ingredientsModel')
      const nutrition = await analyzeNutritionFromIngredients(ingredients, (msg) => {
        if (!signal.aborted) {
          setStatus(msg)
        }
      })
      if (signal.aborted) {
        return
      }
      setGeminiNutrition(nutrition)
      setPipelinePhase('done')
      setStatus('Done.')
      setScreen('score')
    } catch (e) {
      console.error(e)
      if (!signal.aborted) {
        const detail = e instanceof Error ? e.message : String(e)
        setError((prev) => (prev ? `${prev} · ${detail}` : detail))
        setStatus('That step failed — try again?')
        setPipelinePhase('idle')
      }
    } finally {
      setIsGeminiNutritionLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!imageFile) {
      setPipelinePhase('idle')
      return
    }

    const ac = new AbortController()
    void runFullPipeline(imageFile, ac.signal)

    return () => {
      ac.abort()
    }
  }, [imageFile, runFullPipeline])

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    applyImageFile(event.target.files?.[0] ?? null)
  }

  /** Back to upload for a new product — does not re-run the same photo. */
  const handleBackToDrop = () => {
    if (pipelineBusy) {
      return
    }
    applyImageFile(null)
  }

  const handleCopyIngredients = async () => {
    if (!ingredientsText) {
      return
    }
    try {
      await navigator.clipboard.writeText(ingredientsText)
      setStatus('Copied.')
    } catch (clipboardError) {
      console.error(clipboardError)
      setError('Copy failed.')
    }
  }

  const showImagePreview = screen === 'upload' && imageUrl && !pipelineBusy

  return (
    <div className="app app--compact">
      <header className="app-header app-header--compact">
        <div className="brand">
          <div>
            <p className="brand-name">motupatlu</p>
            <p className="brand-tag">Label → score</p>
          </div>
        </div>
      </header>

      <div className="compact-track">
        <div
          className="stepper-progress internal-progress"
          style={{ '--step-fraction': String(progressFraction) } as React.CSSProperties}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={INTERNAL_STAGES}
          aria-valuenow={internalStage}
          aria-label={
            pipelineBusy
              ? `Step ${internalStage} of ${INTERNAL_STAGES}`
              : pipelinePhase === 'done'
                ? 'Done'
                : 'Idle'
          }
        />
        {status ? (
          <p className="compact-status" role="status" aria-live={pipelineBusy ? 'assertive' : 'polite'}>
            {status}
          </p>
        ) : null}
      </div>

      <span className="sr-only" aria-live="polite">
        {pipelineBusy ? `Step ${internalStage} of ${INTERNAL_STAGES}` : ''}
      </span>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <main className="app-main pipeline-main pipeline-main--single">
        {screen === 'score' && geminiNutrition ? (
          <div className={`pipeline-section card-wrap pipeline-section--single ${pipelineBusy ? 'pipeline-section--current' : ''}`}>
            <section className="card card--score card--tight">
              <div className="score-card-head score-card-head--stack">
                <h2 className="card-title card-title--inline">Score</h2>
              </div>

              <div className="gemini-nutrition-result score-result score-result--compact">
                <div className="score-dial score-dial--gemini score-dial--compact" aria-live="polite">
                  <span className="score-dial-value">{geminiNutrition.score}</span>
                  <span className="score-dial-max">/100</span>
                </div>
                <div className="harmful-panel">
                  {geminiNutrition.harmful.length === 0 ? (
                    <p className="empty-hint muted empty-hint--tight">No specific ingredient concerns.</p>
                  ) : (
                    <>
                      <h3 className="harmful-panel-title">Specific concerns</h3>
                      <ul className="harmful-list">
                      {geminiNutrition.harmful.map((item, hi) => (
                        <li key={`${hi}-${item.ingredient}`} className="harmful-item harmful-item--compact">
                          <span className="harmful-name">{item.ingredient}</span>
                          <span className="harmful-why">{item.why}</span>
                        </li>
                      ))}
                      </ul>
                    </>
                  )}
                </div>
              </div>

              <details className="details-ingredients">
                <summary>Show ingredients</summary>
                <div className="ingredients-expand-body">
                  <pre className="ingredients-pre">{ingredientsText.trim() || '—'}</pre>
                  <button
                    type="button"
                    className="btn btn-ghost btn--sm"
                    onClick={handleCopyIngredients}
                    disabled={!ingredientsText.trim()}
                  >
                    Copy
                  </button>
                </div>
              </details>

              <div className="score-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  onClick={handleBackToDrop}
                  disabled={pipelineBusy}
                >
                  New label
                </button>
              </div>
            </section>
          </div>
        ) : (
          <div className={`pipeline-section card-wrap pipeline-section--single ${pipelineBusy ? 'pipeline-section--current' : ''}`}>
            <section className="card card--hero card--tight">
              <div className="upload-panel upload-panel--compact">
                <div className="upload-icon upload-icon--sm upload-icon--camera" aria-hidden />
                <p className="upload-title">{imageFile ? 'New photo' : 'Take a picture'}</p>
                <p className="upload-meta">
                  {imageFile ? fileSummary : 'Point the camera at the ingredient label.'}
                </p>
                <div className="upload-actions">
                  <label className="btn btn-primary btn-block upload-file-label">
                    <input
                      key={`cam-${fileInputKey}`}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="sr-only"
                      onChange={handleFileChange}
                    />
                    Take picture
                  </label>
                  <label className="btn btn-ghost btn-block upload-file-label">
                    <input
                      key={`lib-${fileInputKey}`}
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={handleFileChange}
                    />
                    Choose from library
                  </label>
                </div>
              </div>
              {showImagePreview ? (
                <div className="preview-frame preview-frame--compact">
                  <img className="preview-img" src={imageUrl} alt="Label" />
                </div>
              ) : null}
            </section>
          </div>
        )}
      </main>

      <footer className="app-footer app-footer--compact">
        <p>Demo · not medical advice</p>
      </footer>
    </div>
  )
}

export default App
