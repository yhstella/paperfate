import { useRef, useState } from 'react'

const ACCEPTED = '.txt,.docx,.pdf,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export default function FileUpload({ onText, onTitle, currentTextLength = 0, hint }) {
  const inputRef = useRef(null)
  const [filename, setFilename] = useState(null)
  const [filesize, setFilesize] = useState(null)
  const [parsing, setParsing] = useState(false)
  const [error, setError] = useState(null)
  const [dragOver, setDragOver] = useState(false)

  async function handleFile(file) {
    if (!file) return
    setError(null)
    setFilename(file.name)
    setFilesize(file.size)
    setParsing(true)
    try {
      const text = await parseFile(file)
      onText(text)
      // If the parent didn't yet have a title, derive one from the file or text.
      if (typeof onTitle === 'function') {
        const derived = deriveTitle(text, file.name)
        if (derived) onTitle(derived)
      }
    } catch (e) {
      console.error('file parse failed:', e)
      setError(e?.message || 'Could not read this file. Try saving as PDF, DOCX, or TXT.')
      onText('')
    } finally {
      setParsing(false)
    }
  }

  function pickFile(e) {
    // Stop the native click from bubbling so the wrapper div doesn't re-invoke
    // inputRef.current.click() and pop a second dialog.
    e?.stopPropagation?.()
    inputRef.current?.click()
  }

  function onDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) handleFile(f)
  }

  function reset() {
    setFilename(null); setFilesize(null); setError(null)
    onText('')
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; handleFile(f) }}
        onClick={(e) => e.stopPropagation()}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      {!filename && (
        <div
          onClick={pickFile}
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          className={`cursor-pointer rounded-xl border-2 border-dashed transition px-6 py-12 text-center ${
            dragOver ? 'border-fate-400/60 bg-fate-500/[0.06]' : 'border-white/10 bg-ink-900/40 hover:border-white/20'
          }`}
        >
          <UploadIcon />
          <div className="mt-3 text-sm font-medium text-slate-200">
            Drop your manuscript here, or <span className="text-fate-300 underline-offset-4 hover:underline">click to browse</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">PDF · DOCX · TXT · processed locally in your browser</div>
        </div>
      )}
      {filename && (
        <div className="rounded-xl border border-white/10 bg-ink-900/60 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <FileIcon />
                <div className="truncate text-sm font-medium text-slate-100">{filename}</div>
              </div>
              <div className="mt-1.5 text-xs text-slate-500">
                {prettyBytes(filesize)}
                {parsing && <span className="ml-2 text-fate-300">parsing…</span>}
                {!parsing && !error && currentTextLength > 0 && (
                  <span className="ml-2 text-emerald-300/90">
                    parsed · {currentTextLength.toLocaleString()} chars
                  </span>
                )}
                {error && <span className="ml-2 text-amber-300/90">{error}</span>}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={pickFile}
                className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/5"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={reset}
                className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
      {hint && <div className="mt-2 text-[11px] text-slate-500">{hint}</div>}
    </div>
  )
}

// Best-effort title pull: first non-empty line of the parsed text if it looks
// like a title (short-ish, no terminal sentence punctuation, no all caps boiler),
// otherwise strip the file-name extension.
function deriveTitle(text, fname) {
  const txt = String(text || '').replace(/\r/g, '')
  for (const raw of txt.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.length < 12 || line.length > 220) continue
    if (/^(abstract|background|introduction|methods?|materials|results?|discussion|conclusions?|keywords|key words|received|accepted|copyright|doi:|©|figure|table)\b/i.test(line)) continue
    if (/[.!?]$/.test(line) && line.split(' ').length > 30) continue
    return line.replace(/\s+/g, ' ')
  }
  const base = String(fname || '').replace(/\.(pdf|docx?|txt)$/i, '').replace(/[_-]+/g, ' ').trim()
  return base && base.length >= 4 ? base : null
}

async function parseFile(file) {
  const name = (file.name || '').toLowerCase()
  if (name.endsWith('.txt') || file.type === 'text/plain') {
    return await file.text()
  }
  if (name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth/mammoth.browser.js')
    const arrayBuffer = await file.arrayBuffer()
    const { value } = await mammoth.extractRawText({ arrayBuffer })
    return value || ''
  }
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist')
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    const arrayBuffer = await file.arrayBuffer()
    const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      pages.push(tc.items.map(it => ('str' in it ? it.str : '')).join(' '))
    }
    return pages.join('\n\n')
  }
  throw new Error(`Unsupported file type. Use PDF, DOCX, or TXT.`)
}

function prettyBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function UploadIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto text-slate-500">
      <path d="M12 3v12M7 8l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-fate-300">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" strokeLinejoin="round" />
      <path d="M14 3v5h5" strokeLinejoin="round" />
    </svg>
  )
}
