/**
 * Durable deletion intents.
 *
 * A journal entry describes one confirmed delete operation: the root, every
 * target session identity, quarantine directories that may already exist, and
 * any media ids captured before the log is destroyed. Startup replays entries
 * before normal use.
 *
 * @module dsh-session-deleater/journal
 */

import { join } from 'node:path'

import { readJson, writeJsonAtomic } from './fsx.js'

const VERSION = 1

/**
 * One journal store.
 */
export class Journal {
  /**
   * @param home - DSH home.
   */
  constructor(home) {
    this.path = join(home, 'dsh-session-deleater', 'pending.v1.json')
    this.entries = new Map()
  }

  /**
   * Load the journal from disk. Malformed content is ignored rather than acted on.
   * @returns this journal.
   */
  async load() {
    let raw
    try {
      raw = await readJson(this.path, undefined)
    } catch {
      raw = undefined
    }
    if (raw === undefined || raw?.version !== VERSION || !Array.isArray(raw.entries)) {
      this.entries.clear()
      return this
    }
    for (const entry of raw.entries) {
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
      if (!Array.isArray(entry.targets)) continue
      this.entries.set(entry.id, entry)
    }
    return this
  }

  /** Persist the complete journal atomically. */
  async save() {
    if (this.entries.size === 0) {
      // Keep a valid empty document rather than deleting the path: an operator
      // can always inspect it, and an absent file is indistinguishable from a
      // journal that failed to load.
      await writeJsonAtomic(this.path, { version: VERSION, entries: [] })
      return
    }
    await writeJsonAtomic(this.path, {
      version: VERSION,
      entries: [...this.entries.values()],
    })
  }

  /**
   * Read one entry.
   * @param id - root session id.
   * @returns the entry, if present.
   */
  get(id) {
    return this.entries.get(id)
  }

  /** @returns all entries in insertion order. */
  list() {
    return [...this.entries.values()]
  }

  /**
   * Insert or replace one entry and persist.
   * @param entry - complete entry.
   */
  async put(entry) {
    this.entries.set(entry.id, entry)
    await this.save()
  }

  /**
   * Merge fields into an existing entry and persist.
   * @param id - root session id.
   * @param patch - fields to merge.
   * @returns the updated entry.
   */
  async patch(id, patch) {
    const current = this.entries.get(id)
    if (current === undefined) throw new Error(`journal entry "${id}" is missing`)
    const next = { ...current, ...patch, updatedAt: Date.now() }
    this.entries.set(id, next)
    await this.save()
    return next
  }

  /**
   * Remove one entry and persist.
   * @param id - root session id.
   */
  async remove(id) {
    this.entries.delete(id)
    await this.save()
  }
}
