import { Socket } from 'node:dgram'
import type { MobileAccessGateway } from '../src/gateway.js'

type Gateway = Pick<MobileAccessGateway, 'start' | 'address' | 'discoveryStatus' | 'close'>

/** Start one real gateway with an independently allocated UDP transport; advertised HTTP fields stay unchanged. */
export async function startWithMappedUdpDiscovery(gateway: Gateway): Promise<number> {
  const original = Object.getOwnPropertyDescriptor(gateway, 'discoverySocket')
  let current: unknown
  let assignments = 0
  let binds = 0
  let violation: Error | undefined
  let installed = false
  const captured: Array<{
    socket: Socket
    closed: Promise<void>
    didClose: boolean
    didListen: boolean
    closeRequested: boolean
    closeRestored: boolean
    closeDescriptor: PropertyDescriptor | undefined
    observedClose: (this: Socket, ...args: unknown[]) => Socket
    onClose: () => void
    onListen: () => void
  }> = []
  let bindOwner: Socket | undefined
  let originalBind: PropertyDescriptor | undefined
  let mappedBind: ((this: Socket, ...args: unknown[]) => Socket) | undefined
  const get = (): unknown => current
  const set = (value: unknown): void => {
    if (value !== undefined && !(value instanceof Socket)) {
      violation = new Error('Discovery socket field no longer contains a UDP Socket')
      return
    }
    current = value
    if (value === undefined) return
    const socket = value
    assignments += 1
    if (!captured.some(entry => entry.socket === socket)) {
      let closed!: () => void
      const close = socket.close
      const entry = {
        socket, closed: new Promise<void>(resolve => { closed = resolve }), didClose: false, didListen: false,
        closeRequested: false, closeRestored: false, closeDescriptor: Object.getOwnPropertyDescriptor(socket, 'close'),
        observedClose: function (this: Socket, ...args: unknown[]): Socket {
          Reflect.apply(close, this, args)
          if (this === socket) entry.closeRequested = true
          return this
        },
        onClose: () => { entry.didClose = true; closed() },
        onListen: () => { entry.didListen = true },
      }
      socket.once('close', entry.onClose)
      socket.once('listening', entry.onListen)
      Object.defineProperty(socket, 'close', { configurable: true, writable: true, enumerable: entry.closeDescriptor?.enumerable === true, value: entry.observedClose })
      captured.push(entry)
    }
    if (assignments !== 1) { violation = new Error('Mapped UDP fixture observed multiple discovery sockets'); return }
    bindOwner = socket
    originalBind = Object.getOwnPropertyDescriptor(socket, 'bind')
    const bind = socket.bind
    mappedBind = function (...args): Socket {
      if (this !== socket) { Reflect.apply(bind, this, args); return this }
      binds += 1
      if (binds !== 1 || args[0] !== gateway.address().port) {
        violation = new Error('Production discovery bind must request the advertised HTTP port exactly once')
        throw violation
      }
      Reflect.apply(bind, this, [0, ...args.slice(1)])
      return this
    }
    Object.defineProperty(socket, 'bind', { configurable: true, writable: true, enumerable: originalBind?.enumerable === true, value: mappedBind })
  }
  const restore = (): void => {
    const errors: Error[] = []
    if (bindOwner !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(bindOwner, 'bind')
      if (descriptor === undefined || descriptor.value !== mappedBind) errors.push(new Error('Discovery bind descriptor changed'))
      else if (originalBind === undefined) {
        if (!descriptor.configurable || !descriptor.writable || descriptor.enumerable !== false) errors.push(new Error('Discovery bind descriptor flags changed'))
        if (!Reflect.deleteProperty(bindOwner, 'bind')) errors.push(new Error('Discovery bind descriptor could not be restored'))
      }
      else Object.defineProperty(bindOwner, 'bind', originalBind)
      bindOwner = undefined
    }
    for (const entry of captured) {
      if (entry.closeRestored) continue
      if (Object.getOwnPropertyDescriptor(entry.socket, 'close')?.value !== entry.observedClose) errors.push(new Error('Discovery close descriptor changed'))
      else if (entry.closeDescriptor === undefined) {
        if (!Reflect.deleteProperty(entry.socket, 'close')) errors.push(new Error('Discovery close descriptor could not be restored'))
        else entry.closeRestored = true
      } else { Object.defineProperty(entry.socket, 'close', entry.closeDescriptor); entry.closeRestored = true }
    }
    if (installed) {
      const active = Object.getOwnPropertyDescriptor(gateway, 'discoverySocket')
      if (active?.get !== get || active.set !== set) errors.push(new Error('Discovery socket descriptor changed'))
      else {
        if (active.configurable !== true || active.enumerable !== original?.enumerable) errors.push(new Error('Discovery socket descriptor flags changed'))
        Object.defineProperty(gateway, 'discoverySocket', { ...original, value: current })
        installed = false
      }
    }
    if (errors.length !== 0) throw new AggregateError(errors, errors.map(error => error.message).join('; '))
  }
  const detach = (): void => {
    for (const entry of captured) {
      entry.socket.off('close', entry.onClose)
      entry.socket.off('listening', entry.onListen)
    }
  }
  try {
    if (original === undefined || !('value' in original) || original.value !== undefined || !original.configurable || !original.writable) {
      throw new Error('Mapped UDP fixture requires the unstarted discoverySocket data field')
    }
    Object.defineProperty(gateway, 'discoverySocket', { configurable: true, enumerable: original.enumerable === true, get, set })
    installed = true
    await gateway.start()
    if (violation !== undefined) throw violation
    const socket = captured[0]?.socket
    if (assignments !== 1 || binds !== 1 || socket === undefined) throw new Error('Mapped UDP fixture did not observe one discovery bind')
    const status = gateway.discoveryStatus()
    if (!status.broadcast || status.errorCode !== undefined) throw new Error(`Mapped UDP discovery failed: ${JSON.stringify(status)}`)
    if (current !== socket) throw new Error('Gateway no longer owns the captured discovery socket')
    const port = socket.address().port
    restore()
    detach()
    return port
  } catch (error) {
    const errors: unknown[] = [error]
    try { await gateway.close() } catch (closeError) { errors.push(closeError) }
    for (const entry of captured) {
      if (!entry.didClose) {
        try { if (!entry.closeRequested) entry.socket.close() } catch (closeError) {
          if (!(closeError instanceof Error && 'code' in closeError && closeError.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING' && !entry.didListen)) errors.push(closeError)
          else continue
        }
        if (entry.closeRequested) await entry.closed
      }
    }
    try { restore() } catch (restoreError) { errors.push(restoreError) }
    detach()
    if (errors.length === 1) throw error
    throw new AggregateError(errors, 'Mapped UDP fixture startup or cleanup failed')
  }
}
