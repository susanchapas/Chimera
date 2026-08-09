const { spawnSync } = require("child_process")
const { ROOT, readLines, getVal } = require("./preflight.js")

// process.env first, the file second: dotenv never overwrites an already-set variable, so a systemd
// Environment=/EnvironmentFile= beats .env everywhere else. Reading the file alone here would answer a
// watchdog restart with --scale certbot=0 on a deploy whose certbot_ON=true lives in the unit, silently
// removing certbot and stopping renewal
const composeArgs = (lines, args = []) =>
	args[0] === "up" && (process.env.certbot_ON ?? getVal(lines, "certbot_ON")) !== "true" ? [...args, "--scale", "certbot=0"] : args

const composeCommand = (args) => ["docker", "compose", ...composeArgs(readLines(), args)]

const runCompose = (args) => {
	const [cmd, ...rest] = composeCommand(args)
	return spawnSync(cmd, rest, {
		cwd: ROOT,
		stdio: "inherit",
		shell: process.platform === "win32"
	})
}

if (require.main === module) {
	const { status, error } = runCompose(process.argv.slice(2))
	if (error) console.error(error.message)
	process.exit(status ?? 1)
}

module.exports = { composeArgs, composeCommand, runCompose }
