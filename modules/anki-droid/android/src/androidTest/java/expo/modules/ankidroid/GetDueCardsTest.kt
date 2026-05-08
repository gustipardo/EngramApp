package expo.modules.ankidroid

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName
import org.junit.runner.RunWith

/**
 * The deck-isolation regression test for `getDueCards`.
 *
 * Bug class this catches (the one the user is currently hitting on
 * their phone): `getDueCards("DeckA")` returning notes from DeckB. The
 * notes-URI `?deckID=` filter is silently ignored on AnkiDroid 2.23+,
 * so an earlier version of `getDueCards` mixed decks. The fix swapped
 * to the cards URI's `?query=did:<id>` (which routes through
 * `Collection.findCards()`) plus a defense-in-depth `did` row filter.
 *
 * No JS-layer test (Layer 1/2/3) catches this because the bug is in
 * Kotlin <-> ContentProvider behavior. This is the only place that
 * exercises the real ContentResolver against a real AnkiDroid install.
 *
 * Setup creates two decks ("TEST_DeckA", "TEST_DeckB") with three
 * notes each via direct ContentResolver inserts — sidesteps the need
 * for the AnkiDroid AddContentApi library and any external dependency
 * resolution. Teardown removes them so re-runs are idempotent.
 */
@RunWith(AndroidJUnit4::class)
class GetDueCardsTest {

  @get:Rule
  val permissionRule: GrantPermissionRule = GrantPermissionRule.grant(
    "com.ichi2.anki.permission.READ_WRITE_DATABASE"
  )

  @get:Rule
  val testName = TestName()

  private lateinit var context: Context
  private lateinit var resolver: ContentResolver

  // Per-test unique deck names — JUnit calls @Before before each @Test,
  // and AnkiDroid's deck delete is best-effort. Without per-test names,
  // notes accumulate across tests and our deck-isolation assertion picks
  // up notes from previous @Before invocations.
  private val deckAName get() = "TEST_DeckA_${testName.methodName}_$RANDOM_SUFFIX"
  private val deckBName get() = "TEST_DeckB_${testName.methodName}_$RANDOM_SUFFIX"

  private var deckAId: Long = 0L
  private var deckBId: Long = 0L
  private var basicModelId: Long = 0L
  private val deckANoteIds = mutableSetOf<Long>()
  private val deckBNoteIds = mutableSetOf<Long>()

  @Before
  fun setup() {
    context = InstrumentationRegistry.getInstrumentation().targetContext
    resolver = context.contentResolver

    basicModelId = findBasicModelId()
      ?: throw IllegalStateException(
        "AnkiDroid has no 'Basic' model. Open AnkiDroid once on this " +
        "emulator to bootstrap the default collection, then re-run."
      )

    deckAId = createDeck(deckAName)
    deckBId = createDeck(deckBName)

    deckANoteIds.clear()
    deckBNoteIds.clear()

    insertNote(deckAId, "What is a subnet?", "A subnetwork.")?.let { deckANoteIds.add(it) }
    insertNote(deckAId, "What is a VPC?", "Virtual private cloud.")?.let { deckANoteIds.add(it) }
    insertNote(deckAId, "What is IAM?", "Identity and access management.")?.let { deckANoteIds.add(it) }

    insertNote(deckBId, "What does 'go on' mean?", "to continue")?.let { deckBNoteIds.add(it) }
    insertNote(deckBId, "What does 'show up' mean?", "to appear")?.let { deckBNoteIds.add(it) }
    insertNote(deckBId, "What does 'put off' mean?", "to postpone")?.let { deckBNoteIds.add(it) }
  }

  @After
  fun teardown() {
    // Best-effort cleanup. Failures here don't affect test results — a
    // re-run will just see leftover decks (named distinctly enough not
    // to collide with anything else).
    if (deckAId != 0L) deleteDeck(deckAId)
    if (deckBId != 0L) deleteDeck(deckBId)
  }

  // --- The actual regression test ------------------------------------

  @Test
  fun queryDueCards_returnsOnlyTheRequestedDeck() {
    val cards = queryDueCards(resolver, deckAName)

    assertTrue(
      "Expected at least one card from $deckAName, got ${cards.size}",
      cards.isNotEmpty()
    )

    // Critical: assert by the *real* note id, not by the `deckName`
    // field — `deckName` is just the input parameter echoed back, so
    // a leak from DeckB would still claim deckName=DeckA in the result
    // map. Cross-reference each returned cardId against the seed sets.
    val returnedIds = cards.map { (it["cardId"] as Long) }.toSet()
    val leaked = returnedIds intersect deckBNoteIds
    assertTrue(
      "Foreign-deck note ids leaked into $deckAName query: $leaked. " +
        "Returned ids: $returnedIds. DeckA seeds: $deckANoteIds. DeckB seeds: $deckBNoteIds.",
      leaked.isEmpty()
    )
    assertTrue(
      "Returned ids ($returnedIds) should be a subset of DeckA seeds ($deckANoteIds)",
      deckANoteIds.containsAll(returnedIds)
    )
  }

  @Test
  fun queryDueCards_querySymmetric_otherDeckAlsoIsolated() {
    // Same assertion in the other direction — guards against a
    // hardcoded "DeckA" check in production happening to pass test #1.
    val cards = queryDueCards(resolver, deckBName)
    assertTrue("Expected cards from $deckBName", cards.isNotEmpty())

    val returnedIds = cards.map { (it["cardId"] as Long) }.toSet()
    val leaked = returnedIds intersect deckANoteIds
    assertTrue(
      "Foreign-deck note ids leaked into $deckBName query: $leaked",
      leaked.isEmpty()
    )
    assertTrue(
      "Returned ids ($returnedIds) should be a subset of DeckB seeds ($deckBNoteIds)",
      deckBNoteIds.containsAll(returnedIds)
    )
  }

  @Test
  fun notesUri_doesNotFilterByDeck_documentsTheBugClassWeAvoid() {
    // Regression DOCUMENTATION test: AnkiDroid 2.23+'s notes URI silently
    // ignores `?deckID=` and `?did=` filter params, returning notes from
    // every deck on the device. This is exactly why production switched
    // to the cards URI's `?query=did:` (see AnkiDroidQueries.kt). If
    // AnkiDroid ever fixes the notes URI filter, this test will fail
    // and we'll know we can simplify the production query.
    val notesUri = NOTES_URI.buildUpon()
      .appendQueryParameter("deckID", deckAId.toString())
      .build()

    var totalRows = 0
    var deckBNotesSeen = 0
    var cursor: Cursor? = null
    try {
      cursor = resolver.query(notesUri, null, null, null, null)
      cursor?.let {
        val idIdx = it.getColumnIndex("_id").takeIf { i -> i >= 0 }
          ?: it.getColumnIndex("note_id")
        while (it.moveToNext()) {
          totalRows++
          if (idIdx >= 0) {
            val noteId = it.getLong(idIdx)
            if (deckBNoteIds.contains(noteId)) deckBNotesSeen++
          }
        }
      }
    } finally {
      cursor?.close()
    }

    assertTrue(
      "If notes URI started filtering by deck (returned 0 DeckB notes when " +
        "queried for DeckA, totalRows=$totalRows), the production code can " +
        "drop the cards-URI fallback. Currently expecting leak.",
      deckBNotesSeen > 0 || totalRows == 0
    )
  }

  @Test
  fun queryDeckId_resolvesNamedDecks() {
    assertEquals(deckAId, queryDeckId(resolver, deckAName))
    assertEquals(deckBId, queryDeckId(resolver, deckBName))
    assertEquals(0L, queryDeckId(resolver, "TEST_NoSuchDeck_${testName.methodName}_$RANDOM_SUFFIX"))
  }

  // --- Seed helpers --------------------------------------------------

  private fun findBasicModelId(): Long? {
    val modelsUri = Uri.parse("content://com.ichi2.anki.flashcards/models")
    var cursor: Cursor? = null
    try {
      cursor = resolver.query(modelsUri, null, null, null, null)
      cursor?.let {
        val idIdx = it.getColumnIndex("_id").takeIf { i -> i >= 0 }
          ?: it.getColumnIndex("model_id")
        val nameIdx = it.getColumnIndex("name").takeIf { i -> i >= 0 }
          ?: it.getColumnIndex("model_name")
        // Prefer "Basic" by name; fall back to first model. AnkiDroid
        // creates a small set of default models on first launch.
        var firstId: Long? = null
        while (it.moveToNext()) {
          val id = if (idIdx >= 0) it.getLong(idIdx) else continue
          val name = if (nameIdx >= 0) it.getString(nameIdx) else ""
          if (firstId == null) firstId = id
          if (name?.startsWith("Basic", ignoreCase = true) == true) return id
        }
        return firstId
      }
    } finally {
      cursor?.close()
    }
    return null
  }

  private fun createDeck(name: String): Long {
    // Idempotent: if a previous run left this deck behind (teardown
    // failed, or AnkiDroid doesn't honor the delete), reuse it instead
    // of failing the @Before with "Deck name already exists".
    val existing = queryDeckId(resolver, name)
    if (existing != 0L) return existing

    val values = ContentValues().apply { put("deck_name", name) }
    val uri = resolver.insert(DECKS_URI, values)
      ?: throw IllegalStateException("Failed to insert deck '$name'")
    val deckId = uri.lastPathSegment?.toLongOrNull() ?: 0L
    if (deckId == 0L) {
      return queryDeckId(resolver, name)
    }
    return deckId
  }

  private fun insertNote(deckId: Long, front: String, back: String): Long? {
    // AnkiDroid honors a `?deckId=` URI query param on note inserts
    // (CardContentProvider routes the auto-created cards into that
    // deck). Older versions used selected_deck instead, so set both.
    setSelectedDeck(resolver, deckId)

    val notesWithDeck = NOTES_URI.buildUpon()
      .appendQueryParameter("deckId", deckId.toString())
      .build()

    val values = ContentValues().apply {
      put("mid", basicModelId)
      put("did", deckId)
      put("flds", "${front}\u001f${back}")
      put("tags", "")
    }
    val uri = resolver.insert(notesWithDeck, values)
      ?: throw IllegalStateException(
        "Failed to insert note '$front' into deck $deckId"
      )
    val noteId = uri.lastPathSegment?.toLongOrNull()

    // Belt-and-braces: explicitly move the auto-created card into the
    // target deck via the cards URI. Some AnkiDroid versions ignore
    // both the URI param and selected_deck for note inserts and drop
    // cards into the default deck (id=1). Walking the cards URI for
    // the just-inserted note corrects that.
    if (noteId != null) {
      for (ord in 0..1) {
        try {
          val cardUri = Uri.parse("content://$ANKI_AUTHORITY/notes/$noteId/cards/$ord")
          val cardValues = ContentValues().apply { put("deck_id", deckId) }
          resolver.update(cardUri, cardValues, null, null)
        } catch (e: Exception) {
          // best-effort
        }
      }
    }
    return noteId
  }

  private fun deleteDeck(deckId: Long) {
    try {
      val deckUri = Uri.parse("content://com.ichi2.anki.flashcards/decks/$deckId")
      resolver.delete(deckUri, null, null)
    } catch (e: Exception) {
      // Cleanup is best-effort.
    }
  }

  /** Replaces ContentUris.parseId since URI shape from AnkiDroid varies. */
  private fun ContentUris_parseId(uri: Uri): Long {
    val last = uri.lastPathSegment ?: return 0L
    return last.toLongOrNull() ?: 0L
  }

  companion object {
    // Random-ish suffix per test-class load. Combined with the test
    // method name in the per-test `deckAName`/`deckBName` above, every
    // @Before sees a fresh, unused deck — even if AnkiDroid's delete
    // didn't actually purge a previous run's deck.
    private val RANDOM_SUFFIX = System.currentTimeMillis().toString().takeLast(6)
  }
}
