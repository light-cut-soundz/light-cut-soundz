// Cuts: the parts of the track that are removed, as in LightCutVidz. Pure
// helpers, free of DOM access so they can be unit-tested without a browser.
//
// A cut is `{ id, start, end }` in seconds of the file ("real" time). What is
// left once the cuts are gone is the kept segments; the time counted along them
// is the "virtual" time, which is what the seek bar and the player show.

/** The shortest cut worth making. */
export const MIN_CUT = 0.05

/** Sorts the cuts and merges the ones that overlap or touch. A merged cut keeps
 * the id of the earliest one. */
export function mergeCuts(cuts) {
  if (!cuts.length) return []
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const out = [{ ...sorted[0] }]
  for (const cut of sorted.slice(1)) {
    const last = out[out.length - 1]
    if (cut.start <= last.end) last.end = Math.max(last.end, cut.end)
    else out.push({ ...cut })
  }
  return out
}

/** What the cuts leave: `{ start, end }` ranges, in order. */
export function keptSegments(cuts, duration) {
  if (!(duration > 0)) return []
  const kept = []
  let pos = 0
  for (const cut of mergeCuts(cuts)) {
    const start = Math.max(0, Math.min(cut.start, duration))
    const end = Math.max(start, Math.min(cut.end, duration))
    if (start > pos) kept.push({ start: pos, end: start })
    pos = Math.max(pos, end)
  }
  if (pos < duration) kept.push({ start: pos, end: duration })
  return kept
}

/** Total length of the kept segments. */
export function keptDuration(kept) {
  return kept.reduce((sum, seg) => sum + (seg.end - seg.start), 0)
}

/** Time in the file → time along the kept segments. A time inside a cut lands
 * on the cut's start. */
export function realToVirtual(real, kept) {
  let virtual = 0
  for (const seg of kept) {
    if (real <= seg.start) break
    if (real <= seg.end) { virtual += real - seg.start; break }
    virtual += seg.end - seg.start
  }
  return virtual
}

/** Time along the kept segments → time in the file. */
export function virtualToReal(virtual, kept) {
  let remaining = Math.max(0, virtual)
  for (const seg of kept) {
    const length = seg.end - seg.start
    if (remaining <= length) return seg.start + remaining
    remaining -= length
  }
  return kept.length ? kept[kept.length - 1].end : 0
}

/** The payload's `cuts`: `[start, end]` pairs, clamped to the file. */
export function cutRanges(cuts, duration) {
  return mergeCuts(cuts)
    .map((cut) => [Math.max(0, cut.start), Math.min(duration, cut.end)])
    .filter(([start, end]) => end > start)
}

/** "1:23.4", "83.4" or "1:02:03" → seconds, or `null` for anything else. */
export function parseTimeInput(value) {
  const parts = String(value).trim().split(':')
  if (parts.length > 3 || parts.some((part) => part.trim() === '')) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  return nums.reduce((total, n) => total * 60 + n, 0)
}

/** Seconds as `m:ss.t`, for the precise fields. */
export function fmtPrecise(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '0:00.0'
  // The total is rounded first: rounding the seconds alone could print 0:60.0.
  const tenths = Math.round(secs * 10)
  const m = Math.floor(tenths / 600)
  const s = Math.floor((tenths % 600) / 10)
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`
}
