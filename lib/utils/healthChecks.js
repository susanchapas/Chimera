const gatewayHost = require("./gatewayHost.js")

const SERVICES = ["command", "livestream", "object", "schedule", "storage"]

// the gateway only routes /<service>/health when that service is proxied, so an
// unproxied one 404s and would read as an outage
module.exports = ({ localOnly = false } = {}) => {
	const baseUrl = gatewayHost()
	return Object.fromEntries(SERVICES
		.filter(s => process.env[`${s}_PROXY_ON`] === "true" && (!localOnly || process.env[`${s}_ON`] === "true"))
		.map(s => [s, `${baseUrl}/${s}/health`]))
}
