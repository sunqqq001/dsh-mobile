/** Framework-free feedback for a Gateway document whose application entry never renders. */
type BootFailure = 'syntax_error' | 'script_execution_failed' | 'script_load_failed' | 'promise_rejected' | 'startup_stalled'
type BootLocale = 'zh' | 'en' | 'it'

const COPY = {
  en: {
    title: 'DSH could not start',
    syntax_error: 'A page script could not be read by this web engine. This DSH client may require a newer engine.',
    script_execution_failed: 'A page script stopped before DSH could display its interface.',
    script_load_failed: 'A required page script could not be loaded. Check the connection to this computer.',
    promise_rejected: 'Page startup failed before DSH could display its interface.',
    startup_stalled: 'DSH has not displayed its interface yet. The connection may be slow, or this web engine may not support the client.',
    help: 'Update the system WebView or its browser if an update is available. You can also use this computer’s mobile access address in a supported browser. Pairings have not been removed.',
    retry: 'Reload page',
    dismiss: 'Keep waiting',
  },
  zh: {
    title: 'DSH 未能启动',
    syntax_error: '当前网页内核无法解析页面脚本。此 DSH 客户端可能需要更新的内核。',
    script_execution_failed: '页面脚本在 DSH 显示界面前停止运行。',
    script_load_failed: '必需的页面脚本加载失败，请检查与这台电脑的连接。',
    promise_rejected: '页面启动失败，DSH 尚未显示界面。',
    startup_stalled: 'DSH 尚未显示界面。连接可能较慢，当前网页内核也可能不支持此客户端。',
    help: '如有可用更新，请更新系统 WebView 或提供它的浏览器。也可在受支持的浏览器中打开这台电脑的移动访问地址。已有配对未被删除。',
    retry: '重新载入页面',
    dismiss: '继续等待',
  },
  it: {
    title: 'Impossibile avviare DSH',
    syntax_error: 'Il motore web non riesce a interpretare uno script della pagina. Questo client DSH potrebbe richiedere un motore più recente.',
    script_execution_failed: 'Uno script si è interrotto prima che DSH potesse mostrare l’interfaccia.',
    script_load_failed: 'Impossibile caricare uno script necessario. Controlla la connessione a questo computer.',
    promise_rejected: 'L’avvio della pagina non è riuscito prima che DSH potesse mostrare l’interfaccia.',
    startup_stalled: 'DSH non ha ancora mostrato l’interfaccia. La connessione potrebbe essere lenta o il motore web potrebbe non supportare il client.',
    help: 'Aggiorna WebView di sistema o il browser che lo fornisce, se è disponibile un aggiornamento. Puoi anche aprire l’indirizzo di accesso mobile di questo computer in un browser supportato. Gli abbinamenti non sono stati rimossi.',
    retry: 'Ricarica pagina',
    dismiss: 'Continua ad attendere',
  },
} satisfies Record<BootLocale, Record<BootFailure | 'title' | 'help' | 'retry' | 'dismiss', string>>

const STYLE = `
.dsh-mobile-boot-feedback{--dshm-boot-bg:#fff;--dshm-boot-text:#111827;--dshm-boot-secondary:#475569;--dshm-boot-border:#cbd5e1;box-sizing:border-box;position:fixed;z-index:1000;top:max(16px,env(safe-area-inset-top));right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));left:max(16px,env(safe-area-inset-left));width:auto;max-width:34rem;height:fit-content;max-height:calc(100vh - 32px);overflow:auto;margin:auto;padding:24px;border:1px solid var(--dsw-alias-border-l2,var(--dshm-boot-border));border-radius:16px;background:var(--dsw-alias-bg-layer-2,var(--dshm-boot-bg));color:var(--dsw-alias-label-primary,var(--dshm-boot-text));font:400 1rem/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
.dsh-mobile-boot-feedback h1{margin:0 0 16px;font-size:1.25em;line-height:1.35}.dsh-mobile-boot-feedback p{margin:0 0 16px}.dsh-mobile-boot-feedback small{display:block;margin-bottom:16px;color:var(--dsw-alias-label-secondary,var(--dshm-boot-secondary));font-size:.875em}.dsh-mobile-boot-feedback__actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.dsh-mobile-boot-feedback button{box-sizing:border-box;flex:1 1 10rem;min-width:0;min-height:48px;padding:10px 16px;border:1px solid var(--dsw-alias-border-l2,var(--dshm-boot-border));border-radius:12px;background:var(--dsw-alias-bg-layer-2,var(--dshm-boot-bg));color:inherit;font:inherit;cursor:pointer;touch-action:manipulation}.dsh-mobile-boot-feedback button:active{opacity:.7}.dsh-mobile-boot-feedback button:focus-visible{outline:3px solid var(--dsw-alias-label-primary-bluish,#2563eb);outline-offset:3px}
@media(prefers-color-scheme:dark){.dsh-mobile-boot-feedback{--dshm-boot-bg:#1e293b;--dshm-boot-text:#f8fafc;--dshm-boot-secondary:#cbd5e1;--dshm-boot-border:#64748b}}
`

/** Pick only supported languages without reading user settings or Host state. */
function locale(): BootLocale {
  for (const value of [...(navigator.languages ?? [navigator.language]), document.documentElement.lang]) {
    const language = value.toLowerCase().split(/[-_]/u)[0]
    if (language === 'en' || language === 'it' || language === 'zh') return language
  }
  return 'en'
}

/**
 * Observe early script failures only until DSH renders into its own mount point.
 * The notice never replaces application content, retries automatically, transfers
 * credentials, or reads error messages, stacks, resource URLs, or stored pairings.
 * @returns Removes this document's listeners, timer and notice.
 */
export function installMobileBootFeedback(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined'
    || document.querySelector('meta[name="dsh-mobile-gateway"][content="authenticated"]') === null
    || document.documentElement.hasAttribute('data-dsh-mobile-boot-feedback-installed')) return () => {}
  document.documentElement.setAttribute('data-dsh-mobile-boot-feedback-installed', '')
  // Browsers intentionally hide a connected script's nonce from getAttribute().
  const nonce = document.currentScript?.nonce ?? ''
  let failure: BootFailure | undefined
  let notice: HTMLElement | undefined
  let style: HTMLStyleElement | undefined
  let observer: MutationObserver | undefined
  let stopped = false
  const stop = (): void => {
    stopped = true
    window.clearTimeout(deadline)
    window.removeEventListener('error', onError, true)
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('pagehide', stop)
    document.removeEventListener('DOMContentLoaded', inspect)
    observer?.disconnect()
    notice?.remove()
    style?.remove()
  }
  const inspect = (): void => {
    if (stopped) return
    const root = document.getElementById('root')
    if (root === null || document.body === null) return
    // DSH owns its loader and error page as soon as it renders. In particular,
    // never hide [data-dsh-boot] to bypass the App's native readiness checks.
    if (root.childElementCount > 0 || root.textContent?.trim()) { stop(); return }
    if (observer === undefined) {
      observer = new MutationObserver(inspect)
      observer.observe(root, { childList: true, characterData: true, subtree: true })
    }
    if (failure === undefined || notice !== undefined) return
    const copy = COPY[locale()]
    style = document.createElement('style')
    if (nonce !== '') style.setAttribute('nonce', nonce)
    style.textContent = STYLE
    document.head.append(style)
    notice = document.createElement('section')
    notice.className = 'dsh-mobile-boot-feedback'
    notice.setAttribute('data-dsh-mobile-boot-failure', failure)
    notice.setAttribute('role', 'alert')
    notice.setAttribute('aria-labelledby', 'dsh-mobile-boot-feedback-title')
    const title = document.createElement('h1')
    title.id = 'dsh-mobile-boot-feedback-title'
    title.textContent = copy.title
    const summary = document.createElement('p')
    summary.textContent = copy[failure]
    const help = document.createElement('p')
    help.textContent = copy.help
    const code = document.createElement('small')
    code.textContent = `DSH Mobile · ${failure}`
    const actions = document.createElement('div')
    actions.className = 'dsh-mobile-boot-feedback__actions'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = copy.retry
    retry.addEventListener('click', () => { stop(); window.location.reload() })
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = copy.dismiss
    dismiss.addEventListener('click', stop)
    actions.append(retry, dismiss)
    notice.append(title, summary, actions, help, code)
    document.body.append(notice)
  }
  const record = (kind: BootFailure): void => {
    if (stopped || failure !== undefined) return
    failure = kind
    inspect()
  }
  const onError = (event: Event): void => {
    if (event.target !== null && 'tagName' in event.target && event.target.tagName === 'SCRIPT') record('script_load_failed')
    else if (event instanceof ErrorEvent) record(event.error instanceof SyntaxError ? 'syntax_error' : 'script_execution_failed')
  }
  const onRejection = (): void => { record('promise_rejected') }
  const deadline = window.setTimeout(() => { record('startup_stalled') }, 12_000)
  window.addEventListener('error', onError, true)
  window.addEventListener('unhandledrejection', onRejection)
  window.addEventListener('pagehide', stop)
  document.addEventListener('DOMContentLoaded', inspect, { once: true })
  inspect()
  return stop
}
