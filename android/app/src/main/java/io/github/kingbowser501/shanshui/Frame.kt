package io.github.kingbowser501.shanshui

import android.content.Context

object Frame {
    /** The bundled painting (public/ in the repo), straight from the APK's assets, with no server. */
    const val ASSET_URL = "https://appassets.androidplatform.net/assets/index.html"

    fun server(context: Context): FrameServer = (context.applicationContext as FrameApp).server

    /** The painting via the built-in server (live remote), or the bare assets if the server couldn't start. */
    fun startUrl(context: Context): String {
        val s = server(context)
        return if (s.running) "http://127.0.0.1:${s.port}/" else ASSET_URL
    }

    fun version(context: Context): String =
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
}
