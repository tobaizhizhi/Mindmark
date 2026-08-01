# Document Library Architecture
pnpm --filter @mindmark/agent-runner dev
pnpm --filter @mindmark/web dev
## Product model

Mindmark now separates document organization from learning structure:

```text
Folder
  -> Learning Project (one uploaded PDF/source)
      -> Chapters (a confirmed partition of the source)
          -> Knowledge Cards
```

A folder is navigation metadata only. It does not change source hashes, Outline
Draft hashes, Work Unit commitments, Registry state, card proofs, or review
provenance.

## Routes

- `/learn` is the document and folder library.
- `/learn/projects/new?folder=<uuid>` creates a Project in the selected folder.
- `/learn/projects/:projectId` opens the PDF's Chapter workspace.
- `/learn/projects/:projectId/chapters/:chapterId` opens one Chapter and its cards.

Draft Projects (`UPLOADED`, `OUTLINING`, or `OUTLINE_READY`) reopen the creation
workbench. Confirmed Projects open the Chapter workspace.

## Storage

`project_folders` stores the owner, display name, and optional parent folder.
`learning_projects.folder_id` is nullable; `null` represents the library root.
Existing Projects therefore remain visible without a data migration.

The folder table uses forced RLS and has no browser policy. All access goes
through service-role RPCs after the Web application verifies the wallet session.

## Server operations

- `get_document_library_v2` returns all owned folders and only the documents in
  the selected folder, including draft Projects.
- `create_project_folder_v2` validates parent ownership.
- `rename_project_folder_v2` preserves sibling-name uniqueness.
- `move_learning_project_to_folder_v2` validates both Project and folder owner.
- `delete_project_folder_v2` only deletes an empty folder.
- `register_learning_project_source_v2` accepts an optional `folder_id` and
  validates ownership before registering the source.

The library API derives `owner_address` exclusively from the wallet session.
Clients never submit an owner address.

## Invariants

1. One owner-scoped `clientRequestId` creates one idempotent Learning Project;
   a later upload may create another Project from identical source content.
2. Chapters cover the source and are created only after Outline confirmation.
3. Knowledge Cards belong to Chapters, never directly to folders.
4. Moving or renaming a folder cannot change any learning or chain commitment.
5. A non-empty folder cannot be deleted.
6. A wallet cannot use, inspect, or move content into another wallet's folder.
