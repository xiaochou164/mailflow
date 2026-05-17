# Contributing to MailFlow

Thank you for your interest in contributing. This document covers the process and expectations for submitting changes.

## Before You Start

- Check the [issue tracker](https://github.com/maathimself/mailflow/issues) to see if the problem or feature is already being discussed.
- For significant changes, open an issue first to align on the approach before writing code.
- All contributions require agreement to the [Contributor License Agreement](CLA.md).

## Workflow

1. Fork the repository and create a branch from `main`.
2. Name your branch descriptively: `fix/describe-the-fix` or `feat/describe-the-feature`.
3. Make your changes, keeping the scope focused — one fix or feature per PR.
4. Open a pull request against `main` and fill out the PR template completely.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
fix: short description of what was fixed
feat: short description of what was added
chore: dependency updates, config changes, etc.
```

- Use the imperative mood ("add support for" not "adds support for")
- Keep the subject line under 72 characters
- No trailing period

## Pull Request Requirements

- CI must pass (backend and frontend checks)
- At least one approving review is required before merge
- The PR template must be filled out, including the CLA checkbox
- Keep changes minimal and focused — avoid unrelated cleanup in the same PR

## Code Style

- Match the style of the surrounding code
- Default to no comments — only add one when the reason behind something would genuinely surprise a future reader
- No half-finished implementations or feature flags for hypothetical future use
- Backend: Node/Express with async/await; avoid adding new dependencies without discussion
- Frontend: React with hooks; Tailwind for styling; avoid unnecessary abstraction

## Reporting Bugs

Use the [bug report template](https://github.com/maathimself/mailflow/issues/new?template=bug_report.md). Include steps to reproduce, expected behaviour, and actual behaviour. Screenshots or logs are helpful.

## Requesting Features

Use the [feature request template](https://github.com/maathimself/mailflow/issues/new?template=feature_request.md). Explain the problem you are trying to solve, not just the solution.
