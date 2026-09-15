/**
 * The four functions a fork actually calls.
 *
 * Everything below composes the lower modules: `cid` for fingerprints,
 * `manifest` for the canonical document, `filecoin` for storage, `avalanche`
 * for the pointer. Those are worth reading, but nobody adapting this template
 * should have to wire them together by hand.
 *
 *   storeAssetRecord    publish a record set and anchor it
 *   getAssetRecord      read the current manifest for an asset
 *   verifyAssetRecord   check an asset against both chains
 *   getStorageStatus    proof state for one piece (re-exported from ./filecoin)
 *
 * To move this to another domain, change the record types and the dataset.
 * Nothing here knows what a deed is.
 */

import type { Synapse } from '@filoz/synapse-sdk'
import type { Address, Hex, PublicClient, WalletClient } from 'viem'
import { anchorManifest, currentManifest, type ManifestVersion, manifestHistory } from './avalanche.js'
import { computeFileCid } from './cid.js'
import {
  fetchRecord,
  pieceStatusIn,
  type StorageStatus,
  storageContext,
  uploadRecord,
} from './filecoin.js'
import {
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  type ManifestRecord,
  manifestBytes,
  parseManifest,
} from './manifest.js'

export { manifestHistory } from './avalanche.js'
export type { ManifestVersion } from './avalanche.js'
export { getStorageStatus } from './filecoin.js'
export type { StorageStatus } from './filecoin.js'

/** One document on its way in. */
export interface RecordInput {
  filename: string
  /** Manifest record type, for example `deed` or `tax_assessment`. */
  type: string
  mimeType: string
  bytes: Uint8Array
}

export interface StoreAssetRecordOptions {
  synapse: Synapse
  wallet: WalletClient
  assetId: string
  records: RecordInput[]
  network?: string
  /** Called as each step completes, for a progress line. */
  onProgress?: (message: string) => void
}

export interface StoreAssetRecordResult {
  manifest: Manifest
  manifestCid: string
  manifestPieceCid: string
  dataSetId: number
  version: number
  transactionHash: Hex
}

/**
 * Publish a record set and anchor it on Avalanche.
 *
 * The wallet here signs with a key this template reads from an env file,
 * because a demo with one account and no connect flow is simpler to read and
 * simpler to run. Do not carry that into anything real. A key in an env file
 * becomes a key in a bundle the moment this runs in a browser, and a key in a
 * bundle is a key that is gone. An issuer publishing real records wires
 * `wallet` to whatever their custody actually is: a browser wallet the operator
 * approves each write in, a signer held server-side, or an HSM. Nothing else
 * here changes; `WalletClient` is the seam.
 *
 * Records go up first, each as its own piece so each has its own CID and proof
 * state. The manifest is built from what came back and uploaded last, because
 * it has to name the piece CIDs. Only then is anything written to Avalanche: a
 * pointer to a manifest that does not exist yet would be worse than no pointer.
 */
export async function storeAssetRecord(options: StoreAssetRecordOptions): Promise<StoreAssetRecordResult> {
  const { synapse, wallet, assetId, records, onProgress } = options
  const note = (message: string): void => onProgress?.(message)

  if (records.length === 0) throw new Error('storeAssetRecord needs at least one record')

  const stored: ManifestRecord[] = []
  let placement: { dataSetId: number; providerId: number } | null = null

  for (const [index, record] of records.entries()) {
    note(`storing ${record.filename} (${index + 1} of ${records.length})`)
    const result = await uploadRecord({ synapse, bytes: record.bytes, filename: record.filename })
    // Where the records actually landed, taken from the first upload rather
    // than passed in, so the manifest cannot name a data set nothing is in.
    placement ??= { dataSetId: result.dataSetId, providerId: result.providerId }
    stored.push({
      cid: result.cid,
      dataSetId: result.dataSetId,
      filename: record.filename,
      mimeType: record.mimeType,
      pieceCid: result.pieceCid,
      sha256: result.sha256,
      size: result.size,
      type: record.type,
    })
  }

  const manifest: Manifest = {
    assetId,
    records: stored,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    storage: {
      dataSetId: placement!.dataSetId,
      network: options.network ?? 'filecoin-calibration',
      providerId: placement!.providerId,
    },
  }

  note('storing the manifest')
  const manifestUpload = await uploadRecord({
    synapse,
    bytes: manifestBytes(manifest),
    filename: 'manifest.json',
  })

  note('anchoring on Avalanche')
  const anchored = await anchorManifest(wallet, {
    assetId,
    manifestCid: manifestUpload.cid,
    manifestPieceCid: manifestUpload.pieceCid,
    dataSetId: manifestUpload.dataSetId,
  })

  return {
    manifest,
    manifestCid: manifestUpload.cid,
    manifestPieceCid: manifestUpload.pieceCid,
    dataSetId: manifestUpload.dataSetId,
    version: anchored.version,
    transactionHash: anchored.transactionHash,
  }
}

export interface AssetRecord {
  /** What Avalanche holds. Null when nothing has been anchored. */
  anchor: ManifestVersion | null
  /** The manifest those bytes hash to. Null when there is no anchor. */
  manifest: Manifest | null
}

/**
 * Read an asset's current record set: the pointer from Avalanche, then the
 * manifest it points at from Filecoin.
 *
 * The manifest's own CID is checked against the anchored one before it is
 * parsed. A manifest that hashes differently is not the anchored manifest,
 * whatever it says inside.
 */
export async function getAssetRecord(
  client: PublicClient,
  synapse: Synapse,
  owner: Address,
  assetId: string
): Promise<AssetRecord> {
  const anchor = await currentManifest(client, owner, assetId)
  if (anchor == null) return { anchor: null, manifest: null }
  return { anchor, manifest: await readAnchoredManifest(synapse, anchor, assetId) }
}

/**
 * Fetch the manifest a version points at and prove it is that manifest.
 *
 * Every path that reads a manifest goes through here: the current record set,
 * each version in History, and the document lookup. The bytes are re-hashed
 * against the anchored CID before they are parsed, and the parsed manifest has
 * to name the asset it was anchored under. A CAR whose root label is right but
 * whose blocks are not would pass the label check alone.
 */
export async function readAnchoredManifest(
  synapse: Synapse,
  anchor: ManifestVersion,
  assetId: string
): Promise<Manifest> {
  const bytes = await fetchRecord(synapse, anchor.manifestPieceCid, anchor.manifestCid, { dataSetId: anchor.dataSetId })
  const recomputed = await computeFileCid(bytes)
  if (recomputed !== anchor.manifestCid) {
    throw new VerificationError(
      `the manifest fetched for ${assetId} hashes to ${recomputed}, but Avalanche points at ${anchor.manifestCid}`
    )
  }
  const manifest = parseManifest(bytes)
  if (manifest.assetId !== assetId) {
    throw new VerificationError(`the manifest anchored under ${assetId} says it belongs to ${manifest.assetId}`)
  }
  if (manifest.records.length === 0) {
    throw new VerificationError(`the manifest anchored under ${assetId} lists no records`)
  }
  return manifest
}

export class VerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerificationError'
  }
}

/** Why one record passed or failed. Every field is a separate, checkable claim. */
export interface RecordVerdict {
  filename: string
  cid: string
  /** The bytes fetched hash to the CID the manifest lists. Null when nothing was fetched to check. */
  contentMatches: boolean | null
  /** The record could be retrieved at all. */
  retrievable: boolean
  /** Filecoin reports the data set holding it as proven and not overdue. */
  storageProven: boolean
  proof: StorageStatus | null
  /** Present when a check failed, in words a UI can show. */
  problem?: string
}

export interface AssetVerdict {
  verified: boolean
  /** The registry answered. False means nothing below is known, not that nothing is anchored. */
  avalancheRead: boolean
  /** Avalanche has a pointer for this asset. */
  anchored: boolean
  anchor: ManifestVersion | null
  manifest: Manifest | null
  /** Proof state of the manifest's own piece. The pointer is only as good as this. */
  manifestProof: StorageStatus | null
  manifestStorageProven: boolean
  records: RecordVerdict[]
  problems: string[]
}

export interface VerifyProgress {
  /** What is happening now, in words a UI can show unchanged. */
  message: string
  /** Records finished so far, and how many there are once the manifest is read. */
  done: number
  total: number
}

/**
 * Check an asset end to end, against both chains.
 *
 * Nothing here trusts the issuer. The pointer comes from Avalanche, the
 * manifest is checked against that pointer, every record is fetched and
 * re-hashed against the manifest, and the proof state comes from Filecoin.
 * A failure of any one of those fails the record, and each one says which.
 *
 * `onProgress` matters more than it looks. A run takes about a minute and
 * sometimes two, most of it waiting on storage providers, and a UI with no
 * progress is indistinguishable from a UI that has hung.
 */
export async function verifyAssetRecord(
  client: PublicClient,
  synapse: Synapse,
  owner: Address,
  assetId: string,
  onProgress?: (progress: VerifyProgress) => void
): Promise<AssetVerdict> {
  let done = 0
  let total = 0
  const note = (message: string): void => onProgress?.({ message, done, total })
  note(`reading the pointer for ${assetId} from Avalanche`)
  const problems: string[] = []

  let anchor: ManifestVersion | null
  try {
    anchor = await currentManifest(client, owner, assetId)
  } catch (cause) {
    // A registry that cannot be read says nothing about the asset. This must
    // not surface as "not anchored".
    return {
      ...EMPTY_VERDICT,
      avalancheRead: false,
      problems: [`Avalanche could not be read: ${(cause as Error).message}`],
    }
  }
  if (anchor == null) {
    return { ...EMPTY_VERDICT, problems: [`Avalanche has no anchored manifest for ${assetId}`] }
  }

  let manifest: Manifest
  try {
    manifest = await readAnchoredManifest(synapse, anchor, assetId)
  } catch (cause) {
    // Avalanche holds a pointer; what failed is following it. Say so, rather
    // than the flatly wrong "not anchored" or a bare "anchored" with nothing
    // behind it.
    return { ...EMPTY_VERDICT, anchored: true, anchor, problems: [(cause as Error).message] }
  }

  // One context per distinct data set, opened once and shared. Opening a
  // context costs several seconds of chain reads, and records usually share a
  // data set, so opening one per record spent that cost once per file. They do
  // not always share one, though, so this groups rather than assuming. The
  // manifest's own data set is in the set: the pointer is only as good as the
  // storage behind it.
  total = manifest.records.length
  note('opening the Filecoin data sets that prove these records')

  const contexts = new Map<number, Awaited<ReturnType<typeof storageContext>> | null>()
  await Promise.all(
    [...new Set([anchor.dataSetId, ...manifest.records.map((entry) => entry.dataSetId)])].map(async (dataSetId) => {
      contexts.set(dataSetId, await storageContext(synapse, dataSetId).catch(() => null))
    })
  )
  const [manifestProof, records] = await Promise.all([
    readProof(contexts.get(anchor.dataSetId) ?? null, anchor.manifestPieceCid),
    Promise.all(
      manifest.records.map(async (entry) => {
        const verdict = await verifyOneRecord(synapse, entry, contexts.get(entry.dataSetId) ?? null)
        done += 1
        note(`checked ${entry.filename}`)
        return verdict
      })
    ),
  ])

  const manifestStorageProven = isProven(manifestProof)
  if (!manifestStorageProven) problems.push(`manifest: ${describeProofProblem(manifestProof)}`)
  for (const verdict of records) {
    if (verdict.problem != null) problems.push(`${verdict.filename}: ${verdict.problem}`)
  }

  return {
    verified: problems.length === 0,
    avalancheRead: true,
    anchored: true,
    anchor,
    manifest,
    manifestProof,
    manifestStorageProven,
    records,
    problems,
  }
}

const EMPTY_VERDICT: AssetVerdict = {
  verified: false,
  avalancheRead: true,
  anchored: false,
  anchor: null,
  manifest: null,
  manifestProof: null,
  manifestStorageProven: false,
  records: [],
  problems: [],
}

/** Proof state, or null when it cannot be read. Unreadable is not the same as unproven. */
async function readProof(
  context: Awaited<ReturnType<typeof storageContext>> | null,
  pieceCid: string
): Promise<StorageStatus | null> {
  if (context == null) return null
  // Bytes may still be correct and retrievable when proof state is unavailable,
  // so this is reported rather than thrown.
  return pieceStatusIn(context, pieceCid).catch(() => null)
}

/** Filecoin is holding it and the proof is not late. */
function isProven(proof: StorageStatus | null): boolean {
  return proof != null && proof.lastProven != null && !proof.isProofOverdue
}

async function verifyOneRecord(
  synapse: Synapse,
  entry: ManifestRecord,
  context: Awaited<ReturnType<typeof storageContext>> | null
): Promise<RecordVerdict> {
  // Proof state first, because it names a provider known to hold this piece and
  // that is the fallback if the SDK's retrieval race comes back empty.
  const proof = await readProof(context, entry.pieceCid)
  const base = { filename: entry.filename, cid: entry.cid, proof, storageProven: isProven(proof) }

  let bytes: Uint8Array
  try {
    bytes = await fetchRecord(synapse, entry.pieceCid, entry.cid, { retrievalUrl: proof?.retrievalUrl })
  } catch (cause) {
    // Nothing was fetched, so nothing was compared. Unknown is not a mismatch,
    // and a mismatch is the one thing that would mean the document changed.
    return {
      ...base,
      contentMatches: null,
      retrievable: false,
      problem: `could not be retrieved (${(cause as Error).message})`,
    }
  }

  const recomputed = await computeFileCid(bytes)
  const contentMatches = recomputed === entry.cid
  const verdict: RecordVerdict = { ...base, contentMatches, retrievable: true }

  const problem = describeProblem(entry, recomputed, contentMatches, base.storageProven, proof)
  return problem == null ? verdict : { ...verdict, problem }
}

/** The first thing wrong with a record, in words a UI can show unchanged. */
function describeProblem(
  entry: ManifestRecord,
  recomputed: string,
  contentMatches: boolean,
  storageProven: boolean,
  proof: StorageStatus | null
): string | undefined {
  if (!contentMatches) {
    return `the bytes retrieved hash to ${recomputed}, but the manifest lists ${entry.cid}`
  }
  if (storageProven) return undefined
  return describeProofProblem(proof)
}

/** Why a data set does not count as proven. Unreadable, never challenged and overdue are three different things. */
function describeProofProblem(proof: StorageStatus | null): string {
  if (proof == null) return 'proof state could not be read'
  if (proof.lastProven == null) return 'the data set has not been proven yet'
  return 'storage proof is overdue'
}

/** What looking for a document in the history established. */
export type DocumentLookup =
  | { outcome: 'matched'; version: number; record: ManifestRecord; unreadable: number[] }
  /** Every anchored version was read and none lists the CID. */
  | { outcome: 'unmatched'; versions: number }
  /** No readable version lists the CID, but some could not be read. Not a verdict. */
  | { outcome: 'incomplete'; versions: number; unreadable: number[] }

/**
 * Find a CID in any version of an asset's history.
 *
 * Split out from `checkDocument` because a UI has already hashed the file by
 * the time it wants to know, and passing the bytes back in only to hash them
 * again is work for nothing.
 *
 * A version whose manifest cannot be fetched is skipped, so that one unreachable
 * manifest does not stop the file matching a version that is reachable. But a
 * miss with versions unread is not a miss: "no version lists this" is only
 * true once every version has been read. Callers get the difference and must
 * not call an incomplete lookup tampering. A registry that cannot be read at
 * all throws; there is no lookup to report.
 */
export async function findDocumentByCid(
  client: PublicClient,
  synapse: Synapse,
  owner: Address,
  assetId: string,
  cid: string
): Promise<DocumentLookup> {
  const versions = await manifestHistory(client, owner, assetId)

  // Every manifest is fetched at once. A miss has to read them all anyway,
  // and one provider round trip is 10 to 20 seconds on a slow day, so the
  // wall time is the slowest fetch rather than the sum.
  const reads = await Promise.allSettled(versions.map((version) => readAnchoredManifest(synapse, version, assetId)))
  const unreadable = versions.filter((_, index) => reads[index]!.status === 'rejected').map((version) => version.version)

  // Newest first: a document is usually current, and the answer is the same
  // either way.
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const read = reads[index]!
    if (read.status !== 'fulfilled') continue
    const record = read.value.records.find((entry) => entry.cid === cid)
    if (record != null) return { outcome: 'matched', version: versions[index]!.version, record, unreadable }
  }
  return unreadable.length === 0
    ? { outcome: 'unmatched', versions: versions.length }
    : { outcome: 'incomplete', versions: versions.length, unreadable }
}

/**
 * Check a file someone handed you against every version of an asset.
 *
 * The file is hashed locally and never uploaded. A CID that appears in no
 * version of the manifest is not a document of record, which is the honest
 * scenario: gateways will not serve tampered bytes, so the only way to hold one
 * is for someone to have given it to you.
 */
export async function checkDocument(
  client: PublicClient,
  synapse: Synapse,
  owner: Address,
  assetId: string,
  bytes: Uint8Array
): Promise<{ cid: string; lookup: DocumentLookup }> {
  const cid = await computeFileCid(bytes)
  return { cid, lookup: await findDocumentByCid(client, synapse, owner, assetId, cid) }
}
