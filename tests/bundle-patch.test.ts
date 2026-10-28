import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface JavaScriptExpression { readonly __jsExpr: string }

const jsExpressionType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data as string }),
})
const schema = yaml.JSON_SCHEMA.extend(jsExpressionType)
const source = readFileSync(resolve(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected mapping')
  return value as Record<string, unknown>
}

function mobileRow(): Record<string, unknown> {
  const patches = yaml.load(source, { schema }) as unknown[]
  const rows = patches.flatMap(patch => (record(patch).insert as unknown[] | undefined) ?? [patch]).map(record)
  const matches = rows.filter(row => row.id === 'mobile-access')
  if (matches.length !== 1) throw new Error('expected one mobile-access row')
  return matches[0]!
}

function rows(): Record<string, unknown>[] {
  const patches = yaml.load(source, { schema }) as unknown[]
  return patches.flatMap(patch => (record(patch).insert as unknown[] | undefined) ?? [patch]).map(record)
}

function evaluate(value: unknown): unknown {
  const expression = record(value).__jsExpr
  if (typeof expression !== 'string') throw new TypeError('expected JavaScript scalar')
  const run = Function('dshHomePath', `"use strict"; return (${expression});`) as (
    homePath: (path: string) => string,
  ) => unknown
  return run(path => `/dsh-home/${path}`)
}

describe('stock DSH bundle patch', () => {
  it('adds one ordinary dual-face plugin and no core replacement rows', () => {
    const row = mobileRow()
    expect(row).toMatchObject({ id: 'mobile-access', name: 'dsh-mobile', inject: ['webServer', 'connection'] })
    expect(source).not.toContain('pluginInventory')
    expect(source).not.toContain('requestAuth')
    expect(source).not.toMatch(/^\s*- id: connection$/mu)
  })

  it('pins the in-page computer directory browser for remote workspace selection', () => {
    expect(rows()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-auto', disabled: true }),
      expect.objectContaining({ id: 'directory-picker-mobile-host', name: '@deepseek-ai/dsh-host-directory-picker-browse' }),
      expect.objectContaining({ id: 'directory-picker-mobile-surface', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' }),
    ]))
    expect(source).not.toContain('@deepseek-ai/dsh-host-directory-picker-native')
  })

  it('starts disabled until the setup CLI writes the durable control state', () => {
    const config = record(mobileRow().config)
    expect(config.initiallyEnabled).toBe(false)
    expect(config.tls).toEqual({ mode: 'disabled' })
  })

  it('keeps generated files under DSH_HOME without assuming a local checkout path', () => {
    const config = record(mobileRow().config)
    expect(evaluate(config.setupFile)).toBe('/dsh-home/mobile-access/setup.json')
    expect(evaluate(config.stateFile)).toBe('/dsh-home/mobile-access/devices.json')
    expect(evaluate(config.controlFile)).toBe('/dsh-home/mobile-access/control.json')
    expect(evaluate(config.customCssFile)).toBe('/dsh-home/mobile-access/mobile.css')
    expect(evaluate(config.customScriptFile)).toBe('/dsh-home/mobile-access/mobile.js')
  })

  it('keeps the inert fallback listener loopback-only', () => {
    const config = record(mobileRow().config)
    expect(config.listenHost).toBe('127.0.0.1')
    expect(config.allowedCidrs).toEqual(['127.0.0.0/8'])
  })
})
