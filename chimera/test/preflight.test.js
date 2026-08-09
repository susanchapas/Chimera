jest.mock("fs", () => {
	const actual = jest.requireActual("fs")
	return {
		...actual,
		existsSync: jest.fn(() => true),
		readFileSync: jest.fn((p) => {
			if (p.includes("env.example")) return [
				"SECRETKEY = Auth secret key",
				"gateway_PORT = Port number",
				"command_ON = (true | false)",
				"alert_TZ = IANA tz ***",
				"storage_FOLDERPATH = /mnt/storage/  # default; base shared file path",
				"livestream_FOLDERPATH = Base shared folder path  # frames live here"
			].join("\n")
			if (p.includes("cam1.conf")) return "camera_id 1\ncamera_name indoor\nnetcam_url rtsp://1.1.1.1/cam\n"
			if (p.includes("cam2.conf")) return "camera_id 2\ncamera_name outdoor\nnetcam_url rtsp://2.2.2.2/cam\n"
			if (p.includes("motion.conf")) return ""
			return actual.readFileSync(p)
		}),
		readdirSync: jest.fn(() => ["cam1.conf", "cam2.conf"])
	}
})

const fs = require("fs")
const { WATCHDOG_MIN_INTERVAL_MS, parseSchema, typeOf, varProblem, cameraProblems, isServiceOff, blankDisables, objectFeedProblem, insecureCookie, cookieSecureProblem, cookiePlainHttpProblem, cookieAmbiguousHostWarning, httpsRedirectLoopWarning, certUnreadableWarning, httpsRedirectPortWarning, watchdogHostWarning, certbotPortProblem, duplicatePortProblems, setupTokenHint, envProblems, hashTruncated, looseMode } = require("../preflight.js")

describe("parseSchema", () => {
	test("parses required keys", () => {
		const schema = parseSchema()
		expect(schema.map(v => v.key)).toContain("SECRETKEY")
		expect(schema.map(v => v.key)).toContain("gateway_PORT")
	})

	test("marks optional keys (***)", () => {
		const schema = parseSchema()
		const tz = schema.find(v => v.key === "alert_TZ")
		expect(tz.optional).toBe(true)
	})

	test("marks required keys as not optional", () => {
		const schema = parseSchema()
		const sk = schema.find(v => v.key === "SECRETKEY")
		expect(sk.optional).toBe(false)
	})

	test("keeps a trailing # hint in desc but strips it from placeholder", () => {
		const schema = parseSchema()
		const fp = schema.find(v => v.key === "livestream_FOLDERPATH")
		expect(fp.placeholder).toBe("Base shared folder path")
		expect(fp.desc).toContain("# frames live here")
	})

	test("a # default line holds a real value, so nothing is treated as placeholder prose", () => {
		const schema = parseSchema()
		const fp = schema.find(v => v.key === "storage_FOLDERPATH")
		expect(fp.placeholder).toBe("")
		expect(varProblem(fp, "/mnt/storage/")).toBeNull()
	})
})

describe("typeOf", () => {
	test("bool for true|false placeholder", () => {
		expect(typeOf("command_ON", "(true | false)")).toBe("bool")
	})

	test("port for _PORT suffix", () => {
		expect(typeOf("gateway_PORT", "Port number")).toBe("port")
	})

	test("port for _PORT_SECURE suffix", () => {
		expect(typeOf("gateway_PORT_SECURE", "Port number")).toBe("port")
	})

	test("string otherwise", () => {
		expect(typeOf("SECRETKEY", "Auth secret key")).toBe("string")
	})
})

describe("varProblem", () => {
	const boolVar = { key: "command_ON", placeholder: "(true | false)", optional: false }
	const portVar = { key: "gateway_PORT", placeholder: "Port number", optional: false }
	const strVar = { key: "database_NAME", placeholder: "postgres database name", optional: false }
	const secretVar = { key: "SECRETKEY", placeholder: "Auth secret key", optional: false }
	const optVar = { key: "alert_TZ", placeholder: "IANA tz ***", optional: true }
	const instancesVar = { key: "chimeraInstances", placeholder: "Number of instances", optional: false }
	const storageHostVar = { key: "storage_HOST", placeholder: "https://storage.server.example or http://127.0.0.1:8081", optional: false }
	const gatewayHostVar = { key: "gateway_HOST", placeholder: "https://gateway.server.example or http://127.0.0.1:8080 (protocol defaults to https:// if omitted)", optional: false }
	const alertOnVar = { key: "object_ALERT_ON", placeholder: "(true | text | false, default true)", optional: true }
	const tokenVar = { key: "setup_TOKEN", placeholder: "required token gating /authorization/setup", optional: false }
	const schedulerAuthVar = { key: "scheduler_AUTH", placeholder: "Authorization token for scheduler server", optional: false }
	const memoryTokenVar = { key: "memory_AUTH_TOKEN", placeholder: "Header token to connect to memory socket", optional: false }
	const dbPasswordVar = { key: "database_PASSWORD", placeholder: "postgres password", optional: false }
	const watchdogIntervalVar = { key: "watchdog_INTERVAL_MS", placeholder: "Milliseconds between health polls", optional: true }
	const watchdogFailuresVar = { key: "watchdog_FAILURES", placeholder: "Consecutive failed polls", optional: true }

	test("required unset → error", () => {
		expect(varProblem(strVar, undefined)).toBeTruthy()
		expect(varProblem(strVar, "")).toBeTruthy()
	})

	test("optional unset → null", () => {
		expect(varProblem(optVar, undefined)).toBeNull()
	})

	test("bool: invalid value → error", () => {
		expect(varProblem(boolVar, "yes")).toBeTruthy()
	})

	test("bool: true/false → null", () => {
		expect(varProblem(boolVar, "true")).toBeNull()
		expect(varProblem(boolVar, "false")).toBeNull()
	})

	test("object_ALERT_ON: text is a valid third value, anything else is not", () => {
		expect(varProblem(alertOnVar, "text")).toBeNull()
		expect(varProblem(alertOnVar, "true")).toBeNull()
		expect(varProblem(alertOnVar, "false")).toBeNull()
		expect(varProblem(alertOnVar, "yes")).toBeTruthy()
	})

	test("port: non-numeric → error", () => {
		expect(varProblem(portVar, "abc")).toBeTruthy()
	})

	test("port: numeric string → null", () => {
		expect(varProblem(portVar, "8080")).toBeNull()
	})

	test("port: out of range → error, so it cannot reach listen() and throw ERR_SOCKET_BAD_PORT", () => {
		expect(varProblem(portVar, "0")).toBeTruthy()
		expect(varProblem(portVar, "65536")).toBeTruthy()
		expect(varProblem(portVar, "99999")).toBeTruthy()
		expect(varProblem(portVar, "1")).toBeNull()
		expect(varProblem(portVar, "65535")).toBeNull()
	})

	test("string: set to non-placeholder → null", () => {
		expect(varProblem(strVar, "mysecret")).toBeNull()
	})

	test("chimeraInstances: values pm2 cannot cluster → error", () => {
		expect(varProblem(instancesVar, "lots")).toBeTruthy()
		expect(varProblem(instancesVar, "-2")).toBeTruthy()
		expect(varProblem(instancesVar, "4x")).toBeTruthy()
		expect(varProblem(instancesVar, "1.5")).toBeTruthy()
	})

	test("chimeraInstances: values pm2 accepts → null", () => {
		expect(varProblem(instancesVar, "max")).toBeNull()
		expect(varProblem(instancesVar, "-1")).toBeNull()
		expect(varProblem(instancesVar, "0")).toBeNull()
		expect(varProblem(instancesVar, "1")).toBeNull()
		expect(varProblem(instancesVar, "4")).toBeNull()
	})

	test("storage_HOST: implied protocol → error, since https:// to a plain-HTTP storage fails every cron", () => {
		expect(varProblem(storageHostVar, "127.0.0.1:8081")).toBeTruthy()
		expect(varProblem(storageHostVar, "storage.server.example")).toBeTruthy()
	})

	test("storage_HOST: explicit protocol → null", () => {
		expect(varProblem(storageHostVar, "http://127.0.0.1:8081")).toBeNull()
		expect(varProblem(storageHostVar, "https://storage.server.example")).toBeNull()
	})

	test("gateway_HOST: unparseable → error, matching the boot gate instead of writing it to .env", () => {
		expect(varProblem(gatewayHostVar, "not a valid host")).toBeTruthy()
		expect(varProblem(gatewayHostVar, "https://cam.example.com:notaport")).toBeTruthy()
	})

	test("gateway_HOST: parseable with or without a scheme → null", () => {
		expect(varProblem(gatewayHostVar, "cam.example.com")).toBeNull()
		expect(varProblem(gatewayHostVar, "https://cam.example.com:8443")).toBeNull()
		expect(varProblem(gatewayHostVar, "http://127.0.0.1:8080")).toBeNull()
	})

	test("gateway_HOST: a bare IPv6 literal → null, bracketed or not — new URL() only takes the bracketed form", () => {
		expect(varProblem(gatewayHostVar, "::1")).toBeNull()
		expect(varProblem(gatewayHostVar, "[::1]")).toBeNull()
		expect(varProblem(gatewayHostVar, "http://::1")).toBeNull()
		expect(varProblem(gatewayHostVar, "https://[2001:db8::5]:8443")).toBeNull()
	})

	test("watchdog_FAILURES: a threshold below 1 acts on the first blip → error", () => {
		expect(varProblem(watchdogFailuresVar, "0")).toBeTruthy()
		expect(varProblem(watchdogFailuresVar, "-1")).toBeTruthy()
		expect(varProblem(watchdogFailuresVar, "1.5")).toBeTruthy()
		expect(varProblem(watchdogFailuresVar, "1")).toBeNull()
		expect(varProblem(watchdogFailuresVar, "3")).toBeNull()
	})

	// 60 meaning "a minute" would poll every 60ms and reach the reboot stage within a second of the first failure
	test("watchdog_INTERVAL_MS: a seconds-for-milliseconds value → error naming the unit", () => {
		expect(varProblem(watchdogIntervalVar, "60")).toMatch(/milliseconds/)
		expect(varProblem(watchdogIntervalVar, "1")).toBeTruthy()
		expect(varProblem(watchdogIntervalVar, "4999")).toBeTruthy()
		expect(varProblem(watchdogIntervalVar, "abc")).toBeTruthy()
		expect(varProblem(watchdogIntervalVar, String(WATCHDOG_MIN_INTERVAL_MS))).toBeNull()
		expect(varProblem(watchdogIntervalVar, "60000")).toBeNull()
	})

	test("setup_TOKEN: under 32 characters → error, so preflight blocks what validateEnvVars would crash-loop on", () => {
		expect(varProblem(tokenVar, "too-short-a-token")).toBeTruthy()
	})

	test("setup_TOKEN: at least 32 characters → null", () => {
		expect(varProblem(tokenVar, "a".repeat(32))).toBeNull()
	})

	test("SECRETKEY: under 32 characters → error, matching the boot check instead of crash-looping there", () => {
		expect(varProblem(secretVar, "short-signing-key")).toBeTruthy()
	})

	test("SECRETKEY: at least 32 characters → null", () => {
		expect(varProblem(secretVar, "a".repeat(32))).toBeNull()
	})

	test("scheduler_AUTH: under 32 characters → error, since a match grants role admin on the schedulable routes", () => {
		expect(varProblem(schedulerAuthVar, "short-scheduler-auth")).toBeTruthy()
		expect(varProblem(schedulerAuthVar, "a".repeat(32))).toBeNull()
	})

	test("the length floor covers every key isSecret matches, not just SECRETKEY and setup_TOKEN", () => {
		expect(varProblem(memoryTokenVar, "short-memory-token")).toBeTruthy()
		expect(varProblem(dbPasswordVar, "postgres")).toBeTruthy()
		expect(varProblem(memoryTokenVar, "a".repeat(32))).toBeNull()
		expect(varProblem(dbPasswordVar, "a".repeat(32))).toBeNull()
	})

	test("a short non-secret is untouched by the floor", () => {
		expect(varProblem(strVar, "chimera")).toBeNull()
	})
})

describe("objectFeedProblem", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("object without livestream blocks — the HLS feed object scans is never written", () => {
		expect(objectFeedProblem(lines({ object_ON: "true", livestream_ON: "false" }))).toMatch(/object_ON requires livestream_ON/)
	})

	test("an unset livestream_ON blocks the same way — only \"true\" starts the ffmpeg writers", () => {
		expect(objectFeedProblem(lines({ object_ON: "true" }))).toBeTruthy()
	})

	test("object with livestream passes", () => {
		expect(objectFeedProblem(lines({ object_ON: "true", livestream_ON: "true" }))).toBeNull()
	})

	test("livestream_PROXY_ON is no escape — it only routes gateway HTTP to livestream_HOST, it never fills the local livestream_FOLDERPATH", () => {
		expect(objectFeedProblem(lines({ object_ON: "true", livestream_ON: "false", livestream_PROXY_ON: "true" }))).toBeTruthy()
	})

	test("livestream without object passes — livestream stands alone", () => {
		expect(objectFeedProblem(lines({ object_ON: "false", livestream_ON: "true" }))).toBeNull()
	})

	test("both off passes", () => {
		expect(objectFeedProblem(lines({ object_ON: "false", livestream_ON: "false" }))).toBeNull()
	})
})

describe("cookieSecureProblem", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("a scheme-less public gateway_HOST resolves to https, so an insecure cookie is fatal", () => {
		expect(cookieSecureProblem(lines({ gateway_HOST: "example.com", command_COOKIE_SECURE: "false" }))).toMatch(/command_COOKIE_SECURE MUST BE true/)
	})

	test("gateway_HTTPS_Redirect makes it fatal even on a plain-http gateway_HOST", () => {
		expect(cookieSecureProblem(lines({ gateway_HOST: "http://example.com", command_COOKIE_SECURE: "false", gateway_HTTPS_Redirect: "true" }))).toBeTruthy()
	})

	test("certbot_ON makes it fatal even on a plain-http gateway_HOST", () => {
		expect(cookieSecureProblem(lines({ gateway_HOST: "http://example.com", command_COOKIE_SECURE: "false", certbot_ON: "true" }))).toBeTruthy()
	})

	test("a plain-http gateway_HOST with no HTTPS signal warns instead of failing", () => {
		const l = lines({ gateway_HOST: "http://example.com", command_COOKIE_SECURE: "false" })
		expect(cookieSecureProblem(l)).toBeNull()
		expect(insecureCookie(l)).toBe(true)
	})

	test("loopback passes", () => {
		expect(insecureCookie(lines({ gateway_HOST: "127.0.0.1", command_COOKIE_SECURE: "false" }))).toBe(false)
	})

	test("a set cookie flag passes", () => {
		expect(insecureCookie(lines({ gateway_HOST: "example.com", command_COOKIE_SECURE: "true" }))).toBe(false)
	})

	test("the check is skipped when the command service is off", () => {
		expect(insecureCookie(lines({ gateway_HOST: "example.com", command_ON: "false", command_COOKIE_SECURE: "false" }))).toBe(false)
	})

	test("command_COOKIE_SECURE=true on an explicit http:// gateway_HOST never fires cookieSecureProblem — that is cookiePlainHttpProblem's territory", () => {
		expect(cookieSecureProblem(lines({ gateway_HOST: "http://example.com", command_COOKIE_SECURE: "true" }))).toBeNull()
	})
})

describe("cookiePlainHttpProblem", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("fires on an explicit http:// gateway_HOST with command_COOKIE_SECURE=true and no HTTPS signal", () => {
		expect(cookiePlainHttpProblem(lines({ gateway_HOST: "http://192.168.1.50:8080", command_COOKIE_SECURE: "true" }))).toMatch(/command_COOKIE_SECURE MUST BE false/)
	})

	test("a bare, prefix-less gateway_HOST is the ambiguous case and does not fire — normalizeHost implies https:// there", () => {
		expect(cookiePlainHttpProblem(lines({ gateway_HOST: "192.168.1.50:8080", command_COOKIE_SECURE: "true" }))).toBeNull()
	})

	test("loopback is exempt — browsers honour Secure on http://localhost", () => {
		expect(cookiePlainHttpProblem(lines({ gateway_HOST: "http://localhost:8080", command_COOKIE_SECURE: "true" }))).toBeNull()
	})

	test("gateway_HTTPS_Redirect=true rules it out even on an explicit http:// gateway_HOST", () => {
		expect(cookiePlainHttpProblem(lines({ gateway_HOST: "http://192.168.1.50:8080", command_COOKIE_SECURE: "true", gateway_HTTPS_Redirect: "true" }))).toBeNull()
	})

	test("certbot_ON=true rules it out even on an explicit http:// gateway_HOST", () => {
		expect(cookiePlainHttpProblem(lines({ gateway_HOST: "http://192.168.1.50:8080", command_COOKIE_SECURE: "true", certbot_ON: "true" }))).toBeNull()
	})

	test("the check is skipped when the command service is off", () => {
		expect(cookiePlainHttpProblem(lines({ gateway_HOST: "http://192.168.1.50:8080", command_ON: "false", command_COOKIE_SECURE: "true" }))).toBeNull()
	})

	test("command_COOKIE_SECURE=false never fires it — that is cookieSecureProblem's territory", () => {
		expect(cookiePlainHttpProblem(lines({ gateway_HOST: "http://192.168.1.50:8080", command_COOKIE_SECURE: "false" }))).toBeNull()
	})

	test("a bare (unbracketed) IPv6 loopback is exempt — new URL() rejects it, so the raw host must be checked too", () => {
		expect(cookiePlainHttpProblem(lines({ gateway_HOST: "http://::1", command_COOKIE_SECURE: "true" }))).toBeNull()
	})

	test("a bracketed IPv6 loopback is exempt", () => {
		expect(cookiePlainHttpProblem(lines({ gateway_HOST: "http://[::1]", command_COOKIE_SECURE: "true" }))).toBeNull()
	})
})

describe("cookieAmbiguousHostWarning", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("fires on a bare, prefix-less gateway_HOST with command_COOKIE_SECURE=true and no HTTPS signal", () => {
		expect(cookieAmbiguousHostWarning(lines({ gateway_HOST: "192.168.1.50:8080", command_COOKIE_SECURE: "true" }))).toMatch(/WARNING: gateway_HOST has no scheme/)
	})

	test("an explicit scheme rules it out — nothing is ambiguous once the scheme is written down", () => {
		expect(cookieAmbiguousHostWarning(lines({ gateway_HOST: "https://192.168.1.50:8080", command_COOKIE_SECURE: "true" }))).toBeNull()
		expect(cookieAmbiguousHostWarning(lines({ gateway_HOST: "http://192.168.1.50:8080", command_COOKIE_SECURE: "true" }))).toBeNull()
	})

	test("loopback is exempt — browsers honour Secure on localhost", () => {
		expect(cookieAmbiguousHostWarning(lines({ gateway_HOST: "localhost", command_COOKIE_SECURE: "true" }))).toBeNull()
	})

	test("a bare (unbracketed) IPv6 loopback is exempt — new URL() rejects it, so the raw host must be checked too", () => {
		expect(cookieAmbiguousHostWarning(lines({ gateway_HOST: "::1", command_COOKIE_SECURE: "true" }))).toBeNull()
	})

	test("certbot_ON=true rules it out — certbot means HTTPS, not ambiguous", () => {
		expect(cookieAmbiguousHostWarning(lines({ gateway_HOST: "example.com", command_COOKIE_SECURE: "true", certbot_ON: "true" }))).toBeNull()
	})

	test("gateway_HTTPS_Redirect=true rules it out — reverse-proxy TLS termination, not ambiguous", () => {
		expect(cookieAmbiguousHostWarning(lines({ gateway_HOST: "example.com", command_COOKIE_SECURE: "true", gateway_HTTPS_Redirect: "true" }))).toBeNull()
	})

	test("command_COOKIE_SECURE=false never fires it — that is the insecure-cookie warning's territory", () => {
		expect(cookieAmbiguousHostWarning(lines({ gateway_HOST: "192.168.1.50:8080", command_COOKIE_SECURE: "false" }))).toBeNull()
	})

	test("the check is skipped when the command service is off", () => {
		expect(cookieAmbiguousHostWarning(lines({ gateway_HOST: "192.168.1.50:8080", command_ON: "false", command_COOKIE_SECURE: "true" }))).toBeNull()
	})

	test("a blank gateway_HOST has nothing to be ambiguous about", () => {
		expect(cookieAmbiguousHostWarning(lines({ gateway_HOST: "", command_COOKIE_SECURE: "true" }))).toBeNull()
	})
})

const mockCertFs = (readable = [], unreadable = [], code = "EACCES") => {
	const spies = [
		jest.spyOn(fs, "openSync").mockImplementation((p) => {
			if (readable.includes(p)) return 3
			const err = unreadable.includes(p) ? code : "ENOENT"
			throw Object.assign(new Error(err), { code: err })
		}),
		jest.spyOn(fs, "fstatSync").mockImplementation(() => ({ isFile: () => true })),
		jest.spyOn(fs, "closeSync").mockImplementation(() => {})
	]
	return () => spies.forEach(s => s.mockRestore())
}

const LE = ["/etc/letsencrypt/live/cam.example.com/privkey.pem", "/etc/letsencrypt/live/cam.example.com/fullchain.pem"]

describe("httpsRedirectLoopWarning", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("fires when the redirect is on and nothing here gives this machine a certificate", () => {
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", privateKey_FILEPATH: "", certificate_FILEPATH: "" }))).toMatch(/ERR_TOO_MANY_REDIRECTS/)
	})

	test("fires when those lines are missing from .env entirely, not merely blank", () => {
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true" }))).toBeTruthy()
	})

	test("certbot_ON=true rules it out — certbot gets this machine its own certificate", () => {
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "true" }))).toBeNull()
	})

	test("gateway_TRUST_PROXY=true rules it out — the proxy in front says which scheme the visitor used", () => {
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_TRUST_PROXY: "true" }))).toBeNull()
	})

	test("both FILEPATHs set rules it out — the operator supplied a matched certificate pair", () => {
		const restore = mockCertFs(["/certs/privkey.pem", "/certs/fullchain.pem"])
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", privateKey_FILEPATH: "/certs/privkey.pem", certificate_FILEPATH: "/certs/fullchain.pem" }))).toBeNull()
		restore()
	})

	test("both FILEPATHs absolute but missing on disk still fires — an absolute path alone does not prove the cert is there", () => {
		const restore = mockCertFs()
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", privateKey_FILEPATH: "/certs/privkey.pem", certificate_FILEPATH: "/certs/fullchain.pem" }))).toBeTruthy()
		restore()
	})

	test("only privateKey_FILEPATH set still fires — certPaths.js requires both-or-neither and disables TLS entirely on a mismatched pair", () => {
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", privateKey_FILEPATH: "/certs/privkey.pem", certificate_FILEPATH: "" }))).toBeTruthy()
	})

	test("only certificate_FILEPATH set still fires — same both-or-neither gap", () => {
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", privateKey_FILEPATH: "", certificate_FILEPATH: "/certs/fullchain.pem" }))).toBeTruthy()
	})

	test("placeholder prose in the FILEPATHs still fires — `cp env.example .env` leaves the description behind, not a path", () => {
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", privateKey_FILEPATH: "Custom TLS private key path (overrides auto-resolve)", certificate_FILEPATH: "Custom TLS certificate path (overrides auto-resolve)" }))).toBeTruthy()
	})

	test("never fires while the redirect is off — nothing redirects, so nothing can loop", () => {
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "false" }))).toBeNull()
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "" }))).toBeNull()
		expect(httpsRedirectLoopWarning(lines({}))).toBeNull()
	})

	test("auto-resolved cert files on disk for gateway_HOST rule it out — a certbot run on the host outside chimera's own flow still holds the certificate", () => {
		const restore = mockCertFs(LE)
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", gateway_HOST: "https://cam.example.com" }))).toBeNull()
		restore()
	})

	test("still fires when only one of the two auto-resolved cert files exists", () => {
		const restore = mockCertFs([LE[0]])
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", gateway_HOST: "https://cam.example.com" }))).toBeTruthy()
		restore()
	})

	test("still fires when gateway_HOST is set but no cert files exist there yet", () => {
		const restore = mockCertFs()
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", gateway_HOST: "https://cam.example.com" }))).toBeTruthy()
		restore()
	})

	test("fires for an IPv4-literal gateway_HOST — Let's Encrypt issues for domain names only, so there is no auto-resolved pair to find", () => {
		const restore = mockCertFs()
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", gateway_HOST: "https://192.168.1.50" }))).toBeTruthy()
		restore()
	})

	test("stays quiet when the auto-resolved cert dir is unreadable — certbot-entry.sh leaves it mode 0710, and EACCES is not proof the cert is absent", () => {
		const restore = mockCertFs([], LE)
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", gateway_HOST: "https://cam.example.com" }))).toBeNull()
		restore()
	})

	test("a cert that stats fine but cannot be opened counts as unreadable — handleSecureServerStart reads the file, it does not stat it", () => {
		const statSpy = jest.spyOn(fs, "statSync").mockImplementation(() => ({ isFile: () => true }))
		const restore = mockCertFs([], LE)
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", gateway_HOST: "https://cam.example.com" }))).toBeNull()
		expect(certUnreadableWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", gateway_HOST: "https://cam.example.com" }))).toMatch("(EACCES)")
		restore()
		statSpy.mockRestore()
	})

	test("fires when the FILEPATH overrides are missing even though an auto-resolved pair is on disk — certPaths() gives the overrides precedence", () => {
		const restore = mockCertFs(LE)
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", gateway_HOST: "https://cam.example.com", privateKey_FILEPATH: "/certs/privkey.pem", certificate_FILEPATH: "/certs/fullchain.pem" }))).toBeTruthy()
		restore()
	})

	test("fires when only one FILEPATH is set and an auto-resolved pair is on disk — a half-set override disables TLS entirely", () => {
		const restore = mockCertFs(LE)
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", gateway_HOST: "https://cam.example.com", privateKey_FILEPATH: "/certs/privkey.pem" }))).toBeTruthy()
		restore()
	})

	test("stays quiet when a configured FILEPATH is unreadable", () => {
		const restore = mockCertFs([], ["/certs/privkey.pem", "/certs/fullchain.pem"])
		expect(httpsRedirectLoopWarning(lines({ gateway_HTTPS_Redirect: "true", privateKey_FILEPATH: "/certs/privkey.pem", certificate_FILEPATH: "/certs/fullchain.pem" }))).toBeNull()
		restore()
	})
})

describe("certUnreadableWarning", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("names the unreadable path and its errno, so EACCES does not read as a certificate", () => {
		const restore = mockCertFs([], LE)
		const w = certUnreadableWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", gateway_HOST: "https://cam.example.com" }))
		expect(w).toMatch("/etc/letsencrypt/live/cam.example.com/privkey.pem (EACCES)")
		expect(w).toMatch("/etc/letsencrypt/live/cam.example.com/fullchain.pem (EACCES)")
		expect(w).toMatch("the redirect-loop warning stays silent")
		restore()
	})

	test("fires for an unreadable FILEPATH override — a container path need not exist on the host", () => {
		const restore = mockCertFs([], ["/etc/ssl/private/key.pem", "/etc/ssl/certs/cert.pem"])
		expect(certUnreadableWarning(lines({ gateway_HTTPS_Redirect: "true", privateKey_FILEPATH: "/etc/ssl/private/key.pem", certificate_FILEPATH: "/etc/ssl/certs/cert.pem" }))).toMatch("/etc/ssl/private/key.pem (EACCES)")
		restore()
	})

	test("a mixed pair does not claim the loop warning stayed silent — one unreadable path and one missing fires both", () => {
		const opts = { gateway_HTTPS_Redirect: "true", privateKey_FILEPATH: "/etc/ssl/private/key.pem", certificate_FILEPATH: "/etc/ssl/certs/cert.pem" }
		const restore = mockCertFs([], ["/etc/ssl/private/key.pem"])
		expect(httpsRedirectLoopWarning(lines(opts))).toBeTruthy()
		const w = certUnreadableWarning(lines(opts))
		expect(w).toMatch("/etc/ssl/private/key.pem (EACCES)")
		expect(w).not.toMatch("stays silent")
		restore()
	})

	test("stays quiet when the paths are merely absent — httpsRedirectLoopWarning already speaks for that", () => {
		const restore = mockCertFs()
		expect(certUnreadableWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "false", gateway_HOST: "https://cam.example.com" }))).toBeNull()
		restore()
	})

	test("stays quiet when nothing here has to hold a certificate", () => {
		const restore = mockCertFs([], LE)
		expect(certUnreadableWarning(lines({ gateway_HTTPS_Redirect: "false", gateway_HOST: "https://cam.example.com" }))).toBeNull()
		expect(certUnreadableWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_TRUST_PROXY: "true", gateway_HOST: "https://cam.example.com" }))).toBeNull()
		expect(certUnreadableWarning(lines({ gateway_HTTPS_Redirect: "true", certbot_ON: "true", gateway_HOST: "https://cam.example.com" }))).toBeNull()
		restore()
	})
})

describe("httpsRedirectPortWarning", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("stays quiet when gateway_HOST names no port — gateway.js appends gateway_PORT_SECURE itself, so the redirect reaches the listener", () => {
		expect(httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_PORT: "8080", gateway_PORT_SECURE: "8443", gateway_HOST: "https://192.168.1.50" }))).toBeNull()
	})

	test("fires when the TLS listener is on a port gateway_HOST names differently — the redirect lands where nothing serves TLS", () => {
		const w = httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_PORT: "8080", gateway_PORT_SECURE: "8443", gateway_HOST: "https://192.168.1.50:9443" }))
		expect(w).toMatch(/ERR_SSL_PROTOCOL_ERROR/)
		expect(w).toMatch(/visitors to port 9443 \(gateway_HOST\)/)
		expect(w).toMatch(/terminates TLS on port 8443 \(gateway_PORT_SECURE\)/)
	})

	test("fires when gateway_HOST names a port the TLS listener does not use", () => {
		const w = httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_PORT_SECURE: "443", gateway_HOST: "https://192.168.1.50:8443" }))
		expect(w).toMatch(/visitors to port 8443 \(gateway_HOST\)/)
		expect(w).toMatch(/terminates TLS on port 443 \(gateway_PORT_SECURE\)/)
	})

	test("matching ports pass", () => {
		expect(httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_PORT: "8080", gateway_PORT_SECURE: "8443", gateway_HOST: "https://192.168.1.50:8443" }))).toBeNull()
	})

	test("a bare gateway_HOST reads as https on 443, so a blank gateway_PORT_SECURE matches it", () => {
		expect(httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_PORT: "80", gateway_HOST: "cam.example.com" }))).toBeNull()
	})

	test("an explicit :443 in gateway_HOST is the same 443 the default names", () => {
		expect(httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_HOST: "https://cam.example.com:443" }))).toBeNull()
	})

	test("a blank gateway_PORT_SECURE still fires against a non-443 gateway_HOST — the listener falls back to 443", () => {
		expect(httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_HOST: "https://cam.example.com:8443" }))).toBeTruthy()
	})

	test("never fires while the redirect is off — nothing redirects, so nothing can miss the listener", () => {
		expect(httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "false", gateway_PORT_SECURE: "8443", gateway_HOST: "https://cam.example.com" }))).toBeNull()
		expect(httpsRedirectPortWarning(lines({ gateway_PORT_SECURE: "8443", gateway_HOST: "https://cam.example.com" }))).toBeNull()
	})

	test("an explicit http:// gateway_HOST fires — the redirect targets https:// regardless, so the scheme contradicts itself", () => {
		expect(httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_PORT_SECURE: "8443", gateway_HOST: "http://192.168.1.50:8080" }))).toMatch(/gateway_HOST is http:\/\//)
	})

	test("an http:// gateway_HOST behind a trusted proxy still fires — the port it names is the one gateway.js drops", () => {
		expect(httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_TRUST_PROXY: "true", gateway_PORT_SECURE: "8443", gateway_HOST: "http://cam.example.com:8443" }))).toMatch(/gateway_HOST is http:\/\//)
	})

	test("a blank or unparseable gateway_HOST names no port to disagree with", () => {
		expect(httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_PORT_SECURE: "8443", gateway_HOST: "" }))).toBeNull()
		expect(httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_PORT_SECURE: "8443", gateway_HOST: "not a valid host" }))).toBeNull()
	})

	test("gateway_TRUST_PROXY=true rules it out — the container's TLS port and the browser-facing port are meant to differ behind a proxy", () => {
		expect(httpsRedirectPortWarning(lines({ gateway_HTTPS_Redirect: "true", gateway_TRUST_PROXY: "true", gateway_PORT_SECURE: "8443", gateway_HOST: "https://cam.example.com" }))).toBeNull()
	})
})

describe("watchdogHostWarning", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("fires on a scheme-less host — normalizeHost reads it as https, so a plain-HTTP deploy reboot-loops", () => {
		expect(watchdogHostWarning(lines({ watchdog_ON: "true", gateway_HOST: "192.168.1.50:8080" }))).toMatch(/reboots a healthy host/)
	})

	test("an explicit scheme rules it out, either way", () => {
		expect(watchdogHostWarning(lines({ watchdog_ON: "true", gateway_HOST: "http://192.168.1.50:8080" }))).toBeNull()
		expect(watchdogHostWarning(lines({ watchdog_ON: "true", gateway_HOST: "https://cam.example.com" }))).toBeNull()
	})

	test("never fires while the watchdog is off — nothing polls, so nothing reboots", () => {
		expect(watchdogHostWarning(lines({ watchdog_ON: "false", gateway_HOST: "192.168.1.50:8080" }))).toBeNull()
		expect(watchdogHostWarning(lines({ gateway_HOST: "192.168.1.50:8080" }))).toBeNull()
	})

	test("names NODE_EXTRA_CA_CERTS, since node's fetch rejects the self-signed pair the FILEPATH vars allow", () => {
		expect(watchdogHostWarning(lines({ watchdog_ON: "true", gateway_HOST: "cam.example.com" }))).toMatch(/NODE_EXTRA_CA_CERTS/)
	})

	test("fires on an explicit https:// host no public CA issues for", () => {
		for (const host of ["https://cam.lan", "https://chimera", "https://192.168.1.50:8443", "https://nvr.internal"]) {
			expect(watchdogHostWarning(lines({ watchdog_ON: "true", gateway_HOST: host }))).toMatch(/NODE_EXTRA_CA_CERTS/)
		}
	})

	test("a publicly resolvable https:// host stays quiet — its certificate chains to a public CA", () => {
		expect(watchdogHostWarning(lines({ watchdog_ON: "true", gateway_HOST: "https://cam.example.com" }))).toBeNull()
	})

	test("http:// on a private name stays quiet", () => {
		expect(watchdogHostWarning(lines({ watchdog_ON: "true", gateway_HOST: "http://cam.lan" }))).toBeNull()
	})
})

describe("certbotPortProblem", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("certbot on a non-80 gateway_PORT blocks — the HTTP-01 challenge is the only port compose publishes", () => {
		expect(certbotPortProblem(lines({ certbot_ON: "true", gateway_PORT: "8080" }))).toMatch(/gateway_PORT MUST BE 80/)
	})

	test("an unset gateway_PORT blocks the same way — nothing answers the challenge either", () => {
		expect(certbotPortProblem(lines({ certbot_ON: "true" }))).toBeTruthy()
	})

	test("certbot on port 80 passes", () => {
		expect(certbotPortProblem(lines({ certbot_ON: "true", gateway_PORT: "80" }))).toBeNull()
	})

	test("a non-80 port passes with certbot off — BYO certs do not use HTTP-01", () => {
		expect(certbotPortProblem(lines({ certbot_ON: "false", gateway_PORT: "8080" }))).toBeNull()
		expect(certbotPortProblem(lines({ gateway_PORT: "8080" }))).toBeNull()
	})
})

describe("duplicatePortProblems", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("a duplicate PORT across two on services is caught and names both keys", () => {
		const probs = duplicatePortProblems(lines({ command_ON: "true", schedule_ON: "true", command_PORT: "8080", schedule_PORT: "8080" }))
		expect(probs).toEqual([["schedule_PORT", expect.stringMatching(/command_PORT/)]])
		expect(probs[0][1]).toMatch(/8080/)
	})

	test("gateway_PORT=443 with a blank gateway_PORT_SECURE collides with its own 443 default", () => {
		const probs = duplicatePortProblems(lines({ gateway_PORT: "443" }))
		expect(probs).toEqual([["gateway_PORT_SECURE", expect.stringMatching(/gateway_PORT/)]])
		expect(probs[0][1]).toMatch(/443/)
	})

	test("a duplicate is not caught when one of the two services is off", () => {
		expect(duplicatePortProblems(lines({ command_ON: "true", schedule_ON: "false", command_PORT: "8080", schedule_PORT: "8080" }))).toHaveLength(0)
	})

	test("a duplicate is not caught when the matching service is off even with PROXY_ON=true — a proxied service binds nothing locally", () => {
		expect(duplicatePortProblems(lines({ command_ON: "true", schedule_ON: "false", schedule_PROXY_ON: "true", command_PORT: "8080", schedule_PORT: "8080" }))).toHaveLength(0)
	})

	test("a service clashing with gateway_PORT names the service port, since the gateway port is the pinned one", () => {
		const probs = duplicatePortProblems(lines({ command_ON: "true", command_PORT: "80", gateway_PORT: "80" }))
		expect(probs).toEqual([["command_PORT", expect.stringMatching(/gateway_PORT/)]])
	})

	test("distinct ports pass", () => {
		expect(duplicatePortProblems(lines({ command_ON: "true", schedule_ON: "true", command_PORT: "8080", schedule_PORT: "8081" }))).toHaveLength(0)
	})
})

describe("setupTokenHint", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("names setup_TOKEN and how to read it back — the wizard only ever showed it as a default", () => {
		expect(setupTokenHint(lines({ command_ON: "true" }))).toMatch(/setup_TOKEN/)
		expect(setupTokenHint(lines({ command_ON: "true" }))).toMatch(/grep setup_TOKEN/)
	})

	test("no hint when the command service is off — there is no setup screen to reach", () => {
		expect(setupTokenHint(lines({ command_ON: "false" }))).toBeNull()
		expect(setupTokenHint(lines({}))).toBeNull()
	})
})

describe("envProblems", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)
	const SCHEMA = [{ key: "storage_FOLDERPATH", placeholder: "Base shared file path", desc: "Base shared file path", optional: false }]

	test("the insecure-cookie gate blocks preflight, matching the boot check", () => {
		const probs = envProblems([], lines({ gateway_HOST: "example.com", command_COOKIE_SECURE: "false" }))
		expect(probs).toEqual([["command_COOKIE_SECURE", expect.stringMatching(/command_COOKIE_SECURE MUST BE true/)]])
	})

	test("the plain-http cookie gate blocks preflight too", () => {
		const probs = envProblems([], lines({ gateway_HOST: "http://192.168.1.50:8080", command_COOKIE_SECURE: "true" }))
		expect(probs).toEqual([["command_COOKIE_SECURE", expect.stringMatching(/command_COOKIE_SECURE MUST BE false/)]])
	})

	test("a blank storage_FOLDERPATH is a problem once object_ON is on, even with storage off", () => {
		expect(envProblems(SCHEMA, lines({ storage_ON: "false", object_ON: "true", livestream_ON: "true", storage_FOLDERPATH: "" })))
			.toEqual([["storage_FOLDERPATH", "required, not set"]])
	})

	test("the same blank is skipped when neither storage nor object is on", () => {
		expect(envProblems(SCHEMA, lines({ storage_ON: "false", object_ON: "false", storage_FOLDERPATH: "" }))).toHaveLength(0)
	})

	test("the object/livestream dependency rides along with the per-key problems", () => {
		const probs = envProblems(SCHEMA, lines({ storage_ON: "false", object_ON: "true", livestream_ON: "false", storage_FOLDERPATH: "" }))
		expect(probs.map(([k]) => k)).toEqual(["storage_FOLDERPATH", "object_ON"])
		expect(probs[1][1]).toMatch(/object_ON requires livestream_ON/)
	})

	test("the certbot port gate blocks preflight, matching the boot check", () => {
		const probs = envProblems([], lines({ certbot_ON: "true", gateway_PORT: "8080" }))
		expect(probs).toEqual([["gateway_PORT", expect.stringMatching(/gateway_PORT MUST BE 80/)]])
	})

	test("a hand-edited value with a # is flagged even though it never went through the wizard", () => {
		const probs = envProblems(SCHEMA, lines({ storage_ON: "true", storage_FOLDERPATH: "/mnt/storage#leftover" }))
		expect(probs).toEqual([["storage_FOLDERPATH", expect.stringMatching(/cannot contain #/)]])
	})

	test("the duplicate-port gate rides along with the per-key problems", () => {
		const probs = envProblems([], lines({ command_ON: "true", schedule_ON: "true", command_PORT: "8080", schedule_PORT: "8080" }))
		expect(probs).toEqual([["schedule_PORT", expect.stringMatching(/command_PORT/)]])
	})
})

describe("hashTruncated", () => {
	const lines = (o) => Object.entries(o).map(([k, v]) => `${k} = ${v}`)

	test("flags a value that dotenv would silently truncate at #", () => {
		expect(hashTruncated(lines({ setup_TOKEN: "Str0ng#Passphrase" }), "setup_TOKEN")).toMatch(/cannot contain #/)
	})

	test("does not flag a plain value", () => {
		expect(hashTruncated(lines({ setup_TOKEN: "a-real-secret" }), "setup_TOKEN")).toBeNull()
	})

	test("does not flag a seeded key left blank with its example comment intact", () => {
		expect(hashTruncated(lines({ livestream_FOLDERPATH: "# frames live here" }), "livestream_FOLDERPATH")).toBeNull()
	})

	test("does not flag a key that is not set at all", () => {
		expect(hashTruncated(lines({}), "setup_TOKEN")).toBeNull()
	})

	test("does not flag a seeded default that kept the env.example comment dotenv strips", () => {
		expect(hashTruncated(lines({ storage_FOLDERPATH: "/mnt/storage/  # default; base shared file path" }), "storage_FOLDERPATH")).toBeNull()
	})
})

describe("cameraProblems", () => {
	test("no problems with valid confs", () => {
		expect(cameraProblems()).toHaveLength(0)
	})

	test("reports missing camera_id", () => {
		const { readFileSync } = require("fs")
		readFileSync.mockImplementation((p) => {
			if (p.includes("cam1.conf")) return "camera_name indoor\nnetcam_url rtsp://1.1.1.1/cam\n"
			if (p.includes("cam2.conf")) return "camera_id 2\ncamera_name outdoor\nnetcam_url rtsp://2.2.2.2/cam\n"
			return ""
		})
		const problems = cameraProblems()
		expect(problems.some(p => /camera_id/.test(p))).toBe(true)
	})
})

describe("isServiceOff (storage_MOTION_CONF_FILEPATH)", () => {
	const mkLines = (overrides = {}) => {
		const vals = { storage_ON: "false", object_ON: "false", livestream_ON: "false", ...overrides }
		return Object.entries(vals).map(([k, v]) => `${k} = ${v}`)
	}

	test("skipped when all camera services are off", () => {
		expect(isServiceOff(mkLines(), "storage_MOTION_CONF_FILEPATH")).toBe(true)
	})

	test("required when storage_ON=true", () => {
		expect(isServiceOff(mkLines({ storage_ON: "true" }), "storage_MOTION_CONF_FILEPATH")).toBe(false)
	})

	test("required when object_ON=true", () => {
		expect(isServiceOff(mkLines({ object_ON: "true" }), "storage_MOTION_CONF_FILEPATH")).toBe(false)
	})

	test("required when livestream_ON=true", () => {
		expect(isServiceOff(mkLines({ livestream_ON: "true" }), "storage_MOTION_CONF_FILEPATH")).toBe(false)
	})
})

describe("isServiceOff (prefix mapping)", () => {
	const lines = (o = {}) => Object.entries({ schedule_ON: "true", storage_ON: "false", object_ON: "false", livestream_ON: "false", ...o }).map(([k, v]) => `${k} = ${v}`)

	test("scheduler_AUTH follows schedule service (on)", () => {
		expect(isServiceOff(lines({ schedule_ON: "true" }), "scheduler_AUTH")).toBe(false)
	})

	test("scheduler_AUTH is skipped when blank and schedule is off", () => {
		expect(isServiceOff(lines({ schedule_ON: "false" }), "scheduler_AUTH")).toBe(true)
	})

	test("scheduler_AUTH is validated whenever it holds a value, because the storage bypass arms on it alone", () => {
		expect(isServiceOff(lines({ schedule_ON: "false", scheduler_AUTH: "a".repeat(32) }), "scheduler_AUTH")).toBe(false)
		expect(isServiceOff(lines({ schedule_ON: "false", scheduler_AUTH: "short" }), "scheduler_AUTH")).toBe(false)
	})

	test("blanking scheduler_AUTH is a valid interactive answer when schedule is off, so the wizard cannot demand a token the deploy does not need", () => {
		expect(blankDisables(lines({ schedule_ON: "false", scheduler_AUTH: "short" }), "scheduler_AUTH")).toBe(true)
	})

	test("blanking scheduler_AUTH is rejected while schedule is on", () => {
		expect(blankDisables(lines({ schedule_ON: "true", scheduler_AUTH: "short" }), "scheduler_AUTH")).toBe(false)
	})

	test("blankDisables leaves the caller's lines untouched", () => {
		const input = lines({ schedule_ON: "false", scheduler_AUTH: "short" })
		blankDisables(input, "scheduler_AUTH")
		expect(input).toContain("scheduler_AUTH = short")
	})

	test("ffmpeg_FILEPATH / ffprobe_FILEPATH skipped when no camera service is on", () => {
		expect(isServiceOff(lines(), "ffmpeg_FILEPATH")).toBe(true)
		expect(isServiceOff(lines(), "ffprobe_FILEPATH")).toBe(true)
	})

	test("ffmpeg_FILEPATH required when any camera service is on", () => {
		expect(isServiceOff(lines({ storage_ON: "true" }), "ffmpeg_FILEPATH")).toBe(false)
		expect(isServiceOff(lines({ object_ON: "true" }), "ffmpeg_FILEPATH")).toBe(false)
		expect(isServiceOff(lines({ livestream_ON: "true" }), "ffmpeg_FILEPATH")).toBe(false)
	})

	test("ffprobe_FILEPATH required only when storage is on", () => {
		expect(isServiceOff(lines({ storage_ON: "true" }), "ffprobe_FILEPATH")).toBe(false)
		expect(isServiceOff(lines({ object_ON: "true" }), "ffprobe_FILEPATH")).toBe(true)
		expect(isServiceOff(lines({ livestream_ON: "true" }), "ffprobe_FILEPATH")).toBe(true)
	})

	test("storage_FOLDERPATH follows storage or object — object writes objectCaptures under it", () => {
		expect(isServiceOff(lines({ storage_ON: "false", object_ON: "false" }), "storage_FOLDERPATH")).toBe(true)
		expect(isServiceOff(lines({ storage_ON: "true" }), "storage_FOLDERPATH")).toBe(false)
		expect(isServiceOff(lines({ storage_ON: "false", object_ON: "true" }), "storage_FOLDERPATH")).toBe(false)
	})

	test("livestream_FOLDERPATH follows livestream or object — object reads its feeds out of it", () => {
		expect(isServiceOff(lines({ livestream_ON: "false", object_ON: "false" }), "livestream_FOLDERPATH")).toBe(true)
		expect(isServiceOff(lines({ livestream_ON: "true" }), "livestream_FOLDERPATH")).toBe(false)
		expect(isServiceOff(lines({ livestream_ON: "false", object_ON: "true" }), "livestream_FOLDERPATH")).toBe(false)
	})

	test("object_MODEL_SHA256 required only once object_MODEL_URL is set", () => {
		expect(isServiceOff(lines({ object_ON: "true" }), "object_MODEL_SHA256")).toBe(true)
		expect(isServiceOff(lines({ object_ON: "true", object_MODEL_URL: "https://host/m.onnx" }), "object_MODEL_SHA256")).toBe(false)
		expect(isServiceOff(lines({ object_ON: "false", object_MODEL_URL: "https://host/m.onnx" }), "object_MODEL_SHA256")).toBe(true)
	})

	test("object_MODEL_SHA256 stays skipped when object_MODEL_URL still holds its env.example prose", () => {
		const prose = "Override URL to download the YOLOX ONNX model; requires object_MODEL_SHA256. Left blank, the first boot downloads yolox_tiny.onnx (~20 MB)"
		expect(isServiceOff(lines({ object_ON: "true", object_MODEL_URL: prose }), "object_MODEL_SHA256")).toBe(true)
	})

	test("memory vars follow memory service when single-instance", () => {
		expect(isServiceOff(lines({ memory_ON: "false", chimeraInstances: "1" }), "memory_HOST")).toBe(true)
		expect(isServiceOff(lines({ memory_ON: "true", chimeraInstances: "1" }), "memory_HOST")).toBe(false)
	})

	test("memory vars required despite memory_ON=false when chimeraInstances forces cluster mode", () => {
		expect(isServiceOff(lines({ memory_ON: "false", chimeraInstances: "4" }), "memory_HOST")).toBe(false)
		expect(isServiceOff(lines({ memory_ON: "false", chimeraInstances: "max" }), "memory_AUTH_TOKEN")).toBe(false)
		expect(isServiceOff(lines({ memory_ON: "false", chimeraInstances: "0" }), "memory_PORT")).toBe(false)
		expect(isServiceOff(lines({ memory_ON: "false", chimeraInstances: "-1" }), "memory_PORT")).toBe(false)
	})

	test("storage_HOST required despite storage_ON=false when schedule is on — crons post to it directly", () => {
		expect(isServiceOff(lines({ storage_ON: "false", schedule_ON: "true" }), "storage_HOST")).toBe(false)
		expect(isServiceOff(lines({ storage_ON: "true", schedule_ON: "false" }), "storage_HOST")).toBe(false)
		expect(isServiceOff(lines({ storage_ON: "false", schedule_ON: "false" }), "storage_HOST")).toBe(true)
	})

	test.each(["storage", "schedule", "livestream", "object", "command"])("%s_HOST required despite %s_ON=false when the gateway proxies it — it is the proxy target", (prefix) => {
		const off = { schedule_ON: "false", [`${prefix}_ON`]: "false" }
		expect(isServiceOff(lines({ ...off, [`${prefix}_PROXY_ON`]: "true" }), `${prefix}_HOST`)).toBe(false)
		expect(isServiceOff(lines({ ...off, [`${prefix}_PROXY_ON`]: "false" }), `${prefix}_HOST`)).toBe(true)
	})

	test.each(["gateway_PORT", "gateway_PORT_SECURE", "gateway_HOST"])("%s stays required with a stale gateway_ON=false in .env — compose interpolates gateway_PORT with no default and dies on a blank", (key) => {
		expect(isServiceOff(lines({ gateway_ON: "false" }), key)).toBe(false)
	})

	test("a PROXY_ON service still skips its non-host vars — only the proxy target is needed", () => {
		expect(isServiceOff(lines({ storage_ON: "false", schedule_ON: "false", storage_PROXY_ON: "true" }), "storage_PORT")).toBe(true)
		expect(isServiceOff(lines({ storage_ON: "false", schedule_ON: "false", storage_PROXY_ON: "true" }), "storage_FOLDERPATH")).toBe(true)
	})

	test("scheduler_TRUSTED_SOURCES is never service-gated — lib compiles it at import in every service", () => {
		expect(isServiceOff(lines({ schedule_ON: "false" }), "scheduler_TRUSTED_SOURCES")).toBe(false)
		expect(isServiceOff(lines({ schedule_ON: "true" }), "scheduler_TRUSTED_SOURCES")).toBe(false)
		expect(isServiceOff(lines({ schedule_ON: "false" }), "scheduler_AUTH")).toBe(true)
	})
})

// `cp env.example .env` yields 0644, and --check writes nothing, so reporting the mode is the only thing that closes the loop
describe("looseMode", () => {
	const fs = require("fs")
	const os = require("os")
	const path = require("path")
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-mode-"))
	const at = (name, mode) => {
		const p = path.join(dir, name)
		fs.writeFileSync(p, "x")
		fs.chmodSync(p, mode)
		return p
	}

	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

	// win32 and WSL's /mnt/c report a fixed mode whatever chmod does, and looseMode opts out there
	const onModes = (fs.statSync(at("probe", 0o600)).mode & 0o777) === 0o600 ? test : test.skip

	onModes("names the mode of a world-readable secret", () => {
		expect(looseMode(at("world", 0o644))).toBe("0644")
	})

	onModes("accepts the modes preflight itself writes", () => {
		expect(looseMode(at("tight", 0o640))).toBeNull()
		expect(looseMode(at("owner", 0o600))).toBeNull()
	})

	onModes("flags group-write — group 1000 could rewrite the secret, not just read it", () => {
		expect(looseMode(at("groupwrite", 0o660))).toBe("0660")
	})

	test("null for a file that is not there, so a missing artifact reports as missing", () => {
		expect(looseMode(path.join(dir, "absent"))).toBeNull()
	})
})
