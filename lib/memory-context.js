// The host supplies exec.agent.session / session.header.cwd. Never accept a
// workspace path from model arguments or HTTP input, or fall back to process.cwd.
export function resolveMemoryContext(ctx, { session, sessionId } = {}) {
  if (!session && sessionId !== undefined && sessionId !== null) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('SESSION_INVALID')
    session = (ctx.get?.('sessions') ?? ctx.sessions)?.get(sessionId)
    if (!session) throw new Error('SESSION_INVALID')
  }
  if (!session) return { sessionId: null, workspacePath: null }
  const header = typeof session.header === 'function' ? session.header() : session.header
  const workspacePath = typeof header?.cwd === 'string' && header.cwd.trim() ? header.cwd : null
  return { sessionId: session.id ?? sessionId ?? null, workspacePath }
}
