jest.mock("child_process", () => ({ spawnSync: jest.fn(() => ({ status: 0 })) }))
jest.mock("../preflight.js", () => ({
	...jest.requireActual("../preflight.js"),
	readLines: jest.fn(() => [])
}))

const path = require("path")
const { spawnSync } = require("child_process")
const { ROOT, readLines } = require("../preflight.js")
const { composeArgs, composeCommand, runCompose } = require("../compose.js")

const lines = (env) => Object.entries(env).map(([k, v]) => `${k} = ${v}`)

beforeEach(() => {
	jest.clearAllMocks()
	readLines.mockReturnValue([])
})

describe("composeArgs", () => {
	test("certbot_ON=true leaves up alone, so the certbot container starts", () => {
		expect(composeArgs(lines({ certbot_ON: "true" }), ["up", "-d"])).toEqual(["up", "-d"])
	})

	test("certbot_ON=false scales certbot to 0, so no idle container runs and an already-running one is removed", () => {
		expect(composeArgs(lines({ certbot_ON: "false" }), ["up", "-d"])).toEqual(["up", "-d", "--scale", "certbot=0"])
	})

	test("an unset certbot_ON counts as off", () => {
		expect(composeArgs([], ["up", "-d"])).toEqual(["up", "-d", "--scale", "certbot=0"])
	})

	test("process.env wins over the .env file, the same precedence the rest of the watchdog path uses", () => {
		process.env.certbot_ON = "true"
		expect(composeArgs(lines({ certbot_ON: "false" }), ["up", "-d"])).toEqual(["up", "-d"])
		process.env.certbot_ON = "false"
		expect(composeArgs(lines({ certbot_ON: "true" }), ["up", "-d"])).toEqual(["up", "-d", "--scale", "certbot=0"])
		delete process.env.certbot_ON
	})

	test("other commands pass through untouched — --scale is only valid on up", () => {
		expect(composeArgs(lines({ certbot_ON: "false" }), ["down"])).toEqual(["down"])
		expect(composeArgs(lines({ certbot_ON: "false" }), ["logs", "-f"])).toEqual(["logs", "-f"])
	})
})

describe("composeCommand", () => {
	test("prefixes docker compose and reads the certbot gate from .env", () => {
		readLines.mockReturnValue(lines({ certbot_ON: "true" }))
		expect(composeCommand(["up", "-d", "--force-recreate"])).toEqual(["docker", "compose", "up", "-d", "--force-recreate"])

		readLines.mockReturnValue(lines({ certbot_ON: "false" }))
		expect(composeCommand(["up", "-d"])).toEqual(["docker", "compose", "up", "-d", "--scale", "certbot=0"])
	})
})

describe("runCompose", () => {
	// the watchdog's cron mode runs from whatever cwd the scheduler picks, where no compose file resolves
	test("runs from the repo root, not the caller's cwd", () => {
		runCompose(["up", "-d"])
		expect(ROOT).toBe(path.join(__dirname, "..", ".."))
		expect(spawnSync).toHaveBeenCalledWith("docker", ["compose", "up", "-d", "--scale", "certbot=0"], expect.objectContaining({ cwd: ROOT }))
	})

	test("inherits stdio so compose output reaches the scheduler's log", () => {
		runCompose(["down"])
		expect(spawnSync.mock.calls[0][2]).toMatchObject({ stdio: "inherit", shell: process.platform === "win32" })
	})

	test("hands back spawnSync's result, so a failed restart is visible to the caller", () => {
		spawnSync.mockReturnValueOnce({ status: 126, error: undefined })
		expect(runCompose(["up", "-d"])).toEqual({ status: 126, error: undefined })
	})
})

// docker:restart is the documented add-a-camera step, so it needs the same gate as build and up
describe("preflight hooks", () => {
	const { scripts } = require("../../package.json")

	test.each(["docker:build", "docker:up", "docker:restart"])("%s runs the check first", (script) => {
		expect(scripts[`pre${script}`]).toBe("node chimera/preflight.js --check")
	})
})
