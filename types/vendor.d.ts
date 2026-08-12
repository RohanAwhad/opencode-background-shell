declare module "@opencode-ai/sdk" {
  export type Part = { type: string; text?: string } & Record<string, unknown>
  export type TextPartInput = { type: "text"; text: string }
  export type UserMessage = { role: string } & Record<string, unknown>
  export type Message = Record<string, unknown>
  export type Permission = Record<string, unknown>
  export type Project = Record<string, unknown>
  export type Model = Record<string, unknown>
  export type Provider = Record<string, unknown>
  export type SessionInfo = { parentID?: string } & Record<string, unknown>
  export type Event = {
    type: string
    properties: { sessionID?: string; info?: SessionInfo } & Record<string, unknown>
  } & Record<string, unknown>
  export type Config = {
    plugin?: Array<string | [string, Record<string, unknown>]>
  } & Record<string, unknown>
  export type CreateOpencodeClient = {
    session: {
      promptAsync(options: {
        path: { id: string }
        body: { noReply?: boolean; parts: TextPartInput[] }
      }): Promise<unknown>
      get(options: { path: { id: string } }): Promise<{ data?: SessionInfo }>
    }
  }
  export function createOpencodeClient(options: Record<string, unknown>): CreateOpencodeClient
}

declare module "@opencode-ai/sdk/v2" {
  export type Provider = Record<string, unknown>
  export type Model = Record<string, unknown>
  export type Auth = Record<string, unknown>
}

declare module "cross-spawn" {
  const crossSpawn: {
    (command: string, args?: string[], options?: Record<string, unknown>): unknown
  }
  export default crossSpawn
}
