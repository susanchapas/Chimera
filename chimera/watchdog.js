const { ENV, watchdogHostWarning, WATCHDOG_MIN_INTERVAL_MS } = require("./preflight.js")
// dotenv swallows a read error instead of throwing, and every setting would then read as unset
const { error: envError } = require("dotenv").config({ path: ENV })
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")
const { composeCommand, runCompose } = require("./compose.js")
const healthChecks = require("../lib/utils/healthChecks.js")
const gatewayHost = require("../lib/utils/gatewayHost.js")
const webhookAlert = require("../lib/utils/webhookAlert.js")
const { readJSON, writeJSON } = require("../lib/utils/jsonFileHandling.js")

const STAGES = ["restart", "reboot"]
const STATE_FILE = path.join(__dirname, "watchdog.state.json")
const POLL_TIMEOUT_MS = 10000
const RESTART_ARGS = ["up", "-d", "--force-recreate"]
const NO_REBOOT = `no reboot command known for platform ${process.platform} — the watchdog cannot recover this host`
const NOTHING_TO_POLL = "no service has both *_ON=true and *_PROXY_ON=true — nothing runs on this host that the gateway routes a health endpoint for"
const NO_HOST = "gateway_HOST is empty — every health URL would be a relative path that fetch cannot parse, so every poll would read as an outage and reboot a healthy host"
const unreadableEnv = ({ code, message }) => `cannot read ${ENV} (${code ?? message}) and watchdog_ON is not set in the environment either — every setting reads as unset, and the watchdog would exit clean while polling nothing`

// only services that run here: a reboot of this host cannot fix an off-box one
const checkUrl = () => healthChecks({ localOnly: true })

// dotenv never overrides an already-set variable, so a systemd Environment= or an exported shell var wins over .env.
// The warning has to read what settings() and checkUrl() read, or it stays silent on exactly the setups that break.
const envLines = (env = process.env) => ["watchdog_ON", "gateway_HOST"].map(k => `${k} = ${env[k] ?? ""}`)

const settings = () => ({
	enabled: process.env.watchdog_ON === "true",
	intervalMs: Math.max(WATCHDOG_MIN_INTERVAL_MS, Number(process.env.watchdog_INTERVAL_MS) || 60000),
	threshold: Number(process.env.watchdog_FAILURES) || 3
})

const poll = async (urls = checkUrl()) => {
	const results = await Promise.all(Object.entries(urls).map(async ([name, url]) => {
		try {
			const { ok, status } = await fetch(url, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) })
			return ok ? null : `${name} → ${status}`
		} catch ({ message }) {
			return `${name} → ${message}`
		}
	}))
	return results.filter(Boolean)
}

const hasSystemd = () => fs.existsSync("/run/systemd/system")

const rebootCommand = (platform = process.platform, systemd = hasSystemd) =>
	platform === "win32" ? ["shutdown", "/r", "/t", "0"]
		: platform === "darwin" ? ["shutdown", "-r", "now"]
			: platform === "linux" ? (systemd() ? ["systemctl", "reboot"] : ["shutdown", "-r", "now"])
				: null

const privileged = (command, platform = process.platform, uid = process.getuid?.()) =>
	platform === "win32" || uid === 0 ? command : ["sudo", "-n", ...command]

const nextStage = (stage) => (stage + 1) % STAGES.length

const fail = (reason) => {
	console.error(reason)
	process.exitCode = 1
	return false
}

const rebootArgv = () => {
	const command = rebootCommand()
	return command && privileged(command)
}

const reboot = () => {
	const argv = rebootArgv()
	if (!argv) return fail(NO_REBOOT)
	const [command, ...args] = argv
	console.log(`watchdog: ${argv.join(" ")}`)
	const { status, error } = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" })
	if (error) return fail(error.code === "ENOENT"
		? `reboot command not found: ${command}`
		: `reboot command failed: ${error.message}`)
	if (status !== 0) return fail(`\`${argv.join(" ")}\` exited ${status} — this user cannot reboot the host; grant it the privilege listed in the README watchdog section`)
	return true
}

const restart = () => {
	const { status, error } = runCompose(RESTART_ARGS)
	if (error) return fail(error.message)
	if (status !== 0) return fail(`\`${composeCommand(RESTART_ARGS).join(" ")}\` exited ${status ?? "without status"} — the stack was not restarted; check this user's Docker daemon access, listed in the README watchdog section`)
	return true
}

const readState = () => new Promise(resolve =>
	readJSON(STATE_FILE, (_, data) => resolve({ failures: 0, stage: 0, ...data })))

const writeState = (state) => new Promise(resolve => writeJSON(STATE_FILE, state, resolve, ({ message }) => {
	fail(`watchdog: cannot write ${STATE_FILE} (${message}) — the failure count cannot survive this run, so the watchdog will never reach its threshold`)
	resolve()
}))

const act = async (stage, failed) => {
	await webhookAlert(`⚠️ Chimera watchdog on ${os.hostname()}: ${stage === "reboot" ? "rebooting the host" : "restarting the stack"}\n${failed.join("\n")}`)
	return stage === "reboot" ? reboot() : restart()
}

// one healthy poll after a restart proves nothing — a fault the restart only masked (a wedged
// bridge, an exhausted conntrack table) would reset the stage and never reach the reboot that clears it
const recover = (state, threshold) => {
	if (state.failures) console.log("watchdog: healthy again, failure count reset")
	const healthy = (state.healthy || 0) + 1
	const cleared = healthy >= threshold
	if (cleared && state.stage) console.log(`watchdog: ${healthy} healthy polls in a row, escalation reset to ${STAGES[0]}`)
	return writeState({ failures: 0, healthy: cleared ? 0 : healthy, stage: cleared ? 0 : state.stage })
}

const runOnce = async () => {
	const { threshold } = settings()
	const urls = checkUrl()
	const failed = await poll(urls)
	const state = await readState()
	if (!failed.length) return recover(state, threshold)
	const failures = state.failures + 1
	console.log(`watchdog: ${failures}/${threshold} consecutive failures — ${failed.join(", ")}`)
	if (failures < threshold) return writeState({ ...state, failures, healthy: 0 })
	// only a total outage is a host-level fault. One slow service (object inference can outrun the
	// 10s timeout under load) gets the stack restarted, but never takes the whole machine down
	const total = failed.length === Object.keys(urls).length
	const stage = total ? STAGES[state.stage] || STAGES[0] : STAGES[0]
	// committed before the action, so a reboot that cuts this process off still comes back on the restart stage
	await writeState({ failures: 0, healthy: 0, stage: total ? nextStage(state.stage) : state.stage })
	// a restart the daemon refused left the stack untouched, so the next threshold must not reboot over it
	if (!await act(stage, failed)) await writeState({ failures: 0, healthy: 0, stage: state.stage })
}

const loop = async () => {
	const { intervalMs } = settings()
	for (;;) {
		await runOnce()
		await new Promise(resolve => setTimeout(resolve, intervalMs))
	}
}

const dryRun = () => {
	const argv = rebootArgv()
	console.log(composeCommand(RESTART_ARGS).join(" "))
	console.log(argv ? argv.join(" ") : NO_REBOOT)
	console.log(Object.values(checkUrl()).join("\n") || NOTHING_TO_POLL)
}

// Each of these would otherwise look like a clean run while nothing is polled, or fail every poll on a
// healthy host. An enabled watchdog that cannot do its job has to say so and exit 1, not exit 0 quietly.
const envProblem = (error = envError, env = process.env) => error && !env.watchdog_ON ? unreadableEnv(error) : null

const configProblem = () =>
	envProblem() ? envProblem()
		: !settings().enabled ? null
			: !gatewayHost() ? NO_HOST
				: !Object.keys(checkUrl()).length ? NOTHING_TO_POLL
					: null

if (require.main === module) {
	const hostWarning = watchdogHostWarning(envLines())
	if (hostWarning) console.warn(hostWarning)
	const problem = configProblem()
	if (process.argv.includes("--dry-run")) dryRun()
	else if (problem) fail(problem)
	else if (!settings().enabled) console.log("watchdog_ON is not true — nothing to do")
	else (process.argv.includes("--once") ? runOnce() : loop()).catch(({ message }) => fail(message))
}

module.exports = { STAGES, NO_HOST, NOTHING_TO_POLL, checkUrl, configProblem, envProblem, envLines, settings, poll, rebootCommand, privileged, nextStage, runOnce, restart, reboot }
