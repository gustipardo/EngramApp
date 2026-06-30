package expo.modules.foregroundaudio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import android.util.Log

class AudioTrackManager {

  companion object {
    private const val TAG = "AudioTrackManager"
  }

  private var audioTrack: AudioTrack? = null

  // Volatile so writeChunk on a coroutine worker sees the flip immediately.
  // Set true by flush()/stop() so any playAudioChunk calls already queued
  // on the Expo AsyncFunction dispatcher become no-ops instead of blocking
  // on AudioTrack.write() (which can stall for seconds when the buffer is
  // full). Without this guard, End Session / Pause has to wait for the
  // entire queued backlog to drain — user hears the tutor finish speaking
  // long after they tapped End (SESSION-FLOW.md BUG 6).
  @Volatile private var halted: Boolean = false

  /**
   * Flip the halted flag synchronously. Called from a JS sync `Function`
   * so that queued playAudioChunk AsyncFunctions can see `halted = true`
   * and early-return without waiting their turn behind the existing
   * backlog. The slower flush()/stop() then runs whenever the dispatcher
   * gets to it (the audio has already cut by then because the queued
   * chunks no-op).
   */
  fun setHalted(value: Boolean) {
    halted = value
    Log.d(TAG, "halted=$value (sync)")
  }

  fun init(sampleRate: Int) {
    stop() // Release any previous instance
    halted = false  // fresh session — re-enable writes

    // Output is STEREO even though Gemini sends mono PCM: over Bluetooth/A2DP
    // (e.g. AirPods) a CHANNEL_OUT_MONO track gets routed to a single ear.
    // writeChunk duplicates each mono sample into both L+R so the tutor is
    // heard in both ears. (On the phone speaker mono was fine; BT was not.)
    val bufferSize = AudioTrack.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_OUT_STEREO,
      AudioFormat.ENCODING_PCM_16BIT
    )

    if (bufferSize == AudioTrack.ERROR || bufferSize == AudioTrack.ERROR_BAD_VALUE) {
      Log.e(TAG, "Invalid buffer size: $bufferSize")
      return
    }

    audioTrack = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(sampleRate)
          .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
          .build()
      )
      .setBufferSizeInBytes(bufferSize * 4)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()

    audioTrack?.play()
    Log.d(TAG, "Initialized: sampleRate=$sampleRate, bufferSize=${bufferSize * 4}")
  }

  fun writeChunk(base64Data: String) {
    // Drop queued chunks once End/Pause has fired — see `halted` doc above.
    if (halted) return
    val mono = Base64.decode(base64Data, Base64.DEFAULT)
    // Up-mix mono 16-bit PCM → interleaved stereo (L=R) so both ears get audio
    // over Bluetooth. Each 2-byte sample is written twice (L then R).
    val stereo = ByteArray(mono.size * 2)
    var di = 0
    var si = 0
    while (si + 1 < mono.size) {
      val lo = mono[si]
      val hi = mono[si + 1]
      stereo[di] = lo       // L low
      stereo[di + 1] = hi   // L high
      stereo[di + 2] = lo   // R low
      stereo[di + 3] = hi   // R high
      di += 4
      si += 2
    }
    audioTrack?.write(stereo, 0, di)
  }

  /**
   * Flush the AudioTrack queue immediately without releasing the player.
   * Used for pause/end-session: silence starts immediately instead of
   * AudioTrack draining its buffer first (MODE_STREAM stop() is not instant).
   *
   * Sets `halted = true` FIRST so any playAudioChunk already queued on the
   * Expo AsyncFunction dispatcher early-returns from writeChunk instead of
   * blocking on AudioTrack.write — that's the actual fix for BUG 6's
   * "8 seconds of trailing audio" symptom.
   */
  fun flush() {
    halted = true
    try {
      audioTrack?.pause()
      audioTrack?.flush()
      audioTrack?.play() // keep player live for next session
    } catch (_: IllegalStateException) {}
    Log.d(TAG, "Flushed (halted=true)")
  }

  fun stop() {
    halted = true
    try {
      // pause+flush first so audio cuts out immediately (stop() in STREAM
      // mode plays all buffered data before halting — sounds bad on End Session)
      audioTrack?.pause()
      audioTrack?.flush()
      audioTrack?.stop()
    } catch (_: IllegalStateException) {}
    audioTrack?.release()
    audioTrack = null
    Log.d(TAG, "Stopped (halted=true)")
  }
}
