# Branded browser smoke procedure

Run these checks in the exact isolated branded browser identified by the matching matrix tuple. Complete `capture` first. Copy its target, observed version, `capturedAt`, and capture receipt hash into the matching smoke receipt without editing those fields. Set `testedAt` no earlier than `capturedAt`. Record one `passed` or `failed` result and factual notes for every check. Do not use a Playwright bundled engine, a browser download, or another product as a substitute.

## `root-create`

Open `/`. Confirm the React create interface is visible, create a protected paste, and retain the generated credential-free view URL.

## `password-post-hard-refresh`

Open the credential-free view URL. Submit the native password form, confirm full navigation leaves exactly one URL-encoded password query, then hard refresh that URL.

## `ordinary-edit-autosave`

Open an ordinary paste, edit plain source, wait for the one-second autosave, and confirm the saved content remains after refresh.

## `tabs-sheet`

Exercise the Tabs, Sheet, and Dialog controls with keyboard focus, Escape, and the visible controls. Confirm focus returns to the invoking control after each dismiss.

## `raw-html-md-file`

Open raw, HTML, Markdown, and file representations for the paste. Confirm each representation has the expected content and that active HTML is only tested with same-origin fixture content.

## `delete-root-handoff`

Delete the paste through the delete dialog. Confirm the root handoff occurs and a hard refresh does not restore stale feedback or the deleted paste.

The smoke receipt has schema version 2, six check IDs listed above exactly once, a nonempty tester, and only `passed` statuses for release acceptance. `record-pass` validates the receipt against its immutable capture receipt and the closed product/slot mapping.
