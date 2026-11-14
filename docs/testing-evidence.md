# Testing evidence

What was tested against a real environment, and what was not. Two kinds of evidence are kept apart:

- **Real host:** run by hand in PPTB Desktop 1.2.7 against a real Developer Dataverse environment, using only test-owned roles, Business Units and one nominated test user. Results were checked by the tool's own read-back and, where marked, by an independent read of Dataverse made outside the tool.
- **Synthetic:** automated tests against an in-memory Dataverse (about 1,100 tests). They prove the logic, not the behaviour of the real service.

Production environments were never used. No tenant, environment or user identifiers are published here.

## Write operations tested in the real host

| Operation | Scenario | Result | Independent read of Dataverse |
|---|---|---|---|
| Add, change and remove a table privilege on a role | Five cycles on one test role (add at User, change to Business Unit, change to Parent: Child BU, remove) | Verified; other test roles unchanged | Yes |
| Assign and remove a direct role of a user | Assign, remove | Verified | Yes |
| Move a user to another Business Unit, with the target unit's matching roles assigned again | Moves between two test units, in both directions | Verified; Dataverse removed the user's direct roles on the move and the equivalent roles of the target unit were assigned again | Yes |
| Batch with a partial failure | Three role assignments, one role deleted after the preview | Two verified, one failed and classified, result reported as partly applied; history recorded all three steps | Yes |
| Assign a security role to a user, Business Unit-aware | Single user, through the tool: (1) roles of the user's home Business Unit; (2) a role belonging to a different Business Unit | Both passed (reported by the owner on 2026-11-15) | Not recorded for this test |
| Assign security roles to several users at once | Bulk assignment through the tool | Passed (reported by the owner on 2026-11-15; the number of users, their Business Units and the exact steps were not recorded) | Not recorded for this test |
| Restore of a role assignment | Assign, restore, restore again, restore after a manual change, restore of two operations together, restore of a mix of restorable and refused operations, restore of an old entry without a before-state, connection switched with a preview open | All behaved as specified; refused cases sent nothing | Snapshots of the user before and after matched where expected |
| Restore of a privilege edit | Edit one privilege, restore it | Verified; privilege back to the earlier depth | Yes |

Also checked in the real host: the matrices and table-privilege views (240 of 240 matrix cells and 48 of 48 team privilege cells equal an independent read), history persisted between sessions, exports and reports, and the environment identification that gates every write.

## Not covered by real-host evidence

- **Editing several roles in one staged operation.** The owner ran it in PPTB Desktop and the tool's per-role read-back showed each role verified, but the result has **not yet been compared with an independent read** of Dataverse. The single-role path it is built from is covered above.
- **Business Unit-aware role assignment beyond the two single-user scenarios above.** The owner confirmed the assignment of home-Business-Unit roles and of a role of a different Business Unit to a single user. No further scenarios were recorded. The owner also reported that assignment to several users at once passed, without scenario details. Not separately verified in a real environment: **bulk assignment to users of different home Business Units or of another Business Unit's roles**, removing a role that belongs to another Business Unit, holding the same role from two Business Units, the refusal paths (setting off or unreadable), and Modernized Business Unit configurations other than the one tested. These are covered by synthetic tests only.
- **Restoring a Business Unit move.** Moving a user back is covered by synthetic tests only.
- **Side effects of a Business Unit move** other than the removal of direct roles: team memberships, records the user owns, the user's manager and direct reports, and plug-ins or workflows. They were not examined and the tool does not claim anything about them; its preview lists them as not verified.
- **A failing step in the middle of a batch** followed by a successful one, and the **error produced by a duplicate role assignment** (the tool never sends one; it plans it as "already assigned").
- **Interrupting a restore** (closing the host mid-restore) and **switching between two live connections** (a preview discarded on a connection change was tested).
- **Very large environments** (many thousands of users or roles, results above the 5,000-row FetchXML limit) and PPTB versions older than 1.2.7.

Evidence is limited to table privileges, role assignments and Business Unit placement. The tool changes nothing else, and these tests say nothing about record-level access.
