require("dotenv").config()
const fs = require("fs")
const path = require("path")
const { parseSchema, isServiceOff, typeOf, isSecret, objectFeedProblem, insecureCookie, cookieSecureProblem, cookiePlainHttpProblem, cookieAmbiguousHostWarning, warnings, certbotPortProblem, duplicatePortProblems, hashTruncated } = require("./preflight.js")
const { multiInstance, validInstances } = require("../lib/utils/multiInstance.js")
const { validTrustedSources } = require("../lib/utils/trustedSources.js")
const gatewayHost = require("../lib/utils/gatewayHost.js")
const storageHost = require("../lib/utils/storageHost.js")

let allEnvPresent = true
const schema = parseSchema()
const optionalKeys = new Set(schema.filter(v => v.optional).map(v => v.key))
const placeholders = new Map(schema.map(v => [v.key, v.placeholder]))

const instances = (process.env.chimeraInstances || "").trim()
if (instances !== "" && !validInstances(instances)) {
	console.log("chimeraInstances MUST BE \"max\", -1, OR AN INTEGER >= 0 — pm2 runs cluster_mode only for those")
	allEnvPresent = false
}

const trustedSources = (process.env.scheduler_TRUSTED_SOURCES || "").trim()
if (trustedSources !== "" && !validTrustedSources(trustedSources)) {
	console.log("scheduler_TRUSTED_SOURCES MUST BE COMMA-SEPARATED IPs/CIDRs OR proxy-addr NAMES LIKE \"loopback\" — an unparseable value crash-loops every service")
	allEnvPresent = false
}

const envLines = Object.entries(process.env).map(([k, v]) => `${k} = ${v}`)

const rawStorageHost = (process.env.storage_HOST || "").trim()
if (!isServiceOff(envLines, "storage_HOST") && rawStorageHost !== "" && !/^https?:\/\//i.test(rawStorageHost)) {
	console.log("storage_HOST MUST START WITH http:// OR https:// — storage serves plain HTTP, so an implied https:// fails the TLS handshake")
	allEnvPresent = false
}

const rawGatewayHost = (process.env.gateway_HOST || "").trim()
if (!isServiceOff(envLines, "gateway_HOST") && rawGatewayHost !== "") {
	try { new URL(gatewayHost()) }
	catch {
		console.log("gateway_HOST MUST BE A VALID URL — gateway.js builds the https:// redirect target from it, and will not fall back to the Host header the client sent. An unparseable value answers every http:// request with a 500 instead of a redirect")
		allEnvPresent = false
	}
}

const objectFeed = objectFeedProblem(envLines)
if (objectFeed) {
	console.log(objectFeed)
	allEnvPresent = false
}

const rawEnvPath = path.resolve(process.cwd(), ".env")
let rawEnvLines = []
try {
	rawEnvLines = fs.readFileSync(rawEnvPath, "utf8").split(/\r?\n/)
}
catch (e) {
	if (e.code !== "ENOENT") {
		console.log(`CANNOT READ ${rawEnvPath} (${e.code}) — the container opens it as uid 1000, and dotenv reports nothing, so every variable reads as unset`)
		allEnvPresent = false
	}
}
schema.forEach(v => {
	if (isServiceOff(envLines, v.key)) return
	const hp = hashTruncated(rawEnvLines, v.key)
	if (hp) {
		console.log(v.key, hp)
		allEnvPresent = false
	}
})

const checkVar = (varName) => {
	if (optionalKeys.has(varName) || isServiceOff(envLines, varName)) return true
	const val = process.env[varName]
	if (val == null || val.trim() === "") {
		console.log("MISSING ENV VAR", varName)
		allEnvPresent = false
		return false
	}
	if (isSecret(varName) && val.trim() === placeholders.get(varName)) {
		console.log("PLACEHOLDER SECRET — change before deploying:", varName)
		allEnvPresent = false
		return false
	}
	if (isSecret(varName) && val.trim().length < 32) {
		console.log("TOO SHORT — must be at least 32 characters:", varName)
		allEnvPresent = false
		return false
	}
	if (typeOf(varName, placeholders.get(varName)) === "bool" && val.trim() !== "true" && val.trim() !== "false") {
		console.log("MUST BE true OR false:", varName)
		allEnvPresent = false
		return false
	}
	return true
}

const isFolderCheck = (varName) => {
	try {
		return fs.lstatSync(process.env[varName]).isDirectory()
	}
	catch(e) {
		return false
	}
}

const confirmPath = (varName, shouldBeFolder=false) => {
	if (isServiceOff(envLines, varName)) return
	if(process.env[varName] == null || process.env[varName].length == 0){
		return
	}
	const isAbsolutePath =  path.isAbsolute(process.env[varName])
	if(!isAbsolutePath){
		console.log(varName, "SHOULD BE AN ABSOLUTE PATH")
		allEnvPresent = false
		return
	}
	const isFolder = isFolderCheck(varName)
	if(shouldBeFolder && !isFolder){
		console.log(varName, "SHOULD BE A FOLDER")
		allEnvPresent = false
		return
	}
	if(!shouldBeFolder && isFolder){
		console.log(varName, "SHOULD BE A FILE")
		allEnvPresent = false
		return
	}
	return
}

const confirmURL = (varName) => {
	if (isServiceOff(envLines, varName)) return
	const val = process.env[varName]
	if (val == null || val.trim() === "") return
	try {
		if (!/^https?:$/.test(new URL(val).protocol)) throw new Error("scheme")
	} catch (e) {
		console.log(varName, "MUST BE A VALID http(s) URL (SPECIAL CHARACTERS MUST BE URL-ENCODED)")
		allEnvPresent = false
	}
}

schema.forEach(v => checkVar(v.key))
schema.filter(v => /_URL$/.test(v.key)).forEach(v => confirmURL(v.key))
// storage_MOTION_CONF_FILEPATH intentionally skips the filesystem path check
schema.filter(v => /_FILEPATH$/.test(v.key) && v.key !== "storage_MOTION_CONF_FILEPATH").forEach(v => confirmPath(v.key))
schema.filter(v => /_FOLDERPATH$/.test(v.key)).forEach(v => confirmPath(v.key, true))

const motionConfPath = process.env.storage_MOTION_CONF_FILEPATH
if (!isServiceOff(envLines, "storage_MOTION_CONF_FILEPATH") && motionConfPath) {
	try {
		fs.readFileSync(motionConfPath)
	} catch (e) {
		if (e.code !== "ENOENT") {
			console.log(`CANNOT READ ${motionConfPath} (${e.code}) — motion opens this as uid 1000 and crash-loops without it`)
			allEnvPresent = false
		}
	}
}

if (multiInstance(instances) && process.env.memory_ON !== "true") {
	console.log("FORCING memory_ON=true — a cluster coordinates through the memory socket")
	process.env.memory_ON = "true"
}

const certbotPort = certbotPortProblem(envLines)
if (certbotPort) {
	console.log(certbotPort)
	allEnvPresent = false
}

const duplicatePorts = duplicatePortProblems(envLines)
duplicatePorts.forEach(([k, p]) => {
	console.log(k, p)
	allEnvPresent = false
})

if (process.env.certbot_ON === "true" && process.env.gateway_HTTPS_Redirect !== "true") {
	console.log("WARNING: certbot_ON=true but gateway_HTTPS_Redirect is not true — port 80 keeps serving the whole app. Passwords cross the network in cleartext, and the browser drops the Secure cookie, so the login fails and says nothing")
}

warnings(envLines).forEach(w => console.log(w))

const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"]
const originOf = (url) => { try { return new URL(url).host } catch { return "" } }
const hostnameOf = (url) => { try { return new URL(url).hostname } catch { return "" } }

const cookieProblem = cookieSecureProblem(envLines) || cookiePlainHttpProblem(envLines)
const ambiguousHost = cookieAmbiguousHostWarning(envLines)
if (cookieProblem) {
	console.log(cookieProblem)
	allEnvPresent = false
}
else if (insecureCookie(envLines)) {
	console.log("WARNING: auth cookie may be sent over plaintext HTTP — set command_COOKIE_SECURE=true if browsers reach gateway_HOST over HTTPS")
}
else if (ambiguousHost) {
	console.log(ambiguousHost)
}

const scheduleOn = process.env.schedule_ON === "true"
const gwOrigin = originOf(gatewayHost())
const stOrigin = originOf(storageHost())
const stHostname = hostnameOf(storageHost())
if (scheduleOn && gwOrigin && gwOrigin === stOrigin) {
	console.log("WARNING: storage_HOST points at gateway_HOST — the gateway strips Authorization, so every scheduled task 401s; point storage_HOST straight at the storage service")
}
else if (scheduleOn && stHostname && !LOOPBACK.includes(stHostname) && trustedSources === "") {
	console.log("WARNING: storage_HOST is not loopback but scheduler_TRUSTED_SOURCES is unset — storage trusts only loopback, so every scheduled task 401s; set it to the address/CIDR the schedule service connects from")
}

if(allEnvPresent){
	process.exit(0)
}
else{
	process.exit(1)
}
