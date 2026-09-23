import * as crypto from 'crypto'
import { getPawapayPublicKey } from './pawapayPublicKeys'

/**
 * Replaces the old x-pawapay-signature HMAC scheme
 * (verifyPawapayWebhookSignature.ts, removed) with PawaPay's real,
 * documented mechanism: RFC 9421 HTTP Message Signatures, asymmetric,
 * opt-in per environment via "Signed callbacks" in the PawaPay Dashboard.
 * See docs.pawapay.io/using_the_api#signatures and the "Public Keys"
 * endpoint (GET /public-key/http) this depends on.
 *
 * IMPORTANT — deploy ordering: this fails closed on every request until
 * "Signed callbacks" is enabled for the calling PawaPay environment
 * (sandbox and production are independent toggles). Deploying this before
 * that toggle is flipped for an environment means EVERY webhook from that
 * environment gets rejected (no Signature-Input header will be present at
 * all) — enable Signed callbacks first, verify a real callback succeeds,
 * only then deploy.
 */

// RFC 9421 §3.3 registered algorithm identifiers PawaPay documents as
// supported (docs.pawapay.io/using_the_api). ECDSA verification uses the
// IEEE-P1363 (raw r||s) signature encoding per RFC 9421 §3.3.3, not DER.
const ALG_TO_CRYPTO: Record<string, { hash: string; verifyOpts: Record<string, unknown> }> = {
  'ecdsa-p256-sha256': { hash: 'sha256', verifyOpts: { dsaEncoding: 'ieee-p1363' } },
  'ecdsa-p384-sha384': { hash: 'sha384', verifyOpts: { dsaEncoding: 'ieee-p1363' } },
  'rsa-pss-sha512': { hash: 'sha512', verifyOpts: { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } },
  'rsa-v1_5-sha256': { hash: 'sha256', verifyOpts: { padding: crypto.constants.RSA_PKCS1_PADDING } },
}

// The exact component set PawaPay documents for callback signatures.
const REQUIRED_COMPONENTS = ['@method', '@authority', '@path', 'signature-date', 'content-digest', 'content-type']

// How far created/expires may drift from our clock (clock skew tolerance),
// on top of whatever validity window PawaPay itself put in `expires`.
const CLOCK_SKEW_TOLERANCE_SECONDS = 60

interface SignatureInputParsed {
  label: string
  components: string[]
  alg: string
  keyid: string
  created: number
  expires: number
  /** The exact substring after `label=`, reused verbatim as the "@signature-params" line's value — see buildSignatureBase. */
  rawParamsValue: string
}

/**
 * Parses PawaPay's specific Signature-Input format, e.g.:
 *   sig-pp=("@method" "@authority" "@path" "signature-date" "content-digest"
 *     "content-type");alg="ecdsa-p256-sha256";keyid="HTTP_EC_P256_KEY:1";
 *     created=1714657551;expires=1714657611
 * Deliberately narrow (not a general RFC 8941 structured-field parser) —
 * PawaPay's callback signer always uses this exact shape, and a narrow
 * parser is easier to audit and test exhaustively than a general one.
 * Returns null on any deviation — fail closed, never guess.
 */
function parseSignatureInput(header: string | undefined): SignatureInputParsed | null {
  if (!header) return null
  const match = /^([a-zA-Z0-9_-]+)=(\((?:"[^"]*"\s*)*\)[^,]*)/.exec(header.trim())
  if (!match) return null
  const [, label, rest] = match

  const listMatch = /^\(((?:"[^"]*"\s*)*)\)(.*)$/.exec(rest)
  if (!listMatch) return null
  const [, listBody, paramsStr] = listMatch

  const components = Array.from(listBody.matchAll(/"([^"]*)"/g), (m) => m[1])
  if (components.length === 0) return null

  const params = new Map<string, string>()
  const paramRe = /;([a-zA-Z0-9_-]+)=("([^"]*)"|[0-9]+)/g
  let m: RegExpExecArray | null
  while ((m = paramRe.exec(paramsStr)) !== null) {
    params.set(m[1], m[3] !== undefined ? m[3] : m[2])
  }

  const alg = params.get('alg')
  const keyid = params.get('keyid')
  const created = params.get('created')
  const expires = params.get('expires')
  if (!alg || !keyid || !created || !expires) return null
  if (!/^\d+$/.test(created) || !/^\d+$/.test(expires)) return null

  return {
    label,
    components,
    alg,
    keyid,
    created: Number(created),
    expires: Number(expires),
    rawParamsValue: `(${listBody.trim()})${paramsStr}`,
  }
}

/** RFC 9530 Content-Digest: `sha-512=:<base64>:`. Returns the raw digest bytes, or null if absent/malformed. */
function parseContentDigestSha512(header: string | undefined): Buffer | null {
  if (!header) return null
  const match = /sha-512=:([A-Za-z0-9+/=]+):/.exec(header)
  if (!match) return null
  try {
    return Buffer.from(match[1], 'base64')
  } catch {
    return null
  }
}

/** PawaPay's Signature header: `sig-pp=:<base64>:` (label must match Signature-Input's label). */
function parseSignatureHeader(header: string | undefined, label: string): Buffer | null {
  if (!header) return null
  const re = new RegExp(`${label}=:([A-Za-z0-9+/=]+):`)
  const match = re.exec(header)
  if (!match) return null
  try {
    return Buffer.from(match[1], 'base64')
  } catch {
    return null
  }
}

function canonicalizeHeaderValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  const joined = Array.isArray(value) ? value.join(', ') : value
  return joined.trim()
}

/**
 * Builds the RFC 9421 signature base per §2.5: one `"component": value`
 * line per covered component (in the order Signature-Input listed them),
 * joined by '\n', with NO trailing newline after the final
 * "@signature-params" line — confirmed against a reference RFC 9421
 * implementation (misskey-dev/node-http-message-signatures), which joins
 * lines with Array.join('\n') and appends no trailing separator.
 */
function buildSignatureBase(
  parsed: SignatureInputParsed,
  ctx: { method: string; authority: string; path: string; headers: Record<string, string | string[] | undefined> },
): string | null {
  const lines: string[] = []
  for (const name of parsed.components) {
    let value: string | null
    if (name === '@method') value = ctx.method.toUpperCase()
    else if (name === '@authority') value = ctx.authority.toLowerCase()
    else if (name === '@path') value = ctx.path
    else if (name.startsWith('@')) return null // unsupported derived component — fail closed
    else value = canonicalizeHeaderValue(ctx.headers[name])

    if (value === null) return null
    lines.push(`"${name}": ${value}`)
  }
  lines.push(`"@signature-params": ${parsed.rawParamsValue}`)
  return lines.join('\n')
}

export interface VerifyPawapayCallbackInput {
  method: string
  /** Host the request was addressed to — from the Host header, no scheme/path. */
  authority: string
  /** URL path only, no query string. */
  path: string
  headers: Record<string, string | string[] | undefined>
  rawBody: Buffer | undefined
}

/**
 * Verifies an inbound PawaPay callback per RFC 9421. Fails closed (returns
 * false) on absolutely any missing header, parse failure, timestamp
 * outside its validity window, unknown keyid, Content-Digest/body mismatch,
 * or cryptographic verification failure — mirrors the fail-closed
 * discipline of every other signature check in this codebase
 * (verifyPartnerSignature.ts, the old verifyPawapayWebhookSignature.ts).
 */
export async function verifyPawapayCallbackSignature(input: VerifyPawapayCallbackInput): Promise<boolean> {
  const { headers, rawBody } = input
  if (!rawBody || rawBody.length === 0) return false

  const signatureInputHeader = canonicalizeHeaderValue(headers['signature-input'])
  const signatureHeader = canonicalizeHeaderValue(headers['signature'])
  const contentDigestHeader = canonicalizeHeaderValue(headers['content-digest'])
  if (!signatureInputHeader || !signatureHeader || !contentDigestHeader) return false

  const parsed = parseSignatureInput(signatureInputHeader)
  if (!parsed) return false

  // Every component PawaPay documents for callbacks must be present and in
  // the expected set — an attacker-shortened component list (e.g. dropping
  // content-digest so a tampered body isn't actually covered) is rejected.
  const componentSet = new Set(parsed.components)
  if (!REQUIRED_COMPONENTS.every((c) => componentSet.has(c))) return false

  const algSpec = ALG_TO_CRYPTO[parsed.alg]
  if (!algSpec) return false

  const nowSeconds = Math.floor(Date.now() / 1000)
  if (parsed.created - CLOCK_SKEW_TOLERANCE_SECONDS > nowSeconds) return false
  if (parsed.expires + CLOCK_SKEW_TOLERANCE_SECONDS < nowSeconds) return false

  // Content-Digest must match the ACTUAL raw body — the signature only
  // proves "this Content-Digest value was signed", not "this Content-Digest
  // value matches this body". Skipping this check would let a previously
  // valid (Content-Digest, Signature) pair be replayed against a different
  // body within the timestamp validity window.
  const claimedDigest = parseContentDigestSha512(contentDigestHeader)
  if (!claimedDigest) return false
  const actualDigest = crypto.createHash('sha512').update(rawBody).digest()
  if (claimedDigest.length !== actualDigest.length || !crypto.timingSafeEqual(claimedDigest, actualDigest)) {
    return false
  }

  const signatureBase = buildSignatureBase(parsed, {
    method: input.method,
    authority: input.authority,
    path: input.path,
    headers,
  })
  if (!signatureBase) return false

  const signatureBytes = parseSignatureHeader(signatureHeader, parsed.label)
  if (!signatureBytes) return false

  // getPawapayPublicKey already refetches internally whenever the cache
  // doesn't have this keyid (see pawapayPublicKeys.ts) — that alone
  // handles key rotation, so calling it a second time with force:true
  // here would just repeat the same fetch and double the outbound calls
  // for a genuinely unknown keyid, for no additional chance of success.
  const pem = await getPawapayPublicKey(parsed.keyid)
  if (!pem) return false

  try {
    return crypto.verify(
      algSpec.hash,
      Buffer.from(signatureBase, 'utf8'),
      { key: pem, ...algSpec.verifyOpts } as unknown as crypto.KeyLike,
      signatureBytes,
    )
  } catch {
    // A malformed key/signature throws rather than returning false —
    // fail closed either way.
    return false
  }
}
