require("dotenv").config()
const { healthChecks } = require("lib")

const checkUrl = healthChecks()

// pm2 reports this app online whether or not the map has anything in it, so an empty
// one is a heartbeat that watches nothing and never fires the webhook it exists for
if (!Object.keys(checkUrl).length) console.error("heartbeat: no service has *_PROXY_ON=true — the gateway routes no health endpoint, so this heartbeat monitors nothing and will never alert")

module.exports = {
	checkUrl,
	webhookUrl: process.env.alert_URL,
	cronString: "*/10 * * * *",
	consoleOutput: true
}
