let mockState = {}
let mockWriteFails = false

jest.mock("child_process", () => ({ spawnSync: jest.fn(() => ({ status: 0 })) }))
jest.mock("../compose.js", () => ({
	composeCommand: jest.fn((args) => ["docker", "compose", ...args]),
	runCompose: jest.fn(() => ({ status: 0 }))
}))
jest.mock("../../lib/utils/webhookAlert.js", () => jest.fn(() => Promise.resolve()))
jest.mock("../../lib/utils/jsonFileHandling.js", () => ({
	readJSON: (_p, cb) => cb(null, mockState),
	writeJSON: (_p, data, cb, onFail) => {
		if (mockWriteFails) return onFail(new Error("EACCES: permission denied"))
		mockState = data
		cb()
	}
}))

const SERVICES = ["command", "livestream", "object", "schedule", "storage"]

process.env.gateway_HOST = "http://127.0.0.1:8080"
process.env.watchdog_FAILURES = "3"
for (const s of SERVICES) {
	process.env[`${s}_ON`] = "true"
	process.env[`${s}_PROXY_ON`] = "true"
}

const { spawnSync } = require("child_process")
const { runCompose } = require("../compose.js")
const webhookAlert = require("../../lib/utils/webhookAlert.js")
const { WATCHDOG_MIN_INTERVAL_MS, watchdogHostWarning } = require("../preflight.js")
const { checkUrl, configProblem, envProblem, envLines, settings, rebootCommand, privileged, nextStage, runOnce, restart, reboot, STAGES, NO_HOST, NOTHING_TO_POLL } = require("../watchdog.js")

const healthy = () => Promise.resolve({ ok: true, status: 200 })
const down = () => Promise.resolve({ ok: false, status: 502 })

beforeEach(() => {
	mockState = {}
	mockWriteFails = false
	global.fetch = jest.fn(down)
	jest.spyOn(console, "log").mockImplementation(() => {})
	jest.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	process.exitCode = undefined
	jest.restoreAllMocks()
})

describe("health endpoints", () => {
	test("polls the same five gateway paths the heartbeat does", () => {
		expect(checkUrl()).toEqual({
			command: "http://127.0.0.1:8080/command/health",
			livestream: "http://127.0.0.1:8080/livestream/health",
			object: "http://127.0.0.1:8080/object/health",
			schedule: "http://127.0.0.1:8080/schedule/health",
			storage: "http://127.0.0.1:8080/storage/health"
		})
	})

	// the gateway does not route an unproxied service, so polling it would reboot a healthy host
	test("an unproxied service is not polled", () => {
		process.env.object_PROXY_ON = "false"
		expect(Object.keys(checkUrl())).not.toContain("object")
		process.env.object_PROXY_ON = "true"
	})

	test("an off-box service the gateway proxies is not polled", () => {
		process.env.storage_ON = "false"
		expect(Object.keys(checkUrl())).not.toContain("storage")
		expect(Object.keys(require("../../lib/utils/healthChecks.js")())).toContain("storage")
		process.env.storage_ON = "true"
	})

	test("the heartbeat watches everything proxied, the watchdog only what runs here", () => {
		expect(require("../../lib/utils/healthChecks.js")()).toEqual(checkUrl())
	})
})

describe("settings", () => {
	afterEach(() => { delete process.env.watchdog_INTERVAL_MS })

	// nothing runs preflight before `npm run watchdog`, so 60 meaning seconds would poll every 60ms
	test("clamps a seconds-for-milliseconds interval to the floor", () => {
		process.env.watchdog_INTERVAL_MS = "60"
		expect(settings().intervalMs).toBe(WATCHDOG_MIN_INTERVAL_MS)
	})

	test("leaves a sane interval alone, and falls back to a minute when unset", () => {
		process.env.watchdog_INTERVAL_MS = "30000"
		expect(settings().intervalMs).toBe(30000)
		delete process.env.watchdog_INTERVAL_MS
		expect(settings().intervalMs).toBe(60000)
	})
})

describe("restart failures", () => {
	// a silent failure lets the escalation advance and reboot a host whose stack was never actually restarted
	test("a compose exit code this user cannot fix is reported, not swallowed", () => {
		runCompose.mockReturnValueOnce({ status: 1 })
		restart()
		expect(process.exitCode).toBe(1)
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Docker daemon access"))
	})

	test("a spawn error is reported too", () => {
		runCompose.mockReturnValueOnce({ error: new Error("spawn docker ENOENT") })
		restart()
		expect(process.exitCode).toBe(1)
		expect(console.error).toHaveBeenCalledWith("spawn docker ENOENT")
	})

	test("a clean restart leaves the exit code alone", () => {
		restart()
		expect(process.exitCode).toBeUndefined()
	})
})

describe("rebootCommand", () => {
	test("linux with systemd", () => {
		expect(rebootCommand("linux", () => true)).toEqual(["systemctl", "reboot"])
	})

	test("linux without systemd", () => {
		expect(rebootCommand("linux", () => false)).toEqual(["shutdown", "-r", "now"])
	})

	test("macOS", () => {
		expect(rebootCommand("darwin")).toEqual(["shutdown", "-r", "now"])
	})

	test("windows", () => {
		expect(rebootCommand("win32")).toEqual(["shutdown", "/r", "/t", "0"])
	})

	test("an unknown platform has no command, so the caller can exit non-zero", () => {
		expect(rebootCommand("aix")).toBeNull()
	})

	test("no platform ever powers the machine off or writes to sysrq-trigger", () => {
		for (const platform of ["linux", "darwin", "win32"]) {
			const command = (rebootCommand(platform, () => true) || []).join(" ")
			expect(command).not.toMatch(/sysrq/)
			expect(command).not.toMatch(/poweroff|halt|\/s\b|-h\b/)
			expect(command).toMatch(/reboot|-r|\/r/)
		}
	})
})

describe("privileged", () => {
	test("root runs the command as-is", () => {
		expect(privileged(["systemctl", "reboot"], "linux", 0)).toEqual(["systemctl", "reboot"])
	})

	test("a non-root posix user goes through non-interactive sudo, so a missing rule fails loudly", () => {
		expect(privileged(["systemctl", "reboot"], "linux", 1000)).toEqual(["sudo", "-n", "systemctl", "reboot"])
	})

	test("windows has no sudo", () => {
		expect(privileged(["shutdown", "/r", "/t", "0"], "win32", undefined)).toEqual(["shutdown", "/r", "/t", "0"])
	})
})

describe("escalation order", () => {
	test("restart comes first, reboot second, then it starts over", () => {
		expect(STAGES).toEqual(["restart", "reboot"])
		expect(nextStage(0)).toBe(1)
		expect(nextStage(1)).toBe(0)
	})
})

describe("reboot failures", () => {
	const run = (result) => {
		spawnSync.mockReturnValueOnce(result)
		reboot()
	}

	test("reports a non-zero exit code naming the missing command", () => {
		run({ error: Object.assign(new Error("spawn"), { code: "ENOENT" }) })
		expect(process.exitCode).toBe(1)
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("reboot command not found"))
	})

	test("reports a non-zero exit code pointing at the missing privilege", () => {
		run({ status: 1 })
		expect(process.exitCode).toBe(1)
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("cannot reboot the host"))
	})

	// process.exit would kill the loop, taking the restart stage down with the reboot stage
	test("a failed reboot leaves the process alive", () => {
		const exit = jest.spyOn(process, "exit").mockImplementation(() => {})
		run({ status: 1 })
		expect(exit).not.toHaveBeenCalled()
	})
})

describe("runOnce", () => {
	const failUntilThreshold = async () => {
		for (let i = 0; i < 3; i++) await runOnce()
	}

	test("does nothing until the threshold is reached", async () => {
		await runOnce()
		await runOnce()
		expect(runCompose).not.toHaveBeenCalled()
		expect(spawnSync).not.toHaveBeenCalled()
		expect(mockState.failures).toBe(2)
	})

	test("restarts the stack on the threshold, and reboots only on the next one", async () => {
		await failUntilThreshold()
		expect(runCompose).toHaveBeenCalledWith(["up", "-d", "--force-recreate"])
		expect(spawnSync).not.toHaveBeenCalled()

		await failUntilThreshold()
		expect(spawnSync).toHaveBeenCalledTimes(1)
		expect(runCompose).toHaveBeenCalledTimes(1)
	})

	test("keeps cycling restart → reboot forever, with no give-up state", async () => {
		for (let i = 0; i < 4; i++) await failUntilThreshold()
		expect(runCompose).toHaveBeenCalledTimes(2)
		expect(spawnSync).toHaveBeenCalledTimes(2)
	})

	test("alerts before the reboot command runs", async () => {
		await failUntilThreshold()
		await failUntilThreshold()
		expect(webhookAlert).toHaveBeenCalledTimes(2)
		expect(webhookAlert.mock.invocationCallOrder[1]).toBeLessThan(spawnSync.mock.invocationCallOrder[0])
		expect(webhookAlert.mock.calls[1][0]).toMatch(/rebooting the host/)
	})

	test("a healthy poll resets the count", async () => {
		await runOnce()
		await runOnce()
		global.fetch = jest.fn(healthy)
		await runOnce()
		expect(mockState).toMatchObject({ failures: 0, stage: 0 })

		global.fetch = jest.fn(down)
		await failUntilThreshold()
		expect(runCompose).toHaveBeenCalledWith(["up", "-d", "--force-recreate"])
		expect(spawnSync).not.toHaveBeenCalled()
	})

	// a fault a restart papers over for a minute would reset the stage on the first healthy poll and
	// restart forever, never reaching the reboot that clears it
	test("one healthy poll does not clear the escalation stage — a full threshold of them does", async () => {
		await failUntilThreshold()
		expect(mockState.stage).toBe(1)

		global.fetch = jest.fn(healthy)
		await runOnce()
		expect(mockState.stage).toBe(1)

		global.fetch = jest.fn(down)
		await failUntilThreshold()
		expect(spawnSync).toHaveBeenCalledTimes(1)

		global.fetch = jest.fn(healthy)
		for (let i = 0; i < 3; i++) await runOnce()
		expect(mockState).toMatchObject({ failures: 0, stage: 0 })
	})

	// the stage was committed before the action ran, so a stack that was never restarted promoted itself to reboot
	test("a restart the daemon refused does not promote the next escalation to reboot", async () => {
		runCompose.mockReturnValue({ status: 1 })
		await failUntilThreshold()
		expect(mockState.stage).toBe(0)

		await failUntilThreshold()
		expect(runCompose).toHaveBeenCalledTimes(2)
		expect(spawnSync).not.toHaveBeenCalled()
		runCompose.mockReturnValue({ status: 0 })
	})

	// /object/health answers in-band with inference and can outrun the 10s timeout under load
	test("a partial outage restarts the stack but never reboots the host", async () => {
		global.fetch = jest.fn((url) => (url.includes("/object/") ? down() : healthy()))
		for (let i = 0; i < 9; i++) await runOnce()
		expect(runCompose).toHaveBeenCalledTimes(3)
		expect(spawnSync).not.toHaveBeenCalled()
	})

	test("one unhealthy endpoint out of five is enough to count a failure", async () => {
		global.fetch = jest.fn((url) => (url.includes("/object/") ? down() : healthy()))
		await runOnce()
		expect(mockState.failures).toBe(1)
	})

	// a swallowed write error pins the count at 1 forever, so the watchdog never acts on a real outage
	test("an unwritable state file is reported, not swallowed", async () => {
		mockWriteFails = true
		await runOnce()
		expect(process.exitCode).toBe(1)
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("cannot write"))
	})

	test("a thrown request counts as a failure, so an unreachable gateway escalates", async () => {
		global.fetch = jest.fn(() => Promise.reject(new Error("ECONNREFUSED")))
		await failUntilThreshold()
		expect(runCompose).toHaveBeenCalledWith(["up", "-d", "--force-recreate"])
	})
})

describe("configProblem", () => {
	afterEach(() => {
		process.env.gateway_HOST = "http://127.0.0.1:8080"
		delete process.env.watchdog_ON
	})

	test("an enabled watchdog with a clean config has nothing to report", () => {
		process.env.watchdog_ON = "true"
		expect(configProblem()).toBeNull()
	})

	// normalizeHost("") returns "", so every URL would be "/command/health", which fetch cannot parse.
	// Every poll would then "fail" and the watchdog would restart and reboot a host that is fine
	test("an empty gateway_HOST is a startup error, not six failed polls", () => {
		process.env.watchdog_ON = "true"
		process.env.gateway_HOST = ""
		expect(configProblem()).toBe(NO_HOST)
	})

	test("polling nothing is a startup error too — the host would look supervised while nothing is watched", () => {
		process.env.watchdog_ON = "true"
		for (const s of SERVICES) process.env[`${s}_PROXY_ON`] = "false"
		expect(configProblem()).toBe(NOTHING_TO_POLL)
		for (const s of SERVICES) process.env[`${s}_PROXY_ON`] = "true"
	})

	test("a disabled watchdog reports nothing — there is nothing to misconfigure", () => {
		process.env.watchdog_ON = "false"
		process.env.gateway_HOST = ""
		expect(configProblem()).toBeNull()
	})
})

// dotenv discards read errors, so an unreadable .env leaves every setting unset. Without this the
// process prints "watchdog_ON is not true", exits 0, and the operator believes the host is supervised
describe("envProblem", () => {
	const denied = Object.assign(new Error("EACCES"), { code: "EACCES" })

	test("an unreadable .env is fatal when the environment does not carry the settings either", () => {
		expect(envProblem(denied, {})).toMatch(/cannot read .*EACCES/)
	})

	test("stays quiet when the settings arrive from the supervisor instead of the file", () => {
		expect(envProblem(denied, { watchdog_ON: "true" })).toBeNull()
	})

	test("a readable .env is never a problem", () => {
		expect(envProblem(null, {})).toBeNull()
	})
})

// a systemd Environment= or an exported shell var beats .env, and the scheme warning has to see it
describe("scheme warning source", () => {
	test("reads what process.env holds, not the .env file", () => {
		expect(watchdogHostWarning(envLines({ watchdog_ON: "true", gateway_HOST: "chimera.lan" })))
			.toContain("no scheme")
		expect(watchdogHostWarning(envLines({ watchdog_ON: "true", gateway_HOST: "http://chimera.lan" }))).toBeNull()
		expect(watchdogHostWarning(envLines({ gateway_HOST: "chimera.lan" }))).toBeNull()
	})

	test("an unset key reads as empty, not as the string undefined", () => {
		expect(envLines({})).toEqual(["watchdog_ON = ", "gateway_HOST = "])
	})
})
