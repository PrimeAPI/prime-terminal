/** Keeps the most recent `limit` characters of terminal output. */
export class RingBuffer {
  private chunks: string[] = []
  private size = 0

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    if (chunk.length >= this.limit) {
      this.chunks = [chunk.slice(chunk.length - this.limit)]
      this.size = this.limit
      return
    }
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length
    }
  }

  toString(): string {
    return this.chunks.join('')
  }

  clear(): void {
    this.chunks = []
    this.size = 0
  }
}
