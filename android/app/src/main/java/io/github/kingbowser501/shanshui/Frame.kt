package io.github.kingbowser501.shanshui

import android.content.Context

object Frame {
    /** The bundled painting (public/ in the repo), served from the APK's assets. */
    const val START_URL = "https://appassets.androidplatform.net/assets/index.html"

    fun version(context: Context): String =
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
}
