package io.github.sayach.dshmobile

import java.net.HttpURLConnection
import java.net.URL

/**
 * Discovers the public IPv4 address the computer publishes.
 *
 * The computer may sit behind a dynamic ISP address, so a pairing recorded yesterday can
 * point at an address that no longer exists. Only IPv4-only endpoints are queried: a dual
 * stack name would answer with the IPv6 address, which the household port mapping does not
 * publish. Every endpoint failing yields `null`, and the caller keeps the saved origin.
 */
internal object PublicAddressProbe {
    private val IPv4 = Regex("^(?:\\d{1,3}\\.){3}\\d{1,3}$")
    private val ENDPOINTS = arrayOf(
        "https://ipv4.ident.me",
        "https://ifconfig.me/ip",
        "https://ip.sb",
    )

    /** Blocking probe; call from a background thread only. */
    fun probeIpv4(timeoutMs: Int = 4000): String? {
        for (endpoint in ENDPOINTS) {
            val value = probeOnce(endpoint, timeoutMs) ?: continue
            if (IPv4.matches(value) && isPlausible(value)) return value
        }
        return null
    }

    private fun probeOnce(endpoint: String, timeoutMs: Int): String? = try {
        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            requestMethod = "GET"
            setRequestProperty("Accept", "text/plain")
        }
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                null
            } else {
                connection.inputStream.bufferedReader().use { it.readText() }.trim()
            }
        } finally {
            connection.disconnect()
        }
    } catch (_: Exception) {
        null
    }

    /** Reject octets outside 0..255 and obviously local ranges. */
    private fun isPlausible(value: String): Boolean {
        val octets = value.split('.').map { part -> part.toIntOrNull() ?: return false }
        if (octets.size != 4 || octets.any { it !in 0..255 }) return false
        val first = octets[0]
        val second = octets[1]
        return when {
            first == 10 || first == 127 -> false
            first == 0 -> false
            first == 192 && second == 168 -> false
            first == 172 && second in 16..31 -> false
            first == 169 && second == 254 -> false
            first == 100 && second in 64..127 -> false
            else -> true
        }
    }
}
