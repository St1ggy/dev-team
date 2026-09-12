export class RpcClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly role: 'main' | 'worker',
    private readonly agentId: string,
  ) {}

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${this.url}/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: this.role, agentId: this.agentId, method, params }),
    });
    const body = await response.json() as { ok: boolean; result?: T; error?: string };
    if (!response.ok || !body.ok) throw new Error(body.error ?? `RPC failed with ${response.status}`);
    return body.result as T;
  }
}
