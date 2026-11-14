# Dataverse Security Manager for Power Platform ToolBox

See who has access to what in Dataverse, and change it safely. A [Power Platform ToolBox](https://www.powerplatformtoolbox.com/) (PPTB) tool with four modules:

| Module | Use it to |
|---|---|
| **Role Analyzer** | Compare a table's privileges across all security roles (Privilege and Depth matrix), see who holds each role, edit privileges of one or several roles at once |
| **Access Explorer** | Inspect a user or team: direct and team roles, table privileges and where each one comes from; add or remove direct roles, per Business Unit and for several users at once; compare two users |
| **BU Manager** | Move users to another Business Unit and restore their roles, with a per-user dry run first |
| **Operations** | Review every change, copy a ticket-ready report, restore a change |

Unlike a plain role editor, it starts from the table ("who can do what on `account`?"), explains the origin of every privilege (direct role or team), and reads every change back from Dataverse before calling it a success.

## Other tools for security roles

Security Roles Explorer and User Access Explorer, also in the PPTB Marketplace, cover overlapping role analysis, table privileges and role assignments. User Access Explorer also shows where privileges come from: provenance alone is **not** unique to this tool. We have not compared the tools feature by feature; choose the one that fits your workflow.

Dataverse Security Manager brings these capabilities together:

- **Role holder analysis:** start with a table and security role, then inspect who holds that role directly or through teams, with user counts, team paths and Business Unit context.
- **Business Unit-aware role assignments:** select an exact BU-specific role instance and assign roles to several users. Cross-BU assignments are offered only when Dataverse's setting allows them. Assigning roles of the user's own Business Unit, a role of a different Business Unit, and roles to several users at once were each confirmed by the owner in the real host; the scenarios were not itemised and bulk assignment across different Business Units was not separately verified (see Testing).
- **Guided Business Unit moves:** preview a user's move, map the matching roles in the target BU, execute and verify the result.
- **Multi-role privilege editing:** stage privilege changes on several roles for one table in one review, then apply and verify each role separately.
- **Restorable change history:** record changes with before/after state and refuse unsafe restoration when the target has since changed.

These are the tool's practical strengths, not claims that each individual feature is exclusive. The tools can be installed side by side.

## Testing

The write operations were run by hand in PPTB Desktop against a real Developer Dataverse environment with test-owned data, and checked by the tool's read-back and, for most, by an independent read of Dataverse. Role assignment from the user's own and from a different Business Unit, and assignment to several users at once, were confirmed by the owner in the real host (scenario details and an independent read are not recorded; bulk assignment across different Business Units was not separately verified). Known limits: editing several roles at once has no independent read yet, restoring a Business Unit move and most side effects of a move (teams, owned records, manager) are not tested in a real environment. Details: [Testing evidence](https://github.com/juho1337/dataverse-security-manager/blob/main/docs/testing-evidence.md).

## What this tool changes
It writes to Dataverse only after you preview and confirm, and only these kinds of change:

- **Add or remove a privilege** (and its depth) on one or several security roles at once, each role applied and verified separately: `AddPrivilegesRole`, `RemovePrivilegeRole`.
- **Assign or remove a direct security role** of a user: `systemuserroles_association` associate / disassociate.
- **Move a user to another Business Unit** (the user's `businessunitid`), followed by assigning the matching roles of the target unit.
- **Restore** an earlier change of the kinds above (the same operations in reverse).

It changes no record data, solutions, metadata or settings. It never writes when it loads. It sends nothing anywhere except to your Dataverse environment through the PPTB host: no telemetry, no other network access.

**Safeguards:** every change is previewed and confirmed with the environment named; the environment is identified again right before each write; each step is read back and shown as verified, failed or uncertain. Production or unknown-type connections stay read-only until you acknowledge them. There is no automatic undo; **Operations** keeps a history you can export and restore from.

## Install
Needs **PPTB Desktop 1.2.7 or newer** and one active Dataverse connection.

- **From npm:** PPTB Desktop > Debug > **Install from npm** > enter `@juho1337/dataverse-security-manager`.
- **From source:** see the [development guide](https://github.com/juho1337/dataverse-security-manager/blob/main/docs/development.md).

## Documentation
- [User guide](https://github.com/juho1337/dataverse-security-manager/blob/main/docs/user-guide.md): each module, with screenshots, and what to watch out for.
- [Architecture](https://github.com/juho1337/dataverse-security-manager/blob/main/docs/architecture.md): layers, data flow and the write-safety model.
- [Development guide](https://github.com/juho1337/dataverse-security-manager/blob/main/docs/development.md): build, test, package, contribute.

## AI assistance
A substantial part of this tool's code and documentation was written with AI assistants (Claude Code and Codex). Every change was reviewed, tested and approved by the maintainer, [juho1337](https://github.com/juho1337), who is responsible for the tool. The tool was tested by a person in PPTB Desktop against a real Dataverse Developer environment.

## Licence
GPL-3.0-only. See `LICENSE`; bundled third-party packages are listed in `THIRD-PARTY-NOTICES.txt`.

## Support
Please open an [issue](https://github.com/juho1337/dataverse-security-manager/issues). Security problems: see `SECURITY.md`.
