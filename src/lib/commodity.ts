/**
 * Canonical commodity identifier — this platform has no commodity enum
 * anywhere (confirmed by repo-wide audit, 2026-09-19): `commodity` on
 * product_listings is arbitrary French free text set by whoever publishes
 * the listing ("Ananas", "Manioc", "Maïs", ...). Matching a partner's
 * catalog allowlist against that raw text is brittle — "Ananas",
 * "ananas ", and "Ananas" (extra space) would all fail to match each
 * other under strict equality despite meaning the same thing.
 *
 * canonicalizeCommodity() is the stable identifier both sides (stored
 * listings and partner allowlists) are matched on: lowercased, trimmed,
 * diacritics stripped (NFD decomposition + combining-mark removal, so
 * "Maïs" and "Mais" canonicalize identically), internal whitespace
 * collapsed. It is NOT a translation or a controlled vocabulary — two
 * different display strings that aren't accent/case/whitespace variants
 * of each other still canonicalize to two different codes, by design.
 */
export function canonicalizeCommodity(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}
