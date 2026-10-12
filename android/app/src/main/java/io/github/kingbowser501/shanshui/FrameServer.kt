package io.github.kingbowser501.shanshui

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * The wall server, running inside the frame: serves the painting and the phone remote
 * from the APK's assets and relays changes live over Server-Sent Events.
 *
 * This is a port of server.js with the same API, so the web pages work unchanged:
 *   GET  /api/events[?role=remote]   SSE: "state" and "reload" events
 *   GET  /api/state
 *   POST /api/state     {seed?, speed?, paused?, brightness?}
 *   POST /api/new       new random seed
 *   POST /api/position  {seed, x}   the display reports where it is, for resuming
 *   POST /api/reload    tells displays to reload
 */
class FrameServer(private val context: Context, val port: Int = 8080) {

    private class Client(val out: OutputStream, val display: Boolean)

    private val stateFile = File(context.filesDir, "state.json")
    private val clients = CopyOnWriteArrayList<Client>()
    private val pool = Executors.newCachedThreadPool()
    private val timer = Executors.newSingleThreadScheduledExecutor()
    private var socket: ServerSocket? = null

    private val lock = Any()
    private var seed = newSeed()
    private var speed = 6.0
    private var paused = false
    private var brightness = 1.0
    private var position = 0.0

    /** Called with the new brightness (0..1) whenever the remote changes it. */
    var onBrightness: ((Double) -> Unit)? = null

    val running get() = socket != null

    fun start(): Boolean {
        load()
        return try {
            val s = ServerSocket(port, 50, InetAddress.getByName("0.0.0.0"))
            s.reuseAddress = true
            socket = s
            pool.execute { acceptLoop(s) }
            timer.scheduleWithFixedDelay({ ping() }, 25, 25, TimeUnit.SECONDS)
            Log.i(TAG, "listening on $port; remote at ${remoteUrl()}")
            true
        } catch (e: Exception) {
            Log.e(TAG, "could not start on port $port", e)
            false
        }
    }

    fun brightness(): Double = synchronized(lock) { brightness }

    fun remoteUrl(): String = "http://${lanAddress() ?: "localhost"}:$port/remote"

    // ------------------------------------------------------------------ state

    private fun newSeed(): String {
        val chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        return (1..8).map { chars[Random.nextInt(chars.length)] }.joinToString("")
    }

    private fun load() {
        try {
            val j = JSONObject(stateFile.readText())
            synchronized(lock) {
                seed = j.optString("seed", seed).ifBlank { seed }
                speed = j.optDouble("speed", speed)
                paused = j.optBoolean("paused", paused)
                brightness = j.optDouble("brightness", brightness)
                position = j.optDouble("position", position)
            }
        } catch (_: Exception) {
            // first run, or unreadable: keep defaults
        }
    }

    private fun save() {
        val j = synchronized(lock) { stateJson(false) }
        val tmp = File(stateFile.path + ".tmp")
        tmp.writeText(j.toString(2))
        tmp.renameTo(stateFile)
    }

    private fun stateJson(public: Boolean): JSONObject = JSONObject().apply {
        put("seed", seed)
        put("speed", speed)
        put("paused", paused)
        put("brightness", brightness)
        put("position", position)
        if (public) {
            put("displays", clients.count { it.display })
            put("remoteUrl", remoteUrl())
        }
    }

    private fun update(patch: JSONObject) {
        var newBrightness: Double? = null
        synchronized(lock) {
            if (patch.has("paused")) paused = patch.optBoolean("paused")
            val s = patch.optString("seed", "").trim()
            if (s.isNotEmpty()) {
                seed = s.take(64)
                position = 0.0
            }
            patch.optDouble("speed").takeIf { !it.isNaN() }?.let { speed = it.coerceIn(0.0, 60.0) }
            patch.optDouble("brightness").takeIf { !it.isNaN() }?.let {
                brightness = it.coerceIn(0.0, 1.0)
                newBrightness = brightness
            }
        }
        save()
        broadcast("state")
        newBrightness?.let { b -> onBrightness?.invoke(b) }
    }

    // ------------------------------------------------------------------ http

    private fun acceptLoop(server: ServerSocket) {
        while (!server.isClosed) {
            val s = try { server.accept() } catch (_: Exception) { break }
            pool.execute { handle(s) }
        }
    }

    private fun handle(s: Socket) {
        var keep = false
        try {
            s.soTimeout = 15000
            val input = BufferedInputStream(s.getInputStream())
            val out = s.getOutputStream()
            val requestLine = readLine(input) ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0]
            val target = parts[1]
            val headers = HashMap<String, String>()
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val i = line.indexOf(':')
                if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
            }
            val path = target.substringBefore('?')
            val query = target.substringAfter('?', "")

            when ("$method $path") {
                "GET /api/events" -> {
                    keep = true
                    s.soTimeout = 0
                    out.write(
                        ("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n" +
                            "Cache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n").toByteArray()
                    )
                    val display = !query.split('&').contains("role=remote")
                    val c = Client(out, display)
                    send(c, "state", synchronized(lock) { stateJson(true) }.toString())
                    clients.add(c)
                    if (display) broadcast("state") // remotes see the display come online
                }
                "GET /api/state" -> respond(out, 200, "application/json", synchronized(lock) { stateJson(true) }.toString().toByteArray())
                "POST /api/state" -> {
                    update(readJson(input, headers))
                    respond(out, 204)
                }
                "POST /api/new" -> {
                    update(JSONObject().put("seed", newSeed()))
                    respond(out, 204)
                }
                "POST /api/position" -> {
                    val j = readJson(input, headers)
                    val x = j.optDouble("x")
                    synchronized(lock) {
                        if (j.optString("seed") == seed && !x.isNaN()) position = x
                    }
                    save()
                    respond(out, 204)
                }
                "POST /api/reload" -> {
                    broadcast("reload")
                    respond(out, 204)
                }
                else -> if (method == "GET") serveAsset(out, path) else respond(out, 405)
            }
        } catch (e: Exception) {
            Log.w(TAG, "request failed: ${e.message}")
        } finally {
            if (!keep) try { s.close() } catch (_: Exception) {}
        }
    }

    private fun serveAsset(out: OutputStream, path: String) {
        val name = when (path) {
            "/" -> "index.html"
            "/remote" -> "remote.html"
            else -> path.removePrefix("/")
        }
        if (name.contains("..") || name.isEmpty()) return respond(out, 403)
        val bytes = try {
            context.assets.open(name).use { it.readBytes() }
        } catch (_: Exception) {
            return respond(out, 404, "text/plain", "not found".toByteArray())
        }
        respond(out, 200, TYPES[name.substringAfterLast('.', "")] ?: "application/octet-stream", bytes)
    }

    private fun respond(out: OutputStream, code: Int, type: String? = null, body: ByteArray = ByteArray(0)) {
        val reason = when (code) { 200 -> "OK"; 204 -> "No Content"; 403 -> "Forbidden"; 404 -> "Not Found"; else -> "Method Not Allowed" }
        val head = StringBuilder("HTTP/1.1 $code $reason\r\n")
        if (type != null) head.append("Content-Type: $type\r\n")
        head.append("Content-Length: ${body.size}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n")
        out.write(head.toString().toByteArray())
        out.write(body)
        out.flush()
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) return if (buf.size() == 0) null else buf.toString("UTF-8")
            if (b == '\n'.code) return buf.toString("UTF-8").trimEnd('\r')
            buf.write(b)
            if (buf.size() > 8192) return null
        }
    }

    private fun readJson(input: InputStream, headers: Map<String, String>): JSONObject {
        val n = headers["content-length"]?.toIntOrNull()?.coerceIn(0, 10000) ?: 0
        val body = ByteArray(n)
        var read = 0
        while (read < n) {
            val r = input.read(body, read, n - read)
            if (r < 0) break
            read += r
        }
        return try { JSONObject(String(body, 0, read)) } catch (_: Exception) { JSONObject() }
    }

    // ------------------------------------------------------------------ events

    private fun send(c: Client, event: String, data: String): Boolean = try {
        synchronized(c) {
            c.out.write("event: $event\ndata: $data\n\n".toByteArray())
            c.out.flush()
        }
        true
    } catch (_: Exception) {
        false
    }

    private fun broadcast(event: String) {
        val data = if (event == "state") synchronized(lock) { stateJson(true) }.toString() else "{}"
        val dead = clients.filter { !send(it, event, data) }
        if (dead.isNotEmpty()) {
            clients.removeAll(dead.toSet())
            if (dead.any { it.display }) broadcast("state")
        }
    }

    private fun ping() {
        val dead = clients.filter {
            try {
                synchronized(it) { it.out.write(": ping\n\n".toByteArray()); it.out.flush() }
                false
            } catch (_: Exception) {
                true
            }
        }
        if (dead.isNotEmpty()) {
            clients.removeAll(dead.toSet())
            broadcast("state")
        }
    }

    // ------------------------------------------------------------------ network

    private fun lanAddress(): String? = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .sortedBy { if (it.name.startsWith("wlan") || it.name.startsWith("eth")) 0 else 1 }
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
            ?.hostAddress
    } catch (_: Exception) {
        null
    }

    companion object {
        private const val TAG = "FrameServer"
        private val TYPES = mapOf(
            "html" to "text/html; charset=utf-8",
            "js" to "text/javascript; charset=utf-8",
            "css" to "text/css; charset=utf-8",
            "json" to "application/json",
            "svg" to "image/svg+xml",
            "png" to "image/png",
        )
    }
}
