#!/bin/bash
# Lists this repo's own leftover test folders in the temp folder and, with --yes, removes them.
# Only exact test prefixes with a 6-character random end, untouched for over 90 minutes, so a test running now is left alone.
T="${TMPDIR:-/tmp}"
P='wp-memory-capture|guard-sessions|wp-learn|jtu-repo|wp-caps-repo|jtu-data|wp-rule-place|wp-claude|yt-nudge-link|wp-vault-key|wp-vault|wp-rules-slugs|wp-rules-live|wp-rules|wp-plugin|wp-pack|wp-new-home|wp-memnote-git|wp-memnote-db|wp-memnote-brain|wp-memnote|wp-memhook|wp-memcli|wp-guard-claude|wp-fake-claude|wp-export|wp-empty-claude|wp-claude-files|wp-cfgdir|wp-budget-repo|wp-budget-nogit|wp-budget-home|wp-budget-[a-z]+|wp-budget|wp-brain-test|wp-brain-db|wp-backup|wp-backfill|wp-archive-race|wp-archive-cli|wp-archive|vault-up|vault-storage|vault-pack|vault-manifest|vault-crypto|guard-slow-git|guard-repo|guard-pr|guard-none|guard-msg|guard-home|guard-cd|guard-body|guard-bare|wp-stub'
list() { find -E "$T" -maxdepth 1 -type d -regex ".*/($P)-[A-Za-z0-9]{6}" -mmin +90 -print0; }

echo "Folders: $(list | tr -cd '\0' | wc -c | tr -d ' ')"
if [ "$1" != "--yes" ]; then
	echo "Size: $(list | xargs -0 du -sk 2>/dev/null | awk '{s+=$1} END {printf "%.1f GB", s/1048576}')"
	echo 'Nothing removed. To remove them: bash cli/clean-test-temp.sh --yes'
	exit 0
fi
df -h / | tail -1
list | xargs -0 rm -rf
df -h / | tail -1
