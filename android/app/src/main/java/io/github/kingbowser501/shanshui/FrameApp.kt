package io.github.kingbowser501.shanshui

import android.app.Application

/** Starts the built-in wall server once per process, before any screen opens. */
class FrameApp : Application() {
    lateinit var server: FrameServer
        private set

    override fun onCreate() {
        super.onCreate()
        server = FrameServer(this)
        server.start()
    }
}
