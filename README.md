# Dataverse Security Manager for Power Platform ToolBox

See who has access to what in Dataverse, and change it safely. A [Power Platform ToolBox](https://www.powerplatformtoolbox.com/) (PPTB) tool with four modules:

| Module | Use it to |
|---|---|
| **Role Analyzer** | Compare a table's privileges across all security roles (Privilege and Depth matrix), see who holds each role, edit privileges of one or several roles at once |
| **Access Explorer** | Inspect a user or team: direct and team roles, table privileges and where each one comes from; add or remove direct roles; compare two users |
| **BU Manager** | Move users to another Business Unit and restore their roles, with a per-user dry run first |
| **Operations** | Review every change, copy a ticket-ready report, restore a change |

Unlike a plain role editor, it starts from the table ("who can do what on `account`?"), explains the origin of every privilege (direct role or team), and reads every change back from Dataverse before calling it a success.

## Other tools for security roles

Other PPTB tools also show and edit security roles and role assignments, for example Advanced Security Roles Explorer and User Security Manager. This tool does not replace them for everything: it differs in that it explains where each privilege comes from, moves users between Business Units and restores their roles, and keeps a history of every change that can be restored. Pick the tool that fits the task; they can be installed side by side.

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
