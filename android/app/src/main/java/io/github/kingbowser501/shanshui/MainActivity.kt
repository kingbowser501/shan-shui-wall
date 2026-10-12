package io.github.kingbowser501.shanshui

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/**
 * Full-screen kiosk that shows the painting and nothing else.
 *
 * - Keeps the screen on and hides the system bars.
 * - Recreates the WebView if its renderer ever crashes, so the frame recovers on its own.
 * - Loads the painting from the built-in wall server, so the phone remote works.
 * - Gives the page a `ShanShuiFrame` bridge so brightness sets the real backlight
 *   instead of darkening the picture.
 * - Back is ignored. Tapping the top-left corner 5 times opens a small admin menu
 *   (remote address, reload, Wi-Fi, Android settings, auto-start permission, leave).
 */
class MainActivity : Activity() {

    private var web: WebView? = null
    private val taps = ArrayList<Long>()

    private val assets by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect over USB, for troubleshooting
        showPainting()
        maybeAskForAutoStart()
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    @Deprecated("Kiosk: back does nothing")
    override fun onBackPressed() {}

    override fun onDestroy() {
        web?.destroy()
        super.onDestroy()
    }

    private fun showPainting() {
        web?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        val view = WebView(this).apply {
            setBackgroundColor(Color.rgb(0xF0, 0xE4, 0xCC))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                // Kiosk: never navigate away from the painting.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    request.url.host != "127.0.0.1" && request.url.host != "appassets.androidplatform.net"

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    // The page's renderer died (out of memory, crash). Start over instead of showing a dead view.
                    view.post { showPainting() }
                    return true
                }
            }
        }
        view.addJavascriptInterface(Bridge(), "ShanShuiFrame")
        web = view
        setContentView(view)
        view.loadUrl(Frame.startUrl(this))
    }

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
        }
    }

    // ------------------------------------------------------------ backlight

    /** Called by painting.js. Only our own pages are ever loaded (see shouldOverrideUrlLoading). */
    private inner class Bridge {
        @JavascriptInterface
        fun setBrightness(level: Double) {
            runOnUiThread { setBacklight(level) }
        }
    }

    /**
     * Sets this window's backlight level (0..1). Android applies it while the painting is
     * on screen and restores the system setting if anything else is shown. Never fully off,
     * since 0 switches some panels' backlight off entirely.
     */
    private fun setBacklight(level: Double) {
        val attrs = window.attributes
        attrs.screenBrightness = level.coerceIn(0.02, 1.0).toFloat()
        window.attributes = attrs
    }

    // ------------------------------------------------------------ admin menu

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) {
            val corner = minOf(window.decorView.width, window.decorView.height) * 0.15f
            if (ev.x < corner && ev.y < corner) {
                val now = ev.eventTime
                taps.add(now)
                taps.removeAll { now - it > 3000 }
                if (taps.size >= 5) {
                    taps.clear()
                    showAdmin()
                }
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun showAdmin() {
        val items = mutableListOf<Pair<String, () -> Unit>>(
            "Reload painting" to { showPainting() },
            "Wi-Fi settings" to { startActivity(Intent(Settings.ACTION_WIFI_SETTINGS)) },
            "Android settings" to { startActivity(Intent(Settings.ACTION_SETTINGS)) },
        )
        if (!Settings.canDrawOverlays(this)) {
            items += "Allow starting after a power cut" to { openOverlaySettings() }
        }
        items += "Choose home screen" to { startActivity(Intent(Settings.ACTION_HOME_SETTINGS)) }
        items += "Close Shan Shui" to { finishAndRemoveTask() }

        val server = Frame.server(this)
        AlertDialog.Builder(this)
            .setTitle(
                "Shan Shui ${Frame.version(this)}\n" +
                    if (server.running) "Phone remote: ${server.remoteUrl()}" else "Phone remote unavailable"
            )
            .setItems(items.map { it.first }.toTypedArray()) { _, i -> items[i].second() }
            .setNegativeButton("Back to painting", null)
            .show()
    }

    // ------------------------------------------------------------ auto-start

    /**
     * Android only lets an app open itself at boot if it may "display over other apps".
     * Ask once; the admin menu offers it again later.
     */
    private fun maybeAskForAutoStart() {
        val prefs = getSharedPreferences("frame", MODE_PRIVATE)
        if (Settings.canDrawOverlays(this) || prefs.getBoolean("asked_autostart", false)) return
        prefs.edit().putBoolean("asked_autostart", true).apply()
        AlertDialog.Builder(this)
            .setTitle("Start automatically?")
            .setMessage(
                "To come back on its own after a power cut, Shan Shui needs the " +
                    "\"Display over other apps\" permission. On the next screen, switch it on, then press Back."
            )
            .setPositiveButton("Open setting") { _, _ -> openOverlaySettings() }
            .setNegativeButton("Not now", null)
            .show()
    }

    private fun openOverlaySettings() {
        startActivity(
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
        )
    }
}
