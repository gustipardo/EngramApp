#!/usr/bin/env python3
"""
create-test-apkg.py — Generate Anki .apkg fixture files for isolated E2E testing.

Each named profile produces a deterministic, self-contained deck with known cards
so tests never touch the developer's personal AnkiDroid collection.

Usage:
    python3 scripts/create-test-apkg.py                  # all profiles
    python3 scripts/create-test-apkg.py aws-sa           # single profile
    python3 scripts/create-test-apkg.py --list           # list profiles

Output:
    src/test-harness/fixtures/<profile-name>.apkg

Card format: Basic (Front / Back), all cards created as NEW (queue=0) so the
scheduler serves them immediately on any collection, regardless of its crt.
"""

import os, sys, sqlite3, zipfile, json, time, struct, hashlib

# ---------------------------------------------------------------------------
# Deck profiles
# Each profile is: (deck_name, deck_id, model_id, cards)
# deck_id and model_id must be unique across profiles so they can coexist in
# the same AnkiDroid collection without colliding.
#
# Card tuple: (front, back, correct_answer_hint)
# correct_answer_hint is used by E2E scenario scripts to inject a plausible
# correct answer — it does NOT affect the AnkiDroid schema, only the companion
# scenario files.  Format: (front_text, back_text, hint_for_answer_injection)
# ---------------------------------------------------------------------------

PROFILES = {
    # ── AWS Solutions Architect ─────────────────────────────────────────────
    "aws-sa": {
        "deck_name":  "Engram Test — AWS SA",
        "deck_id":    1_000_000_042,
        "model_id":   1_607_392_300,
        "cards": [
            ("What does EC2 stand for?",
             "Elastic Compute Cloud",
             "EC2 stands for Elastic Compute Cloud, it provides virtual servers"),
            ("What does S3 stand for?",
             "Simple Storage Service",
             "S3 is Simple Storage Service, object storage for any amount of data"),
            ("What is AWS Lambda?",
             "Serverless compute — run code without managing servers",
             "Lambda is serverless compute, you run code without provisioning servers"),
            ("What does IAM stand for?",
             "Identity and Access Management",
             "IAM stands for Identity and Access Management, it controls who can access AWS resources"),
            ("What is an AWS Availability Zone?",
             "An isolated data-centre location within a region",
             "An Availability Zone is an isolated data centre within a region"),
            ("What is Amazon RDS?",
             "Relational Database Service — managed SQL databases",
             "RDS is the Relational Database Service, it manages SQL databases for you"),
            ("What is Amazon CloudFront?",
             "A CDN that caches content at edge locations globally",
             "CloudFront is a content delivery network that caches content at edge locations around the world"),
            ("What does VPC stand for?",
             "Virtual Private Cloud — isolated network in AWS",
             "VPC is Virtual Private Cloud, your own isolated network inside AWS"),
        ],
    },

    # ── Refold English vocabulary (1000-words persona) ──────────────────────
    # Cards simulate a typical Refold i+1 vocab deck: target word on the front,
    # definition + example on the back.
    "refold-english": {
        "deck_name":  "Engram Test — Refold English",
        "deck_id":    1_000_000_043,
        "model_id":   1_607_392_301,
        "cards": [
            ("grasp",
             "to hold firmly; to understand\nEx: She grasped the concept quickly.",
             "Grasp means to hold firmly or to understand something"),
            ("subtle",
             "so slight as to be hard to notice\nEx: There was a subtle difference in tone.",
             "Subtle means something so slight it is difficult to notice"),
            ("persist",
             "to continue doing something despite difficulty\nEx: He persisted despite the obstacles.",
             "Persist means to keep going even when things are difficult"),
            ("leverage",
             "to use something to maximum advantage\nEx: She leveraged her contacts to land the job.",
             "Leverage means to use something to your maximum advantage"),
            ("arbitrary",
             "based on random choice rather than reason\nEx: The rule seemed completely arbitrary.",
             "Arbitrary means based on random choice with no clear reason"),
            ("coherent",
             "logical and consistent; easy to understand\nEx: His argument was coherent and well-structured.",
             "Coherent means logical and consistent, easy to follow"),
            ("ambiguous",
             "having more than one possible meaning\nEx: His answer was deliberately ambiguous.",
             "Ambiguous means something that can be interpreted in more than one way"),
            ("concise",
             "giving a lot of information clearly in a few words\nEx: Write a concise summary.",
             "Concise means expressing a lot clearly with few words"),
            ("implicit",
             "implied but not directly expressed\nEx: There was an implicit agreement between them.",
             "Implicit means something that is understood but not directly stated"),
            ("threshold",
             "the level at which something begins or changes\nEx: We crossed the pain threshold.",
             "A threshold is the point at which something begins or changes"),
        ],
    },

    # ── Spanish conversation phrases ────────────────────────────────────────
    # Simulates a language learner studying conversational phrases.
    "spanish-phrases": {
        "deck_name":  "Engram Test — Spanish Phrases",
        "deck_id":    1_000_000_044,
        "model_id":   1_607_392_302,
        "cards": [
            ("¿Cómo te llamas?",
             "What is your name?",
             "It means what is your name"),
            ("¿Cuántos años tienes?",
             "How old are you?",
             "It means how old are you"),
            ("¿De dónde eres?",
             "Where are you from?",
             "It means where are you from"),
            ("¿Qué hora es?",
             "What time is it?",
             "It means what time is it"),
            ("¿Puedes repetir, por favor?",
             "Can you repeat that, please?",
             "It means can you please repeat that"),
            ("Tengo hambre",
             "I am hungry",
             "Tengo hambre means I am hungry"),
            ("No entiendo",
             "I don't understand",
             "No entiendo means I don't understand"),
        ],
    },

    # ── Human anatomy — med student persona ────────────────────────────────
    "anatomy-med": {
        "deck_name":  "Engram Test — Anatomy",
        "deck_id":    1_000_000_045,
        "model_id":   1_607_392_303,
        "cards": [
            ("What does the mitochondria do?",
             "Produces ATP through cellular respiration — the powerhouse of the cell",
             "The mitochondria produces ATP, it is the powerhouse of the cell"),
            ("What is the function of the hippocampus?",
             "Memory consolidation and spatial navigation",
             "The hippocampus is responsible for memory consolidation and spatial navigation"),
            ("What does the pancreas secrete?",
             "Insulin and glucagon (endocrine); digestive enzymes (exocrine)",
             "The pancreas secretes insulin and glucagon for blood sugar regulation, and digestive enzymes"),
            ("Where is the brachial plexus located?",
             "Network of nerves from C5-T1, running through the neck and armpit",
             "The brachial plexus is a network of nerves originating from C5 to T1 in the neck and armpit"),
            ("What is the role of the sinoatrial node?",
             "The heart's natural pacemaker — generates the electrical impulse that starts each heartbeat",
             "The sinoatrial node is the natural pacemaker of the heart, generating the electrical impulse for each heartbeat"),
            ("What does the thyroid gland regulate?",
             "Metabolism, heart rate, and body temperature via T3/T4 hormones",
             "The thyroid regulates metabolism, heart rate, and body temperature through T3 and T4 hormones"),
        ],
    },
}

# ---------------------------------------------------------------------------
# .apkg generation (shared logic)
# ---------------------------------------------------------------------------

FIXTURES_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "test-harness", "fixtures")
)


def _checksum(text: str) -> int:
    return struct.unpack(">I", hashlib.sha1(text.encode()).digest()[:4])[0]


def _build_col_json(deck_id: int, deck_name: str, model_id: int, now: int) -> tuple:
    model = {
        str(model_id): {
            "id": model_id, "name": "Engram Basic", "type": 0, "mod": now,
            "usn": -1, "sortf": 0, "did": deck_id,
            "tmpls": [{"name": "Card 1", "ord": 0,
                        "qfmt": "{{Front}}", "afmt": "{{FrontSide}}<hr>{{Back}}",
                        "bqfmt": "", "bafmt": "", "did": None, "bfont": "", "bsize": 0}],
            "flds": [
                {"name": "Front", "ord": 0, "sticky": False, "rtl": False,
                 "font": "Arial", "size": 20, "media": []},
                {"name": "Back",  "ord": 1, "sticky": False, "rtl": False,
                 "font": "Arial", "size": 20, "media": []},
            ],
            "css": ".card{font-family:arial;font-size:20px;}",
            "latexPre": "", "latexPost": "", "tags": [], "vers": [],
        }
    }
    decks = {
        "1": {
            "id": 1, "name": "Default", "conf": 1,
            "extendNew": 10, "extendRev": 50,
            "collapsed": False, "browserCollapsed": False,
            "usn": 0, "lrnToday": [0, 0], "revToday": [0, 0],
            "newToday": [0, 0], "timeToday": [0, 0],
            "dyn": 0, "mod": now, "desc": "",
        },
        str(deck_id): {
            "id": deck_id, "name": deck_name, "conf": 1,
            "extendNew": 10, "extendRev": 50,
            "collapsed": False, "browserCollapsed": False,
            "usn": -1, "lrnToday": [0, 0], "revToday": [0, 0],
            "newToday": [0, 0], "timeToday": [0, 0],
            "dyn": 0, "mod": now,
            "desc": f"Auto-generated test deck for Engram E2E testing.",
        },
    }
    dconf = {
        "1": {
            "id": 1, "name": "Default", "replayq": True,
            "lapse": {"leechFails": 8, "minInt": 1, "delays": [10],
                      "leechAction": 0, "mult": 0},
            "rev": {"perDay": 200, "ease4": 1.3, "fuzz": 0.05,
                    "minSpace": 1, "ivlFct": 1, "maxIvl": 36500,
                    "bury": True, "hardFactor": 1.2},
            "timer": 0, "maxTaken": 60, "usn": 0,
            "new": {"perDay": 20, "delays": [1, 10], "separate": True,
                    "ints": [1, 4, 7], "initialFactor": 2500,
                    "bury": True, "order": 1},
            "autoplay": True, "mod": now,
        }
    }
    return model, decks, dconf


def build_apkg(profile_key: str) -> str:
    profile  = PROFILES[profile_key]
    deck_id  = profile["deck_id"]
    deck_name = profile["deck_name"]
    model_id = profile["model_id"]
    cards    = profile["cards"]

    now   = int(time.time())
    today = now // 86400

    db_path  = f"/tmp/engram-test-{profile_key}.anki2"
    out_path = os.path.join(FIXTURES_DIR, f"{profile_key}.apkg")

    if os.path.exists(db_path):
        os.remove(db_path)

    conn = sqlite3.connect(db_path)
    c    = conn.cursor()
    c.executescript("""
        CREATE TABLE col(
            id integer primary key, crt integer not null, mod integer not null,
            scm integer not null, ver integer not null, dty integer not null,
            usn integer not null, ls integer not null, conf text not null,
            models text not null, decks text not null, dconf text not null,
            tags text not null
        );
        CREATE TABLE notes(
            id integer primary key, guid text not null, mid integer not null,
            mod integer not null, usn integer not null, tags text not null,
            flds text not null, sfld integer not null, csum integer not null,
            flags integer not null, data text not null
        );
        CREATE TABLE cards(
            id integer primary key, nid integer not null, did integer not null,
            ord integer not null, mod integer not null, usn integer not null,
            type integer not null, queue integer not null, due integer not null,
            ivl integer not null, factor integer not null, reps integer not null,
            lapses integer not null, left integer not null, odue integer not null,
            odid integer not null, flags integer not null, data text not null
        );
        CREATE TABLE revlog(
            id integer primary key, cid integer not null, usn integer not null,
            ease integer not null, ivl integer not null, lastIvl integer not null,
            factor integer not null, time integer not null, type integer not null
        );
        CREATE TABLE graves(usn integer not null, oid integer not null, type integer not null);
        CREATE INDEX ix_notes_usn on notes(usn);
        CREATE INDEX ix_cards_usn on cards(usn);
        CREATE INDEX ix_revlog_usn on revlog(usn);
        CREATE INDEX ix_cards_nid on cards(nid);
        CREATE INDEX ix_cards_sched on cards(did,queue,due);
        CREATE INDEX ix_revlog_cid on revlog(cid);
        CREATE INDEX ix_notes_csum on notes(csum);
    """)

    model, decks, dconf = _build_col_json(deck_id, deck_name, model_id, now)
    c.execute(
        "INSERT INTO col VALUES(1,?,?,?,11,0,-1,0,'{}',?,?,?,'{}');",
        (now, now, now * 1000,
         json.dumps(model), json.dumps(decks), json.dumps(dconf)),
    )

    for i, card_tuple in enumerate(cards):
        front, back = card_tuple[0], card_tuple[1]
        note_id = deck_id * 100 + i
        card_id = deck_id * 100 + 50 + i
        flds    = f"{front}\x1f{back}"
        guid    = f"etd{deck_id:010d}{i:03d}"

        c.execute(
            "INSERT INTO notes VALUES(?,?,?,?,-1,'',?,?,?,0,'');",
            (note_id, guid, model_id, now, flds, front, _checksum(front)),
        )
        # type=0 (new), queue=0 (new), due=position (1..N).
        # NEW cards are served by the scheduler immediately and — unlike review
        # cards — their `due` is a queue position, NOT a day number relative to
        # the collection's `crt`. Review cards (queue=2, due=now//86400) land
        # ~20000 days in the future on any real collection (whose crt differs
        # from this file's), so the deck shows "0 due". New cards avoid that.
        c.execute(
            "INSERT INTO cards VALUES(?,?,?,0,?,-1,0,0,?,0,0,0,0,0,0,0,0,'');",
            (card_id, note_id, deck_id, now, i + 1),
        )

    conn.commit()
    conn.close()

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(db_path, "collection.anki2")
        zf.writestr("media", "{}")

    os.remove(db_path)
    return out_path


# ---------------------------------------------------------------------------
# Generate companion scenario metadata (JSON sidecar)
# The scenario runner reads this to know which answers to inject and what
# outcomes to expect.  Kept separate from the .apkg so the binary doesn't
# need to be re-parsed.
# ---------------------------------------------------------------------------

def write_scenario_json(profile_key: str) -> str:
    profile  = PROFILES[profile_key]
    out_path = os.path.join(FIXTURES_DIR, f"{profile_key}.scenario.json")
    data = {
        "profile":   profile_key,
        "deck_name": profile["deck_name"],
        "deck_id":   profile["deck_id"],
        "cards": [
            {
                "index":   i,
                "front":   c[0],
                "back":    c[1],
                "correct_answer_hint": c[2] if len(c) > 2 else c[1],
            }
            for i, c in enumerate(profile["cards"])
        ],
    }
    with open(out_path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    return out_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]

    if "--list" in args:
        print("Available profiles:")
        for k, p in PROFILES.items():
            n = len(p["cards"])
            print(f"  {k:<20} {p['deck_name']}  ({n} cards)")
        return

    targets = [a for a in args if not a.startswith("-")]
    if not targets:
        targets = list(PROFILES.keys())

    unknown = [t for t in targets if t not in PROFILES]
    if unknown:
        print(f"Unknown profile(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"Available: {', '.join(PROFILES.keys())}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(FIXTURES_DIR, exist_ok=True)

    for key in targets:
        apkg = build_apkg(key)
        meta = write_scenario_json(key)
        p    = PROFILES[key]
        print(f"[{key}] {apkg}")
        print(f"       {meta}")
        for i, card in enumerate(p["cards"]):
            print(f"       [{i + 1}] {card[0]}")
        print()


if __name__ == "__main__":
    main()
