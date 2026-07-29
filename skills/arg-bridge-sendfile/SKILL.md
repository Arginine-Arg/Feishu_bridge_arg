---
name: arg-bridge-sendfile
description: Deliver an agent-produced local artifact through the active arg-bridge Feishu/Lark conversation. Use when the user needs the actual file, image, report, data export, or generated artifact in chat rather than a textual summary or a local path.
---

# Arg Bridge Sendfile

Use the bridge-owned command only after the file has been written and verified. The bridge chooses the chat, reply target, and permitted root; do not use `lark-cli` for this operation.

## Workflow

1. Confirm that the user needs the file itself. Do not upload a file merely because it was read or mentioned.
2. Verify it is a regular file inside the current working directory. Do not use an absolute path, `..`, a symlink, or a directory.
3. Send it with:

```bash
arg-bridge sendfile relative/path/to/artifact.ext --caption "Short description"
```

4. Report only the meaningful outcome. If the command fails, fix the path or file before retrying; never bypass the bridge capability.

## Constraints

- The command is available only inside an active arg-bridge agent run.
- The path is relative to the agent's current working directory.
- The bridge enforces workspace containment, regular-file status, and the current profile's file-size limit.
- A live terminal's token is scope-bound; it may be reused across turns but cannot be used outside the active bridge conversation.
