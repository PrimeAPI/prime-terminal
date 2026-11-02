// A JSON file with validation, atomic writes and external-change reloading.

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

export interface JsonFileStoreOptions<T> {
  defaults: () => T
  /** Returns an error message or null when valid. */
  validate: (value: unknown) => string | null
  /** Fill in defaults etc. after successful validation. */
  normalize?: (value: unknown) => T
}

export class JsonFileStore<T> extends EventEmitter {
  private current: T
  private err: string | null = null
  private lastText: string | null = null
  private watcher: FSWatcher | null = null
  private debounce: NodeJS.Timeout | null = null

  constructor(
    readonly file: string,
    private readonly opts: JsonFileStoreOptions<T>
  ) {
    super()
    this.current = opts.defaults()
  }

  get value(): T {
    return this.current
  }

  get error(): string | null {
    return this.err
  }

  private parse(text: string): { ok: true; value: T } | { ok: false; error: string } {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
    }
    const problem = this.opts.validate(raw)
    if (problem) return { ok: false, error: problem }
    return { ok: true, value: this.opts.normalize ? this.opts.normalize(raw) : (raw as T) }
  }

  /** (Re)load from disk. Creates the file with defaults if it does not exist. */
  load(): void {
    if (!existsSync(this.file)) {
      this.write(this.opts.defaults())
      return
    }
    const text = readFileSync(this.file, 'utf8')
    this.lastText = text
    const r = this.parse(text)
    if (r.ok) {
      this.current = r.value
      this.err = null
    } else this.err = r.error
  }

  readText(): string {
    return existsSync(this.file) ? readFileSync(this.file, 'utf8') : JSON.stringify(this.current, null, 2) + '\n'
  }

  private write(value: T) {
    const text = JSON.stringify(value, null, 2) + '\n'
    this.writeText(text)
    this.current = value
    this.err = null
  }

  private writeText(text: string) {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, this.file)
    this.lastText = text
  }

  save(value: T): void {
    const problem = this.opts.validate(JSON.parse(JSON.stringify(value)))
    if (problem) throw new Error(problem)
    this.write(value)
    this.emit('change', this.current)
  }

  /** Save raw text (JSON editor). Keeps the user's formatting. */
  saveText(text: string): { ok: true } | { ok: false; error: string } {
    const r = this.parse(text)
    if (!r.ok) return r
    this.writeText(text.endsWith('\n') ? text : text + '\n')
    this.current = r.value
    this.err = null
    this.emit('change', this.current)
    return { ok: true }
  }

  watch(): void {
    if (this.watcher) return
    mkdirSync(dirname(this.file), { recursive: true })
    const name = basename(this.file)
    // watch the directory: atomic renames replace the inode, which breaks file watches
    this.watcher = watch(dirname(this.file), (_ev, f) => {
      if (f && f.toString() !== name) return
      if (this.debounce) clearTimeout(this.debounce)
      this.debounce = setTimeout(() => this.onExternalChange(), 100)
    })
  }

  private onExternalChange() {
    if (!existsSync(this.file)) return
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    if (text === this.lastText) return
    const prevErr = this.err
    this.load()
    if (this.err) {
      if (this.err !== prevErr) this.emit('error-state', this.err)
      this.emit('change', this.current)
      return
    }
    this.emit('change', this.current)
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.debounce) clearTimeout(this.debounce)
  }
}
