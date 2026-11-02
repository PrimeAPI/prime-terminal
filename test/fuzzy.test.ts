import { describe, expect, it } from 'vitest'
import { fuzzyFilter, parseAdhocTarget } from '../src/shared/fuzzy'

describe('fuzzyFilter', () => {
  const items = ['web-01', 'web-02', 'db-primary', 'bastion', 'PowerShell 7']

  it('returns everything for an empty query', () => {
    expect(fuzzyFilter('', items, (s) => s)).toEqual(items)
  })

  it('matches subsequences and ranks contiguous/prefix matches first', () => {
    expect(fuzzyFilter('web', items, (s) => s)).toEqual(['web-01', 'web-02'])
    expect(fuzzyFilter('dbp', items, (s) => s)).toEqual(['db-primary'])
    expect(fuzzyFilter('b', items, (s) => s)[0]).toBe('bastion')
  })

  it('is case-insensitive and drops non-matches', () => {
    expect(fuzzyFilter('pow', items, (s) => s)).toEqual(['PowerShell 7'])
    expect(fuzzyFilter('xyz', items, (s) => s)).toEqual([])
  })
})

describe('parseAdhocTarget', () => {
  it('parses user@host:port', () => {
    expect(parseAdhocTarget('root@10.0.0.1:2222')).toEqual({ username: 'root', host: '10.0.0.1', port: 2222 })
  })
  it('parses host only and user@host', () => {
    expect(parseAdhocTarget('example.com')).toEqual({ host: 'example.com' })
    expect(parseAdhocTarget('me@example.com')).toEqual({ username: 'me', host: 'example.com' })
  })
  it('rejects strings that are not host-like', () => {
    expect(parseAdhocTarget('web 01')).toBeNull()
    expect(parseAdhocTarget('a@b:99999')).toBeNull()
    expect(parseAdhocTarget('')).toBeNull()
  })
})
