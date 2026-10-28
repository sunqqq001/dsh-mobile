import { describe, expect, it } from 'vitest'
import { trustAuthenticatedGatewayConnection } from '../src/client.js'

describe('authenticated gateway client trust', () => {
  it('temporarily exposes loopback-only DSH surfaces to a paired gateway page', () => {
    const connection = { isLoopback: false }
    const restore = trustAuthenticatedGatewayConnection(connection)

    expect(connection.isLoopback).toBe(true)
    restore()
    expect(connection.isLoopback).toBe(false)
  })
})
