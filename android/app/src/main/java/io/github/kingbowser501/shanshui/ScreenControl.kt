package io.github.kingbowser501.shanshui

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log

/**
 * Turns the screen fully off for the night and back on in the morning.
 *
 * Off uses DevicePolicyManager.lockNow(), which needs Shan Shui to be a device admin
 * (force-lock only). Waking uses an alarm-clock alarm plus a screen wake lock. While
 * the screen is off, a partial wake lock keeps the CPU and Wi-Fi up so the phone
 * remote can still wake it early.
 */
object ScreenControl {
    private const val TAG = "ScreenControl"
    private var keepAwake: PowerManager.WakeLock? = null

    fun admin(context: Context) = ComponentName(context, AdminReceiver::class.java)

    fun canTurnOff(context: Context): Boolean =
        context.getSystemService(DevicePolicyManager::class.java).isAdminActive(admin(context))

    fun isOn(context: Context): Boolean = context.getSystemService(PowerManager::class.java).isInteractive

    /** Screen off now; back on at [wakeAt] (epoch ms). Returns false if not allowed. */
    fun sleepUntil(context: Context, wakeAt: Long): Boolean {
        if (!canTurnOff(context)) return false
        val app = context.applicationContext
        app.getSystemService(AlarmManager::class.java).setAlarmClock(
            AlarmManager.AlarmClockInfo(wakeAt, null),
            wakeIntent(app),
        )
        if (keepAwake == null) {
            keepAwake = app.getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ShanShui:night")
                .apply { setReferenceCounted(false); acquire() }
        }
        Log.i(TAG, "screen off until $wakeAt")
        app.getSystemService(DevicePolicyManager::class.java).lockNow()
        return true
    }

    /** Screen on and the painting in front. Safe to call when already awake. */
    fun wake(context: Context) {
        val app = context.applicationContext
        app.getSystemService(AlarmManager::class.java).cancel(wakeIntent(app))
        keepAwake?.let { if (it.isHeld) it.release() }
        keepAwake = null
        if (!isOn(app)) {
            Log.i(TAG, "waking screen")
            @Suppress("DEPRECATION") // still the only way for a normal app to switch the screen on
            app.getSystemService(PowerManager::class.java)
                .newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                    "ShanShui:morning",
                )
                .acquire(5000)
        }
        app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun wakeIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context, 0, Intent(context, WakeReceiver::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    class WakeReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = wake(context)
    }

    /** Device admin with only the force-lock policy, so the app can switch the screen off. */
    class AdminReceiver : DeviceAdminReceiver()
}
