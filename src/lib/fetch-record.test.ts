/**
 * The SDK's provider race can fail as a group while the provider that holds the
 * piece is serving it. A live verify on 2026-09-15 failed exactly so on the
 * manifest piece, which had no fallback. These pin the fallback for callers
 * that only know the data set, not the URL.
 */

import { calculate as calculatePieceCid } from '@filoz/synapse-core/piece'
import type { Synapse } from '@filoz/synapse-sdk'
import { createCarFromFile } from 'filecoin-pin'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchRecord } from './filecoin.js'
import { bytesOfLength, expectSameBytes, fileOf } from './test-bytes.js'

const RETRIEVAL_URL = 'https://provider.example/piece/x'

async function fixture() {
  const original = bytesOfLength(2816)
  const car = await createCarFromFile(fileOf(original, 'manifest.json'))
  const pieceCid = (await calculatePieceCid(car.carBytes)).toString()
  return { original, carBytes: car.carBytes, cid: car.rootCid.toString(), pieceCid }
}

/** A Synapse whose download always loses the race and whose data set knows the URL. */
function synapseWith(retrievalUrl: string | null, contextsOpened: { count: number }): Synapse {
  return {
    storage: {
      download: async () => { throw new Error('All provider retrieval attempts failed') },
      createContexts: async () => {
        contextsOpened.count += 1
        return [{ pieceStatus: async () => ({ retrievalUrl, dataSetLastProven: null, dataSetNextProofDue: null, isProofOverdue: false }) }]
      },
    },
  } as unknown as Synapse
}

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchRecord when the SDK race fails', () => {
  it('asks the data set for the provider URL and fetches the piece from it', async () => {
    const { original, carBytes, cid, pieceCid } = await fixture()
    const opened = { count: 0 }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(carBytes))))

    const bytes = await fetchRecord(synapseWith(RETRIEVAL_URL, opened), pieceCid, cid, { dataSetId: 54 })

    await expectSameBytes(bytes, original)
    expect(opened.count).toBe(1)
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(RETRIEVAL_URL)
  })

  it('rethrows the SDK error when neither a URL nor a data set is known', async () => {
    const { cid, pieceCid } = await fixture()
    vi.stubGlobal('fetch', vi.fn())

    await expect(fetchRecord(synapseWith(RETRIEVAL_URL, { count: 0 }), pieceCid, cid)).rejects.toThrow('All provider retrieval attempts failed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rethrows the SDK error when the data set publishes no URL', async () => {
    const { cid, pieceCid } = await fixture()
    vi.stubGlobal('fetch', vi.fn())

    await expect(fetchRecord(synapseWith(null, { count: 0 }), pieceCid, cid, { dataSetId: 54 })).rejects.toThrow('All provider retrieval attempts failed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a provider that serves a different piece', async () => {
    const { cid, pieceCid } = await fixture()
    const other = await createCarFromFile(fileOf(bytesOfLength(100, 7), 'other.json'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(other.carBytes))))

    await expect(fetchRecord(synapseWith(RETRIEVAL_URL, { count: 0 }), pieceCid, cid, { dataSetId: 54 })).rejects.toThrow(`not the ${pieceCid}`)
  })
})
