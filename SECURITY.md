# Security policy

## Supported versions

Graphward is a public alpha. Security fixes are applied to the latest released version and the default branch.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/speadskater/graphward/security/advisories/new). Do not include exploit details, private repository content, or credentials in a public issue.

Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgement within seven days. Please allow time for investigation and a coordinated fix before public disclosure.

## Security boundaries

Graphward is designed to keep indexed source, queries, graph data, and decisions on the local machine. Its dashboard binds to loopback, MCP uses stdio, and core runtime operation requires no outbound network access. Installing dependencies and interacting with GitHub or npm are separate, user-initiated network operations.
