"""Parser version — stamped onto every raw payload and every normalized row.

WHY THIS EXISTS. The raw layer (raw_yahoo_api_responses) is only useful if you
can find the payloads a given parser touched. Bumping this constant is what
makes "reparse everything the old parser handled" a query instead of a guess:

    SELECT * FROM raw_yahoo_api_responses WHERE parser_version < '...'

BUMP IT whenever parsing behaviour changes in a way that would produce different
normalized rows from the same payload. Do NOT bump it for logging, comments, or
changes confined to the CLI.
"""

PARSER_VERSION = "1.0.0"

# Bumped independently of the parser: the shape of the fantasy_* tables.
# Migrations 0132-0139. Renumbered from 0132-0139 on 2026-08-24: main had taken
# 0127-0131 for the penalty/lineup work while this branch was unmerged, so every
# number collided. Identify fantasy migrations by NAME (*_fantasy_*), never by
# number — the number is assigned by whoever merges first.
SCHEMA_VERSION = "0139"
