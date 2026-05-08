package expo.modules.ankidroid

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Smoke test — verifies the instrumented-test toolchain itself is wired
 * up before any AnkiDroid-specific tests are added. If this fails, no
 * test in this directory will run.
 */
@RunWith(AndroidJUnit4::class)
class SmokeTest {

  @Test
  fun targetContextIsAvailable() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    assertNotNull("Target context should be non-null on a real device/emulator", context)
    assertTrue("Test package name should be set", context.packageName.isNotEmpty())
  }
}
