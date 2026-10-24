# Background startup

The Linux client installer sets up the user-level `spool.service`, which starts at sign-in and restarts after failures. Server setup installs `spool-shared.service` separately and offers boot-time startup. Services keep credentials and history in private state directories outside your checkout.

```sh
systemctl --user status spool.service
journalctl --user -u spool.service -n 50 --no-pager
systemctl --user restart spool.service
```

Use `spool-shared.service` for relay maintenance. The Codex plugin also supports a companion that starts with the plugin without a separately installed service; see [plugin setup](codex-plugin.md).

To disable the client service reversibly: `systemctl --user disable --now spool.service`. Saved Codex history can be captured when the client starts again; uninterrupted live capture is not guaranteed while it is stopped.
