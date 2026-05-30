#!/usr/bin/env node
/**
 * build-changelog-feed.mjs
 *
 * Parse CHANGELOG.md and emit an RSS 2.0 feed at public/changelog.xml.
 *
 * The script extracts each '### Round N — title' heading and the bullet list
 * that follows it (until the next '### ' heading or '## ' section). Each
 * round becomes a <item> with:
 *
 *   - title       = "Round N: title"
 *   - pubDate     = a hardcoded sprint date (RFC-822) keyed by round number;
 *                   rounds we don't have a date for fall back to the file
 *                   mtime so the feed stays valid.
 *   - description = bullets joined as <ul><li>…</li></ul> (HTML-escaped),
 *                   wrapped in <![CDATA[…]]>.
 *   - link        = https://github.com/yhstella/paperfate/blob/main/CHANGELOG.md
 *   - guid        = stable per round, isPermaLink="false"
 *
 * Usage:
 *   node scripts/build-changelog-feed.mjs [--out public/changelog.xml]
 *
 * Exit codes:
 *   0 wrote feed successfully
 *   1 CHANGELOG.md missing or unparseable
 */

import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// ---------- CLI parsing ----------
function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const nxt = argv[i + 1]
    if (nxt && !nxt.startsWith('--')) { out[key] = nxt; i++ }
    else out[key] = true
  }
  return out
}

const args = parseArgs(process.argv)
const OUT = args.out || 'public/changelog.xml'
const CHANGELOG = args.in || 'CHANGELOG.md'

const SITE_URL = 'https://paperfate.com'
const CHANGELOG_URL = 'https://github.com/yhstella/paperfate/blob/main/CHANGELOG.md'
const FEED_TITLE = 'PaperFate Changelog'
const FEED_DESC = 'Round-by-round release notes for PaperFate.'

// ---------- Sprint dates (RFC-822) ----------
// Keyed by the round label as it appears after 'Round '. Rounds we don't
// have an exact ship date for fall back to the CHANGELOG.md mtime.
const SPRINT_DATES = {
  '1': 'Mon, 04 May 2026 10:00:00 +0000',
  '2': 'Mon, 11 May 2026 10:00:00 +0000',
  '3': 'Wed, 13 May 2026 10:00:00 +0000',
  '4': 'Fri, 15 May 2026 10:00:00 +0000',
  '5': 'Sun, 17 May 2026 10:00:00 +0000',
  '6': 'Tue, 19 May 2026 10:00:00 +0000',
  '6.5': 'Wed, 20 May 2026 10:00:00 +0000',
  '7': 'Thu, 21 May 2026 10:00:00 +0000',
  '7.5': 'Fri, 22 May 2026 10:00:00 +0000',
  '8': 'Sun, 24 May 2026 10:00:00 +0000',
  '9': 'Tue, 26 May 2026 10:00:00 +0000',
  '10': 'Thu, 28 May 2026 10:00:00 +0000',
}

// ---------- Helpers ----------
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function toRfc822(d) {
  return d.toUTCString()
}

// ---------- Parser ----------
// Returns [{ round, title, bullets: [string] }, …] in source order
// (newest first, since CHANGELOG.md lists newest rounds first).
function parseChangelog(md) {
  const lines = md.split(/\r?\n/)
  const rounds = []
  let current = null
  let inEarlier = false

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    // Stop folding bullets into a round once we hit '## Earlier work …'
    if (/^##\s+Earlier work/i.test(line)) { inEarlier = true; if (current) { rounds.push(current); current = null } ; continue }
    if (inEarlier) continue
    const m = line.match(/^###\s+Round\s+([\d.]+)\s+[—–-]\s+(.+?)\s*$/)
    if (m) {
      if (current) rounds.push(current)
      current = { round: m[1], title: m[2], bullets: [] }
      continue
    }
    // New '##' section (e.g. another release header) flushes the current round
    if (/^##\s+/.test(line) && current) {
      rounds.push(current)
      current = null
      continue
    }
    if (!current) continue
    // Bullet — start of an item (continuation lines start with spaces)
    const b = line.match(/^[-*]\s+(.+)$/)
    if (b) {
      current.bullets.push(b[1].trim())
    } else if (/^\s{2,}\S/.test(line) && current.bullets.length) {
      // continuation line: append to the last bullet with a single space
      const last = current.bullets[current.bullets.length - 1]
      current.bullets[current.bullets.length - 1] = (last + ' ' + line.trim()).replace(/\s+/g, ' ')
    }
  }
  if (current) rounds.push(current)
  return rounds
}

// ---------- Renderer ----------
function renderItem(round, fallbackPubDate) {
  const title = `Round ${round.round}: ${round.title}`
  const pubDate = SPRINT_DATES[round.round] || fallbackPubDate
  const ul = '<ul>' + round.bullets.map((b) => `<li>${htmlEscape(b)}</li>`).join('') + '</ul>'
  const guid = `paperfate-changelog-round-${round.round}`
  return [
    '    <item>',
    `      <title>${xmlEscape(title)}</title>`,
    `      <link>${xmlEscape(CHANGELOG_URL)}</link>`,
    `      <guid isPermaLink="false">${xmlEscape(guid)}</guid>`,
    `      <pubDate>${xmlEscape(pubDate)}</pubDate>`,
    `      <description><![CDATA[${ul}]]></description>`,
    '    </item>',
  ].join('\n')
}

function renderFeed(rounds, buildDate) {
  // Newest pubDate among items becomes channel lastBuildDate when available.
  const itemsXml = rounds.map((r) => renderItem(r, buildDate)).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xmlEscape(FEED_TITLE)}</title>`,
    `    <link>${xmlEscape(SITE_URL)}</link>`,
    `    <description>${xmlEscape(FEED_DESC)}</description>`,
    '    <language>en</language>',
    `    <lastBuildDate>${xmlEscape(buildDate)}</lastBuildDate>`,
    `    <atom:link href="${xmlEscape(SITE_URL + '/changelog.xml')}" rel="self" type="application/rss+xml" />`,
    itemsXml,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n')
}

// ---------- Main ----------
function main() {
  if (!existsSync(CHANGELOG)) {
    console.error(`[build-changelog-feed] missing ${CHANGELOG}`)
    process.exit(1)
  }
  const md = readFileSync(CHANGELOG, 'utf8')
  const rounds = parseChangelog(md)
  if (rounds.length === 0) {
    console.error('[build-changelog-feed] no rounds parsed; refusing to write empty feed')
    process.exit(1)
  }
  const mtime = statSync(CHANGELOG).mtime
  const buildDate = toRfc822(mtime)
  const xml = renderFeed(rounds, buildDate)
  const outPath = resolve(OUT)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, xml, 'utf8')
  console.log(`[build-changelog-feed] wrote ${rounds.length} item(s) -> ${OUT}`)
}

main()
