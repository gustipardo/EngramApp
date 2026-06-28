package expo.modules.ankidroid

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AnkiDroidModule : Module() {
  companion object {
    const val TAG = "AnkiDroidModule"
    const val ANKIDROID_PACKAGE = "com.ichi2.anki"
    const val ANKIDROID_PERMISSION = "com.ichi2.anki.permission.READ_WRITE_DATABASE"
    private const val PERMISSION_REQUEST_CODE = 42

    // ContentProvider URIs
    const val AUTHORITY = "com.ichi2.anki.flashcards"
    val DECKS_URI: Uri = Uri.parse("content://$AUTHORITY/decks")
    val SELECTED_DECK_URI: Uri = Uri.parse("content://$AUTHORITY/selected_deck")
    val NOTES_URI: Uri = Uri.parse("content://$AUTHORITY/notes")
    val CARDS_URI: Uri = Uri.parse("content://$AUTHORITY/cards")
    val SCHEDULE_URI: Uri = Uri.parse("content://$AUTHORITY/schedule")
    // Column names for decks
    const val DECK_ID = "deck_id"
    const val DECK_NAME = "deck_name"
    const val DECK_COUNTS = "deck_count"

    // Column names for notes
    const val NOTE_FLDS = "flds"

    // Column names for schedule (review answers).
    // Verified against AnkiDroid 2.23.3 FlashCardsContract.ReviewInfo —
    // historic guesses ("card_ord", "ease") silently fail because
    // AnkiDroid's update parser uses these EXACT strings in its `when` block.
    const val REVIEW_NOTE_ID = "note_id"
    const val REVIEW_CARD_ORD = "ord"
    const val REVIEW_EASE = "answer_ease"
    const val REVIEW_TIME_TAKEN = "time_taken"

    // Broadcast actions
    const val ACTION_SYNC = "com.ichi2.anki.DO_SYNC"
  }

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context is not available")

  private val contentResolver: ContentResolver
    get() = context.contentResolver

  override fun definition() = ModuleDefinition {
    Name("AnkiDroid")

    // Check if AnkiDroid is installed on the device
    AsyncFunction("isInstalled") { promise: Promise ->
      try {
        val packageManager = context.packageManager
        packageManager.getPackageInfo(ANKIDROID_PACKAGE, PackageManager.GET_ACTIVITIES)
        promise.resolve(true)
      } catch (e: PackageManager.NameNotFoundException) {
        promise.resolve(false)
      } catch (e: Exception) {
        promise.reject("CHECK_FAILED", "Failed to check AnkiDroid installation: ${e.message}", e)
      }
    }

    // Check if AnkiDroid API permission is granted
    AsyncFunction("hasApiPermission") { promise: Promise ->
      try {
        val result = ContextCompat.checkSelfPermission(context, ANKIDROID_PERMISSION)
        promise.resolve(result == PackageManager.PERMISSION_GRANTED)
      } catch (e: Exception) {
        promise.resolve(false)
      }
    }

    // Request AnkiDroid API permission via Android's system permission dialog.
    // Returns true when the dialog was shown (AppState listener re-checks on return).
    // Returns false when Android has permanently blocked the dialog ("never ask again")
    // — the JS side should show an "Open Settings" fallback in that case.
    AsyncFunction("requestApiPermission") { promise: Promise ->
      try {
        val activity = appContext.currentActivity
        if (activity == null) {
          promise.reject("NO_ACTIVITY", "No current activity available", null)
          return@AsyncFunction
        }

        val alreadyGranted = ContextCompat.checkSelfPermission(context, ANKIDROID_PERMISSION) == PackageManager.PERMISSION_GRANTED
        if (alreadyGranted) {
          promise.resolve(true)
          return@AsyncFunction
        }

        // Track whether we have ever asked. SharedPreferences lives in the app
        // data dir and is wiped by `pm clear`, matching the permission reset.
        val prefs = context.getSharedPreferences("engram_permissions", Context.MODE_PRIVATE)
        val hasAskedBefore = prefs.getBoolean("asked_ankidroid_permission", false)
        val shouldShow = ActivityCompat.shouldShowRequestPermissionRationale(activity, ANKIDROID_PERMISSION)

        // shouldShowRationale == false AND we have asked before → USER_FIXED
        // ("never ask again"). The dialog will be silently suppressed — tell JS
        // to show the Settings fallback instead.
        if (!shouldShow && hasAskedBefore) {
          promise.resolve(false)
          return@AsyncFunction
        }

        prefs.edit().putBoolean("asked_ankidroid_permission", true).apply()
        ActivityCompat.requestPermissions(activity, arrayOf(ANKIDROID_PERMISSION), PERMISSION_REQUEST_CODE)
        promise.resolve(true)
      } catch (e: Exception) {
        promise.reject("REQUEST_FAILED", "Failed to request permission: ${e.message}", e)
      }
    }

    // Get list of deck names from AnkiDroid
    AsyncFunction("getDeckNames") { promise: Promise ->
      try {
        val hasPermission = ContextCompat.checkSelfPermission(context, ANKIDROID_PERMISSION) == PackageManager.PERMISSION_GRANTED
        if (!hasPermission) {
          promise.reject("PERMISSION_DENIED", "AnkiDroid API permission not granted", null)
          return@AsyncFunction
        }

        val deckNames = mutableListOf<String>()
        var cursor: Cursor? = null

        try {
          cursor = contentResolver.query(DECKS_URI, arrayOf(DECK_NAME), null, null, null)
          cursor?.let {
            val nameIndex = it.getColumnIndex(DECK_NAME)
            while (it.moveToNext()) {
              val name = it.getString(nameIndex)
              if (name != null && !name.startsWith("Default::")) {
                deckNames.add(name)
              }
            }
          }
        } finally {
          cursor?.close()
        }

        promise.resolve(deckNames)
      } catch (e: SecurityException) {
        promise.reject("PERMISSION_DENIED", "Permission denied when accessing AnkiDroid: ${e.message}", e)
      } catch (e: Exception) {
        promise.reject("QUERY_FAILED", "Failed to get deck names: ${e.message}", e)
      }
    }

    // Returns deck info (name + due count) in a single query, avoiding N getDueCards calls
    AsyncFunction("getDeckInfo") { promise: Promise ->
      try {
        val hasPermission = ContextCompat.checkSelfPermission(context, ANKIDROID_PERMISSION) == PackageManager.PERMISSION_GRANTED
        if (!hasPermission) {
          promise.reject("PERMISSION_DENIED", "AnkiDroid API permission not granted", null)
          return@AsyncFunction
        }

        val decks = mutableListOf<Map<String, Any>>()
        var cursor: Cursor? = null

        try {
          cursor = contentResolver.query(
            DECKS_URI,
            arrayOf(DECK_NAME, DECK_COUNTS),
            null, null, null
          )
          cursor?.let {
            Log.d(TAG, "getDeckInfo columns: ${it.columnNames.joinToString()}")
            val nameIdx = it.getColumnIndex(DECK_NAME)
            val countsIdx = it.getColumnIndex(DECK_COUNTS)
            while (it.moveToNext()) {
              val name = if (nameIdx >= 0) it.getString(nameIdx) else null
              if (name == null || name.startsWith("Default::")) continue

              val countsRaw = if (countsIdx >= 0) it.getString(countsIdx) else null
              val counts = parseDeckCountsSeparate(countsRaw)

              decks.add(mapOf(
                "deckName" to name,
                "dueCount" to (counts.new + counts.learn + counts.review),
                "newCount" to counts.new,
                "learnCount" to counts.learn,
                "reviewCount" to counts.review
              ))
            }
          }
        } finally {
          cursor?.close()
        }

        promise.resolve(decks)
      } catch (e: SecurityException) {
        promise.reject("PERMISSION_DENIED", "Permission denied when accessing AnkiDroid: ${e.message}", e)
      } catch (e: Exception) {
        promise.reject("QUERY_FAILED", "Failed to get deck info: ${e.message}", e)
      }
    }

    // Get cards that are actually DUE for review in a specific deck.
    //
    // The actual query logic lives in `AnkiDroidQueries.queryDueCards` so
    // it can be unit-tested from `androidTest/` without the Expo Module
    // runtime. This wrapper just handles permission gating + Promise
    // adapter + exception → reject mapping.
    AsyncFunction("getDueCards") { deckName: String, promise: Promise ->
      try {
        val hasPermission = ContextCompat.checkSelfPermission(context, ANKIDROID_PERMISSION) == PackageManager.PERMISSION_GRANTED
        if (!hasPermission) {
          promise.reject("PERMISSION_DENIED", "AnkiDroid API permission not granted", null)
          return@AsyncFunction
        }

        val cards = queryDueCards(contentResolver, deckName)
        promise.resolve(cards)
      } catch (e: IllegalArgumentException) {
        promise.reject("DECK_NOT_FOUND", e.message ?: "Deck not found", e)
      } catch (e: SecurityException) {
        promise.reject("PERMISSION_DENIED", "Permission denied when accessing AnkiDroid: ${e.message}", e)
      } catch (e: Exception) {
        promise.reject("QUERY_FAILED", "Failed to get due cards for deck '$deckName': ${e.message}", e)
      }
    }

    // Answer a card (write-back to AnkiDroid scheduling).
    // Caller MUST pass the exact `cardOrd` returned by the schedule cursor
    // for this card. AnkiDroid's update(SCHEDULE_URI) needs (note_id, card_ord)
    // to match a card it has just queued for review — using a stale or
    // enumerated ord causes update to silently return 0 rows.
    //
    // `deckName` is required because AnkiDroid 2.23+ scopes the "currently
    // being reviewed" queue to the globally-selected deck. We re-set the
    // selected deck before update for safety (it may have drifted since the
    // last query if the user navigated within AnkiDroid, etc.).
    //
    // ease: 1=Again, 2=Hard, 3=Good, 4=Easy. The app uses pass/fail (1 or 4 only).
    AsyncFunction("answerCard") { deckName: String, noteId: Long, cardOrd: Int, ease: Int, timeTakenMs: Long, promise: Promise ->
      try {
        val hasPermission = ContextCompat.checkSelfPermission(context, ANKIDROID_PERMISSION) == PackageManager.PERMISSION_GRANTED
        if (!hasPermission) {
          promise.reject("PERMISSION_DENIED", "AnkiDroid API permission not granted", null)
          return@AsyncFunction
        }
        if (ease !in 1..4) {
          promise.reject("INVALID_EASE", "ease must be in 1..4 (got $ease)", null)
          return@AsyncFunction
        }

        // Make sure AnkiDroid's scheduler is pointed at our deck. The
        // schedule URI's update is queue-scoped; without this the update
        // silently returns 0 rows even with a valid (note_id, card_ord).
        val deckId = getDeckId(deckName)
        if (deckId != 0L) {
          setSelectedDeck(deckId)
        } else {
          Log.w(TAG, "answerCard: deck '$deckName' not found, proceeding without selected_deck reset")
        }

        // Re-query the schedule URI for this deck. AnkiDroid only accepts
        // answers for cards it considers actively presented — without a
        // fresh query, the (note_id, card_ord) is not in the review queue
        // and update returns 0.
        val primingUri = SCHEDULE_URI.buildUpon()
          .appendQueryParameter("deckID", deckId.toString())
          .appendQueryParameter("limit", "1")
          .build()
        var primingCursor: Cursor? = null
        try {
          primingCursor = contentResolver.query(primingUri, null, null, null, null)
          val primedCount = primingCursor?.count ?: 0
          Log.d(TAG, "answerCard: primed schedule queue with $primedCount card(s)")
        } catch (e: Exception) {
          Log.d(TAG, "answerCard: priming query failed: ${e.message}")
        } finally {
          primingCursor?.close()
        }

        val values = ContentValues().apply {
          put(REVIEW_NOTE_ID, noteId)
          put(REVIEW_CARD_ORD, cardOrd)
          put(REVIEW_EASE, ease)
          put(REVIEW_TIME_TAKEN, timeTakenMs)
        }
        Log.d(TAG, "answerCard: submitting deck='$deckName' note=$noteId ord=$cardOrd ease=$ease time=${timeTakenMs}ms")
        val rows = contentResolver.update(SCHEDULE_URI, values, null, null)
        Log.d(TAG, "answerCard: result deck='$deckName' note=$noteId ord=$cardOrd -> $rows row(s) updated")

        promise.resolve(mapOf(
          "updatedCards" to rows,
          "totalCards" to 1
        ))
      } catch (e: SecurityException) {
        promise.reject("PERMISSION_DENIED", "Permission denied when answering card: ${e.message}", e)
      } catch (e: Exception) {
        promise.reject("ANSWER_FAILED", "Failed to answer card: ${e.message}", e)
      }
    }

    // Trigger AnkiDroid sync
    AsyncFunction("triggerSync") { promise: Promise ->
      try {
        val intent = Intent(ACTION_SYNC).apply {
          setPackage(ANKIDROID_PACKAGE)
        }
        context.sendBroadcast(intent)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("SYNC_FAILED", "Failed to trigger sync: ${e.message}", e)
      }
    }
  }

  // Get deck ID from deck name by iterating all rows (decks URI ignores WHERE)
  private fun getDeckId(deckName: String): Long {
    var cursor: Cursor? = null
    try {
      cursor = contentResolver.query(DECKS_URI, arrayOf(DECK_ID, DECK_NAME), null, null, null)
      cursor?.let {
        val idIndex = it.getColumnIndex(DECK_ID)
        val nameIndex = it.getColumnIndex(DECK_NAME)
        while (it.moveToNext()) {
          val name = if (nameIndex >= 0) it.getString(nameIndex) else null
          if (name == deckName) {
            return if (idIndex >= 0) it.getLong(idIndex) else 0L
          }
        }
      }
    } finally {
      cursor?.close()
    }
    return 0L
  }

  // Parse note fields into a card map. `ord` comes from the schedule cursor —
  // AnkiDroid's update(SCHEDULE_URI) needs (note_id, ord) to identify the
  // exact card. Defaults to 0 for callers that don't have a scheduler ord.
  private fun parseNoteFields(fields: String, noteId: Long, deckName: String, ord: Int = 0): Map<String, Any>? {
    val meaningful = fields.split("\u001f")
      .map { f -> cleanAnkiText(f) }
      .filter { f -> f.isNotEmpty() && !f.matches(Regex("\\d+")) && !f.startsWith("[sound:") }

    val front = meaningful.getOrNull(0) ?: return null
    val back = meaningful.drop(1).joinToString(" | ")

    if (front.isEmpty()) return null

    return mapOf(
      "cardId" to noteId,
      "cardOrd" to ord,
      "front" to front,
      "back" to back,
      "deckName" to deckName
    )
  }

  // Look up the (new + learn + review) due count for a single deck by name.
  // Used by getDueCards to cap the notes-URI fallback so we don't load
  // hundreds of not-yet-due cards when only a handful are actually due.
  // Returns 0 if the deck is missing or the count can't be parsed —
  // callers should `coerceAtLeast(1)` before using as a session size.
  private fun getDeckDueCount(deckName: String): Int {
    var cursor: Cursor? = null
    try {
      cursor = contentResolver.query(
        DECKS_URI,
        arrayOf(DECK_NAME, DECK_COUNTS),
        null, null, null
      )
      cursor?.let {
        val nameIdx = it.getColumnIndex(DECK_NAME)
        val countsIdx = it.getColumnIndex(DECK_COUNTS)
        while (it.moveToNext()) {
          val name = if (nameIdx >= 0) it.getString(nameIdx) else null
          if (name == deckName) {
            val raw = if (countsIdx >= 0) it.getString(countsIdx) else null
            val counts = parseDeckCountsSeparate(raw)
            return counts.new + counts.learn + counts.review
          }
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "getDeckDueCount($deckName) failed: ${e.message}")
    } finally {
      cursor?.close()
    }
    return 0
  }

  // Tell AnkiDroid which deck to scope schedule operations to. Required
  // because AnkiDroid 2.23+ ignores `?deckID=` on the schedule URI and
  // operates on whatever deck is globally selected.
  private fun setSelectedDeck(deckId: Long) {
    try {
      val values = ContentValues().apply { put(DECK_ID, deckId) }
      val rows = contentResolver.update(SELECTED_DECK_URI, values, null, null)
      Log.d(TAG, "setSelectedDeck($deckId) -> $rows row(s) updated")
    } catch (e: Exception) {
      Log.w(TAG, "setSelectedDeck($deckId) failed: ${e.message}")
    }
  }

  private data class DeckCounts(val new: Int, val learn: Int, val review: Int)

  // Parse deck_counts JSON. Per AnkiDroid's FlashCardsContract, DECK_COUNTS
  // is a 3-element JSON array in the order [learn, review, new] — NOT
  // [new, learn, review] as previously assumed. Mislabelling caused the
  // deck list to show wrong-answered counts under "newCount", review-due
  // counts under "learnCount", and new-card counts under "reviewCount".
  private fun parseDeckCountsSeparate(raw: String?): DeckCounts {
    if (raw == null) return DeckCounts(0, 0, 0)
    return try {
      val cleaned = raw.trim().removePrefix("[").removeSuffix("]")
      val parts = cleaned.split(",").map { it.trim().toIntOrNull() ?: 0 }
      DeckCounts(
        learn = parts.getOrElse(0) { 0 },
        review = parts.getOrElse(1) { 0 },
        new = parts.getOrElse(2) { 0 }
      )
    } catch (e: Exception) {
      DeckCounts(0, 0, 0)
    }
  }

  // Clean HTML and formatting from Anki text
  private fun cleanAnkiText(text: String): String {
    return text
      // Remove HTML tags
      .replace(Regex("<[^>]*>"), "")
      // Decode HTML entities
      .replace("&nbsp;", " ")
      .replace("&amp;", "&")
      .replace("&lt;", "<")
      .replace("&gt;", ">")
      .replace("&quot;", "\"")
      .replace("&#39;", "'")
      // Remove cloze deletion markers
      .replace(Regex("\\{\\{c\\d+::|\\}\\}"), "")
      // Clean up whitespace
      .replace(Regex("\\s+"), " ")
      .trim()
  }
}
