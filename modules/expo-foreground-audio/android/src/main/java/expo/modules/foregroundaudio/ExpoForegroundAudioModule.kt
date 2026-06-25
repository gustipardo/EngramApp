package expo.modules.foregroundaudio

import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoForegroundAudioModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context not available")

  private val audioRecordManager = AudioRecordManager()
  private val audioTrackManager = AudioTrackManager()

  override fun definition() = ModuleDefinition {
    Name("ExpoForegroundAudio")

    Events("onAudioFocusChange", "onNotificationAction", "onAudioData")

    // --- Foreground service functions ---

    AsyncFunction("startService") { title: String, body: String ->
      ForegroundAudioService.moduleRef = this@ExpoForegroundAudioModule

      val intent = Intent(context, ForegroundAudioService::class.java).apply {
        action = ForegroundAudioService.ACTION_START
        putExtra(ForegroundAudioService.EXTRA_TITLE, title)
        putExtra(ForegroundAudioService.EXTRA_BODY, body)
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      Unit
    }

    AsyncFunction("stopService") {
      val intent = Intent(context, ForegroundAudioService::class.java).apply {
        action = ForegroundAudioService.ACTION_STOP
      }
      context.startService(intent)
      Unit
    }

    AsyncFunction("updateNotification") { title: String, body: String ->
      val intent = Intent(context, ForegroundAudioService::class.java).apply {
        action = ForegroundAudioService.ACTION_UPDATE
        putExtra(ForegroundAudioService.EXTRA_TITLE, title)
        putExtra(ForegroundAudioService.EXTRA_BODY, body)
      }
      context.startService(intent)
      Unit
    }

    // Trigger the transient heads-up banner. Called from JS when the app
    // goes to background mid-session — produces the WhatsApp-style 3-second
    // peek that auto-collapses to the status bar.
    AsyncFunction("triggerHeadsUp") {
      if (ForegroundAudioService.isRunning) {
        val intent = Intent(context, ForegroundAudioService::class.java).apply {
          action = ForegroundAudioService.ACTION_HEADS_UP
        }
        context.startService(intent)
      }
      Unit
    }

    Function("isServiceRunning") {
      ForegroundAudioService.isRunning
    }

    AsyncFunction("requestAudioFocus") {
      if (!ForegroundAudioService.isRunning) {
        throw IllegalStateException("Foreground service is not running")
      }
      val intent = Intent(context, ForegroundAudioService::class.java).apply {
        action = ForegroundAudioService.ACTION_REQUEST_AUDIO_FOCUS
      }
      context.startService(intent)
      Unit
    }

    AsyncFunction("abandonAudioFocus") {
      if (ForegroundAudioService.isRunning) {
        val intent = Intent(context, ForegroundAudioService::class.java).apply {
          action = ForegroundAudioService.ACTION_ABANDON_AUDIO_FOCUS
        }
        context.startService(intent)
      }
      Unit
    }

    // --- PCM mic capture ---

    AsyncFunction("startMicCapture") { sampleRate: Int ->
      audioRecordManager.start(sampleRate) { base64Data ->
        sendEvent("onAudioData", mapOf("data" to base64Data))
      }
    }

    AsyncFunction("stopMicCapture") {
      audioRecordManager.stop()
    }

    // --- PCM audio playback ---

    AsyncFunction("initAudioPlayer") { sampleRate: Int ->
      audioTrackManager.init(sampleRate)
    }

    AsyncFunction("playAudioChunk") { base64Data: String ->
      audioTrackManager.writeChunk(base64Data)
    }

    AsyncFunction("stopAudioPlayer") {
      audioTrackManager.stop()
    }

    // Flush the audio queue immediately (pause + flush + resume player).
    // Use this on Pause/End Session so the tutor stops speaking right away
    // instead of draining the buffer first.
    AsyncFunction("flushAudioPlayer") {
      audioTrackManager.flush()
    }

    // SYNCHRONOUS. Flips the AudioTrackManager `halted` flag so any
    // playAudioChunk AsyncFunction calls already queued on the dispatcher
    // early-return as no-ops. Must be sync because AsyncFunctions are
    // serialized — calling flushAudioPlayer() alone would have to wait
    // behind the queued chunks, defeating the purpose. Call this from
    // End Session / Pause BEFORE flushAudioPlayer (BUG 6).
    Function("haltAudioPlayer") { halted: Boolean ->
      audioTrackManager.setHalted(halted)
    }
  }

  fun emitAudioFocusChange(state: String) {
    sendEvent("onAudioFocusChange", mapOf("state" to state))
  }

  fun emitNotificationAction(action: String) {
    sendEvent("onNotificationAction", mapOf("action" to action))
  }
}
