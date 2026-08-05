set -eu

target=docs
cleanup_project() {
  for file in presentation.pptx report.docx; do
    rm "$target/$file"
  done
}

if [ "${RUN_CLEANUP:-0}" = 1 ]; then
  cleanup_project
else
  echo "cleanup disabled"
fi
