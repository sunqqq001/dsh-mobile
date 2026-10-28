import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_VHOST_HTTP_PORT,
  FrpConfigStore,
  createFrpcToml,
  createFrpServerTemplate,
  mergeSavedFrpSettings,
  mergeSavedFrpTarget,
  parseFrpSettings,
} from '../src/frp-config.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const TOKEN = '0123456789abcdef0123456789abcdef'
const DOMAIN_INPUT = { serverAddress: 'frp.example.com', serverPort: 7000, token: TOKEN, publicOrigin: 'https://dsh.example.com' }
const IP_INPUT = { serverAddress: '1.2.3.4', serverPort: 7000, token: TOKEN, publicOrigin: 'https://1.2.3.4' }

/*
 * Byte-for-byte compatibility gate.
 *
 * Every literal below was captured by executing the upstream implementation
 * (see docs/dsh-remote/11-impl-notes.md §3) before the attach/self-signed work
 * started. Adding provisioning modes must never change a default artefact: this
 * test fails the moment one byte of frpc.toml, frps.toml, or the Caddy snippet
 * drifts, which is the whole reason `mode`, `entryTls`, `vhostHttpPort`, and
 * `publicPort` are optional and default to the upstream values.
 */
describe('FRP default artefacts stay byte-identical to upstream', () => {
  it('parses a legacy configuration without adding any field', () => {
    expect(JSON.stringify(parseFrpSettings(DOMAIN_INPUT))).toBe("{\"version\":1,\"serverAddress\":\"frp.example.com\",\"serverPort\":7000,\"token\":\"0123456789abcdef0123456789abcdef\",\"publicOrigin\":\"https://dsh.example.com\"}")
    expect(JSON.stringify(parseFrpSettings(IP_INPUT))).toBe("{\"version\":1,\"serverAddress\":\"1.2.3.4\",\"serverPort\":7000,\"token\":\"0123456789abcdef0123456789abcdef\",\"publicOrigin\":\"https://1.2.3.4\"}")
    // A saved file written by the previous version must round-trip unchanged.
    expect(JSON.stringify(parseFrpSettings(JSON.parse(JSON.stringify(parseFrpSettings(DOMAIN_INPUT))) as unknown)))
      .toBe("{\"version\":1,\"serverAddress\":\"frp.example.com\",\"serverPort\":7000,\"token\":\"0123456789abcdef0123456789abcdef\",\"publicOrigin\":\"https://dsh.example.com\"}")
  })

  it('emits the same HTTP vhost frpc.toml', () => {
    expect(createFrpcToml(parseFrpSettings(DOMAIN_INPUT), 42123)).toBe("serverAddr = \"frp.example.com\"\nserverPort = 7000\nauth.method = \"token\"\nauth.token = \"0123456789abcdef0123456789abcdef\"\ntransport.tls.enable = true\n\n[[proxies]]\nname = \"dsh-mobile\"\ntype = \"http\"\nlocalIP = \"127.0.0.1\"\nlocalPort = 42123\ncustomDomains = [\"dsh.example.com\"]\ntransport.useEncryption = true\ntransport.useCompression = true\n")
    expect(createFrpcToml(parseFrpSettings(IP_INPUT), 1)).toBe("serverAddr = \"1.2.3.4\"\nserverPort = 7000\nauth.method = \"token\"\nauth.token = \"0123456789abcdef0123456789abcdef\"\ntransport.tls.enable = true\n\n[[proxies]]\nname = \"dsh-mobile\"\ntype = \"http\"\nlocalIP = \"127.0.0.1\"\nlocalPort = 1\ncustomDomains = [\"1.2.3.4\"]\ntransport.useEncryption = true\ntransport.useCompression = true\n")
  })

  it('emits the same frps.toml, Caddy snippet, and certbot guide', () => {
    expect(createFrpServerTemplate(parseFrpSettings(DOMAIN_INPUT))).toBe("# frps.toml — save as /etc/dsh-mobile/frps.toml, then start the frps service.\nbindPort = 7000\nproxyBindAddr = \"127.0.0.1\"\nvhostHTTPPort = 7080\nauth.method = \"token\"\nauth.token = \"0123456789abcdef0123456789abcdef\"\n\n# Caddy — save the site below as /etc/caddy/dsh-mobile-dsh.caddy,\n# then make sure your Caddyfile contains exactly this line at the TOP of the file\n# (create the file with just this line if needed; globals must precede sites):\n#   import /etc/caddy/dsh-mobile-dsh.caddy\n# finally run: caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy\n# Uninstall later removes only this snippet file and the import line; your own Caddy content is kept.\n# Managed by DSH Mobile - snippet, safe to delete\ndsh.example.com {\n  reverse_proxy 127.0.0.1:7080\n}\n")
    expect(createFrpServerTemplate(parseFrpSettings(IP_INPUT))).toBe("# frps.toml — save as /etc/dsh-mobile/frps.toml, then start the frps service.\nbindPort = 7000\nproxyBindAddr = \"127.0.0.1\"\nvhostHTTPPort = 7080\nauth.method = \"token\"\nauth.token = \"0123456789abcdef0123456789abcdef\"\n\n# Caddy — save the site below as /etc/caddy/dsh-mobile-dsh.caddy,\n# then make sure your Caddyfile contains exactly this line at the TOP of the file\n# (create the file with just this line if needed; globals must precede sites):\n#   import /etc/caddy/dsh-mobile-dsh.caddy\n# finally run: caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy\n# Uninstall later removes only this snippet file and the import line; your own Caddy content is kept.\n# Managed by DSH Mobile - snippet, safe to delete\n{\n  default_sni 1.2.3.4\n}\n\nhttp://1.2.3.4 {\n  redir https://1.2.3.4{uri} permanent\n}\n\nhttps://1.2.3.4 {\n  tls /var/lib/caddy/dsh-mobile-certs/fullchain.pem /var/lib/caddy/dsh-mobile-certs/privkey.pem\n  reverse_proxy 127.0.0.1:7080\n}\n\n# Public-IPv4 manual HTTPS: Caddy cannot issue IP certificates by itself.\n# On the VPS (Ubuntu/Debian, port 80 reachable from the internet), run once as root:\n#   apt-get install -y python3-venv\n#   python3 -m venv /opt/dsh-mobile/certbot-venv\n#   /opt/dsh-mobile/certbot-venv/bin/pip install 'certbot==5.8.0'\n#   systemctl stop caddy || true\n#   /opt/dsh-mobile/certbot-venv/bin/certbot certonly --standalone --preferred-profile shortlived --ip-address 1.2.3.4 --agree-tos --register-unsafely-without-email --non-interactive --keep-until-expiring\n#   install -d -m 0750 -o caddy -g caddy /var/lib/caddy/dsh-mobile-certs\n#   install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/1.2.3.4/fullchain.pem /var/lib/caddy/dsh-mobile-certs/fullchain.pem\n#   install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/1.2.3.4/privkey.pem /var/lib/caddy/dsh-mobile-certs/privkey.pem\n#   systemctl start caddy\n# The site below already references those paths. Certificates last about 6 days: re-run certonly before expiry.\n#\n")
  })

  it('keeps the merge helpers and the exported default port unchanged', () => {
    const saved = parseFrpSettings(DOMAIN_INPUT)
    expect(JSON.stringify(mergeSavedFrpSettings({ ...DOMAIN_INPUT }, saved))).toBe("{\"version\":1,\"serverAddress\":\"frp.example.com\",\"serverPort\":7000,\"token\":\"0123456789abcdef0123456789abcdef\",\"publicOrigin\":\"https://dsh.example.com\"}")
    expect(JSON.stringify(mergeSavedFrpTarget({ serverAddress: '', serverPort: 0 }, saved))).toBe("{\"serverAddress\":\"frp.example.com\",\"serverPort\":7000}")
    expect(String(DEFAULT_VHOST_HTTP_PORT)).toBe("7080")
  })

  it('reports the same configuration status for a legacy configuration', async () => {
    // The status object must come from the real store: a hand-written literal
    // here would assert nothing and could never fail. The expected string keeps
    // the upstream field order and values; only the state directory is real, so
    // one byte of drift in `status()` now breaks this test.
    //
    // `proxyName` is the one deliberate addition: the panel rebuilds the
    // token-bearing frpc.toml in the browser (the saved token never leaves the
    // host), and it must register the same installation-derived proxy name the
    // provider writes. A store constructed without one still reports the legacy
    // fixed name, so this literal pins the default.
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-compat-'))
    temporaryDirectories.push(directory)
    const stateRoot = join(directory, 'frp')
    const store = new FrpConfigStore(stateRoot)
    await store.initialize()
    expect(JSON.stringify(store.status())).toBe(
      `{"configured":false,"vhostHttpPort":7080,"storagePath":${JSON.stringify(stateRoot)},"proxyName":"dsh-mobile"}`,
    )
    await store.configure(DOMAIN_INPUT)
    expect(JSON.stringify(store.status())).toBe(
      '{"configured":true,"serverAddress":"frp.example.com","serverPort":7000,'
      + `"publicOrigin":"https://dsh.example.com","vhostHttpPort":7080,"storagePath":${JSON.stringify(stateRoot)},"proxyName":"dsh-mobile"}`,
    )
    // A legacy file written by the previous version must round-trip byte for byte.
    expect(await readFile(store.settingsFile, 'utf8')).toBe(`${JSON.stringify(parseFrpSettings(DOMAIN_INPUT))}\n`)
    const reopened = new FrpConfigStore(stateRoot)
    await reopened.initialize()
    expect(JSON.stringify(reopened.status())).toBe(JSON.stringify(store.status()))
    await store.writeRuntimeConfig(42123)
    expect(await readFile(store.runtimeConfigFile, 'utf8')).toBe(createFrpcToml(parseFrpSettings(DOMAIN_INPUT), 42123))
  })
})
