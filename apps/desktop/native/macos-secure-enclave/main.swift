import CryptoKit
import Darwin
import Foundation

private struct Request: Decodable {
    let operation: String
    let wrappedKey: String?
    let payload: String?
}

private func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func decodeBase64URL(_ value: String, maximumBytes: Int) throws -> Data {
    guard value.count <= maximumBytes * 2 else { throw HelperError.invalidInput }
    let normalized = value
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    let padding = String(repeating: "=", count: (4 - normalized.count % 4) % 4)
    guard let data = Data(base64Encoded: normalized + padding), data.count <= maximumBytes else {
        throw HelperError.invalidInput
    }
    return data
}

private func publicJWK(_ key: P256.Signing.PublicKey) throws -> [String: String] {
    let point = key.x963Representation
    guard point.count == 65, point.first == 0x04 else { throw HelperError.invalidKey }
    return [
        "kty": "EC",
        "crv": "P-256",
        "x": base64URL(point.subdata(in: 1..<33)),
        "y": base64URL(point.subdata(in: 33..<65)),
    ]
}

private enum HelperError: Error {
    case invalidInput
    case invalidKey
    case unavailable
}

private func output(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
}

private func run() throws {
    guard let input = try FileHandle.standardInput.read(upToCount: 1_100_001),
          !input.isEmpty,
          input.count <= 1_100_000 else {
        throw HelperError.invalidInput
    }
    let request = try JSONDecoder().decode(Request.self, from: input)
    if request.operation == "status" {
        try output(["available": SecureEnclave.isAvailable])
        return
    }
    guard SecureEnclave.isAvailable else { throw HelperError.unavailable }

    switch request.operation {
    case "create":
        let key = try SecureEnclave.P256.Signing.PrivateKey()
        try output([
            "wrappedKey": base64URL(key.dataRepresentation),
            "publicKey": try publicJWK(key.publicKey),
        ])
    case "publicKey":
        guard let wrappedKey = request.wrappedKey else { throw HelperError.invalidInput }
        let key = try SecureEnclave.P256.Signing.PrivateKey(
            dataRepresentation: decodeBase64URL(wrappedKey, maximumBytes: 16_384)
        )
        try output(["publicKey": try publicJWK(key.publicKey)])
    case "sign":
        guard let wrappedKey = request.wrappedKey, let payload = request.payload else {
            throw HelperError.invalidInput
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey(
            dataRepresentation: decodeBase64URL(wrappedKey, maximumBytes: 16_384)
        )
        let signature = try key.signature(
            for: decodeBase64URL(payload, maximumBytes: 1_048_576)
        )
        try output(["signature": base64URL(signature.rawRepresentation)])
    default:
        throw HelperError.invalidInput
    }
}

do {
    try run()
} catch {
    FileHandle.standardError.write(Data("secure enclave operation failed\n".utf8))
    Darwin.exit(1)
}
