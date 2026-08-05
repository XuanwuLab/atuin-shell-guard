set -eu

cat <<'PLAN' > tmp/bash-project-plan.txt
rm -rf docs
Remove-Item docs/presentation.pptx
PLAN

git clean -nfdx
kubectl delete pod demo --dry-run=client
