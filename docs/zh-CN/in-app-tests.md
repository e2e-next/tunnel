# 在测试用例里调用 tunnel

📖 [English](../in-app-tests.md)

其余几页讲的都是宿主机这一侧的活儿。跑在 app 里的测试用例做同样的事情要走 HTTP，
因为它没法在你的机器上起一个命令。行得通的分工是：

- **整轮级，在宿主机用 CLI**：`serve --background`、`recordings import`、
  `mode replay --session acct_a`、`ssl add`、`ca install`。
- **用例级，在测试里调管理 API**：`POST /__admin__/mocks/apply` 应用本用例的
  场景，`POST /__admin__/state/reset` 在用例之间重置，
  `GET /__admin__/requests/wait` 代替 sleep，
  `GET /__admin__/requests?each=1` 断言客户端调了什么。

测试用例应用的场景必须是自包含的 —— `tunnel pack` 写出来的正是这个 ——
因为服务端既不读设备上的文件，也不读你 checkout 里的文件。

从测试的角度看，管理口在哪里：

| 测试跑在 | 管理 API 地址 |
| --- | --- |
| iOS 模拟器 | `http://127.0.0.1:8000` —— 它和 Mac 共享回环 |
| Android 模拟器 | `http://10.0.2.2:8000` |
| USB 连着的 Android 真机 | `adb reverse tcp:8000 tcp:8000` 之后用 `http://127.0.0.1:8000` |
| iPhone / iPad | 没有反向转发这回事：开跑之前在宿主机上用 CLI 准备好 |

## Swift，用 URLSession

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

    /// 应用本用例的场景，覆盖掉上一个用例留下的东西。
    static func apply(_ scenario: [String: Any]) async throws {
        _ = try await post("mocks/apply", scenario)
        _ = try await post("state/reset", [:])
    }

    /// 阻塞到客户端发出这次调用；false 表示它始终没发。
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

// 在测试里
try await Tunnel.apply([
    "replace": true,
    "mocks": [["key": "GET:api.example.com/v5/feed",
               "mode": "json",
               "json_response": ["code": 0, "cards": []]]],
])
// …驱动 app…
XCTAssertTrue(try await Tunnel.waitFor("POST:api.example.com/v5/pay", timeout: 30))
```

## Kotlin，用 OkHttp

```kotlin
object Tunnel {
    // 10.0.2.2 是模拟器眼里的宿主机；`adb reverse` 之后用 127.0.0.1。
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

// 在测试里
Tunnel.apply(
    """
    {"replace": true,
     "mocks": [{"key": "GET:api.example.com/v5/feed", "mode": "json",
                "json_response": {"code": 0, "cards": []}}]}
    """.trimIndent()
)
// …驱动 app…
assertTrue(Tunnel.waitFor("POST:api.example.com/v5/pay", timeoutSeconds = 30))
```

被测 app 自己不需要为这一切写任何代码：把它的流量送进 tunnel 的是代理设置和 CA。
给测试构建一个信任用户 CA 的 `network_security_config`，并在那里关掉证书固定。
