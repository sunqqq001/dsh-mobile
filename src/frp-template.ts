/** Loopback-only HTTP vhost port used between Caddy and frps. */
export const FRP_VHOST_HTTP_PORT = 7080

/** Caddy snippet owned entirely by DSH Mobile; the main Caddyfile only imports it. */
export const FRP_CADDY_SNIPPET_PATH = '/etc/caddy/dsh-mobile-dsh.caddy'

/** First line of the owned snippet; also the legacy whole-file marker. */
export const FRP_CADDY_SNIPPET_MARKER = '# Managed by DSH Mobile - snippet, safe to delete'

/** Exact line the main Caddyfile must contain (uncommented) for the site to load. */
export const FRP_CADDY_IMPORT_LINE = `import ${FRP_CADDY_SNIPPET_PATH}`

/** Directory holding the public-IPv4 certificates installed by certbot. */
export const FRP_CADDY_IP_CERT_DIR = '/var/lib/caddy/dsh-mobile-certs'

/**
 * Entry TLS mode for the FRP channel.
 *
 * - `public-ip-cert` (default): the VPS Caddy terminates TLS with a public-CA
 *   certificate and reverse-proxies the plaintext vhost to frps.
 * - `self-signed`: no Caddy and no public certificate at all. frps publishes a
 *   raw TCP proxy and the DSH gateway terminates TLS itself with a leaf signed
 *   by its own pairing CA, which the Android app pins through `ca.cer`.
 */
export type FrpEntryTls = 'public-ip-cert' | 'self-signed'

/** Optional overrides for the generated Caddy site; every field defaults to the upstream value. */
export interface CaddySiteOptions {
  readonly certDir?: string
  /**
   * The user's real `vhostHTTPPort`. `attach` mode must never assume the
   * upstream 7080: a wrong port silently disables the plaintext-exposure gate.
   */
  readonly vhostHttpPort?: number
  /** `self-signed` is a TCP passthrough and never produces a Caddy site. */
  readonly entryTls?: FrpEntryTls
}

function publicIpv4Address(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^(?:0|[1-9][0-9]{0,2})$/u.test(part)
    && Number(part) <= 255)
}

function publicDnsHostname(value: string): boolean {
  return value.length <= 253 && value.includes('.') && !/^[0-9.]+$/u.test(value)
    && !value.includes(':') && value.split('.').every(label => label.length >= 1 && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
}

function parsePublicOrigin(publicOrigin: string): string {
  let url: URL
  try { url = new URL(publicOrigin) } catch { throw new Error('frp_template_input_invalid') }
  if (url.protocol !== 'https:' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || url.username !== '' || url.password !== '' || (!publicIpv4Address(url.hostname) && !publicDnsHostname(url.hostname))) {
    throw new Error('frp_template_input_invalid')
  }
  return url.hostname
}

function resolveVhostHttpPort(options: CaddySiteOptions): number {
  const port = options.vhostHttpPort ?? FRP_VHOST_HTTP_PORT
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('frp_template_input_invalid')
  return port
}

/**
 * A self-signed entry deliberately never reaches Caddy: the tunnel is a raw TCP
 * passthrough and the DSH gateway is the TLS endpoint. Refuse loudly instead of
 * emitting a Caddy site that would need the gateway's private CA on the VPS.
 */
function rejectSelfSignedCaddySite(options: CaddySiteOptions): void {
  if (options.entryTls === 'self-signed') throw new Error('frp_entry_tls_invalid')
}

/**
 * Build the Caddy site for one public host (without markers or import wiring).
 *
 * The second parameter accepts either a bare certificate directory (the legacy
 * signature) or a full {@link CaddySiteOptions} object, so existing callers keep
 * working unchanged.
 */
export function createCaddySite(publicHost: string, options: CaddySiteOptions | string = {}): string {
  const resolved: CaddySiteOptions = typeof options === 'string' ? { certDir: options } : options
  rejectSelfSignedCaddySite(resolved)
  const certDir = resolved.certDir ?? FRP_CADDY_IP_CERT_DIR
  const vhostHttpPort = resolveVhostHttpPort(resolved)
  if (publicIpv4Address(publicHost)) {
    return [
      '{',
      `  default_sni ${publicHost}`,
      '}',
      '',
      `http://${publicHost} {`,
      `  redir https://${publicHost}{uri} permanent`,
      '}',
      '',
      `https://${publicHost} {`,
      `  tls ${certDir}/fullchain.pem ${certDir}/privkey.pem`,
      `  reverse_proxy 127.0.0.1:${String(vhostHttpPort)}`,
      '}',
      '',
    ].join('\n')
  }
  if (!publicDnsHostname(publicHost)) throw new Error('frp_template_input_invalid')
  return [
    `${publicHost} {`,
    `  reverse_proxy 127.0.0.1:${String(vhostHttpPort)}`,
    '}',
    '',
  ].join('\n')
}

/** Manual certbot steps for a public-IPv4 origin (Caddy cannot issue IP certificates itself). */
export function manualIpCertificateGuide(publicHost: string): string {
  return [
    '# Public-IPv4 manual HTTPS: Caddy cannot issue IP certificates by itself.',
    '# On the VPS (Ubuntu/Debian, port 80 reachable from the internet), run once as root:',
    '#   apt-get install -y python3-venv',
    '#   python3 -m venv /opt/dsh-mobile/certbot-venv',
    "#   /opt/dsh-mobile/certbot-venv/bin/pip install 'certbot==5.8.0'",
    '#   systemctl stop caddy || true',
    `#   /opt/dsh-mobile/certbot-venv/bin/certbot certonly --standalone --preferred-profile shortlived --ip-address ${publicHost} --agree-tos --register-unsafely-without-email --non-interactive --keep-until-expiring`,
    '#   install -d -m 0750 -o caddy -g caddy /var/lib/caddy/dsh-mobile-certs',
    `#   install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/fullchain.pem /var/lib/caddy/dsh-mobile-certs/fullchain.pem`,
    `#   install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/privkey.pem /var/lib/caddy/dsh-mobile-certs/privkey.pem`,
    '#   systemctl start caddy',
    '# The site below already references those paths. Certificates last about 6 days: re-run certonly before expiry.',
    '#',
  ].join('\n')
}

/**
 * Build the only supported frps config and Caddy snippet from validated user inputs.
 *
 * Default `options` reproduce the upstream artefact byte for byte; `attach` mode
 * passes the user's real vhost port, and `self-signed` is rejected because that
 * mode publishes a raw TCP proxy instead of an HTTP vhost.
 */
export function createRestrictedFrpServerTemplate(
  serverPort: number,
  token: string,
  publicOrigin: string,
  options: CaddySiteOptions = {},
): string {
  if (!Number.isSafeInteger(serverPort) || serverPort < 1 || serverPort > 65_535
    || token.length < 16 || token.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error('frp_template_input_invalid')
  }
  rejectSelfSignedCaddySite(options)
  const vhostHttpPort = resolveVhostHttpPort(options)
  const certDir = options.certDir ?? FRP_CADDY_IP_CERT_DIR
  const publicHost = parsePublicOrigin(publicOrigin)
  const lines = [
    '# frps.toml — save as /etc/dsh-mobile/frps.toml, then start the frps service.',
    `bindPort = ${String(serverPort)}`,
    'proxyBindAddr = "127.0.0.1"',
    `vhostHTTPPort = ${String(vhostHttpPort)}`,
    'auth.method = "token"',
    `auth.token = ${JSON.stringify(token)}`,
    '',
    `# Caddy — save the site below as ${FRP_CADDY_SNIPPET_PATH},`,
    '# then make sure your Caddyfile contains exactly this line at the TOP of the file',
    '# (create the file with just this line if needed; globals must precede sites):',
    `#   ${FRP_CADDY_IMPORT_LINE}`,
    '# finally run: caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy',
    '# Uninstall later removes only this snippet file and the import line; your own Caddy content is kept.',
    `${FRP_CADDY_SNIPPET_MARKER}`,
    createCaddySite(publicHost, { certDir, vhostHttpPort }).trimEnd(),
    '',
  ]
  if (publicIpv4Address(publicHost)) lines.push(manualIpCertificateGuide(publicHost), '')
  return lines.join('\n')
}