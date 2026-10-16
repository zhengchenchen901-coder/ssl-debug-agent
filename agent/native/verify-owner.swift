import Foundation
import LocalAuthentication

// Password entry remains entirely inside macOS's authentication UI.
let nonce = CommandLine.arguments.dropFirst().first ?? ""
let context = LAContext()
context.localizedCancelTitle = "取消"
var error: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
    print("{\"verified\":false}")
    exit(2)
}
if nonce == "--check" {
    print("{\"available\":true}")
    exit(0)
}
guard nonce.count == 64, nonce.allSatisfy({ $0.isHexDigit }) else { exit(2) }
context.touchIDAuthenticationAllowableReuseDuration = 0
context.evaluatePolicy(.deviceOwnerAuthentication,
    localizedReason: "注册或恢复 Remote Debug Agent 管理员，允许手动操作服务器。") { success, _ in
    let value: [String: Any] = ["verified": success, "nonce": nonce, "uid": getuid()]
    if let data = try? JSONSerialization.data(withJSONObject: value), let result = String(data: data, encoding: .utf8) {
        print(result)
    }
    exit(success ? 0 : 1)
}
RunLoop.main.run()
