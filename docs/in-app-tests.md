# Calling tunnel from a test case

📖 [中文](zh-CN/in-app-tests.md)

The rest of these docs is the host's side of the work. A test case running inside the
app does the same things over HTTP, because it cannot spawn a command on your
machine. The split that works:

- **Run level, from the host, with the CLI**: `serve --background`,
  `recordings import`, `mode replay --session acct_a`, `ssl add`, `ca install`.
- **Case level, inside the test, over the admin API**: `POST
  /__admin__/mocks/apply` with this case's scenario, `POST
  /__admin__/state/reset` between cases, `GET /__admin__/requests/wait` instead
  of sleeping, `GET /__admin__/requests?each=1` to assert on what was called.

The scenario a test case applies has to be self-contained — `tunnel pack`
writes exactly that — because the server reads no files from the device or from
your checkout.

Where the admin port is, seen from the test:

| Test runs on | Admin API base |
| --- | --- |
| iOS simulator | `http://127.0.0.1:8000` — it shares the Mac's loopback |
| Android emulator | `http://10.0.2.2:8000` |
| Android device over USB | `http://127.0.0.1:8000` after `adb reverse tcp:8000 tcp:8000` |
| iPhone or iPad | there is no reverse forward: do the preparation from the host with the CLI before the run |

## Swift, with URLSession

```swift
enum Tunnel {
    static let base = URL(string: "http://127.0.0.1:8000/__admin__")!

    static func post(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    /// Apply this case's scenario, replacing whatever the last one left.
    static func apply(_ scenario: [String: Any]) async throws {
        _ = try await post("mocks/apply", scenario)
        _ = try await post("state/reset", [:])
    }

    /// Block until the client has made this call; false means it never did.
    static func waitFor(_ key: String, timeout: Int = 10) async throws -> Bool {
        var components = URLComponents(url: base.appendingPathComponent("requests/wait"),
                                       resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "key", value: key),
                                 URLQueryItem(name: "timeout", value: String(timeout))]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        let answer = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        return (answer["timed_out"] as? Bool) == false
    }
}

// in the test
try await Tunnel.apply([
    "replace": true,
    "mocks": [["key": "GET:api.example.com/v5/feed",
               "mode": "json",
               "json_response": ["code": 0, "cards": []]]],
])
// ... drive the app ...
XCTAssertTrue(try await Tunnel.waitFor("POST:api.example.com/v5/pay", timeout: 30))
```

## Kotlin, with OkHttp

```kotlin
object Tunnel {
    // 10.0.2.2 is the host from an emulator; use 127.0.0.1 after `adb reverse`.
    private const val BASE = "http://10.0.2.2:8000/__admin__"
    private val client = OkHttpClient()
    private val JSON = "application/json".toMediaType()

    fun apply(scenario: String) {
        post("mocks/apply", scenario)
        post("state/reset", "{}")
    }

    fun waitFor(key: String, timeoutSeconds: Int = 10): Boolean {
        val url = "$BASE/requests/wait".toHttpUrl().newBuilder()
            .addQueryParameter("key", key)
            .addQueryParameter("timeout", timeoutSeconds.toString())
            .build()
        val body = client.newCall(Request.Builder().url(url).build())
            .execute().use { it.body!!.string() }
        return !JSONObject(body).getBoolean("timed_out")
    }

    private fun post(path: String, body: String): String =
        client.newCall(
            Request.Builder().url("$BASE/$path").post(body.toRequestBody(JSON)).build()
        ).execute().use { response ->
            check(response.isSuccessful) { "tunnel said ${response.code}: ${response.body?.string()}" }
            response.body!!.string()
        }
}

// in the test
Tunnel.apply(
    """
    {"replace": true,
     "mocks": [{"key": "GET:api.example.com/v5/feed", "mode": "json",
                "json_response": {"code": 0, "cards": []}}]}
    """.trimIndent()
)
// ... drive the app ...
assertTrue(Tunnel.waitFor("POST:api.example.com/v5/pay", timeoutSeconds = 30))
```

The app under test needs no code of its own for any of this: it is the proxy
setting and the CA that put its traffic through tunnel. Give the test build a
`network_security_config` that trusts user CAs, and turn certificate pinning
off there.
