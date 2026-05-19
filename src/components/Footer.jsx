export default function Footer() {
  return (
    <footer className="border-t border-white/5 bg-ink-950/60">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:px-6">
        <div>
          <div className="text-slate-300">PaperFate</div>
          <div>Simulate your manuscript's future before submission.</div>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <div>Built on OpenAlex · Semantic Scholar · Crossref</div>
          <div className="text-xs text-slate-600">© {new Date().getFullYear()} PaperFate · FateCore v0.1 Beta</div>
        </div>
      </div>
    </footer>
  )
}
