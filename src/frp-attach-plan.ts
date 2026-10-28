import {
  resolveFrpEntryTls,
  isFrpSelfSignedIngress,
  type FrpEntryTls,
  type FrpSettings,
} from './frp-config.js'
import {
  FRP_ATTACH_DISCOVERY_PATH,
  FRP_ATTACH_LOCAL_DECLARATION,
  FRP_ATTACH_SELF_SIGNED_DECLARATION,
  FRP_ATTACH_VPS_DECLARATION,
  createFrpAttachFrpcToml,
  frpAttachVpsParts,
  type FrpAttachOptions,
} from './frp-attach.js'
import { FRP_CADDY_IMPORT_LINE, FRP_CADDY_SNIPPET_PATH } from './frp-template.js'

/** Stable step identifiers; the panel maps each one to a translated title. */
export type FrpAttachStepId =
  | 'write-snippet'
  | 'add-import'
  | 'issue-ip-cert'
  | 'enable-cert-timer'
  | 'verify-https'
  | 'open-public-port'
  | 'verify-frps'
  | 'verify-entry'

/** One actionable VPS-side step; `title` is a message key, `label` the copied text. */
export interface FrpAttachPlanStep {
  readonly id: FrpAttachStepId
  readonly title: string
  readonly label: string
  readonly commands: readonly string[]
  readonly optional: boolean
  readonly verifyHint: string
}

/** The local half of the plan: the exact frpc.toml plus its self-check command. */
export interface FrpAttachPlanLocal {
  /** The frpc.toml as previewed: masked unless the caller explicitly revealed the token. */
  readonly frpcToml: string
  /** True when `frpcToml` carries the fixed placeholder instead of the shared token. */
  readonly tokenMasked: boolean
  readonly verifyCommand: string
  readonly configFile: string
  readonly declaration: string
}

/** Zero-SSH plan for attaching to an frps the user already runs. */
export interface FrpAttachPlan {
  readonly mode: 'attach'
  readonly entryTls: FrpEntryTls
  readonly vhostHttpPort?: number
  readonly publicPort?: number
  readonly local: FrpAttachPlanLocal
  readonly vps: readonly FrpAttachPlanStep[]
  readonly warnings: readonly string[]
}

const DEFAULT_PLAN_CONFIG_FILE = '<DSH Mobile 私有目录>/remote/frp/config/frpc.toml'

function planConfigFile(options: FrpAttachOptions): string {
  const file = options.configFile
  return file === undefined || file === '' ? DEFAULT_PLAN_CONFIG_FILE : file
}

/**
 * Build the copy-only attach plan. It performs no network access, no SSH, and no
 * filesystem write: the caller renders or copies the steps and the local frpc
 * configuration is written by the ordinary provider lifecycle.
 */
export function createFrpAttachPlan(settings: FrpSettings, options: FrpAttachOptions = {}): FrpAttachPlan {
  const parts = frpAttachVpsParts(settings, options)
  const configFile = planConfigFile(options)
  const localPort = options.localPort ?? 3443
  // The plan is a preview structure: it stays masked unless the panel's explicit
  // reveal action asked for the plaintext variant.
  const frpcToml = createFrpAttachFrpcToml(settings, { ...options, localPort })
  const tokenMasked = options.revealToken !== true
  const verifyCommand = `frpc verify -c "${configFile}"`
  const commonWarnings: string[] = [
    '本机探测 ≠ 公网验证：请在外部（手机流量或另一台机器）再执行一次 VPS 侧清单里的 curl 验证。',
    '插件不会安装、不会改动、不会重启你既有的 frps，也不会改动 Caddyfile 里的其他内容。',
  ]

  if (isFrpSelfSignedIngress(settings)) {
    const publicPort = parts.publicPort ?? 0
    const publicHost = parts.publicHost
    return Object.freeze({
      mode: 'attach' as const,
      entryTls: resolveFrpEntryTls(settings),
      publicPort,
      local: Object.freeze({
        frpcToml,
        tokenMasked,
        verifyCommand,
        configFile,
        declaration: FRP_ATTACH_LOCAL_DECLARATION,
      }),
      vps: Object.freeze([
        Object.freeze({
          id: 'open-public-port' as const,
          title: 'frpAttachStepOpenPort',
          label: `放行公网入口端口 ${String(publicPort)}/tcp`,
          commands: Object.freeze([`ufw allow ${String(publicPort)}/tcp`, `ufw status | grep ${String(publicPort)}`]),
          optional: false,
          verifyHint: `ufw status 中应出现 ${String(publicPort)}/tcp ALLOW；云厂商安全组也需放行同一 TCP 端口。`,
        }),
        Object.freeze({
          id: 'verify-frps' as const,
          title: 'frpAttachStepVerifyFrps',
          label: '确认既有 frps 已就绪（不改动它的配置）',
          commands: Object.freeze([
            'systemctl is-active frps || true',
            `ss -lnt | grep -E ':(${String(settings.serverPort)}|${String(publicPort)})\\b' || true`,
          ]),
          optional: false,
          verifyHint: `frps 控制端口 ${String(settings.serverPort)} 应监听；入口 ${String(publicPort)} 的 Local Address 不应是 127.0.0.1。若仅回环监听，防火墙放行也无法公网访问。`,
        }),
        Object.freeze({
          id: 'verify-entry' as const,
          title: 'frpAttachStepVerifyEntry',
          label: 'frpc 启动后端到端验证（自签证书需 -k）',
          commands: Object.freeze([
            `curl -k -sS -o /dev/null -w '%{http_code}\\n' https://${publicHost}:${String(publicPort)}${FRP_ATTACH_DISCOVERY_PATH}`,
          ]),
          optional: false,
          verifyHint: '期望输出 200；curl -k 仅验证连通性，不验证服务器身份；App 配对后会固定网关 CA。返回 000 时检查端口与转发。',
        }),
      ]),
      warnings: Object.freeze([
        ...commonWarnings,
        FRP_ATTACH_SELF_SIGNED_DECLARATION,
        '现有 frps 的 TCP 代理必须已监听公网地址；若 proxyBindAddr=127.0.0.1，单靠开放防火墙端口无法连通，请改选公网证书 + Caddy 模式。插件不会修改你的 frps。',
        '手机浏览器访问自签入口会提示证书不受信任 —— 请用 App 扫码配对；App 已固定网关 CA，不需要公开证书。',
        '切勿把网关 listenHost 改成 0.0.0.0：公网入口由 frps 的 TCP 代理提供，网关只监听 127.0.0.1。',
      ]),
    })
  }

  const vhostHttpPort = parts.vhostHttpPort ?? 0
  const publicHost = parts.publicHost
  const certGuide = parts.certGuide
  const certificateSteps: FrpAttachPlanStep[] = certGuide.length === 0 ? [] : [
    Object.freeze({
      id: 'issue-ip-cert' as const,
      title: 'frpAttachStepIssueCert',
      label: '为公网 IP 签发受信任证书（certbot）',
      commands: Object.freeze([...certGuide]),
      optional: false,
      verifyHint: `证书应落到 /etc/letsencrypt/live/${publicHost}/ 并安装到 Caddy 证书目录。`,
    }),
    Object.freeze({
      id: 'enable-cert-timer' as const,
      title: 'frpAttachStepCertTimer',
      label: '确认 certbot 续期定时器并更新 Caddy 证书文件',
      commands: Object.freeze(['systemctl list-timers certbot.timer --all || true']),
      optional: false,
      verifyHint: '公网 IP 证书有效期较短；续期后还须将新证书安装到 Caddy 并重载。',
    }),
  ]
  return Object.freeze({
    mode: 'attach' as const,
    entryTls: resolveFrpEntryTls(settings),
    vhostHttpPort,
    local: Object.freeze({
      frpcToml,
      tokenMasked,
      verifyCommand,
      configFile,
      declaration: FRP_ATTACH_LOCAL_DECLARATION,
    }),
    vps: Object.freeze([
      Object.freeze({
        id: 'write-snippet' as const,
        title: 'frpAttachStepWriteSnippet',
        label: `新增 Caddy 片段 ${FRP_CADDY_SNIPPET_PATH}`,
        commands: Object.freeze([
          `cat > ${FRP_CADDY_SNIPPET_PATH} <<'DSH_MOBILE_CADDY_SNIPPET'`,
          parts.snippet.trimEnd(),
          'DSH_MOBILE_CADDY_SNIPPET',
        ]),
        optional: false,
        verifyHint: `片段内容里的反代目标是 127.0.0.1:${String(vhostHttpPort)}，即你 frps 的 vhostHTTPPort。`,
      }),
      Object.freeze({
        id: 'add-import' as const,
        title: 'frpAttachStepAddImport',
        label: '在 Caddyfile 顶部加入 import 行并重载',
        commands: Object.freeze([
          `# 确认 /etc/caddy/Caddyfile 顶部包含：${FRP_CADDY_IMPORT_LINE}`,
          'caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy',
        ]),
        optional: false,
        verifyHint: 'caddy validate 通过且 reload 无报错；Caddyfile 中你自己原有的站点内容保持不变。',
      }),
      ...certificateSteps,
      Object.freeze({
        id: 'verify-https' as const,
        title: 'frpAttachStepVerifyHttps',
        label: '端到端验证公网 HTTPS 入口',
        commands: Object.freeze([
          `curl -sS -o /dev/null -w '%{http_code}\\n' https://${publicHost}${FRP_ATTACH_DISCOVERY_PATH}`,
        ]),
        optional: true,
        verifyHint: certGuide.length === 0
          ? '期望输出 200；证书错误时检查 DNS、80/443 端口和 Caddy 日志。'
          : '期望输出 200；证书错误时检查 certbot 证书是否安装并重载 Caddy。',
      }),
    ]),
    warnings: Object.freeze([
      ...commonWarnings,
      FRP_ATTACH_VPS_DECLARATION,
      `你 frps 的明文 vhost 必须只监听 127.0.0.1（proxyBindAddr）且 vhostHTTPPort=${String(vhostHttpPort)}；`
        + '插件启动前会探测该端口，若公网可达将直接拒绝启动。',
    ]),
  })
}
