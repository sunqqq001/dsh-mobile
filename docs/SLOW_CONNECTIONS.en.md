# Slow links and repeated reconnection

[中文](SLOW_CONNECTIONS.md)

The remote page may open and `/mobile-access/health` may respond normally while DSH stays on “Reconnecting” or delays model and Workspace lists. HTTP reachability only shows that requests pass through; DSH's live data also needs a WebSocket connection to finish initialization and remain connected.

Start with the actual channel rather than treating every delay as a DSH heartbeat problem. [Cloudflare Quick Tunnels](CLOUDFLARE_TUNNEL.en.md#quick-tunnel-feature-limits) do not support SSE, so completion or online-revocation notices may be missing; an external proxy's [Backend listening](SELF_HOSTED_ORIGIN.en.md#state-and-phone-verification) only confirms its private HTTP listener; [Managed Caddy](CADDY_MANAGED.en.md#requirements) needs Tencent Cloud DNSPod validation and real public HTTPS ingress, which DNS-01 cannot create through CGNAT. Check ingress, certificates, authentication, WebSockets, and notification streams separately before lengthening timeouts.

## Identify the stage that fails

First record the DSH, DSH Mobile plugin and Android app versions. On the computer, check the current channel under **Mobile Access → Connection diagnostics**, then inspect DSH startup logs and the browser's developer tools under Network → WS and update the component involved. The plugin and app release independently; their version numbers do not need to match. Remove Tokens, Cookies, and complete pairing URLs before sharing logs.

- **WebSocket never connects**: check for `101 Switching Protocols` and errors such as `401`, `403`, `404`, or `502`. Authentication, Host/Origin checks, proxy upgrade support, paths, and version differences can all cause this. Heartbeat adjustments do not resolve these failures. Allow blocked third-party plugin paths individually in Connection diagnostics; DSH's built-in paths do not need to be added again.
- **The request gets 101 but connections keep closing**: record the interval and compare the same page and Session through LAN and remote access. If a long Session repeatedly disconnects only through the remote channel while downloads saturate the link, investigate the heartbeat and initialization deadlines below. Browser close code `1006` means an abnormal end and does not identify which layer disconnected.
- **Initialization reaches its deadline**: a console message such as `connection generation was not ready within 15000ms` means that attempt did not finish initializing in time. Check server errors, proxy interference, and incomplete data subscriptions as well as slow transfers.

Both [#126](https://github.com/saya-ch/dsh-mobile/issues/126) and [#146](https://github.com/saya-ch/dsh-mobile/issues/146) report healthy HTTP access with a reconnecting live connection. The same interface message does not establish the same cause.

### HTTP rejection diagnostics (plugin 0.6.11+)

Plugin 0.6.11 and later write limited `auth failure` HTTP diagnostics to the plugin log (`$DSH_HOME/mobile-access/logs/dsh-mobile.log`): authorization versus CSRF rejection, status, method, a safe route or route category, related Cookie/header presence and counts, normalized Origin and recognized fetch-site values. It omits tokens, Cookie values, query strings and arbitrary original paths. Each Gateway rate-limits its two categories separately: the first event is immediate and same-category rejections aggregate within a 30-second window; `suppressed` counts previously suppressed records of that category, not all requests or only the current path. This helps investigate missing credentials and CSRF failures; it does not automatically repair a 401/403. The absence of a record does not establish successful authentication: earlier Host/Origin rejections, WebSocket upgrades and native pairing/renewal are outside these two recording points. Review logs before sharing them.

## HTTP 400, 408 and 431 (in development)

The unpublished plugin correction distinguishes request receive timeouts as `408 request_timeout` and oversized headers as `431 headers_too_large`; other malformed HTTP requests remain `400 bad_request`. Older versions may return 400 with the same short JSON for all of them, so a status and a 24-byte body do not identify the cause.

New `http failure` diagnostics distinguish three per-Gateway categories: `parser` for HTTP parsing/receive failures, `target` for invalid request targets, and `upstream` for an authenticated `POST /api/session/prompt` rejected upstream. The first event of each kind is immediate; repeats aggregate for 30 seconds, with `suppressed` counting earlier suppressed events of that kind. Logs exclude raw errors, request bodies, raw packets, Cookies, Tokens, queries and arbitrary URLs. No record does not establish success.

`upstreamTimeoutMs` governs upstream transport waits and also configures the complete inbound-request receive deadline. A continuously active upload can still exceed that total deadline, and Node's periodic checks affect the observed firing time. Do not delete pairings, clear App data or automatically resend because of HTTP 400 alone. Identify the rejection layer using the actual response body, Content-Type, exact versions and redacted proxy upstream status. Check the Session result before retrying an operation whose execution outcome is unknown.

## Keep event streams distinct

In DSH 0.2.0-rc.2, `/plugins/events` is the SSE stream for plugin-module graph and build updates, not conversation-message delivery. Its `200` response, small body or repeated reconnects alone cannot establish successful delivery, failure or a missing processing animation. Inspect the `/api/remote.mux` WebSocket and the actual HTTP request for that operation as well.

An ordinary message bubble and cleared draft can precede `POST /api/session/prompt`: they are an optimistic local echo, not Host acceptance. If no corresponding request appears, retain redacted request timing, status codes and DSH logs to distinguish a request never started by the browser, proxy rejection and Host acceptance. The plugin does not automatically replay messages, approvals or other writes; check the Session before retrying an operation with an unknown outcome.

## Slow transfers can exceed the default deadlines

DSH 0.2.0-rc.2's API gateway sends a WebSocket Ping every **2 seconds** by default and ends the connection after two missed Pongs, allowing roughly **4–6 seconds** in practice. The client separately allows **15 seconds** for live-connection initialization. Large Session data, a slow uplink, or congestion can delay a Pong or the first synchronization and trigger disconnection and another synchronization.

In the deployment reported in #146, the contributor measured a Session window of about 2.18 MiB and a 2.68 Mbps uplink, and reported fewer reconnections after increasing both intervals. These are observations from that deployment. Transfer sizes and improvements depend on the Session, plugins, and network; they are not a general performance guarantee.

## Increase two existing DSH settings when needed

After confirming this slow-link case, try a **30-second heartbeat interval** and a **120-second initialization deadline**. These are settings of existing DSH plugins, not DSH Mobile's `upstreamTimeoutMs`; the latter cannot change DSH's heartbeat or client initialization deadline.

Find the enabled `@deepseek-ai/dsh-api-gateway` and `@deepseek-ai/dsh-client-connection` entries in the current profile on the computer. If your DSH version provides configuration controls for them, edit their existing configuration there. Otherwise back up and edit the current profile's `cordis.patch.yml`. CLI Web normally uses `$DSH_HOME/profiles/web/cordis.patch.yml`; official Desktop defaults to `$DSH_HOME/profiles/desktop/cordis.patch.yml`. Use the actual running profile for a custom deployment.

The following example targets the standard Web/official Desktop composition in DSH 0.2.0-rc.2, whose existing entry IDs are `typert-gateway` and `connection`. Check your entry IDs first. If an override already exists for an ID, edit its `config` instead of inserting another plugin.

```yaml
- id: typert-gateway
  config:
    websocketHeartbeatIntervalMs: 30000

- id: connection
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
    recovery:
      generationReadyTimeoutMs: 120000
```

**A patch replaces the target entry's entire `config`.** The example shows the trusted-Host expression retained by the standard composition and the two adjusted fields. Preserve any existing custom `trustedHosts`, Cookie lifetime, request size, `streamInboxBytes`, and other `recovery` settings as well. Merge the changes into the original file's top-level YAML list and preserve other entries. Do not replace the whole file with this example or edit `node_modules`.

Save and restart the current DSH instance, then reopen the phone page so it receives the new client recovery settings. If startup reports an unknown entry or unsupported field, restore the backup and check the running DSH version and configuration. Do not apply this example unchanged to another version or a custom composition.

## Check the result

Open the Session that previously reconnected and compare connection lifetime, reconnection count, and actual transfer volume. A 30-second heartbeat detects a genuinely disconnected peer more slowly; a 120-second initialization deadline also makes failed attempts wait longer. If the adjustment does not help, restore the original values and continue diagnosing instead of increasing deadlines indefinitely. Longer deadlines do not increase tunnel bandwidth or repair authentication, proxy, or server failures.

Settings and defaults were checked against DSH 0.2.0-rc.2: [API gateway configuration and heartbeat implementation](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2/packages/api/gateway/src), [client recovery settings](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/connection/src/recovery-config.ts), and [standard Web entries](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/bundle/web-app/cordis.patch.yml).

## Optional WebSocket compression

DSH Mobile 0.5.4 can compress selected live-connection paths. This suits limited bandwidth, metered links, or large Session data, trading extra CPU and memory use for reduced transfer volume. The path list is empty by default, retaining the existing uncompressed relay.

Add the following property to the existing `config` of the current `mobile-access` entry. This is a **configuration fragment, not a complete profile patch**. Keep the entry's existing interface, certificate, pairing-state, and management settings; do not replace the whole `config` with the fragment.

```yaml
websocketCompression:
  paths:
    - /api/remote.mux
```

`/api/remote.mux` is the main live-data path in the current DSH. The list selects **exact paths** for compression and does not grant access: device authentication, Host/Origin checks, and WebSocket approval must still succeed. Before adding a community plugin's path, verify and approve it in Connection diagnostics. Compression is negotiated only between the phone/browser and the Mobile gateway; the DSH side remains uncompressed. Each message uses no compression dictionary retained from previous messages. The gateway relays the real Ping/Pong frames from both ends, adds no separate heartbeat, and does not change the DSH deadlines described above.

These optional fields sit alongside `paths`; their defaults normally suffice:

| Field | Default | Purpose |
| --- | --- | --- |
| `maxMessageBytes` | `33554432` (32 MiB) | Maximum decompressed message size; exceeding it closes the connection |
| `maxQueuedBytes` | `67108864` (64 MiB) | Maximum pending data and frame headers per relay direction; must cover the message limit plus a 14-byte frame header |
| `thresholdBytes` | `1024` | Messages sent to the phone/browser below this size are not considered for compression |
| `concurrencyLimit` | `4` | Concurrent compression work; `ws` establishes this shared limit on the process's first compressed connection, so restart DSH after changing it |
| `level` | `3` | Compression level (0–9); higher values may use more CPU |

Restart DSH and reopen the phone page after a change. Developer tools can show whether the WebSocket handshake negotiated `permessage-deflate`; a client that does not negotiate it can still connect without compression. Compare actual channel transfer volume and CPU use for the same Session, rather than judging savings from the decompressed message lengths shown in developer tools. Set `paths` back to `[]` to disable it. Compression does not raise provider quotas or replace connection troubleshooting.

## Static-resource caching and repeated downloads

Gateway-generated resources use quoted ETags and process conditional GET/HEAD requests only after device authentication and resource checks. When the gateway applies streaming gzip to an upstream static resource, a valid upstream ETag can remain usable as a weak validator with `Vary: Accept-Encoding`. Identity lengths and range metadata are not reused as compressed-representation metadata. Failed responses are not cached, and API requests receive no new caching policy.

Resources without upstream validators do not automatically acquire a reliable one. Compare the same complete resource URL during ordinary navigation, reload and app cold start: inspect `200`/`304`, cache hits, `If-None-Match`, encoding and actual transfer volume. Do not clear site data first and treat the result as normal cache behavior. Improved HTTP validation does not guarantee cache reuse in every WebView, and these headers alone do not establish a complete fix for [#107](https://github.com/saya-ch/dsh-mobile/issues/107).

## Manual compaction and long-running API requests (0.6.0)

Commands such as `/compact` sent from the phone traverse the Mobile gateway's HTTP API. Automatic compaction inside DSH does not traverse that gateway request. Older gateways used the default 30-second `upstreamTimeoutMs` for every proxied request, so manual compaction could return `502 upstream_unavailable` while the model was still producing the summary. [#171](https://github.com/saya-ch/dsh-mobile/issues/171) records this case.

The gateway now separates transport waits from authenticated API response waits. `upstreamTimeoutMs` still defaults to 30000 milliseconds (1000–300000) for uploads, static assets, boot resources, and WebSocket handshakes; incoming request headers retain their existing 10-second deadline. Only `/api` and `/api/…` HTTP requests that pass device authentication, Host/Origin checks, and any required CSRF check switch to `upstreamApiTimeoutMs` after the request body is sent to DSH. The new field defaults to `0`, disabling the API response idle timeout. To set a limit, use an integer from `1` through `2147483647` milliseconds; the upper limit is Node's timer representation limit. This is not a total execution deadline: arriving response data resets the idle timer.

Add the property below to the existing `mobile-access` entry's `config` and keep all other settings. This is a configuration fragment, not a complete profile patch. `0` is the default; this example sets a 10-minute API response idle timeout:

```yaml
upstreamApiTimeoutMs: 600000
```

Save and restart DSH. Device/Session expiry, revocation, caller disconnection, and gateway shutdown still abort the proxy request. Setting `0` does not disable upload sizes, upload deadlines, connection counts, concurrent-request limits, or CSRF checks. A tunnel, reverse proxy, or model provider may still end the request sooner. This field does not change the WebSocket heartbeat or initialization settings described above.

For ordinary HTTP proxy requests, the Mobile gateway's own upstream timeout returns `504 {"error":"upstream_timeout"}` before response headers are sent; ordinary connection failures remain `502 upstream_unavailable`. Once a stream has started, the gateway can only close the connection, not send a second HTTP status. It never automatically retries API requests. A timeout or disconnect means the caller stopped waiting; it does not guarantee that DSH or the model task stopped, and it does not reverse prior side effects. Check the actual Session result before retrying an operation.
