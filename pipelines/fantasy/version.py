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
# 0127-0132.
SCHEMA_VERSION = "0132"
