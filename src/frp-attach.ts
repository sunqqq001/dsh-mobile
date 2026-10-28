import { isIP } from './ip.js'
import {
  createFrpcToml,
  FRP_DEFAULT_PROXY_NAME,
  isFrpSelfSignedIngress,
  resolveFrpMode,
  resolveFrpPublicPort,
  resolveFrpVhostHttpPort,
  type FrpSettings,
} from './frp-config.js'
import {
  createCaddySite,
  FRP_CADDY_IMPORT_LINE,
  FRP_CADDY_SNIPPET_MARKER,
  FRP_CADDY_SNIPPET_PATH,
  manualIpCertificateGuide,
} from './frp-template.js'

/** Default proof path used to confirm the public entry answered from this computer. */
export const FRP_ATTACH_DISCOVERY_PATH = '/mobile-access/discovery'

/** Declaration printed above the VPS half of an attach template. */
export const FRP_ATTACH_VPS_DECLARATION = '# 本模板不安装、不改动、不重启你的 frps；只新增 Caddy 片段与证书。'
  + 'frps 侧需你自行确认 vhostHTTPPort=<N> 与 proxyBindAddr="127.0.0.1"。'

/** Declaration printed above the local half of an attach template. */
export const FRP_ATTACH_LOCAL_DECLARATION = '# 本机只写入 frpc.toml 并启动 frpc：不安装、不改动本机 frps，也不改动 DSH 自身配置。'

/** Declaration for the self-signed passthrough, which keeps its CA on this computer. */
export const FRP_ATTACH_SELF_SIGNED_DECLARATION = '# 自签穿透档不使用 Caddy 或公开证书：'
  + 'frps 只做 TCP 透传，由本机 DSH 网关终止 TLS；服务端证书会在运行时续签，CA 到期需重新配对。'

/** Optional inputs for attach artefacts; every field falls back to the validated settings. */
export interface FrpAttachOptions {
  readonly vhostHttpPort?: number
  readonly publicPort?: number
  readonly certDir?: string
  /** Absolute path of the plugin-written frpc.toml, used for the `frpc verify` self-check. */
  readonly configFile?: string
  /**
   * Proxy name the previewed frpc.toml registers.
   *
   * Defaults to the legacy fixed name; the panel and the provider pass the
   * installation-derived {@link frpProxyName} so a preview never describes a
   * registration that would collide on a shared frps.
   */
  readonly proxyName?: string
  /** Loopback port the gateway will listen on; only a placeholder inside the copied runbook. */
  readonly localPort?: number
  /**
   * Explicit reveal of the shared token inside previews and clipboard copies.
   *
   * Defaults to `false`: every artefact the panel produces on its own stays
   * masked, because the copied text lands in the system clipboard. Only the
   * panel's dedicated "copy the frpc.toml with its token" action sets this, and
   * the result never reaches a stored state, a log, or localStorage.
   */
  readonly revealToken?: boolean
}

/** Fixed placeholder that replaces the shared token in every preview or copied artefact. */
export const FRP_ATTACH_TOKEN_PLACEHOLDER = '***'

/**
 * One-line notice printed above the masked frpc.toml preview.
 *
 * It states both facts a reader cannot verify from the text itself: the real
 * file is written with 0600 permissions, and an unmasked copy would survive in
 * the system clipboard.
 */
export function frpAttachTokenMaskNotice(configFile: string): string {
  return `# 预览已打码：真正的 frpc.toml 已由插件以 0600 权限写入 ${configFile}；`
    + '明文 token 不打码会随复制进入系统剪贴板，故此处只显示占位符。'
}

/** One-line notice printed above an explicitly revealed frpc.toml preview. */
export const FRP_ATTACH_TOKEN_REVEAL_NOTICE = '# 明文 token 已按你的显式操作显示：'
  + '复制后即进入系统剪贴板并长期留存，请勿粘贴到公开位置。'

/** Matches the single `auth.token` assignment of a generated frpc.toml. */
const FRPC_TOKEN_ASSIGNMENT = /^auth\.token\s*=\s*"(?:[^"\\]|\\.)*"/mu

/**
 * Replace the `auth.token` value of a rendered frpc.toml with a fixed placeholder.
 *
 * Only the preview and clipboard paths call this: the file written to disk keeps
 * the real token, because frpc has to read it. The mapping never fails open — a
 * token line that cannot be masked raises instead of leaking the secret.
 */
export function redactFrpcTomlToken(frpcToml: string): string {
  if (!/(^|\n)auth\.token/u.test(frpcToml)) return frpcToml
  const masked = frpcToml.replace(FRPC_TOKEN_ASSIGNMENT, `auth.token = "${FRP_ATTACH_TOKEN_PLACEHOLDER}"`)
  if (!masked.includes(`auth.token = "${FRP_ATTACH_TOKEN_PLACEHOLDER}"`)) throw new Error('frp_token_mask_failed')
  return masked
}

/**
 * The frpc.toml exactly as the panel displays or copies it.
 *
 * `options.revealToken` is the only way to obtain the plaintext variant; the
 * default is the masked text. `createFrpcToml` itself is untouched, so the file
 * the provider writes stays byte-for-byte identical to the upstream output.
 */
export function createFrpAttachFrpcToml(settings: FrpSettings, options: FrpAttachOptions = {}): string {
  const frpcToml = createFrpcToml(
    settings,
    attachLocalPort(options),
    options.proxyName ?? FRP_DEFAULT_PROXY_NAME,
  )
  return options.revealToken === true ? frpcToml : redactFrpcTomlToken(frpcToml)
}

/** The two separated halves of the attach artefact, plus their combined text. */
export interface FrpAttachTemplate {
  readonly mode: 'attach'
  readonly vps: string
  readonly local: string
  readonly text: string
}

const DEFAULT_ATTACH_CONFIG_FILE = '<DSH Mobile 私有目录>/remote/frp/config/frpc.toml'

function attachConfigFile(options: FrpAttachOptions): string {
  const file = options.configFile
  if (file === undefined || file === '') return DEFAULT_ATTACH_CONFIG_FILE
  return file
}

function attachLocalPort(options: FrpAttachOptions): number {
  const port = options.localPort ?? 3443
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('frp_local_port_invalid')
  return port
}

/**
 * Reject every attach request that could not be carried out safely before any
 * artefact is produced. Attach never installs frps, so it must know the user's
 * real vhost port (unless the self-signed passthrough removes the vhost entirely).
 */
export function validateAttachSettings(settings: FrpSettings, options: FrpAttachOptions = {}): void {
  if (resolveFrpMode(settings) !== 'attach') throw new Error('frp_settings_invalid')
  if (isFrpSelfSignedIngress(settings)) {
    if (settings.mode !== 'attach') throw new Error('frp_entry_tls_invalid')
    resolveFrpPublicPort(settings)
    return
  }
  const vhostHttpPort = options.vhostHttpPort ?? settings.vhostHttpPort
  if (vhostHttpPort === undefined) throw new Error('frp_attach_mode_requires_vhost_port')
  if (!Number.isSafeInteger(vhostHttpPort) || vhostHttpPort < 1 || vhostHttpPort > 65_535) {
    throw new Error('frp_settings_invalid')
  }
}

/** Strip the leading `# ` of a guide block so it can be pasted as runnable shell. */
function guideCommands(guide: string): string[] {
  return guide
    .split('\n')
    .map(line => line.replace(/^#\s?/u, '').trimEnd())
    .filter(line => line !== '')
}

/** Shared VPS-side inputs of both the copied runbook and the panel plan. */
export interface FrpAttachVpsParts {
  readonly publicHost: string
  readonly selfSigned: boolean
  readonly vhostHttpPort?: number
  readonly publicPort?: number
  readonly snippet: string
  readonly certGuide: readonly string[]
}

/**
 * Derive every VPS-side value once so the copied runbook and the panel plan can
 * never drift apart.
 */
export function frpAttachVpsParts(settings: FrpSettings, options: FrpAttachOptions = {}): FrpAttachVpsParts {
  validateAttachSettings(settings, options)
  const publicHost = new URL(settings.publicOrigin).hostname
  if (isFrpSelfSignedIngress(settings)) {
    return Object.freeze({
      publicHost,
      selfSigned: true,
      publicPort: resolveFrpPublicPort(settings),
      snippet: '',
      certGuide: Object.freeze([] as string[]),
    })
  }
  const vhostHttpPort = options.vhostHttpPort ?? resolveFrpVhostHttpPort(settings)
  const certDir = options.certDir
  const site = createCaddySite(publicHost, {
    vhostHttpPort,
    ...(certDir === undefined ? {} : { certDir }),
  })
  return Object.freeze({
    publicHost,
    selfSigned: false,
    vhostHttpPort,
    snippet: `${FRP_CADDY_SNIPPET_MARKER}\n${site.trimEnd()}\n`,
    certGuide: Object.freeze(isIP(publicHost) === 4 ? guideCommands(manualIpCertificateGuide(publicHost)) : []),
  })
}

/**
 * Build the attach artefact for an existing frps.
 *
 * The result is deliberately split in two: the VPS half contains only what the
 * user's own server needs (Caddy snippet + import + certificate guidance, or a
 * single firewall rule for the self-signed passthrough), and the local half
 * contains the generated frpc.toml plus its `frpc verify` self-check. Neither
 * half installs, rewrites, or restarts the user's frps.
 */
export function createFrpAttachTemplateParts(
  settings: FrpSettings,
  options: FrpAttachOptions = {},
): FrpAttachTemplate {
  const parts = frpAttachVpsParts(settings, options)
  const configFile = attachConfigFile(options)
  const revealed = options.revealToken === true
  const frpcToml = createFrpAttachFrpcToml(settings, options)
  const local = [
    '# ---- (b) 本机侧（在这台电脑上执行）----',
    FRP_ATTACH_LOCAL_DECLARATION,
    revealed ? FRP_ATTACH_TOKEN_REVEAL_NOTICE : frpAttachTokenMaskNotice(configFile),
    `# frpc.toml 全文（插件同样会以 0600 权限写入 ${configFile}）`,
    frpcToml.trimEnd(),
    '',
    '# 启动前自检：',
    `frpc verify -c "${configFile}"`,
    '',
  ].join('\n')

  if (parts.selfSigned) {
    const publicPort = parts.publicPort ?? resolveFrpPublicPort(settings)
    const vps = [
      '# ---- (a) VPS 侧（在你的服务器上执行，共 3 项）----',
      FRP_ATTACH_SELF_SIGNED_DECLARATION,
      '#',
      '# 1) 放行公网入口端口（就是这台电脑网关的 HTTPS 入口，TCP 透传不解密）：',
      `ufw allow ${String(publicPort)}/tcp`,
      `ufw status | grep ${String(publicPort)}`,
      '# 若使用 firewalld / 云厂商安全组，请放行同样的 TCP 端口。',
      '# 前提：现有 frps 的 TCP 代理已监听公网地址；若 proxyBindAddr=127.0.0.1，放行防火墙仍无法从公网访问。',
      '# 插件不会修改你现有的 frps；不满足此前提时请改选受信任证书入口。',
      '#',
      '# 2) 确认你既有的 frps 已就绪（无需修改它的配置）：',
      'systemctl is-active frps || true',
      `ss -lnt | grep -E ':(${String(settings.serverPort)}|${String(publicPort)})\\b' || true`,
      '#',
      '# 3) frpc 启动后，用 -k 检查连通性；此命令不验证身份，App 配对后会固定网关 CA：',
      `curl -k -sS -o /dev/null -w '%{http_code}\\n' https://${parts.publicHost}:${String(publicPort)}${FRP_ATTACH_DISCOVERY_PATH}`,
      '# 期望输出 200。',
      '',
    ].join('\n')
    return Object.freeze({
      mode: 'attach' as const,
      vps,
      local,
      text: `${vps}${local}`,
    })
  }

  const vps = [
    '# ---- (a) VPS 侧（在你的服务器上执行）----',
    FRP_ATTACH_VPS_DECLARATION,
    '#',
    `# 1) 保存 Caddy 片段到 ${FRP_CADDY_SNIPPET_PATH}（只新增这一个文件）：`,
    `cat > ${FRP_CADDY_SNIPPET_PATH} <<'DSH_MOBILE_CADDY_SNIPPET'`,
    parts.snippet.trimEnd(),
    'DSH_MOBILE_CADDY_SNIPPET',
    '#',
    '# 2) 确认 Caddyfile 顶部含下面这一行（全局块必须在前；没有则加到文件最上方）：',
    `#   ${FRP_CADDY_IMPORT_LINE}`,
    'caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy',
    '#',
    ...(parts.certGuide.length === 0
      ? ['# 3) 域名 HTTPS：确认 DNS 指向 VPS，开放 80/443；Caddy 会自动申请和续期证书。']
      : [
          '# 3) 公网 IP 的 HTTPS 证书（Caddy 不能为 IP 自动签发，故用 certbot 签发）：',
          ...parts.certGuide.map(line => `#   ${line}`),
          '#',
          '# 4) 确认证书续期任务，并在续期后将新证书安装到 Caddy：',
          'systemctl list-timers certbot.timer --all || true',
        ]),
    '#',
    '# 端到端验证（公网入口为 443，与 frps 的 vhost 端口无关）：',
    `curl -sS -o /dev/null -w '%{http_code}\\n' https://${parts.publicHost}${FRP_ATTACH_DISCOVERY_PATH}`,
    '# 期望输出 200。',
    '',
  ].join('\n')
  return Object.freeze({
    mode: 'attach' as const,
    vps,
    local,
    text: `${vps}${local}`,
  })
}

/** Combined attach artefact, ready for the clipboard. */
export function createFrpAttachTemplate(settings: FrpSettings, options: FrpAttachOptions = {}): string {
  return createFrpAttachTemplateParts(settings, options).text
}
