---
name: git-workflow
description: Use when inspecting Git changes, staging files, creating commits, preparing branches, configuring or checking remotes, pushing changes, or preparing GitHub pull requests.
---

# Git Workflow

Preserve user work, keep operations reviewable, and never expose credentials.

## Inspect

1. Confirm the repository root, current branch, worktree status, and applicable task scope.
2. Inspect unstaged and staged diffs before deciding what belongs together.
3. Identify unrelated, generated, sensitive, unexpectedly large, or ignored files. Do not discard or absorb unrelated user changes.

## Stage

Stage explicit intended paths. Do not mechanically use git add . when narrower path selection is possible. Never force-add secrets, private raw sources, private task artifacts, or ignored local context.

After staging, review git diff --cached and run git diff --cached --check. Recheck status and remove unintended paths from the index without deleting the working copy.

## Commit

Confirm Git identity without changing it. If identity is missing, ask the user for user.name, user.email, and local or global scope; never change global configuration without explicit permission.

Use a clear Conventional Commit type such as feat, fix, docs, refactor, test, or chore. Keep commits coherent by meaning. After committing, inspect status and recent log before claiming success.

## Branches, Remotes, Pushes, and PRs

Inspect existing branches and remotes before mutation. Creating a GitHub repository requires an explicit owner and visibility. Pushing, opening a PR, changing a remote, or deleting a branch changes external state and must be within the user's requested scope.

Use gh auth status for authentication checks when GitHub CLI is available; never use a token-printing option or expose credential files.

## Prohibited Without Explicit Permission

- git reset --hard
- git clean -fd or git clean -fdx
- force push, including force-with-lease
- interactive history rewrite
- branch, tag, remote, or repository deletion
- overwriting an existing remote
- discarding existing changes

If a command partially succeeds or times out, verify local and remote state before retrying.
