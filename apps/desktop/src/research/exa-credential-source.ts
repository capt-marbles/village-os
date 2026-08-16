export interface ExaCredentialSource {
  withApiKey<T>(use: (apiKey: Uint8Array) => Promise<T>): Promise<T>;
}
