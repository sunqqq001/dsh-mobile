import type { MobileControlLocale } from './client-messages.js'

/** Failures that can be reported without exposing authentication or local file contents. */
export type MobileAssetLoadFailure = 'gateway_required' | 'authentication_required' | 'manifest_unavailable' | 'manifest_invalid' | 'resource_unavailable' | 'refresh_failed'

const COPY: Record<MobileControlLocale, Record<MobileAssetLoadFailure | 'recovered', string>> = {
  en: {
    gateway_required: 'Custom mobile CSS, scripts and extensions require a paired DSH Mobile access entry. This page is not using the Mobile gateway.',
    authentication_required: 'Mobile customization was not refreshed because device authentication is unavailable. Reconnect through the current Mobile access entry.',
    manifest_unavailable: 'The mobile extension manifest is unavailable. Check the plugin version and proxy routing; legacy custom files can still load when authorized.',
    manifest_invalid: 'The mobile extension manifest is invalid. Existing customization is retained; check the plugin version and proxy routing.',
    resource_unavailable: 'A mobile customization resource could not be loaded or activated. Check the custom files and current Mobile access entry.',
    refresh_failed: 'Mobile customization could not be refreshed. Check the connection and current Mobile access entry.',
    recovered: 'Mobile customization is available again.',
  },
  it: {
    gateway_required: 'CSS, script ed estensioni mobili personalizzati richiedono un accesso DSH Mobile abbinato. Questa pagina non usa il gateway Mobile.',
    authentication_required: 'La personalizzazione mobile non è stata aggiornata perché l’autenticazione del dispositivo non è disponibile. Riconnettiti tramite l’accesso Mobile attuale.',
    manifest_unavailable: 'Il manifest delle estensioni mobili non è disponibile. Controlla la versione del plugin e le route del proxy; i file personalizzati legacy possono essere caricati se autorizzati.',
    manifest_invalid: 'Il manifest delle estensioni mobili non è valido. La personalizzazione esistente viene mantenuta; controlla la versione del plugin e le route del proxy.',
    resource_unavailable: 'Una risorsa mobile personalizzata non è stata caricata o attivata. Controlla i file personalizzati e l’accesso Mobile attuale.',
    refresh_failed: 'Impossibile aggiornare la personalizzazione mobile. Controlla la connessione e l’accesso Mobile attuale.',
    recovered: 'La personalizzazione mobile è di nuovo disponibile.',
  },
  zh: {
    gateway_required: '自定义移动样式、脚本与扩展需要通过已配对的 DSH Mobile 入口访问；当前页面不是移动网关页面。',
    authentication_required: '设备认证不可用，移动定制暂未刷新；请通过当前移动访问入口重新连接。',
    manifest_unavailable: '移动扩展清单不可用；请检查插件版本及反向代理路由。通过认证时，旧版自定义文件仍可加载。',
    manifest_invalid: '移动扩展清单无效，保留现有定制；请检查插件版本及反向代理路由。',
    resource_unavailable: '移动定制资源加载或激活失败；请检查定制文件及当前移动访问入口。',
    refresh_failed: '移动定制暂未刷新；请检查网络及当前移动访问入口。',
    recovered: '移动定制已恢复加载。',
  },
}

/** Only the authenticated Gateway owns customization APIs; the older dedicated marker remains supported. */
export function ownsMobileCustomization(gateway: boolean | undefined, frontend: string | undefined): boolean {
  return gateway === true || frontend === 'dedicated'
}

/** Emit each safe failure once until recovery, and ignore work after cancellation or disposal. */
export function createMobileAssetLoadReporter(
  locale: () => MobileControlLocale,
  output: Pick<Console, 'warn' | 'info'> = console,
): {
  fail(reason: MobileAssetLoadFailure, signal?: AbortSignal): void
  recover(signal: AbortSignal): void
  dispose(): void
} {
  const reported = new Set<MobileAssetLoadFailure>()
  let disposed = false
  return {
    fail(reason, signal) {
      if (disposed || signal?.aborted === true || reported.has(reason)) return
      if (reason === 'resource_unavailable' && reported.has('authentication_required')) return
      reported.add(reason)
      output.warn(`[DSH Mobile] ${COPY[locale()][reason]}`)
    },
    recover(signal) {
      if (disposed || signal.aborted || reported.size === 0) return
      reported.clear()
      output.info(`[DSH Mobile] ${COPY[locale()].recovered}`)
    },
    dispose() { disposed = true; reported.clear() },
  }
}

/** Read customization text within its file budget; the aggregate manifest has no existing byte cap. */
export async function readMobileAssetText(response: Response, signal: AbortSignal, maxBytes: number | undefined): Promise<string> {
  const assertActive = (): void => { if (signal.aborted) throw signal.reason ?? new DOMException('mobile customization cancelled', 'AbortError') }
  if (response.body === null) { assertActive(); return '' }
  const reader = response.body.getReader()
  let cancelled: Promise<void> | undefined
  const cancel = (): Promise<void> => cancelled ??= reader.cancel().catch((error: unknown) => {
    // A failed stream cancellation must not replace the original read or abort failure.
    void error
  })
  const aborted = (): void => { void cancel() }
  signal.addEventListener('abort', aborted, { once: true })
  let completed = false
  try {
    assertActive()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const next = await reader.read()
      assertActive()
      if (next.done) { completed = true; break }
      bytes += next.value.byteLength
      if (maxBytes !== undefined && bytes > maxBytes) throw new Error('mobile customization resource is too large')
      chunks.push(next.value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(body)
  } finally {
    signal.removeEventListener('abort', aborted)
    if (!completed) await cancel()
    reader.releaseLock()
  }
}
