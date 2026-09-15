/**
 * Filecoin storage: put a record there, get it back, ask whether it is still held.
 *
 * Everything here was proven against Calibration first in
 * `scripts/spike-calibration.ts` before it was shaped into functions. Three
 * facts from that run drive the design:
 *
 * - An upload took just over two minutes. Nothing on a stage waits for that, so
 *   the demo asset is seeded ahead of time and `uploadRecord` is never on the
 *   critical path of the recording.
 * - `download` returns the CAR, not the file. 2913 bytes came back for a 2816
 *   byte deed. Extraction is part of retrieval, not an optional extra.
 * - `pieceStatus` reports a real last-proven time on a data set minutes old, so
 *   the proof panel has something true to show without waiting for a challenge
 *   window.
 */

import { calculate as calculatePieceCid } from '@filoz/synapse-core/piece'
import type { Synapse } from '@filoz/synapse-sdk'
import type { StorageContext } from '@filoz/synapse-sdk/storage'
import { checkUploadReadiness, createCarFromFile, executeUpload } from 'filecoin-pin'
import { type Logger, pino } from 'pino'
import { extractFileFromCar } from './car.js'
import { computeFileCid, sha256Hex } from './cid.js'

/**
 * filecoin-pin's upload path requires a pino logger. Callers who do not want
 * upload chatter get a silent one rather than having to construct it.
 */
export function quietLogger(): Logger {
  return pino({ level: 'silent' })
}

/** A record as the manifest will describe it, once stored. */
export interface StoredRecord {
  /** UnixFS CID of the file bytes. What the manifest lists and the verifier checks. */
  cid: string
  /** Filecoin piece CID. What the proof system tracks. */
  pieceCid: string
  sha256: string
  size: number
  /** Data set the primary copy landed in. Needed to read proof state later. */
  dataSetId: number
  providerId: number
  /**
   * Whether IPNI confirmed the root CID is announced. A public gateway link is
   * a lie until this is true, so the UI must not offer one before then.
   */
  ipniValidated: boolean
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageError'
  }
}

export interface UploadRecordOptions {
  synapse: Synapse
  bytes: Uint8Array
  filename: string
  logger?: Logger
  /** Called with filecoin-pin's progress event names, for a status line. */
  onProgress?: (stage: string) => void
}

/**
 * Store one record on Filecoin.
 *
 * Each record is its own CAR and its own piece, so each gets an independent
 * CID and proof state. That is what makes the per-record checks on the Verify
 * screen honest rather than a single pass or fail for the whole asset.
 */
export async function uploadRecord(options: UploadRecordOptions): Promise<StoredRecord> {
  const { synapse, bytes, filename, onProgress } = options
  const logger = options.logger ?? quietLogger()

  const file = new File([bytes as unknown as BlobPart], filename)
  const car = await createCarFromFile(file)

  const cid = await computeFileCid(bytes)
  if (car.rootCid.toString() !== cid) {
    // Cannot happen as long as both use the same importer options, and the CID
    // suite holds them to that. Checked anyway: a manifest listing a CID the
    // bytes were not stored under would fail verification for everyone, forever.
    throw new StorageError(`CAR root ${car.rootCid.toString()} does not match the file CID ${cid}`)
  }

  const readiness = await checkUploadReadiness({ synapse, fileSize: car.carBytes.length })
  if (readiness.status !== 'ready') {
    const reason = readiness.validation.errorMessage ?? 'the account cannot pay for this upload'
    const suggestions = readiness.suggestions.length > 0 ? `\n  ${readiness.suggestions.join('\n  ')}` : ''
    throw new StorageError(`${reason}${suggestions}`)
  }

  const result = await executeUpload(synapse, car.carBytes, car.rootCid, {
    logger,
    pieceMetadata: { name: filename },
    ...(onProgress != null ? { onProgress: (event: { type: string }) => onProgress(event.type) } : {}),
  })

  const primary = result.copies.find((copy) => copy.role === 'primary') ?? result.copies[0]
  if (primary == null) {
    const failures = result.failedAttempts.map((f) => `provider ${f.providerId}: ${f.error}`).join('; ')
    throw new StorageError(`no copy of ${filename} was stored${failures === '' ? '' : ` (${failures})`}`)
  }

  return {
    cid,
    pieceCid: result.pieceCid,
    sha256: await sha256Hex(bytes),
    size: bytes.length,
    dataSetId: Number(primary.dataSetId),
    providerId: Number(primary.providerId),
    ipniValidated: result.ipniValidated,
  }
}

export interface FetchRecordOptions {
  /**
   * A provider URL known to hold this piece, from `pieceStatus`. Used only if
   * the SDK's own retrieval fails.
   */
  retrievalUrl?: string | null
  /**
   * The data set holding the piece. When no `retrievalUrl` was supplied, the
   * fallback asks this data set's provider for one before giving up.
   */
  dataSetId?: number
}

/**
 * Fetch a record and hand back the document bytes.
 *
 * `expectedCid` is checked against the CAR's root before extraction, so a
 * provider serving the wrong piece is caught here with both CIDs named. The
 * caller still re-hashes what comes back; this only means a mixed-up piece
 * fails with a useful message rather than as an unexplained mismatch.
 *
 * Two paths, because one is not reliable enough to stand on. The SDK races
 * every provider that might hold the piece and takes the first answer, which is
 * the right default and fails as a group: on a network where some provider
 * hostnames do not resolve, the race can exhaust before a good one replies. A
 * verify run failed exactly that way on a piece that two providers were serving
 * in under half a second. So when the race loses, this asks the one provider
 * that `pieceStatus` said holds the piece, directly.
 */
export async function fetchRecord(
  synapse: Synapse,
  pieceCid: string,
  expectedCid: string,
  options: FetchRecordOptions = {}
): Promise<Uint8Array> {
  try {
    return extractFileFromCar(await synapse.storage.download({ pieceCid }), expectedCid)
  } catch (cause) {
    let url = options.retrievalUrl
    if ((url == null || url === '') && options.dataSetId != null) {
      url = (await getStorageStatus(synapse, { pieceCid, dataSetId: options.dataSetId }).catch(() => null))?.retrievalUrl
    }
    if (url == null || url === '') throw cause

    const response = await fetch(url, { signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) })
    if (!response.ok) {
      throw new StorageError(
        `retrieval failed twice for ${pieceCid}: the SDK reported "${(cause as Error).message}", ` +
          `and ${url} answered ${response.status}`
      )
    }
    const car = new Uint8Array(await response.arrayBuffer())
    // The SDK path validates the piece CID of what it downloads. This path must
    // too, or "content matches" and "storage proven" could be about different
    // bytes: a provider could serve a valid CAR that is not the piece whose
    // proof state was just read.
    const received = (await calculatePieceCid(car)).toString()
    if (received !== pieceCid) {
      throw new StorageError(`${url} served piece ${received}, not the ${pieceCid} the manifest lists`)
    }
    return extractFileFromCar(car, expectedCid)
  }
}

/** A direct provider fetch with no deadline can hold a verify run open for minutes. */
const FALLBACK_TIMEOUT_MS = 60_000

/** Proof state for one piece, in the terms the UI shows. */
export interface StorageStatus {
  /** Null on a data set that has not been challenged yet. */
  lastProven: Date | null
  nextProofDue: Date | null
  /** True when a proof is past its deadline. Amber in the UI, never red. */
  isProofOverdue: boolean
  /** Direct provider URL for the piece, when the provider publishes one. */
  retrievalUrl: string | null
}

/**
 * Open a storage context on a data set.
 *
 * Worth holding on to. Opening one costs several seconds of chain reads, and
 * every record in an asset lives in the same data set, so verifying five
 * records with five contexts spends that cost five times for one answer.
 */
export async function storageContext(synapse: Synapse, dataSetId: number): Promise<StorageContext> {
  const [context] = await synapse.storage.createContexts({ dataSetIds: [BigInt(dataSetId)] })
  if (context == null) throw new StorageError(`no storage context for data set ${dataSetId}`)
  return context
}

/**
 * Read proof state for a piece in an already-open context.
 *
 * This is about the data set the piece belongs to, not the piece alone. The
 * provider proves it holds the set; there is no per-file proof, and the UI must
 * not imply one.
 */
export async function pieceStatusIn(context: StorageContext, pieceCid: string): Promise<StorageStatus> {
  const status = await context.pieceStatus({ pieceCid })
  if (status == null) throw new StorageError(`this data set does not hold piece ${pieceCid}`)

  return {
    lastProven: status.dataSetLastProven,
    nextProofDue: status.dataSetNextProofDue,
    isProofOverdue: status.isProofOverdue ?? false,
    retrievalUrl: status.retrievalUrl,
  }
}

/** Proof state for one piece. Opens a context per call; use the two above for several. */
export async function getStorageStatus(
  synapse: Synapse,
  options: { pieceCid: string; dataSetId: number }
): Promise<StorageStatus> {
  return pieceStatusIn(await storageContext(synapse, options.dataSetId), options.pieceCid)
}

/**
 * Proof state in plain words, for the proof panel.
 *
 * `now` is a parameter rather than a call to `Date.now()` so the output is a
 * function of its inputs and the tests are not time-dependent.
 *
 * The wording stays at the level the protocol supports. The provider proves it
 * still holds the data set; saying "this deed was proven" would claim a
 * per-file proof that does not exist.
 */
export function describeProof(status: StorageStatus, now: Date): { lastProven: string; nextProofDue: string } {
  return {
    lastProven: status.lastProven == null ? 'not proven yet' : `${ago(now, status.lastProven)} ago`,
    nextProofDue:
      status.nextProofDue == null
        ? 'not scheduled yet'
        : status.isProofOverdue
          ? `overdue by ${ago(now, status.nextProofDue)}`
          : `in ${ago(status.nextProofDue, now)}`,
  }
}

/** Rounded gap between two instants. Never negative; a gap the wrong way reads as "less than a minute". */
function ago(later: Date, earlier: Date): string {
  const minutes = Math.floor((later.getTime() - earlier.getTime()) / 60_000)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} min`

  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `about ${hours} h`
  return `${Math.floor(hours / 24)} days`
}
