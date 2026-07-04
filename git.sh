#!/bin/sh
# git.sh — run git for this repo on a host that has no git binary.
#
# Wraps a containerized git (alpine/git) with the GitHub SSH deploy key, the
# commit identity, and safe.directory already wired in. Agents: use this for
# ALL git operations in this repo. Examples:
#
#   ./git.sh status
#   ./git.sh add -A
#   ./git.sh commit -m "message"
#   ./git.sh push
#   ./git.sh log --oneline
#
# Overridable via env: MANGA_DL_GIT_SSH_KEY, MANGA_DL_GIT_IMAGE,
# MANGA_DL_GIT_NAME, MANGA_DL_GIT_EMAIL.
set -e

REPO_DIR=$(cd "$(dirname "$0")" && pwd)
SSH_KEY="${MANGA_DL_GIT_SSH_KEY:-/var/services/homes/Jim/.ssh/id_ed25519_github}"
SSH_DIR=$(dirname "$SSH_KEY")
KEY_NAME=$(basename "$SSH_KEY")
GIT_IMAGE="${MANGA_DL_GIT_IMAGE:-alpine/git}"
GIT_NAME="${MANGA_DL_GIT_NAME:-east35}"
GIT_EMAIL="${MANGA_DL_GIT_EMAIL:-jimj512@icloud.com}"

exec docker run --rm \
  -v "$REPO_DIR":/git -w /git \
  -v "$SSH_DIR":/root/.ssh \
  -e GIT_SSH_COMMAND="ssh -i /root/.ssh/$KEY_NAME -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
  --entrypoint git \
  "$GIT_IMAGE" \
  -c safe.directory=/git \
  -c user.name="$GIT_NAME" \
  -c user.email="$GIT_EMAIL" \
  "$@"
