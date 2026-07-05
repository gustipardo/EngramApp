# Play Store listing — Engram

Copy for the Play Console listing, both locales, written to the brand voice
(`_design/01-identidad.md` §10 Slot C; anti-patterns §15). Trademark rule
(PLAY-STORE.md §5): "AnkiDroid" only as factual/nominative use in the
description — never in the title or implying affiliation.

Character limits: title 30, short description 80, full description 4000.

---

## English (en-US)

**Title (24/30):**

> Engram — Study by Voice

**Short description (65/80):**

> Your AnkiDroid decks, studied out loud with a realtime AI tutor.

**Full description:**

> Engram reads your due cards aloud, listens to your spoken answer, and grades
> it semantically — synonyms, reordered phrases, and natural variations all
> count. Every answer is written back to your AnkiDroid collection through the
> official AnkiDroid API, so your review schedule stays exactly as it is.
>
> No new flashcard system. No streaks, no badges, no mascot. Your decks, your
> scheduler, your review queue — studied hands-free while you walk, cook, or
> commute.
>
> HOW IT WORKS
> • Pick a deck. The tutor greets you and reads the first due card.
> • Answer out loud. The AI evaluates the meaning of what you said, not the
> exact wording.
> • Correct or not, the result is graded into AnkiDroid and the next card
> comes up. The session runs with the screen off.
>
> BUILT FOR SERIOUS REVIEW
> • Works with any deck in any subject — languages, medicine, certifications, law.
> • Per-deck tutor language and custom instructions.
> • Optional read-back of the expected answer after each card.
> • Session keeps running in the background with a call-style notification.
>
> PRIVACY
> Your session audio and the text of the cards under review are sent to Google
> Gemini for the conversation and never stored by us. Deck data stays on your
> device. Full policy: https://engramcards.com/en/privacy
>
> REQUIREMENTS
> • AnkiDroid installed, with its API access enabled (Engram walks you
> through it on first run).
> • A Google account for sign-in.
>
> PRICING
> Free trial: 7 days or 10 sessions, whichever runs out first. After that a
> subscription keeps it running — realtime audio AI is billed by the minute,
> and the subscription is what pays for it.
>
> Engram is an independent app. It is not affiliated with or endorsed by the
> Anki or AnkiDroid projects.

## Español (es-419)

**Title (25/30):**

> Engram — Estudio por voz

**Short description (67/80):**

> Tus mazos de AnkiDroid, estudiados en voz alta con un tutor de IA.

**Full description:**

> Engram te lee las tarjetas pendientes en voz alta, escucha tu respuesta
> hablada y la evalúa por significado — sinónimos, frases reordenadas y
> variaciones naturales cuentan como correctas. Cada respuesta se registra en
> tu colección de AnkiDroid a través de la API oficial, así que tu calendario
> de repasos queda exactamente como está.
>
> No es otro sistema de flashcards. Sin rachas, sin medallas, sin mascota.
> Tus mazos, tu scheduler, tu cola de repaso — estudiados con las manos libres
> mientras caminás, cocinás o viajás.
>
> CÓMO FUNCIONA
> • Elegís un mazo. El tutor te saluda y lee la primera tarjeta pendiente.
> • Respondés en voz alta. La IA evalúa el significado de lo que dijiste, no
> la redacción exacta.
> • Correcta o no, la respuesta se califica en AnkiDroid y sigue la próxima
> tarjeta. La sesión sigue con la pantalla apagada.
>
> HECHO PARA REPASO EN SERIO
> • Funciona con cualquier mazo de cualquier tema: idiomas, medicina,
> certificaciones, derecho.
> • Idioma del tutor e instrucciones propias por mazo.
> • Lectura opcional de la respuesta esperada después de cada tarjeta.
> • La sesión sigue en segundo plano con una notificación tipo llamada.
>
> PRIVACIDAD
> El audio de la sesión y el texto de las tarjetas en repaso se envían a
> Google Gemini para la conversación y nosotros nunca los almacenamos. Los
> datos de tus mazos quedan en tu dispositivo. Política completa:
> https://engramcards.com/privacy
>
> REQUISITOS
> • AnkiDroid instalado, con su acceso por API habilitado (Engram te guía en
> el primer uso).
> • Una cuenta de Google para iniciar sesión.
>
> PRECIO
> Prueba gratis: 7 días o 10 sesiones, lo que se termine primero. Después, la
> suscripción es lo que mantiene esto andando — la IA de audio en tiempo real
> se cobra por minuto.
>
> Engram es una app independiente. No está afiliada ni respaldada por los
> proyectos Anki o AnkiDroid.

---

## Assets still needed

| Asset                  | Spec                      | Source                                                                                  |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| App icon               | 512×512 PNG, 32-bit       | `_design/04-cip/` mark (already shipped in-app)                                         |
| Feature graphic        | 1024×500 PNG              | render from `_design/05-marketing/` templates                                           |
| Phone screenshots      | ≥2, 16:9 or 9:16, ≥1080px | deck list, live session, per-deck settings, account — take on the Pixel 9 release build |
| (Optional) promo video | YouTube URL               | the 30-sec explainer from `docs/MVP_validation_plan.md` §"pre-launch assets"            |

## Console setup checklist (user actions, in order)

1. **Create the app** in Play Console: name "Engram", default language
   (decide: ES or EN — landing is ES-default), app, free-with-IAP.
2. **Upload the AAB** (`scripts/build-release.sh --aab`) to **Internal
   testing** first.
3. **Subscriptions**: create `com.engram.app.monthly` ($4.99/mo) and
   `com.engram.app.yearly` ($39.99/yr) with base plans + any intro offers.
   SKUs are immutable — these names are final (Engram rebrand, 2026-07-01).
4. **License testers**: Play Console → Settings → License testing — add your
   test Gmail accounts so purchases are sandboxed.
5. **Service account for verifyPurchase**: Play Console → Users and
   permissions → invite the Cloud Functions runtime service account
   (Firebase project `engram-3392a` — check the exact email in Google Cloud
   Console → Cloud Functions → verifyPurchase → Details; typically
   `866005886684-compute@developer.gserviceaccount.com`) with **View
   financial data** + **Manage orders** permissions. Also enable the
   **Google Play Android Developer API** for the project. Until this is
   done, every real purchase verification fails closed
   (`purchase_verification_unavailable`).
6. **Data Safety form**: Audio = collected, shared with third party (Google
   Gemini), not stored; account identifiers collected. Must match
   https://engramcards.com/en/privacy — see PLAY-STORE.md §2.
7. **Foreground service (microphone) declaration** + demo video (PLAY-STORE.md
   checklist).
8. **Content rating questionnaire**, ads declaration (none), target audience.
9. **Closed testing**: new personal developer accounts need **12 testers
   opted in for 14 days** before production access — start this track
   immediately after internal testing passes.
10. **Production** rollout after the testing gate clears.
