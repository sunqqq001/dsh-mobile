/** Observe the active DSH theme's public typography consumers, without a version allowlist. */
export interface MobileTypographyCapabilities {
  readonly codeSize: boolean
  readonly textFamily: boolean
  readonly codeFamily: boolean
}

export const NO_ADVANCED_MOBILE_TYPOGRAPHY: MobileTypographyCapabilities = Object.freeze({
  codeSize: false, textFamily: false, codeFamily: false,
})

/**
 * Probe computed fonts derived from DSH's public Markdown tokens. Input values are
 * restored synchronously before painting; merely defining the input variable is not support.
 * @param document - Live page document in the current browsing context.
 * @returns Independently observed advanced typography support.
 */
export function readMobileTypographyCapabilities(document: Document): MobileTypographyCapabilities {
  const style = document.body.style
  const text = document.createElement('span')
  const code = document.createElement('span')
  for (const probe of [text, code]) {
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;contain:strict;width:0;height:0;overflow:hidden'
  }
  text.style.font = 'var(--dsw-font-markdown-base, 14px sans-serif)'
  code.style.font = 'var(--dsw-font-markdown-code-block, 11px monospace)'
  document.body.append(text, code)
  const previous = new Map<string, { value: string; priority: string }>()
  const sample = (property: string, value: string): void => {
    if (!previous.has(property)) previous.set(property, { value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) })
    style.setProperty(property, value)
  }
  try {
    sample('--dsh-code-font-size', '23px')
    const firstSize = getComputedStyle(code).fontSize
    sample('--dsh-code-font-size', '24px')
    const secondSize = getComputedStyle(code).fontSize
    sample('--dsh-font-family-text', '"dsh-mobile-text-capability-a"')
    const firstTextFamily = getComputedStyle(text).fontFamily
    sample('--dsh-font-family-text', '"dsh-mobile-text-capability-b"')
    const secondTextFamily = getComputedStyle(text).fontFamily
    sample('--dsh-font-family-code', '"dsh-mobile-code-capability-a"')
    const firstCodeFamily = getComputedStyle(code).fontFamily
    sample('--dsh-font-family-code', '"dsh-mobile-code-capability-b"')
    const secondCodeFamily = getComputedStyle(code).fontFamily
    return Object.freeze({
      codeSize: firstSize === '23px' && secondSize === '24px',
      textFamily: firstTextFamily.includes('dsh-mobile-text-capability-a') && secondTextFamily.includes('dsh-mobile-text-capability-b'),
      codeFamily: firstCodeFamily.includes('dsh-mobile-code-capability-a') && secondCodeFamily.includes('dsh-mobile-code-capability-b'),
    })
  } finally {
    for (const [property, value] of previous) {
      if (value.value === '') style.removeProperty(property)
      else style.setProperty(property, value.value, value.priority)
    }
    text.remove()
    code.remove()
  }
}
