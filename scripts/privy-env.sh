#!/usr/bin/env bash
# The Privy lines of the server's .env, rewritten on every deploy (2026-11-02). Run from the app dir.
#
# The app secret on the NA box went bad on 11-01 and could only be fixed over SSH. It now lives in the repo secret
# PRIVY_APP_SECRET (GitHub > Settings > Secrets and variables > Actions); deploy.yml pipes it to this script's
# STDIN over ssh. Never an argument: an argument of the remote shell is readable in /proc/<pid>/cmdline by every
# process on the box for as long as the deploy runs (Fable review 2026-11-02). Here it is a shell variable, then
# awk's environment, which only its own user can read.
#
# Leaves .env with one PRIVY_APP_ID line (the last, the one dotenv was using; .env had it twice) and one
# PRIVY_APP_SECRET line: the secret from stdin when one came, else the last line already there (so the 16-character
# placeholder before it goes). Prints nothing from .env, ever: this repo and its Actions logs are public. The file
# stays 600 and is replaced only when it changed. No .env here: nothing to do.
set -eu
umask 077
if [ ! -f .env ]; then echo ".env: none here, left alone"; exit 0; fi

PRIVY_APP_SECRET=''
IFS= read -r PRIVY_APP_SECRET || true
PRIVY_APP_SECRET=${PRIVY_APP_SECRET%$'\r'}
# Privy secrets are letters, digits and underscores; anything else is a bad paste, not written.
if [ -n "$PRIVY_APP_SECRET" ] && ! { [[ "$PRIVY_APP_SECRET" =~ ^[A-Za-z0-9_-]+$ ]] \
    && [ "${#PRIVY_APP_SECRET}" -ge 20 ] && [ "${#PRIVY_APP_SECRET}" -le 300 ]; }; then
  echo ".env: the PRIVY_APP_SECRET repo secret does not look like a Privy app secret; not written"
  PRIVY_APP_SECRET=''
fi
export PRIVY_APP_SECRET

awk '
  { line[NR] = $0 }
  /^PRIVY_APP_ID=/ { lastId = NR }
  /^PRIVY_APP_SECRET=/ { lastSec = NR }
  END {
    sec = ENVIRON["PRIVY_APP_SECRET"]
    for (i = 1; i <= NR; i++) {
      l = line[i]
      if (l ~ /^PRIVY_APP_ID=/ && i != lastId) continue
      if (l ~ /^PRIVY_APP_SECRET=/) {
        if (i != lastSec) continue
        if (sec != "") l = "PRIVY_APP_SECRET=" sec
      }
      print l
    }
    if (!lastSec && sec != "") print "PRIVY_APP_SECRET=" sec
  }' .env > .env.privy-tmp
unset PRIVY_APP_SECRET

if cmp -s .env .env.privy-tmp; then
  rm -f .env.privy-tmp
  echo ".env: Privy lines unchanged"
else
  chmod 600 .env.privy-tmp
  mv .env.privy-tmp .env
  echo ".env: Privy lines updated (restart to load them)"
fi
