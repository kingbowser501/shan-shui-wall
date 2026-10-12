package io.github.kingbowser501.shanshui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Opens the painting when the frame finishes booting, and again after the app is updated.
 * Android only allows this when "Display over other apps" is granted (MainActivity asks),
 * or when the frame's own auto-launch setting or home-screen choice points at this app.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
