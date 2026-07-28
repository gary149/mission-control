/**
 * Wall-clock budget for each adapter's `detect()` `--version` probe. A
 * resolved binary path isn't proof it's runnable - detect() actually runs
 * the CLI and requires a clean exit within this window, or the harness
 * reports not-installed and every run against it is refused at preflight.
 *
 * Configurable via env rather than fixed: a `--version` probe that's
 * intermittently slower than 10s on a given host (observed for claude-code;
 * root cause unconfirmed - possibly its auto-update check, possibly just a
 * slow cold binary load) should not need a source-level patch that a fresh
 * install silently discards. `MC_DETECT_TIMEOUT_MS` is the escape hatch.
 * 10s stays the default: detect() runs on every `mc harness ls` (all
 * adapters, sequentially) and every `mc run` preflight, so the default must
 * stay tight - a slow host opts into a longer wait explicitly, everyone
 * else doesn't pay for it.
 */
export function detectTimeoutMs() {
    const raw = process.env.MC_DETECT_TIMEOUT_MS;
    if (!raw)
        return 10_000;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}
