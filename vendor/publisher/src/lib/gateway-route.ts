/** Local gateway HTTP and WebSocket requests must use the same direct route. */
export function isLocalGateway(url: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(url).hostname)
}
