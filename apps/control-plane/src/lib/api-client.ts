export class VillageApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async get<T>(path: string, headers?: HeadersInit): Promise<T> {
    return this.send<T>(path, {
      method: "GET",
      ...(headers === undefined ? {} : { headers }),
    });
  }

  async mutate<T>(
    path: string,
    method: "POST" | "PUT" | "DELETE",
    body?: unknown,
    headers?: HeadersInit,
  ): Promise<T> {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    return this.send<T>(path, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async send<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.request(new URL(path, this.baseUrl), init);
    const result = (await response.json()) as T & { code?: string };
    if (!response.ok) throw new Error(result.code ?? `HTTP_${response.status}`);
    return result;
  }
}
