import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * Raw control characters (NUL, US, DEL, …) in a source file make Git and GitHub
 * classify the whole file as binary: diffs are not shown, `git grep` skips it and
 * editors may corrupt it. Write them as escapes (\u0000) instead.
 *
 * Two files predate this check and still contain one raw NUL each, used as a
 * hash-input separator. Changing them would alter deterministic ids
 * (webhook eventId, offer-idempotency fingerprint), so they need their own
 * change with golden-hash tests. They are listed here so that NO NEW file can
 * join them, and so this list must shrink when they are fixed.
 */
const KNOWN_LEGACY_FILES = ['src/lib/eventId.ts', 'src/partners/offerFingerprint.ts']

const SRC = join(process.cwd(), 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

/** Control bytes other than tab, LF and CR. */
function rawControlBytes(path: string): number {
  return readFileSync(path).reduce((n, c) => n + ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127 ? 1 : 0), 0)
}

const withControlBytes = sourceFiles(SRC)
  .filter((f) => rawControlBytes(f) > 0)
  .map((f) => relative(process.cwd(), f).split('\\').join('/'))
  .sort()

describe('source files are plain text', () => {
  it('no source file other than the known legacy ones contains raw control characters', () => {
    expect(withControlBytes.filter((f) => !KNOWN_LEGACY_FILES.includes(f))).toEqual([])
  })

  it('the legacy list only names files that still have the problem (remove an entry once its file is fixed)', () => {
    expect(withControlBytes.filter((f) => KNOWN_LEGACY_FILES.includes(f))).toEqual([...KNOWN_LEGACY_FILES].sort())
  })

  it('the accepted-offer enrichment and its tests are clean', () => {
    for (const f of [
      'src/partners/externalHarvestOfferEnrichment.ts',
      'src/partners/__tests__/externalHarvestOfferEnrichment.test.ts',
      'src/partners/__tests__/externalHarvestOfferEnrichmentHandlers.test.ts',
    ]) {
      expect(rawControlBytes(join(process.cwd(), f)), f).toBe(0)
    }
  })
})
