# Contributing to Graphward

Thanks for helping improve Graphward. Bug reports, focused fixes, documentation improvements, and well-scoped feature proposals are welcome.

## Before opening a change

- Search existing issues before filing a duplicate.
- Use a GitHub Security Advisory for vulnerabilities; do not open a public security issue.
- Discuss large architectural changes in an issue before investing in an implementation.
- Keep source, tests, and fixtures local. Contributions must not add telemetry, hosted dependencies, or outbound runtime calls without explicit project discussion.

## Development setup

Graphward requires Node.js 22.18 or newer; Node.js 24 LTS is recommended.

```shell
git clone https://github.com/speadskater/graphward.git
cd graphward
npm ci
npm test
```

Use `node .\src\cli.mjs --help` to run the development checkout without installing it globally. Use `npm link` when you need the `graphward` command on `PATH`.

## Pull requests

- Keep each pull request focused on one coherent change.
- Add or update tests for behavior changes.
- Run `npm test` before submitting.
- Update the README, architecture notes, or changelog when public behavior changes.
- Preserve explicit bounds, repository isolation, loopback-only networking, and `CannotProve` semantics.
- Explain any AI-assisted changes you have not manually verified. Contributors remain responsible for every submitted line.

By contributing, you agree that your contribution is licensed under the MIT License.
