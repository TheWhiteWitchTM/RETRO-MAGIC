#!/bin/bash
git add -A
if [ -n "$1" ]; then
  git commit -m "$1"
else
  git commit -m "Update"
fi
git push
