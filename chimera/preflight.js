const fs = require("fs")
const path = require("path")
const readline = require("readline")
const crypto = require("crypto")

let loadCameras, multiInstanceLib, trustedSourcesLib, normalizeHost, certPaths
try {
	loadCameras = require("../lib/utils/loadCameras.js")
	multiInstanceLib = require("../lib/utils/multiInstance.js")
	trustedSourcesLib = require("../lib/utils/trustedSources.js")
	normalizeHost = require("../lib/utils/normalizeHost.js")
	certPaths = require("../lib/utils/certPaths.js")
} catch (e) {
	if (e.code === "MODULE_NOT_FOUND") {
		console.error("Missing dependencies — run `npm install` first.")
		process.exit(1)
	}
	throw e
}
const { parseConf, buildFullUrl, urlProblem } = loadCameras
const { multiInstance, validInstances } = multiInstanceLib
const { validTrustedSources } = trustedSourcesLib
const { letsencryptPaths, isIpLiteral } = certPaths

const ROOT = path.join(__dirname, "..")
const ENV = path.join(ROOT, ".env")
const ENV_EXAMPLE = path.join(ROOT, "env.example")
const MOTION = path.join(ROOT, "motion.conf")
const MOTION_EXAMPLE = path.join(ROOT, "motion.conf.example")
const CAM_DIR = path.join(ROOT, "cameraconf")

const WATCHDOG_MIN_INTERVAL_MS = 5000

const CHECK_ONLY = process.argv.includes("--check") || (!process.stdin.isTTY && !process.argv.includes("--interactive"))
const OK = "✓", BAD = "✗"

// a "# default" comment means the value shown is real, not prose to be replaced
const hasDefault = (rest) => /^\s*default\b/i.test(rest.split("#")[1] || "")

const parseSchema = () =>
	fs.readFileSync(ENV_EXAMPLE, "utf8").split(/\r?\n/).reduce((acc, line) => {
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
		if (m) acc.push({ key: m[1], placeholder: hasDefault(m[2]) ? "" : m[2].split("#")[0].trim(), desc: m[2].replace(/\*\*\*/g, "").trim(), optional: m[2].includes("***") })
		return acc
	}, [])

const typeOf = (key, placeholder) =>
	/true\s*\|\s*false/.test(placeholder) ? "bool"
		: /_PORT(_SECURE)?$/.test(key) ? "port"
			: "string"

const isSecret = (key) => /^SECRETKEY$|_(AUTH|TOKEN|PASSWORD)$/.test(key)

const readLines = () => fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8").split(/\r?\n/) : []
const getRaw = (lines, key) => {
	for (const l of lines) {
		const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
		if (m && m[1] === key) return m[2].trim()
	}
	return undefined
}
const getVal = (lines, key) => getRaw(lines, key)?.split("#")[0].trim()
const setVal = (lines, key, value) => {
	const idx = lines.findIndex(l => { const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/); return m && m[1] === key })
	if (idx >= 0) lines[idx] = `${key} = ${value}`
	else lines.push(`${key} = ${value}`)
}

const SECRET_MODE = 0o640
const CONTAINER_GID = 1000
const secretsWritten = []
const writeSecret = (file, data) => {
	fs.writeFileSync(file, data, { mode: SECRET_MODE })
	fs.chmodSync(file, SECRET_MODE)
	if (!secretsWritten.includes(file)) secretsWritten.push(file)
}
const modesSupported = (() => {
	let cached
	return () => {
		if (cached !== undefined) return cached
		const probe = path.join(ROOT, `.preflight-mode-${process.pid}`)
		try {
			fs.writeFileSync(probe, "", { mode: 0o600 })
			cached = (fs.statSync(probe).mode & 0o777) === 0o600
		} catch {
			cached = false
		} finally {
			try { fs.unlinkSync(probe) } catch { /* nothing to remove */ }
		}
		return cached
	}
})()
const looseMode = (file) => {
	try {
		if (!modesSupported()) return null
		const mode = fs.statSync(file).mode & 0o777
		return mode & 0o037 ? `0${mode.toString(8).padStart(3, "0")}` : null
	} catch {
		return null
	}
}
const groupHint = () => {
	const gid = process.getgid?.()
	if (!secretsWritten.includes(ENV) || gid === undefined || gid === CONTAINER_GID) return null
	const file = path.relative(ROOT, ENV)
	return `Wrote ${file} mode 0640 — only your account can read it. The container runs as uid ${CONTAINER_GID}, so hand it the group or the container will restart-loop:\n`
		+ `  sudo chown "$USER":${CONTAINER_GID} ${file} && sudo chmod 640 ${file}\n`
}

const seedEnv = () => writeSecret(ENV,
	fs.readFileSync(ENV_EXAMPLE, "utf8").split(/\r?\n/).map(line => {
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
		if (!m || hasDefault(m[2])) return line
		const h = m[2].indexOf("#")
		return `${m[1]} =${h >= 0 ? " " + m[2].slice(h) : ""}`
	}).join("\n"))

const varProblem = (v, val) => {
	const blank = val === undefined || val === "" || val === v.placeholder
	if (blank) return v.optional ? null : "required, not set"
	if (v.key === "chimeraInstances" && !validInstances(val)) return `must be "max", -1, or an integer >= 0 (got "${val}")`
	if (v.key === "scheduler_TRUSTED_SOURCES" && !validTrustedSources(val)) return `must be comma-separated IPs/CIDRs or proxy-addr names like "loopback" (got "${val}")`
	if (v.key === "storage_HOST" && !/^https?:\/\//i.test(val)) return `must start with http:// or https:// (got "${val}")`
	if (v.key === "gateway_HOST" && !urlPart(normalizeHost(val), "hostname")) return `must be a valid URL (got "${val}")`
	if (v.key === "object_ALERT_ON" && !["true", "text", "false"].includes(val)) return `must be true, text, or false (got "${val}")`
	if (v.key === "watchdog_FAILURES" && !(/^\d+$/.test(val) && Number(val) >= 1)) return `must be an integer >= 1 (got "${val}")`
	if (v.key === "watchdog_INTERVAL_MS" && !(/^\d+$/.test(val) && Number(val) >= WATCHDOG_MIN_INTERVAL_MS)) return `must be milliseconds, an integer >= ${WATCHDOG_MIN_INTERVAL_MS} — 60 is 60ms, not a minute (got "${val}")`
	if (isSecret(v.key) && val.length < 32) return `must be at least 32 characters (got ${val.length})`
	const t = typeOf(v.key, v.placeholder)
	if (t === "bool" && val !== "true" && val !== "false") return `must be true or false (got "${val}")`
	if (t === "port" && !(/^\d+$/.test(val) && Number(val) >= 1 && Number(val) <= 65535)) return `must be a port from 1 to 65535 (got "${val}")`
	return null
}

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

const ABSENT = "ENOENT"
const certStatus = (p) => {
	let fd
	try {
		fd = fs.openSync(p, "r")
		return fs.fstatSync(fd).isFile() ? null : ABSENT
	}
	catch (e) {
		return e.code === "ENOENT" || e.code === "ENOTDIR" ? ABSENT : (e.code || "EACCES")
	}
	finally {
		if (fd !== undefined) fs.closeSync(fd)
	}
}
const certUnreadable = (p) => { const code = certStatus(p); return code === ABSENT ? null : code }
const certMaybePresent = (p) => certStatus(p) !== ABSENT

const motionDirProblem = () => !isFile(MOTION) && fs.existsSync(MOTION)
	? "is a directory — Docker creates one when the bind-mounted file is missing; run `rm -rf motion.conf && cp motion.conf.example motion.conf`"
	: null

const getCamDir = () => {
	if (isFile(MOTION)) {
		const conf = parseConf(fs.readFileSync(MOTION, "utf8"))
		if (conf.camera_dir && !path.isAbsolute(conf.camera_dir)) return path.resolve(ROOT, conf.camera_dir)
	}
	return CAM_DIR
}
const listConfs = () => { const d = getCamDir(); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith(".conf")) : [] }

const cameraProblems = () => {
	const problems = []
	const ids = {}
	const names = {}
	const camDir = getCamDir()
	const confs = listConfs()
	if (!confs.length) return [`no camera .conf files in ${camDir}`]
	for (const f of confs) {
		const cam = parseConf(fs.readFileSync(path.join(camDir, f), "utf8"))
		const id = parseInt(cam.camera_id)
		if (!(id > 0)) problems.push(`${f}: camera_id must be a positive integer`)
		else if (ids[id]) problems.push(`${f}: duplicate camera_id ${id} (also in ${ids[id]})`)
		else ids[id] = f
		if (!cam.camera_name) problems.push(`${f}: camera_name not set`)
		else if (names[cam.camera_name]) problems.push(`${f}: duplicate camera_name "${cam.camera_name}" (also in ${names[cam.camera_name]})`)
		else names[cam.camera_name] = f
		if (!cam.netcam_url) problems.push(`${f}: netcam_url not set`)
		else {
			const p = urlProblem(cam.netcam_url, buildFullUrl(cam.netcam_url, cam.netcam_userpass || ""))
			if (p) problems.push(`${f}: netcam_url ${p}`)
		}
	}
	return problems
}

const confModeProblem = () => {
	const camDir = getCamDir()
	const loose = listConfs().map(f => [f, looseMode(path.join(camDir, f))]).filter(([, m]) => m)
	return loose.length
		? `${loose.map(([f, m]) => `${f} mode ${m}`).join(", ")} — holds camera logins and every account on this machine can read them; run: chmod 640 ${path.relative(ROOT, camDir) || camDir}/*.conf`
		: null
}

const camTemplate = (id, name, url, userpass) =>
	`camera_id ${id}\ncamera_name ${name}\n\nnetcam_url ${url}\nnetcam_userpass ${userpass}\nnetcam_keepalive on\nnetcam_use_tcp on\n`

const SERVICE_PREFIXES = ["command", "schedule", "storage", "livestream", "object", "memory"]
const on = (lines, s) => getVal(lines, `${s}_ON`) === "true"
const camerasNeeded = (lines) => ["storage", "object", "livestream"].some(s => on(lines, s))
const isServiceOff = (lines, key) => {
	if (key === "storage_MOTION_CONF_FILEPATH" || /^ffmpeg_/.test(key)) return !camerasNeeded(lines)
	// object needs both: writes storage_FOLDERPATH, reads livestream_FOLDERPATH
	if (key === "storage_FOLDERPATH") return !on(lines, "storage") && !on(lines, "object")
	if (key === "livestream_FOLDERPATH") return !on(lines, "livestream") && !on(lines, "object")
	if (key === "object_MODEL_SHA256") return !on(lines, "object") || !/^https?:\/\//i.test(getVal(lines, "object_MODEL_URL") || "")
	if (/^ffprobe_/.test(key)) return !on(lines, "storage")
	if (key === "storage_HOST" && on(lines, "schedule")) return false
	if (key === "scheduler_TRUSTED_SOURCES") return false
	if (key === "scheduler_AUTH" && getVal(lines, key)) return false
	const prefix = key.startsWith("scheduler_") ? "schedule" : SERVICE_PREFIXES.find(s => key.startsWith(s + "_"))
	if (!prefix || key === `${prefix}_ON`) return false
	if (/_HOST$/.test(key) && getVal(lines, `${prefix}_PROXY_ON`) === "true") return false
	if (prefix === "memory" && multiInstance(getVal(lines, "chimeraInstances"))) return false
	return getVal(lines, `${prefix}_ON`) === "false"
}

const blankDisables = (lines, key) => {
	const copy = [...lines]
	setVal(copy, key, "")
	return isServiceOff(copy, key)
}

const objectFeedProblem = (lines) => on(lines, "object") && !on(lines, "livestream")
	? "object_ON requires livestream_ON — object reads its frames from the livestream feeds, which only run when livestream_ON=true"
	: null

const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"]
const urlPart = (url, part) => { try { return new URL(url)[part] } catch { return "" } }
const gatewayUrl = (lines) => normalizeHost(getVal(lines, "gateway_HOST"))
const rawGatewayHost = (lines) => (getVal(lines, "gateway_HOST") || "").trim()
const schemelessHost = (lines) => rawGatewayHost(lines) !== "" && !/^https?:\/\//i.test(rawGatewayHost(lines))

const insecureCookie = (lines) => {
	if (isServiceOff(lines, "command_COOKIE_SECURE") || getVal(lines, "command_COOKIE_SECURE") === "true") return false
	const host = urlPart(gatewayUrl(lines), "hostname") || rawGatewayHost(lines)
	return !!host && !LOOPBACK.includes(host)
}

const cookieSecureProblem = (lines) =>
	insecureCookie(lines) && (urlPart(gatewayUrl(lines), "protocol") === "https:" || getVal(lines, "gateway_HTTPS_Redirect") === "true" || getVal(lines, "certbot_ON") === "true")
		? "command_COOKIE_SECURE MUST BE true — this deploy serves HTTPS on a non-loopback host (the gateway_HOST scheme, gateway_HTTPS_Redirect, or certbot_ON says so). The session cookie ships without Secure and leaks on the first plain-HTTP request. For a plain-HTTP deploy, give gateway_HOST an explicit http:// prefix, and leave gateway_HTTPS_Redirect and certbot_ON false"
		: null

const cookiePlainHttpProblem = (lines) =>
	!isServiceOff(lines, "command_COOKIE_SECURE") && getVal(lines, "command_COOKIE_SECURE") === "true"
		&& /^http:\/\//i.test(rawGatewayHost(lines)) && getVal(lines, "gateway_HTTPS_Redirect") !== "true" && getVal(lines, "certbot_ON") !== "true"
		&& !LOOPBACK.includes(urlPart(rawGatewayHost(lines), "hostname") || rawGatewayHost(lines).replace(/^https?:\/\//i, ""))
		? "command_COOKIE_SECURE MUST BE false — gateway_HOST is http://, and neither gateway_HTTPS_Redirect nor certbot_ON marks this deploy as HTTPS. Browsers drop the Secure cookie, so the login loops with no error. For HTTPS, terminate TLS (certbot_ON, your own certs, or a proxy) and write gateway_HOST as https://"
		: null

const cookieAmbiguousHostWarning = (lines) =>
	!isServiceOff(lines, "command_COOKIE_SECURE") && getVal(lines, "command_COOKIE_SECURE") === "true"
		&& schemelessHost(lines)
		&& getVal(lines, "gateway_HTTPS_Redirect") !== "true" && getVal(lines, "certbot_ON") !== "true"
		&& !LOOPBACK.includes(urlPart(gatewayUrl(lines), "hostname") || rawGatewayHost(lines))
		? "WARNING: gateway_HOST has no scheme, so it reads as https://. If browsers reach this deploy over http://, the login loops forever. Give gateway_HOST an explicit http:// prefix"
		: null

const PRIVATE_SUFFIX = /\.(lan|local|internal|intranet|home\.arpa)$/i
const privateHostname = (host) => !!host && (isIpLiteral(host) || !host.includes(".") || PRIVATE_SUFFIX.test(host))

const watchdogHostWarning = (lines) => {
	if (getVal(lines, "watchdog_ON") !== "true") return null
	if (schemelessHost(lines)) return "WARNING: watchdog_ON=true and gateway_HOST has no scheme, so the watchdog polls https://. On a plain-HTTP deploy every poll fails and the watchdog reboots a healthy host on a loop — give gateway_HOST an explicit http:// or https:// prefix. If the certificate is self-signed or from a private CA, point NODE_EXTRA_CA_CERTS at it, or node's fetch rejects it"
	const url = gatewayUrl(lines)
	return urlPart(url, "protocol") === "https:" && privateHostname(urlPart(url, "hostname"))
		? "WARNING: watchdog_ON=true and gateway_HOST is https:// on a name no public CA issues for, so the certificate is self-signed or from a private CA. Node's fetch rejects it (UNABLE_TO_VERIFY_LEAF_SIGNATURE) on every poll, and the watchdog restarts the stack and then reboots a healthy host on a loop — point NODE_EXTRA_CA_CERTS at the CA that signed it"
		: null
}

const configuredCertPair = (lines) => {
	const [key, cert] = ["privateKey_FILEPATH", "certificate_FILEPATH"].map(k => getVal(lines, k) || "")
	if (key || cert) return { paths: key && cert ? [key, cert] : [], source: "override" }
	const hostname = urlPart(gatewayUrl(lines), "hostname")
	if (!hostname || isIpLiteral(hostname)) return { paths: [], source: "auto" }
	const auto = letsencryptPaths(hostname)
	return { paths: [auto.key, auto.cert], source: "auto" }
}

const certPairMaybePresent = (lines) => {
	const { paths } = configuredCertPair(lines)
	return paths.length > 0 && paths.every(certMaybePresent)
}

const redirectNeedsLocalCert = (lines) =>
	getVal(lines, "gateway_HTTPS_Redirect") === "true" && getVal(lines, "gateway_TRUST_PROXY") !== "true"
		&& getVal(lines, "certbot_ON") !== "true"

const certUnreadableWarning = (lines) => {
	if (!redirectNeedsLocalCert(lines)) return null
	const unreadable = configuredCertPair(lines).paths.map(p => [p, certUnreadable(p)]).filter(([, code]) => code)
	if (!unreadable.length) return null
	const named = unreadable.map(([p, code]) => `${p} (${code})`).join(", ")
	const blind = certPairMaybePresent(lines) ? "\n  A path this user cannot read is not proof the certificate is absent, so the redirect-loop warning stays silent." : ""
	return `WARNING: this user cannot read ${named}.${blind}`
		+ "\n  The gateway opens the same paths as uid 1000. If it cannot open them, the secure listener stays down."
		+ "\n  /etc/letsencrypt is mode 0700 root. A FILEPATH names a path inside the container, so docker-compose.yml must mount it, and uid 1000 must be able to read it."
}

const OVERRIDE_PATH_CAVEAT = "\n  Already mounted your own pair? privateKey_FILEPATH and certificate_FILEPATH name paths inside the container. This check can only look at the filesystem it runs on. From the host, that is the mount source, not the container path."

const httpsRedirectLoopWarning = (lines) => {
	if (!redirectNeedsLocalCert(lines) || certPairMaybePresent(lines)) return null
	const { paths, source } = configuredCertPair(lines)
	return "WARNING: gateway_HTTPS_Redirect=true, but nothing here serves https:// and gateway_TRUST_PROXY is not true. Every page redirects to itself (ERR_TOO_MANY_REDIRECTS).\n  Who holds the certificate?\n  this machine — set certbot_ON=true, or give privateKey_FILEPATH and certificate_FILEPATH absolute paths to your cert pair\n  a proxy or tunnel — set gateway_TRUST_PROXY=true, and make the proxy send X-Forwarded-Proto (nginx: proxy_set_header X-Forwarded-Proto $scheme)"
		+ (source === "override" && paths.length ? OVERRIDE_PATH_CAVEAT : "")
}

const GATEWAY_PORT_SECURE_DEFAULT = "443"

const httpsRedirectPortWarning = (lines) => {
	if (getVal(lines, "gateway_HTTPS_Redirect") !== "true") return null
	const url = gatewayUrl(lines)
	if (!urlPart(url, "hostname")) return null
	if (urlPart(url, "protocol") !== "https:") {
		return "WARNING: gateway_HTTPS_Redirect=true but gateway_HOST is http://. The redirect always sends visitors to https://, so it ignores the scheme. With gateway_TRUST_PROXY=true it also drops any port gateway_HOST names and lands visitors on 443. Write gateway_HOST as https:// with the port browsers reach, or turn the redirect off"
	}
	if (getVal(lines, "gateway_TRUST_PROXY") === "true") return null
	const hostPort = urlPart(url, "port")
	if (!hostPort) return null
	const securePort = getVal(lines, "gateway_PORT_SECURE") || GATEWAY_PORT_SECURE_DEFAULT
	return hostPort === securePort
		? null
		: `WARNING: gateway_HTTPS_Redirect=true sends http:// visitors to port ${hostPort} (gateway_HOST), but this deploy terminates TLS on port ${securePort} (gateway_PORT_SECURE). The redirect lands on a port that serves no TLS (ERR_SSL_PROTOCOL_ERROR). Give gateway_HOST and gateway_PORT_SECURE the same port`
}

const redirectWarnings = (lines) =>
	[httpsRedirectLoopWarning(lines), certUnreadableWarning(lines), httpsRedirectPortWarning(lines)].filter(Boolean)

const warnings = (lines) => [...redirectWarnings(lines), watchdogHostWarning(lines)].filter(Boolean)

const certbotPortProblem = (lines) =>
	getVal(lines, "certbot_ON") === "true" && getVal(lines, "gateway_PORT") !== "80"
		? "gateway_PORT MUST BE 80 when certbot_ON=true — Let's Encrypt validates over HTTP-01 on port 80, and compose publishes no port but gateway_PORT, so nothing answers the challenge. Set gateway_PORT=80, or set certbot_ON=false and supply your own certs via privateKey_FILEPATH/certificate_FILEPATH"
		: null

const setupTokenHint = (lines) => on(lines, "command")
	? `The first admin account needs setup_TOKEN — read it with \`grep setup_TOKEN ${path.relative(ROOT, ENV)}\`.\n`
	: null

const duplicatePortProblems = (lines) => {
	const keys = ["gateway_PORT", "gateway_PORT_SECURE", ...SERVICE_PREFIXES.map(s => `${s}_PORT`)]
	const seen = Object.create(null)
	const probs = []
	for (const key of keys) {
		if (isServiceOff(lines, key)) continue
		const val = key === "gateway_PORT_SECURE" ? (getVal(lines, key) || GATEWAY_PORT_SECURE_DEFAULT) : getVal(lines, key)
		if (!val) continue
		const num = /^\d+$/.test(val) ? Number(val) : val
		if (seen[num]) probs.push([key, `duplicate port ${val} — also used by ${seen[num]}; the services share one network namespace, so the second to bind fails with EADDRINUSE`])
		else seen[num] = key
	}
	return probs
}

const HASH_MSG = "cannot contain # — dotenv reads it as a comment and drops the rest of the line"
const answerProblem = (v, val) => val.includes("#") ? HASH_MSG : varProblem(v, val)

const hashTruncated = (lines, key) => {
	const raw = getRaw(lines, key)
	const h = raw === undefined ? -1 : raw.indexOf("#")
	return h > 0 && /\S/.test(raw[h - 1]) ? HASH_MSG : null
}
const keyProblem = (lines, v) => hashTruncated(lines, v.key) || varProblem(v, getVal(lines, v.key))

const envProblems = (schema, lines) => {
	const probs = schema.filter(v => !isServiceOff(lines, v.key)).map(v => [v.key, keyProblem(lines, v)]).filter(([, p]) => p)
	const feedProb = objectFeedProblem(lines)
	if (feedProb) probs.push(["object_ON", feedProb])
	const cookieProb = cookieSecureProblem(lines) || cookiePlainHttpProblem(lines)
	if (cookieProb) probs.push(["command_COOKIE_SECURE", cookieProb])
	const certbotProb = certbotPortProblem(lines)
	if (certbotProb) probs.push(["gateway_PORT", certbotProb])
	probs.push(...duplicatePortProblems(lines))
	return probs
}

const runCheck = () => {
	const schema = parseSchema()
	const lines = readLines()
	let failed = false
	console.log("Chimera pre-flight check\n")

	if (!fs.existsSync(ENV)) {
		console.log(`  .env          ${BAD}  missing`)
		failed = true
	} else {
		const probs = envProblems(schema, lines)
		const mode = looseMode(ENV)
		if (mode) probs.push([".env", `mode ${mode} — holds your secrets and every account on this machine can read them; run: chmod 640 .env`])
		console.log(`  .env          ${probs.length ? BAD : OK}${probs.length ? `  ${probs.length} problem(s)` : ""}`)
		probs.forEach(([k, p]) => console.log(`                  - ${k}: ${p}`))
		if (probs.length) failed = true
	}

	if (camerasNeeded(lines)) {
		const motionOk = isFile(MOTION)
		console.log(`  motion.conf   ${motionOk ? OK : BAD}${motionOk ? "" : `  ${motionDirProblem() || "missing"}`}`)
		if (!motionOk) failed = true

		const cam = cameraProblems()
		const modeProb = confModeProblem()
		if (modeProb) cam.push(modeProb)
		console.log(`  cameraconf/   ${cam.length ? BAD : OK}${cam.length ? `  ${cam.length} problem(s)` : ""}`)
		cam.forEach(p => console.log(`                  - ${p}`))
		if (cam.length) failed = true
	}

	for (const w of warnings(lines)) console.log(`\n${w}`)

	if (failed) {
		console.log("\nBlocked. Run `npm run preflight` to fix interactively.")
		process.exit(1)
	}
	console.log("\nAll checks passed. Safe to run docker.")
}

const runInteractive = async () => {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
	// EOF resolves no question callback, so without this the walk stalls and node exits 0 as if it had passed
	let finished = false
	let wrote = false
	rl.on("close", () => {
		if (finished) return
		console.log(wrote
			? "\nAborted — changes already written are kept. Re-run `npm run preflight` to finish."
			: "\nAborted — no changes written. Re-run `npm run preflight` to start over.")
		process.exit(1)
	})
	const ask = q => new Promise(res => rl.question(q, a => res(a.trim())))
	const confirm = async (q, def = true) => {
		const a = (await ask(`${q} ${def ? "[Y/n]" : "[y/N]"} `)).toLowerCase()
		return a === "" ? def : a.startsWith("y")
	}

	console.log("Chimera pre-flight\n")

	if (!fs.existsSync(ENV)) {
		console.log("No .env found, seeding from env.example.")
		seedEnv()
		wrote = true
	}
	const schema = parseSchema()
	const lines = readLines()
	console.log("Checking .env...")
	// answering a key can unskip an earlier one, so re-walk until nothing new
	let answered
	const asked = new Set()
	const askKey = async (v) => {
		if (v.desc) console.log(`    ${v.desc}`)
		const secretDefault = isSecret(v.key) ? crypto.randomBytes(32).toString("base64url") : null
		let val, ap
		do {
			val = await ask(secretDefault ? `    ${v.key} [${secretDefault}] = ` : `    ${v.key} = `)
			if (val === "" && secretDefault && !blankDisables(lines, v.key)) val = secretDefault
			ap = val === "" && blankDisables(lines, v.key) ? null : answerProblem(v, val)
			if (ap) console.log(`    ${BAD} ${ap}`)
		} while (ap)
		setVal(lines, v.key, val)
		asked.add(v.key)
	}
	do {
		answered = false
		for (const v of schema) {
			if (asked.has(v.key) || isServiceOff(lines, v.key)) continue
			const p = keyProblem(lines, v)
			if (!p) continue
			console.log(`\n  ${v.key} ${BAD} ${p}`)
			await askKey(v)
			answered = true
		}
		// both keys hold valid values, so the walk never re-asks them — force it
		const feedProb = objectFeedProblem(lines)
		if (feedProb) {
			console.log(`\n  object_ON ${BAD} ${feedProb}`)
			for (const key of ["livestream_ON", "object_ON"]) {
				if (!objectFeedProblem(lines)) break
				const v = schema.find(s => s.key === key)
				if (!v) continue
				asked.delete(key)
				await askKey(v)
			}
			answered = true
		}
		const cookieProb = cookieSecureProblem(lines)
		if (cookieProb) {
			console.log(`\n  command_COOKIE_SECURE ${BAD} ${cookieProb}`)
			for (const key of ["gateway_HOST", "command_COOKIE_SECURE"]) {
				if (!cookieSecureProblem(lines)) break
				const v = schema.find(s => s.key === key)
				if (!v) continue
				asked.delete(key)
				await askKey(v)
			}
			answered = true
		}
		const plainHttpProb = cookiePlainHttpProblem(lines)
		if (plainHttpProb) {
			console.log(`\n  command_COOKIE_SECURE ${BAD} ${plainHttpProb}`)
			for (const key of ["gateway_HOST", "command_COOKIE_SECURE"]) {
				if (!cookiePlainHttpProblem(lines)) break
				const v = schema.find(s => s.key === key)
				if (!v) continue
				asked.delete(key)
				await askKey(v)
			}
			answered = true
		}
		const certbotProb = certbotPortProblem(lines)
		if (certbotProb) {
			console.log(`\n  gateway_PORT ${BAD} ${certbotProb}`)
			for (const key of ["certbot_ON", "gateway_PORT"]) {
				if (!certbotPortProblem(lines)) break
				const v = schema.find(s => s.key === key)
				if (!v) continue
				asked.delete(key)
				await askKey(v)
			}
			answered = true
		}
		for (let dup = duplicatePortProblems(lines); dup.length; dup = duplicatePortProblems(lines)) {
			const [key, p] = dup[0]
			console.log(`\n  ${key} ${BAD} ${p}`)
			const other = p.match(/also used by (\w+)/)?.[1]
			let prompted = false
			for (const k of [...new Set([key, other])].filter(Boolean)) {
				if (!duplicatePortProblems(lines).some(([kk, pp]) => kk === key && pp === p)) break
				const v = schema.find(s => s.key === k)
				if (!v) continue
				asked.delete(k)
				await askKey(v)
				prompted = true
			}
			if (!prompted) break
			answered = true
		}
	} while (answered)
	writeSecret(ENV, lines.join("\n"))
	wrote = true
	const probs = envProblems(schema, lines)
	probs.forEach(([k, p]) => console.log(`\n  ${k} ${BAD} ${p}`))
	const envOk = !probs.length
	console.log(`.env ${envOk ? OK : BAD}\n`)

	for (const w of warnings(lines)) console.log(`${w}\n`)

	const needCams = camerasNeeded(lines)
	let motionOk = true, camOk = true
	if (needCams) {
		console.log("Checking motion.conf...")
		const dirProb = motionDirProblem()
		if (dirProb) console.log(`  ${BAD} motion.conf ${dirProb}`)
		else if (!fs.existsSync(MOTION)) {
			if (await confirm("  motion.conf missing. Create from motion.conf.example?"))
				fs.copyFileSync(MOTION_EXAMPLE, MOTION)
		}
		motionOk = isFile(MOTION)
		console.log(`motion.conf ${motionOk ? OK : BAD}\n`)

		console.log("Checking cameraconf/...")
		const camDir = getCamDir()
		if (!fs.existsSync(camDir)) fs.mkdirSync(camDir, { recursive: true })
		while (cameraProblems().length) {
			for (const p of cameraProblems()) console.log(`  ${BAD} ${p}`)
			if (!(await confirm("  Add a camera now?"))) break
			const files = listConfs()
			const confs = files.map(f => parseConf(fs.readFileSync(path.join(camDir, f), "utf8")))
			const used = confs.map(c => parseInt(c.camera_id))
			const usedNames = confs.map(c => c.camera_name)
			const idProblem = (id) => {
				if (!(id > 0)) return "camera_id must be a positive integer"
				const i = used.indexOf(id)
				if (i >= 0) return `camera_id ${id} already used by ${files[i]}`
				return files.includes(`cam${id}.conf`) ? `cam${id}.conf already exists` : null
			}
			const nameProblem = (name) => {
				if (!name) return "camera_name not set"
				const i = usedNames.indexOf(name)
				return i >= 0 ? `camera_name "${name}" already used by ${files[i]}` : null
			}
			let id
			do {
				const rawId = await ask("    camera_id (positive integer) = ")
				id = /^\d+$/.test(rawId) ? parseInt(rawId) : NaN
				const p = idProblem(id)
				if (p) console.log(`    ${BAD} ${p}`)
			} while (idProblem(id))
			let name
			do {
				name = await ask("    camera_name = ")
				const p = nameProblem(name)
				if (p) console.log(`    ${BAD} ${p}`)
			} while (nameProblem(name))
			let url, userpass
			do {
				url = await ask("    netcam_url (rtsp://...) = ")
				userpass = await ask("    netcam_userpass (user:pass, blank if none) = ")
				const p = urlProblem(url, buildFullUrl(url, userpass))
				if (p) console.log(`    ${BAD} ${p}`)
			} while (urlProblem(url, buildFullUrl(url, userpass)))
			writeSecret(path.join(camDir, `cam${id}.conf`), camTemplate(id, name, url, userpass))
			console.log(`    created ${camDir}/cam${id}.conf ${OK}`)
			if (!(await confirm("  Add another camera?", false))) break
		}
		for (const f of listConfs()) {
			try { fs.chmodSync(path.join(camDir, f), SECRET_MODE) } catch { /* reported by confModeProblem below */ }
		}
		const modeProb = confModeProblem()
		if (modeProb) console.log(`  ${BAD} ${modeProb}`)
		camOk = !cameraProblems().length && !modeProb
		console.log(`cameraconf/ ${camOk ? OK : BAD}\n`)
	}

	finished = true
	rl.close()
	const setupHint = setupTokenHint(lines)
	if (setupHint) console.log(setupHint)
	const hint = groupHint()
	if (hint) console.log(hint)
	if (motionOk && camOk && envOk) console.log(`All checks passed ${OK}  Safe to run docker.`)
	else { console.log(`Still incomplete ${BAD}  Docker blocked.`); process.exit(1) }
}

if (require.main === module) {
	if (CHECK_ONLY) runCheck()
	else runInteractive()
}

module.exports = { WATCHDOG_MIN_INTERVAL_MS, parseSchema, typeOf, isSecret, varProblem, cameraProblems, isServiceOff, blankDisables, objectFeedProblem, insecureCookie, cookieSecureProblem, cookiePlainHttpProblem, cookieAmbiguousHostWarning, httpsRedirectLoopWarning, certUnreadableWarning, httpsRedirectPortWarning, warnings, watchdogHostWarning, certbotPortProblem, duplicatePortProblems, setupTokenHint, answerProblem, envProblems, hashTruncated, runInteractive, runCheck, ROOT, ENV, readLines, getVal, setVal, looseMode, confModeProblem, motionDirProblem }
