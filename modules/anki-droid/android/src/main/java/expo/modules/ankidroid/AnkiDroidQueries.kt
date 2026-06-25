package expo.modules.ankidroid

import android.content.ContentResolver
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.util.Log

/**
 * Pure query/write logic against the AnkiDroid `FlashCardsContract`
 * ContentProvider. Extracted from `AnkiDroidModule` so instrumented
 * tests (running outside the Expo Module runtime) can exercise the
 * exact same code paths the app uses at runtime.
 *
 * Anything in this file is testable from `androidTest/`. Anything in
 * `AnkiDroidModule.kt` is the thin Expo<->Kotlin adapter on top.
 */

// -- ContentProvider URIs ---------------------------------------------------

internal const val ANKI_AUTHORITY = "com.ichi2.anki.flashcards"
internal val DECKS_URI: Uri = Uri.parse("content://$ANKI_AUTHORITY/decks")
internal val SELECTED_DECK_URI: Uri = Uri.parse("content://$ANKI_AUTHORITY/selected_deck")
internal val NOTES_URI: Uri = Uri.parse("content://$ANKI_AUTHORITY/notes")
internal val CARDS_URI: Uri = Uri.parse("content://$ANKI_AUTHORITY/cards")
internal val SCHEDULE_URI: Uri = Uri.parse("content://$ANKI_AUTHORITY/schedule")

// -- Column names -----------------------------------------------------------

internal const val COL_DECK_ID = "deck_id"
internal const val COL_DECK_NAME = "deck_name"
internal const val COL_DECK_COUNTS = "deck_count"
internal const val COL_NOTE_FLDS = "flds"
internal const val COL_REVIEW_NOTE_ID = "note_id"
internal const val COL_REVIEW_CARD_ORD = "ord"
internal const val COL_REVIEW_EASE = "answer_ease"
internal const val COL_REVIEW_TIME_TAKEN = "time_taken"

private const val TAG = "AnkiDroidQueries"

// -- Public entry points ----------------------------------------------------

/**
 * Get cards that are actually DUE for review in a specific deck. See
 * `AnkiDroidModule.AsyncFunction("getDueCards")` for the long-form
 * design notes — the gist is: schedule URI gives one card; cards URI
 * `?query=did:` gives the rest, deck-scoped via `Collection.findCards`.
 *
 * @throws SecurityException if the caller lacks the AnkiDroid permission.
 */
internal fun queryDueCards(contentResolver: ContentResolver, deckName: String): List<Map<String, Any>> {
  val deckId = queryDeckId(contentResolver, deckName)
  Log.d(TAG, "queryDueCards: deckName='$deckName' deckId=$deckId")

  if (deckId == 0L) {
    throw IllegalArgumentException("Deck '$deckName' not found")
  }

  // AnkiDroid 2.23+ ignores the schedule URI's `?deckID=` query param
  // and returns cards from whatever deck is globally selected. We must
  // explicitly set the selected deck via the SELECTED_DECK URI first.
  setSelectedDeck(contentResolver, deckId)

  // Step 1: Ask AnkiDroid's scheduler for the due cards in this deck.
  // We keep `?deckID=` and `?limit=` for older AnkiDroid versions that
  // do honor them; the SELECTED_DECK update above handles 2.23+.
  val scheduleQueryUri = SCHEDULE_URI.buildUpon()
    .appendQueryParameter("deckID", deckId.toString())
    .appendQueryParameter("limit", "500")
    .build()

  val dueRefs = mutableListOf<DueRef>()
  var schedCursor: Cursor? = null
  try {
    schedCursor = contentResolver.query(scheduleQueryUri, null, null, null, null)
    schedCursor?.let {
      Log.d(TAG, "queryDueCards: schedule columns: ${it.columnNames.joinToString()}")
      val noteIdIdx = it.getColumnIndex(COL_REVIEW_NOTE_ID)
      // Schedule URI uses "ord", but be tolerant of "card_ord" too.
      val ordIdx = it.getColumnIndex("ord").takeIf { i -> i >= 0 }
        ?: it.getColumnIndex(COL_REVIEW_CARD_ORD)
      while (it.moveToNext()) {
        if (noteIdIdx < 0) continue
        val nid = it.getLong(noteIdIdx)
        val ord = if (ordIdx >= 0) it.getInt(ordIdx) else 0
        // Scheduler hands us cards in review order, so anchor due=0 for
        // the head — it should always lead the final sorted list.
        dueRefs.add(DueRef(nid, ord, due = 0L))
      }
    }
  } finally {
    schedCursor?.close()
  }

  Log.d(TAG, "queryDueCards: scheduler returned ${dueRefs.size} due cards for deck $deckId")

  // Earlier versions of this function padded the result with cards from
  // the CARDS URI (`?query=did:N is:due`). That URI returns results in
  // `nid` (insertion) order and DOES NOT expose `due` — meaning the
  // pad was always wrong-ordered. Concretely: slot[1] was the deck's
  // oldest-added card every session (SESSION-FLOW.md BUG 5). Attempts to
  // fix it via explicit projection (BUG 7 regression) or sortOrder hint
  // (silently ignored by AnkiDroid 2.23) both failed.
  //
  // Current design: this function returns only the scheduler head. The
  // JS layer (cardLoader + sessionManager) calls it again after each
  // answerCard write-back to obtain the new head. That walks the deck
  // in AnkiDroid's real review order, no `due` column needed.
  if (dueRefs.isEmpty()) {
    return emptyList()
  }

  // No re-sort needed: a single card list is trivially sorted. Variable
  // name kept so the rest of the function (hydration, result build) is
  // unchanged.
  val sortedDueRefs = dueRefs

  // Step 2: Hydrate each note's fields via per-note URI. AnkiDroid's
  // notes provider does not accept `_id IN (...)` selections, so we
  // query one note at a time. Sub-100ms for typical batch sizes.
  val uniqueNoteIds = sortedDueRefs.map { it.noteId }.toSet()
  val noteFieldsByNoteId = HashMap<Long, String>(uniqueNoteIds.size)
  for (noteId in uniqueNoteIds) {
    var noteCursor: Cursor? = null
    try {
      val noteUri = Uri.parse("content://$ANKI_AUTHORITY/notes/$noteId")
      noteCursor = contentResolver.query(noteUri, null, null, null, null)
      noteCursor?.let {
        if (it.moveToFirst()) {
          val fldsIdx = it.getColumnIndex(COL_NOTE_FLDS)
          if (fldsIdx >= 0) {
            val flds = it.getString(fldsIdx)
            if (flds != null) noteFieldsByNoteId[noteId] = flds
          }
        }
      }
    } catch (e: Exception) {
      Log.d(TAG, "queryDueCards: failed to fetch note $noteId: ${e.message}")
    } finally {
      noteCursor?.close()
    }
  }

  // Step 3: Build result preserving the sorted (by-due) order.
  val cards = mutableListOf<Map<String, Any>>()
  for (ref in sortedDueRefs) {
    val fields = noteFieldsByNoteId[ref.noteId] ?: continue
    val parsed = parseNoteFields(fields, ref.noteId, deckName, ref.ord) ?: continue
    cards.add(parsed)
  }

  // First few + last for sanity: easy to spot a stuck slot[1] in logcat.
  val orderSummary = sortedDueRefs.take(3).joinToString(",") { "${it.noteId}@${it.due}" }
  Log.d(TAG, "queryDueCards: returning ${cards.size} due cards for '$deckName' (head: $orderSummary)")
  return cards
}

/**
 * Submit a pass/fail answer for a card. Mirrors the runtime path of
 * `AnkiDroidModule.AsyncFunction("answerCard")`.
 *
 * @return number of rows updated by AnkiDroid's scheduler; 0 = silently
 *         ignored (usually because the (note_id, ord) wasn't in the
 *         active review queue at submit time).
 */
internal fun submitCardAnswer(
  contentResolver: ContentResolver,
  deckName: String,
  noteId: Long,
  cardOrd: Int,
  ease: Int,
  timeTakenMs: Long,
): Int {
  require(ease in 1..4) { "ease must be in 1..4 (got $ease)" }

  val deckId = queryDeckId(contentResolver, deckName)
  if (deckId != 0L) {
    setSelectedDeck(contentResolver, deckId)
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
  } catch (e: Exception) {
    Log.d(TAG, "submitCardAnswer: priming query failed: ${e.message}")
  } finally {
    primingCursor?.close()
  }

  val values = ContentValues().apply {
    put(COL_REVIEW_NOTE_ID, noteId)
    put(COL_REVIEW_CARD_ORD, cardOrd)
    put(COL_REVIEW_EASE, ease)
    put(COL_REVIEW_TIME_TAKEN, timeTakenMs)
  }
  return contentResolver.update(SCHEDULE_URI, values, null, null)
}

// -- Internal helpers -------------------------------------------------------

// `due` is AnkiDroid's scheduling timestamp/position for the card.
// Long.MAX_VALUE = unknown (column not exposed by the cursor); such cards
// sort last in the natural-due order so they're seen after cards we
// actually have ordering info for.
internal data class DueRef(val noteId: Long, val ord: Int, val due: Long = Long.MAX_VALUE)

internal data class DeckCounts(val new: Int, val learn: Int, val review: Int)

/** Iterates all decks (decks URI ignores WHERE) to find one by name. */
internal fun queryDeckId(contentResolver: ContentResolver, deckName: String): Long {
  var cursor: Cursor? = null
  try {
    cursor = contentResolver.query(DECKS_URI, arrayOf(COL_DECK_ID, COL_DECK_NAME), null, null, null)
    cursor?.let {
      val idIndex = it.getColumnIndex(COL_DECK_ID)
      val nameIndex = it.getColumnIndex(COL_DECK_NAME)
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

/**
 * Tell AnkiDroid which deck to scope schedule operations to. Required
 * because AnkiDroid 2.23+ ignores `?deckID=` on the schedule URI and
 * operates on whatever deck is globally selected.
 */
internal fun setSelectedDeck(contentResolver: ContentResolver, deckId: Long) {
  try {
    val values = ContentValues().apply { put(COL_DECK_ID, deckId) }
    val rows = contentResolver.update(SELECTED_DECK_URI, values, null, null)
    Log.d(TAG, "setSelectedDeck($deckId) -> $rows row(s) updated")
  } catch (e: Exception) {
    Log.w(TAG, "setSelectedDeck($deckId) failed: ${e.message}")
  }
}

/**
 * Look up (new + learn + review) due count for one deck by name. Used
 * to cap the cards-URI fallback so a small session doesn't load the
 * whole deck.
 */
internal fun queryDeckDueCount(contentResolver: ContentResolver, deckName: String): Int {
  var cursor: Cursor? = null
  try {
    cursor = contentResolver.query(DECKS_URI, arrayOf(COL_DECK_NAME, COL_DECK_COUNTS), null, null, null)
    cursor?.let {
      val nameIdx = it.getColumnIndex(COL_DECK_NAME)
      val countsIdx = it.getColumnIndex(COL_DECK_COUNTS)
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
    Log.w(TAG, "queryDeckDueCount($deckName) failed: ${e.message}")
  } finally {
    cursor?.close()
  }
  return 0
}

/**
 * Parse `deck_counts` JSON. Per AnkiDroid's FlashCardsContract,
 * DECK_COUNTS is a 3-element JSON array in the order [learn, review, new]
 * — NOT [new, learn, review] as previously assumed.
 */
internal fun parseDeckCountsSeparate(raw: String?): DeckCounts {
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

/** Build a card map from a note's raw `flds` string + scheduler `ord`. */
internal fun parseNoteFields(fields: String, noteId: Long, deckName: String, ord: Int = 0): Map<String, Any>? {
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

/** Strip HTML, decode entities, drop cloze markers, collapse whitespace. */
internal fun cleanAnkiText(text: String): String {
  return text
    .replace(Regex("<[^>]*>"), "")
    .replace("&nbsp;", " ")
    .replace("&amp;", "&")
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
    .replace(Regex("\\{\\{c\\d+::|\\}\\}"), "")
    .replace(Regex("\\s+"), " ")
    .trim()
}
